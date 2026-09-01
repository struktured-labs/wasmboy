// Deterministic drift/latency tests for the AudioWorklet output path.
//
// The worklet is the only thing standing between the emulator's sample clock
// and the audio hardware's. Those clocks are independent, so the queue between
// them integrates their difference: without feedback it walks off until it
// either empties (underruns, audible gaps) or sits far above the latency the
// player asked for. Both were observed in a real browser, so they are pinned
// here instead, where the clocks can be set exactly.
//
// This runs the real processor source with the AudioWorklet globals stubbed,
// and drives it with a simulated producer and a render loop, so it is fast and
// has no browser in it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKLET_SOURCE = path.resolve(__dirname, '../../lib/audio/worklet/audio.worklet.js');

const RENDER_QUANTUM = 128;
const SOURCE_SAMPLE_RATE = 44100;

// Load the processor with the globals an AudioWorkletGlobalScope would provide.
const loadProcessor = contextSampleRate => {
  let registered;

  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: () => {}, onmessage: undefined };
      }
    },
    registerProcessor: (name, processorClass) => {
      registered = processorClass;
    },
    sampleRate: contextSampleRate,
    Float32Array,
    Uint8Array,
    Math
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(WORKLET_SOURCE, 'utf8'), sandbox, { filename: WORKLET_SOURCE });

  assert(registered, 'the worklet did not register a processor');
  return registered;
};

// A producer whose sample clock differs from the audio clock by driftRatio,
// delivering in blocks the way the emulator does.
const createHarness = ({ contextSampleRate, driftRatio = 1, targetLatencySeconds, blockFrames = 512 }) => {
  const Processor = loadProcessor(contextSampleRate);
  const processor = new Processor({
    processorOptions: {
      sourceSampleRate: SOURCE_SAMPLE_RATE,
      capacityFrames: 4096,
      targetLatencySeconds
    }
  });

  const outputs = [[new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]];
  let pendingSourceFrames = 0;
  let phase = 0;

  const renderOneQuantum = () => {
    // Frames the producer generated during the time this quantum covers.
    pendingSourceFrames += (RENDER_QUANTUM / contextSampleRate) * SOURCE_SAMPLE_RATE * driftRatio;

    while (pendingSourceFrames >= blockFrames) {
      const left = new Float32Array(blockFrames);
      const right = new Float32Array(blockFrames);
      for (let i = 0; i < blockFrames; i++) {
        // A plain tone, so an underrun shows up as a real discontinuity.
        left[i] = Math.sin(phase);
        right[i] = left[i];
        phase += 0.05;
      }
      processor._write(left, right, 1);
      pendingSourceFrames -= blockFrames;
    }

    processor.process([], outputs);
  };

  const runSeconds = seconds => {
    const quanta = Math.round((seconds * contextSampleRate) / RENDER_QUANTUM);
    for (let i = 0; i < quanta; i++) renderOneQuantum();
  };

  return {
    processor,
    runSeconds,
    latencyMs: () => (processor.queuedFrames / SOURCE_SAMPLE_RATE) * 1000
  };
};

describe('AudioWorklet drift and latency', () => {
  it('should settle at the requested latency rather than wherever it started', () => {
    const harness = createHarness({ contextSampleRate: 48000, targetLatencySeconds: 0.028 });

    // Hand it a large backlog up front, which is what a producer that queues
    // ahead of the target does.
    const backlog = 2500;
    harness.processor._write(new Float32Array(backlog), new Float32Array(backlog), 1);
    assert(harness.latencyMs() > 50, `expected a starting backlog, got ${harness.latencyMs().toFixed(1)}ms`);

    harness.runSeconds(20);

    const latency = harness.latencyMs();
    assert(latency <= 31, `steady-state latency ${latency.toFixed(1)}ms exceeded the 31ms budget`);
    assert(latency >= 15, `latency ${latency.toFixed(1)}ms collapsed toward underrun`);
  });

  it('should not accumulate underruns when the producer runs slightly slow', () => {
    // A producer 0.3% slow drains the queue steadily without correction.
    const harness = createHarness({ contextSampleRate: 48000, driftRatio: 0.997, targetLatencySeconds: 0.028 });

    harness.runSeconds(5);
    const underrunsAfterSettling = harness.processor.underrunFrames;

    harness.runSeconds(30);

    const newUnderruns = harness.processor.underrunFrames - underrunsAfterSettling;
    assert.strictEqual(newUnderruns, 0, `accumulated ${newUnderruns} underrun frames over 30s`);
    assert.strictEqual(harness.processor.droppedFrames, 0, `dropped ${harness.processor.droppedFrames} frames`);
  });

  it('should not accumulate drops or latency when the producer runs slightly fast', () => {
    // The mirror image: 0.3% fast fills the queue until it overflows.
    const harness = createHarness({ contextSampleRate: 48000, driftRatio: 1.003, targetLatencySeconds: 0.028 });

    harness.runSeconds(5);
    const dropsAfterSettling = harness.processor.droppedFrames;

    harness.runSeconds(30);

    const newDrops = harness.processor.droppedFrames - dropsAfterSettling;
    assert.strictEqual(newDrops, 0, `dropped ${newDrops} frames over 30s`);

    const latency = harness.latencyMs();
    assert(latency <= 31, `latency grew to ${latency.toFixed(1)}ms`);
  });

  it('should hold the target at a context rate that matches the source', () => {
    // 44100 makes the resample ratio exactly 1, a different arithmetic path.
    const harness = createHarness({ contextSampleRate: 44100, targetLatencySeconds: 0.028 });

    harness.runSeconds(20);

    const latency = harness.latencyMs();
    assert(latency <= 31, `latency ${latency.toFixed(1)}ms exceeded the budget at 44100Hz`);
    assert.strictEqual(harness.processor.droppedFrames, 0);
  });

  it('should keep pitch correction inaudible in steady state', () => {
    const harness = createHarness({ contextSampleRate: 48000, driftRatio: 1.002, targetLatencySeconds: 0.028 });

    harness.runSeconds(25);

    // Beyond about 2% the correction stops being a nudge and starts being
    // heard as pitch.
    assert(Math.abs(harness.processor.driftTrim) <= 0.02 + 1e-9, `drift trim ${harness.processor.driftTrim} is audible`);
  });

  it('should recover from a producer stall without silence for the full target', () => {
    const harness = createHarness({ contextSampleRate: 48000, targetLatencySeconds: 0.028 });
    harness.runSeconds(5);

    // Starve it until the queue empties.
    const outputs = [[new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]];
    while (harness.processor.queuedFrames > 0) harness.processor.process([], outputs);
    assert.strictEqual(harness.processor.primed, false, 'expected the stall to unprime playback');

    // One small block should restart it, rather than needing a full target's worth.
    const rePrime = harness.processor.rePrimeThresholdFrames;
    assert(rePrime < harness.processor.targetFrames, 'recovery should need less than a cold start');
    harness.processor._write(new Float32Array(rePrime), new Float32Array(rePrime), 1);
    assert.strictEqual(harness.processor.primed, true, 'playback did not resume after refill');
  });
});
