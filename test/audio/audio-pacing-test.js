// Closed-loop tests for the audio path: emulator, pacing control and worklet
// together.
//
// The drift tests next door exercise the worklet alone against a producer with
// a fixed clock offset. That was not enough. A real browser run showed two
// failures it could not see, because both come from the loop rather than from
// the worklet:
//
//   direct output   the queue sat at 48-58ms and grew, with the resampler's
//                   correction pinned at its limit. The producer outran the
//                   consumer by more than the consumer could correct, and the
//                   old ceiling-based brake let it.
//   relayed output  the queue sat below target and still underran, because
//                   blocks arrive late through the main thread. That is
//                   variance, and rate control only moves the average.
//
// So these drive the producer too, through the same pacing function that
// ships, with the feedback delay and the arrival jitter that make it hard.
// Sampled at 2s and 30s to match how the failures were reported.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKLET_SOURCE = path.resolve(__dirname, '../../lib/audio/worklet/audio.worklet.js');
const PACING_SOURCE = path.resolve(__dirname, '../../lib/audio/pacing.js');

const RENDER_QUANTUM = 128;
const SOURCE_SAMPLE_RATE = 44100;
const BLOCK_FRAMES = 512;
// The worklet reports every 8 render quanta, so the producer is always acting
// on a slightly stale reading. Pacing has to be stable in spite of that.
const STATUS_INTERVAL_QUANTA = 8;

const loadWorklet = contextSampleRate => {
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
  return registered;
};

// The pacing module is ESM and the suite is CommonJS. Rather than duplicate the
// control law into the test, where it could drift from the shipped one, run the
// real file with the export keyword stripped.
const loadPacing = () => {
  const sandbox = { Math };
  vm.createContext(sandbox);
  const source = fs.readFileSync(PACING_SOURCE, 'utf8').replace(/^export /gm, '');
  vm.runInContext(`${source}\nthis.computeProducerDelayMs = computeProducerDelayMs;\nthis.getEffectiveTargetLatencySeconds = getEffectiveTargetLatencySeconds;`, sandbox, {
    filename: PACING_SOURCE
  });
  return sandbox;
};

// Deterministic jitter, so a failure is always reproducible.
const createRandom = seed => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const createLoop = ({ contextSampleRate = 48000, driftRatio = 1, targetLatencySeconds, jitterMs = 0, seed = 1 }) => {
  const Processor = loadWorklet(contextSampleRate);
  const pacing = loadPacing();
  const random = createRandom(seed);

  const processor = new Processor({
    processorOptions: {
      sourceSampleRate: SOURCE_SAMPLE_RATE,
      capacityFrames: 4096,
      targetLatencySeconds
    }
  });

  const outputs = [[new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]];
  const quantumSeconds = RENDER_QUANTUM / contextSampleRate;
  const blockSeconds = BLOCK_FRAMES / SOURCE_SAMPLE_RATE;

  let now = 0;
  let nextSendAt = 0;
  let reportedLatency = 0;
  let quantaSinceReport = 0;
  const inFlight = [];

  const step = () => {
    // Producer: hands over a block when its schedule says so, then paces the
    // next one off the most recent latency reading it has.
    while (nextSendAt <= now) {
      const arriveAt = now + (jitterMs > 0 ? (random() * jitterMs) / 1000 : 0);
      inFlight.push({ arriveAt });

      const delayMs = pacing.computeProducerDelayMs(reportedLatency, targetLatencySeconds);
      nextSendAt = nextSendAt + blockSeconds / driftRatio + delayMs / 1000;
    }

    // Blocks land, late by however long the transport took.
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].arriveAt <= now) {
        processor._write(new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES), 1);
        inFlight.splice(i, 1);
      }
    }

    processor.process([], outputs);
    now += quantumSeconds;

    if (++quantaSinceReport >= STATUS_INTERVAL_QUANTA) {
      quantaSinceReport = 0;
      reportedLatency = processor.queuedFrames / SOURCE_SAMPLE_RATE;
    }
  };

  const runTo = seconds => {
    while (now < seconds) step();
  };

  const sample = () => ({
    latencyMs: (processor.queuedFrames / SOURCE_SAMPLE_RATE) * 1000,
    queuedFrames: processor.queuedFrames,
    underrunFrames: processor.underrunFrames,
    droppedFrames: processor.droppedFrames,
    driftTrim: processor.driftTrim
  });

  return { processor, runTo, sample };
};

describe('Audio producer pacing (closed loop)', () => {
  it('should hold direct output at the target when the emulator runs fast', () => {
    // The reported failure: producer ahead by more than the resampler can
    // correct, so pacing has to be what pulls the queue back.
    const loop = createLoop({ driftRatio: 1.01, targetLatencySeconds: 0.026 });

    loop.runTo(2);
    const early = loop.sample();
    loop.runTo(30);
    const late = loop.sample();

    assert(late.latencyMs <= 31, `30s latency ${late.latencyMs.toFixed(1)}ms exceeded the 31ms budget`);
    assert(late.latencyMs <= early.latencyMs + 5, `queue grew from ${early.latencyMs.toFixed(1)}ms to ${late.latencyMs.toFixed(1)}ms`);
    assert.strictEqual(late.underrunFrames - early.underrunFrames, 0, 'underruns accumulated after settling');
    assert.strictEqual(late.droppedFrames - early.droppedFrames, 0, 'frames were dropped after settling');
  });

  it('should not need audible pitch correction to do it', () => {
    // Pitch-shifting to hide a pacing problem is the thing to avoid.
    const loop = createLoop({ driftRatio: 1.01, targetLatencySeconds: 0.026 });
    loop.runTo(30);

    const trim = Math.abs(loop.sample().driftTrim);
    assert(trim <= 0.005 + 1e-9, `drift trim ${trim} exceeded the inaudible budget`);
  });

  it('should recover a large backlog down to the target', () => {
    const loop = createLoop({ targetLatencySeconds: 0.026 });

    // Roughly what the old ceiling-based brake used to leave standing.
    const backlog = 2600;
    loop.processor._write(new Float32Array(backlog), new Float32Array(backlog), 1);
    assert(loop.sample().latencyMs > 55, 'expected a starting backlog');

    loop.runTo(30);

    const latency = loop.sample().latencyMs;
    assert(latency <= 31, `latency stayed at ${latency.toFixed(1)}ms`);
  });

  it('should hold the target when the emulator runs slow', () => {
    const loop = createLoop({ driftRatio: 0.99, targetLatencySeconds: 0.026 });

    loop.runTo(2);
    const early = loop.sample();
    loop.runTo(30);
    const late = loop.sample();

    assert.strictEqual(late.underrunFrames - early.underrunFrames, 0, 'underruns accumulated with a slow producer');
    assert(late.latencyMs >= 10, `queue collapsed to ${late.latencyMs.toFixed(1)}ms`);
  });

  it('should survive main-thread arrival jitter on the relayed path', () => {
    // The other reported failure: queue below target and still underrunning,
    // because blocks arrive late rather than at the wrong average rate. The
    // relayed path is given extra depth for exactly this.
    const pacing = loadPacing();
    const relayedTarget = pacing.getEffectiveTargetLatencySeconds(0.026, false);
    assert(relayedTarget > 0.028, 'the relayed path should ask for more depth than direct');

    const loop = createLoop({ targetLatencySeconds: relayedTarget, jitterMs: 18, seed: 7 });

    loop.runTo(2);
    const early = loop.sample();
    loop.runTo(30);
    const late = loop.sample();

    assert.strictEqual(late.underrunFrames - early.underrunFrames, 0, `accumulated ${late.underrunFrames - early.underrunFrames} underrun frames under 18ms jitter`);
    assert.strictEqual(late.droppedFrames - early.droppedFrames, 0, 'frames were dropped under jitter');
  });

  it('should brake proportionally rather than only past a ceiling', () => {
    const pacing = loadPacing();
    const target = 0.026;

    // At and below target, run freely.
    assert.strictEqual(pacing.computeProducerDelayMs(0.02, target), 0);
    assert.strictEqual(pacing.computeProducerDelayMs(target, target), 0);

    // Above it, brake in proportion, which is what stops the queue parking at
    // whatever ceiling used to be enforced.
    const small = pacing.computeProducerDelayMs(0.035, target);
    const large = pacing.computeProducerDelayMs(0.055, target);
    assert(small > 0, 'a queue over target should slow the producer');
    assert(large > small, 'a larger overshoot should brake harder');

    // But never long enough to hitch video.
    assert(pacing.computeProducerDelayMs(5, target) <= 32, 'pacing delay must stay bounded');
  });
});
