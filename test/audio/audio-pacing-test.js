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

describe('Audio feedback freshness', () => {
  const pacing = loadPacing();
  const BLOCK_SECONDS = 512 / 44100; // ~11.61ms, the emulator's audio block
  const TARGET = 0.026;

  it('should count the block it is about to send', () => {
    // The decision runs before the block is enqueued, so pacing on the reading
    // alone restrains a queue that does not yet include what is being added.
    const reading = { queuedSecondsAtReading: 0.027, secondsSentSinceReading: 0, elapsedSeconds: 0 };

    const ignoringPending = pacing.projectQueuedSeconds(reading);
    const includingPending = pacing.projectQueuedSeconds({ ...reading, pendingSeconds: BLOCK_SECONDS });

    assert(includingPending > ignoringPending, 'the pending block should raise the projection');
    assert(
      pacing.computeProducerDelayMs(includingPending, TARGET) > pacing.computeProducerDelayMs(ignoringPending, TARGET),
      'and should therefore brake harder'
    );
  });

  it('should stay ahead of a two-block burst inside one frame', () => {
    // The reported failure: at a reading of ~27ms the producer computed ~1ms of
    // delay and then sent two blocks before any fresh status could arrive, so
    // the real queue reached ~52ms while the producer still believed 27ms.
    const readingSeconds = 0.0275;

    const staleDelay = pacing.computeProducerDelayMs(readingSeconds, TARGET);

    let sent = 0;
    let projected = 0;
    for (let block = 0; block < 2; block++) {
      projected = pacing.projectQueuedSeconds({
        queuedSecondsAtReading: readingSeconds,
        secondsSentSinceReading: sent,
        pendingSeconds: BLOCK_SECONDS,
        elapsedSeconds: 0
      });
      sent += BLOCK_SECONDS;
    }

    const projectedDelay = pacing.computeProducerDelayMs(projected, TARGET);

    assert(staleDelay <= 1, `the stale reading barely braked, as reported: ${staleDelay}ms`);
    assert(projectedDelay > staleDelay, `projection should brake harder: stale=${staleDelay}ms projected=${projectedDelay}ms`);
    assert(projected > 0.045, `two blocks past a 27.5ms reading should project past 45ms, got ${(projected * 1000).toFixed(1)}ms`);
  });

  it('should subtract what the hardware drained while the reading aged', () => {
    // Without this a stale reading would inflate forever and the producer would
    // brake on a queue that has already emptied.
    const fresh = pacing.projectQueuedSeconds({ queuedSecondsAtReading: 0.03, elapsedSeconds: 0 });
    const aged = pacing.projectQueuedSeconds({ queuedSecondsAtReading: 0.03, elapsedSeconds: 0.02 });

    assert(aged < fresh, 'an older reading should project a smaller queue');
    assert(Math.abs(aged - 0.01) < 1e-9, `expected 10ms remaining, got ${(aged * 1000).toFixed(1)}ms`);
  });

  it('should never project a negative queue', () => {
    const projected = pacing.projectQueuedSeconds({ queuedSecondsAtReading: 0.01, elapsedSeconds: 5 });
    assert.strictEqual(projected, 0);
  });

  it('should report no projection when no reading has arrived', () => {
    assert.strictEqual(pacing.projectQueuedSeconds({}), undefined);
    assert.strictEqual(pacing.projectQueuedSeconds(undefined), undefined);
  });
});

describe('Audio pacing against a stale-high reading', () => {
  const pacing = loadPacing();
  const BLOCK_SECONDS = 512 / 44100;
  const TARGET = 0.026;

  it('should not over-brake when the reading is stale and too high', () => {
    // Adding the pending block to the raw feedback, with no decay, brakes on a
    // queue that has already drained: measured elsewhere as a producer seeing
    // 27.68ms and pacing 15ms while the real queue was 6.96ms, which starved
    // the output. Subtracting elapsed time and counting only what was actually
    // sent is what makes the projection safe.
    const anchorSeconds = 0.02768;
    const elapsedSeconds = 0.021;
    // The emulator fell behind real time over that window, which is why the
    // queue drained rather than grew.
    const sentSeconds = 0.008;

    const naive = anchorSeconds + BLOCK_SECONDS;
    const projected = pacing.projectQueuedSeconds({
      queuedSecondsAtReading: anchorSeconds,
      secondsSentSinceReading: sentSeconds,
      pendingSeconds: BLOCK_SECONDS,
      elapsedSeconds
    });

    assert(projected < naive, `decay should pull the projection below the naive sum: ${projected} vs ${naive}`);
    assert(
      pacing.computeProducerDelayMs(naive, TARGET) > pacing.computeProducerDelayMs(projected, TARGET),
      'the naive sum should brake harder than the decayed projection'
    );
    assert(
      pacing.computeProducerDelayMs(projected, TARGET) <= 2,
      `a queue near target should barely brake, got ${pacing.computeProducerDelayMs(projected, TARGET)}ms`
    );
  });

  it('should hold its estimate when readings stop arriving', () => {
    // If feedback dies, the emulator keeps producing at roughly real time, so
    // what it sent and what drained cancel and the projection holds the last
    // known depth rather than drifting to either extreme.
    const projected = pacing.projectQueuedSeconds({
      queuedSecondsAtReading: 0.028,
      secondsSentSinceReading: 2,
      elapsedSeconds: 2
    });

    assert(Math.abs(projected - 0.028) < 1e-9, `expected the anchor to hold, got ${projected}`);
  });
});
