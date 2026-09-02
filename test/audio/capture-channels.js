#!/usr/bin/env node
// Capture per-channel APU output straight from the core, before any browser or
// Web Audio involvement.
//
// A mix-level comparison against another emulator can say "the timbre is
// wrong" but not which of the four channels is wrong, and a channel that is
// late looks much like a channel that is too loud once they are summed. The
// core keeps a separate buffer per channel when audio debugging is on, so this
// dumps all four alongside the mix for the same frame range.
//
//   node test/audio/capture-channels.js --rom game.gbc --start 600 --end 660 --out tmp/capture
//
// Writes <name>.mix.wav and <name>.ch1..ch4.wav at 44100Hz stereo, plus a JSON
// summary with per-channel RMS and peak so a difference has a number attached.

const fs = require('fs');
const path = require('path');

const getWasmBoyCore = require('../../dist/core/getWasmBoyWasmCore.cjs.js');

const SAMPLE_RATE = 44100;

const parseArgs = argv => {
  const args = { start: 0, end: 60, out: 'tmp/capture', gbc: true };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'dmg') {
      args.gbc = false;
      continue;
    }
    args[key] = argv[++i];
  }
  args.start = parseInt(args.start, 10);
  args.end = parseInt(args.end, 10);
  return args;
};

// The core stores samples as unsigned bytes with 1 added so silence is not an
// empty byte. This is the inverse, and deliberately does NOT apply the volume
// division or the noise gate the lib applies afterwards: this is meant to show
// what the APU produced, not what the speaker got.
const toFloat = sample => (sample - 1) / 127 - 1;

const writeWav = (file, left, right) => {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 4;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), 44 + i * 4);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), 44 + i * 4 + 2);
  }

  fs.writeFileSync(file, buffer);
};

const summarize = channel => {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < channel.left.length; i++) {
    const value = channel.left[i];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  return {
    samples: channel.left.length,
    rms: channel.left.length ? Math.sqrt(sumSquares / channel.left.length) : 0,
    peak
  };
};

const main = async () => {
  const args = parseArgs(process.argv);
  if (!args.rom) {
    console.error('usage: capture-channels.js --rom <file> [--start N] [--end N] [--out dir] [--dmg]');
    process.exit(2);
  }

  const core = await getWasmBoyCore();
  const wasmboy = core.instance.exports;
  const memory = new Uint8Array(wasmboy.memory.buffer);

  memory.set(new Uint8Array(fs.readFileSync(args.rom)), wasmboy.CARTRIDGE_ROM_LOCATION);

  // Audio debugging on, and both batching options off: batching changes when
  // samples are emitted, which is the kind of thing being measured.
  wasmboy.config(
    0, // enableBootRom
    args.gbc ? 1 : 0, // useGbcWhenAvailable
    0, // audioBatchProcessing
    0, // graphicsBatchProcessing
    0, // timersBatchProcessing
    0, // graphicsDisableScanlineRendering
    0, // audioAccumulateSamples
    0, // tileRendering
    0, // tileCaching
    1 // enableAudioDebugging
  );

  const channels = {
    mix: { location: wasmboy.AUDIO_BUFFER_LOCATION, left: [], right: [] },
    ch1: { location: wasmboy.CHANNEL_1_BUFFER_LOCATION, left: [], right: [] },
    ch2: { location: wasmboy.CHANNEL_2_BUFFER_LOCATION, left: [], right: [] },
    ch3: { location: wasmboy.CHANNEL_3_BUFFER_LOCATION, left: [], right: [] },
    ch4: { location: wasmboy.CHANNEL_4_BUFFER_LOCATION, left: [], right: [] }
  };

  for (let frame = 0; frame < args.end; frame++) {
    wasmboy.executeFrame();

    const sampleCount = wasmboy.getNumberOfSamplesInAudioBuffer();
    if (frame >= args.start) {
      Object.keys(channels).forEach(key => {
        const channel = channels[key];
        for (let sample = 0; sample < sampleCount; sample++) {
          const offset = channel.location + sample * 2;
          channel.left.push(toFloat(memory[offset]));
          channel.right.push(toFloat(memory[offset + 1]));
        }
      });
    }

    // Drain every frame, so the window is contiguous and nothing is dropped by
    // the buffer filling up.
    wasmboy.clearAudioBuffer();
  }

  fs.mkdirSync(args.out, { recursive: true });
  const name = path.basename(args.rom).replace(/\.[^.]+$/, '');

  const summary = { rom: args.rom, startFrame: args.start, endFrame: args.end, sampleRate: SAMPLE_RATE, channels: {} };
  Object.keys(channels).forEach(key => {
    const channel = channels[key];
    writeWav(path.join(args.out, `${name}.${key}.wav`), channel.left, channel.right);
    summary.channels[key] = summarize(channel);
  });

  fs.writeFileSync(path.join(args.out, `${name}.summary.json`), JSON.stringify(summary, null, 2));

  console.log(`frames ${args.start}-${args.end} of ${path.basename(args.rom)} -> ${args.out}`);
  Object.keys(summary.channels).forEach(key => {
    const stats = summary.channels[key];
    console.log(`  ${key.padEnd(4)} samples=${String(stats.samples).padStart(6)}  rms=${stats.rms.toFixed(5)}  peak=${stats.peak.toFixed(4)}`);
  });
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
