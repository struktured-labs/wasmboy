// Wave channel (CH3) output level tests, against the core directly.
//
// NR32 selects one of four output levels: mute, full, half, quarter. Those are
// ratios, so they can be checked without a reference emulator: play the same
// waveform at each code and compare amplitudes to the full-volume run.
//
// This exists because the attenuation used to be applied twice — the sample was
// shifted right and then divided by the same amount again — so code 2 played at
// a quarter instead of a half and code 3 at a sixteenth instead of a quarter. On
// a four-bit sample the second division also collapses the waveform into very
// few levels, which costs the high harmonics the wave channel is supposed to
// have. A mix-level golden could not see it, because it only shows up as the
// wave channel sitting too low against the others.

const assert = require('assert');

const getWasmBoyCore = require('../../dist/core/getWasmBoyWasmCore.cjs.js');

// A wave pattern that alternates between the extremes, so the peak-to-peak
// amplitude is the full range the volume code allows and attenuation is
// directly visible.
const WAVE_PATTERN = [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00];

const makeWaveChannelRom = volumeCode => {
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x00;
  rom[0x0143] = 0x00;

  const ldh = (register, value) => [0x3e, value, 0xe0, register];

  const program = [
    0xf3, // di
    ...ldh(0x26, 0x80), // NR52: sound on. Must come first; the others are ignored while off.
    ...ldh(0x25, 0xff), // NR51: every channel to both outputs
    ...ldh(0x24, 0x77), // NR50: full volume, no Vin
    ...ldh(0x1a, 0x00), // NR30: wave DAC off while loading wave RAM
    // Wave RAM, $FF30-$FF3F
    ...WAVE_PATTERN.flatMap((byte, index) => ldh(0x30 + index, byte)),
    ...ldh(0x1a, 0x80), // NR30: wave DAC on
    ...ldh(0x1b, 0x00), // NR31: length, unused with looping disabled
    ...ldh(0x1c, volumeCode << 5), // NR32: output level
    ...ldh(0x1d, 0x00), // NR33: frequency low
    ...ldh(0x1e, 0x87), // NR34: trigger, no length enable, frequency high 7
    0x18,
    0xfe // jr -2, spin forever
  ];

  rom.set(program, 0x0100);
  return rom;
};

// The core stores each sample as an unsigned byte with 1 added. Peak-to-peak of
// the raw bytes is enough to compare levels, and avoids depending on how the
// lib later converts them.
const measureChannel3PeakToPeak = (wasmboy, memory) => {
  const sampleCount = wasmboy.getNumberOfSamplesInAudioBuffer();
  let min = 255;
  let max = 0;

  let written = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const value = memory[wasmboy.CHANNEL_3_BUFFER_LOCATION + sample * 2];
    // Samples carry a +1 offset so silence is not an empty byte, which makes 0
    // mean "never written" rather than a real level. Counting those as a
    // minimum invents amplitude that was not produced.
    if (value === 0) {
      continue;
    }
    written++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  return { peakToPeak: written > 0 ? max - min : 0, sampleCount: written };
};

const runVolumeCode = async volumeCode => {
  const core = await getWasmBoyCore();
  const wasmboy = core.instance.exports;
  const memory = new Uint8Array(wasmboy.memory.buffer);

  memory.set(makeWaveChannelRom(volumeCode), wasmboy.CARTRIDGE_ROM_LOCATION);

  wasmboy.config(
    0, // enableBootRom
    0, // useGbcWhenAvailable
    0, // audioBatchProcessing
    0, // graphicsBatchProcessing
    0, // timersBatchProcessing
    0, // graphicsDisableScanlineRendering
    0, // audioAccumulateSamples
    0, // tileRendering
    0, // tileCaching
    1 // enableAudioDebugging, so the per-channel buffer is written
  );

  // A few frames to get past the register writes, then measure one.
  for (let frame = 0; frame < 4; frame++) {
    wasmboy.executeFrame();
    wasmboy.clearAudioBuffer();
  }
  wasmboy.executeFrame();

  return measureChannel3PeakToPeak(wasmboy, memory);
};

describe('WasmBoy Core Wave Channel', () => {
  it('should attenuate by the NR32 volume code exactly once', async () => {
    const full = await runVolumeCode(1);
    const half = await runVolumeCode(2);
    const quarter = await runVolumeCode(3);

    assert(full.sampleCount > 0, 'expected the wave channel to produce samples');
    assert(full.peakToPeak > 0, 'expected a non-silent waveform at full volume');

    // The hardware shifts a four-bit sample, so the levels follow 15, 7, 3
    // rather than exact halves. Comparing against exact halves would fail on
    // correct behaviour. The bug being caught was a further factor of two and
    // four below these, which is far outside the rounding.
    const expectedHalf = (full.peakToPeak * 7) / 15;
    const expectedQuarter = (full.peakToPeak * 3) / 15;

    assert(
      Math.abs(half.peakToPeak - expectedHalf) <= 1,
      `code 2 should be half: full=${full.peakToPeak} half=${half.peakToPeak} expected~${expectedHalf.toFixed(1)}`
    );
    assert(
      Math.abs(quarter.peakToPeak - expectedQuarter) <= 1,
      `code 3 should be a quarter: full=${full.peakToPeak} quarter=${quarter.peakToPeak} expected~${expectedQuarter.toFixed(1)}`
    );
  });

  it('should mute on volume code 0', async () => {
    const muted = await runVolumeCode(0);
    const full = await runVolumeCode(1);

    assert(full.peakToPeak > 0, 'expected a non-silent waveform at full volume');
    assert.strictEqual(muted.peakToPeak, 0, 'code 0 should produce no output');
  });

  it('should ignore the unused high bit of NR32', async () => {
    // Only bits 6-5 select the level. Bit 7 is unused, and a game setting it
    // must not change the volume. Masking it in as part of the code sent every
    // such write to the quarter-volume branch.
    const full = await runVolumeCode(1);
    const fullWithHighBit = await runVolumeCode(1 | 0x04);

    assert.strictEqual(
      fullWithHighBit.peakToPeak,
      full.peakToPeak,
      `NR32 bit 7 changed the output level: without=${full.peakToPeak} with=${fullWithHighBit.peakToPeak}`
    );
  });
});
