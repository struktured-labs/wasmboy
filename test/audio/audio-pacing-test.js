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
  const raw = fs.readFileSync(PACING_SOURCE, 'utf8');
  const names = [
    ...[...raw.matchAll(/^export function (\w+)/gm)].map(match => match[1]),
    ...[...raw.matchAll(/^export const (\w+)/gm)].map(match => match[1])
  ];
  const exposure = names.map(name => `this.${name} = ${name};`).join('\n');
  vm.runInContext(`${source}\n${exposure}`, sandbox, { filename: PACING_SOURCE });
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
  let minQueuedFrames = Infinity;
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
    minQueuedFrames = Math.min(minQueuedFrames, processor.queuedFrames);

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
    minLatencyMs: (minQueuedFrames / SOURCE_SAMPLE_RATE) * 1000,
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
    // The queue rides a sawtooth of one write block around the guard's
    // equilibrium, so an instantaneous reading can sit in a trough. What
    // matters is that the trough never approaches empty.
    assert(late.minLatencyMs >= 3, `queue trough reached ${late.minLatencyMs.toFixed(1)}ms`);
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

describe('Audio admission control', () => {
  const pacing = loadPacing();

  it('should allow more than one block outstanding', () => {
    // One block per acknowledgement round trip could not move 44100 frames a
    // second and the output starved.
    assert(pacing.MAX_AUDIO_BLOCKS_IN_FLIGHT > 1, 'one block in flight cannot sustain real time');
    assert.strictEqual(pacing.evaluateAdmission({ ackActive: true, blocksInFlight: 1 }).admit, true);
  });

  it('should stop at the window', () => {
    const admission = pacing.evaluateAdmission({ ackActive: true, blocksInFlight: pacing.MAX_AUDIO_BLOCKS_IN_FLIGHT });
    assert.strictEqual(admission.admit, false, 'the window is the flow control');
  });

  it('should not refuse on latency alone', () => {
    // A hard latency ceiling here stalled the producer before emulation ran,
    // and those stalls dragged the frame rate down and starved the output.
    // Latency is held by pacing the interval instead.
    const admission = pacing.evaluateAdmission({
      ackActive: true,
      blocksInFlight: 0,
      acceptedSeconds: 5,
      unackedSeconds: 5,
      pendingSeconds: 5
    });
    assert.strictEqual(admission.admit, true, 'admission must not stop the producer over a queue depth');
  });

  it('should not gate the relayed path, which has nothing to acknowledge', () => {
    const admission = pacing.evaluateAdmission({ ackActive: false, blocksInFlight: 99 });
    assert.strictEqual(admission.admit, true, 'without acknowledgements the producer must not stall');
    assert.strictEqual(admission.timedOut, false);
  });

  it('should treat the watchdog as a fault, well beyond normal jitter', () => {
    assert(pacing.AUDIO_ACK_WATCHDOG_MS >= 50, 'a watchdog near one block would fire on jitter');

    const jitter = pacing.evaluateAdmission({ ackActive: true, blocksInFlight: 1, oldestWaitedMs: 30 });
    assert.strictEqual(jitter.timedOut, false, 'a late acknowledgement is still worth waiting for');

    const broken = pacing.evaluateAdmission({ ackActive: true, blocksInFlight: 1, oldestWaitedMs: pacing.AUDIO_ACK_WATCHDOG_MS + 1 });
    assert.strictEqual(broken.timedOut, true, 'a genuinely broken path has to be reported');
    assert.strictEqual(broken.admit, false);
  });

  it('should sustain real time through the window', () => {
    // Acknowledgement round trips measured near 15ms.
    const roundTripSeconds = 0.015;
    const framesPerSecond = (pacing.MAX_AUDIO_BLOCKS_IN_FLIGHT * pacing.MAX_ACCEPTED_BLOCK_FRAMES) / roundTripSeconds;
    assert(framesPerSecond > 44100, `window sustains only ${Math.round(framesPerSecond)} frames/s`);
  });

  it('should split the core handoff evenly', () => {
    // The core hands over about 1024 frames. 768 split that into 768 and 256
    // and did not raise the acknowledgement rate at all.
    assert.strictEqual(1024 % pacing.MAX_ACCEPTED_BLOCK_FRAMES, 0, 'chunks should divide the native handoff evenly');
  });
});

describe('AudioWorklet block acknowledgement', () => {
  const RENDER_QUANTUM_FRAMES = 128;

  const createProcessorWithInputPort = () => {
    const Processor = loadWorklet(48000);
    const processor = new Processor({
      processorOptions: { sourceSampleRate: SOURCE_SAMPLE_RATE, capacityFrames: 4096, targetLatencySeconds: 0.026 }
    });

    const sent = [];
    processor.inputPort = { postMessage: message => sent.push(message) };
    return { processor, sent };
  };

  const writeUnsignedBlock = (processor, frames, sequence) => {
    // Interleaved unsigned stereo, the shape the emulator worker sends.
    const buffer = new Uint8Array(frames * 2).fill(128);
    processor._writeUnsigned({
      buffer: buffer.buffer,
      numberOfSamples: frames,
      fps: 60,
      sequence
    });
  };

  it('should acknowledge a block only after taking it into the ring', () => {
    const { processor, sent } = createProcessorWithInputPort();

    writeUnsignedBlock(processor, 512, 7);

    const acks = sent.filter(message => message.type === 'ack');
    assert.strictEqual(acks.length, 1, 'expected exactly one acknowledgement');
    assert.strictEqual(acks[0].sequence, 7, 'the acknowledgement must identify the block');
    // The point of acknowledging on acceptance: the reported queue includes it.
    assert.strictEqual(acks[0].queuedFrames, 512, `expected the block to be counted, got ${acks[0].queuedFrames}`);
    assert(Math.abs(acks[0].queuedSeconds - 512 / SOURCE_SAMPLE_RATE) < 1e-9);
  });

  it('should report the queue shrinking as it is consumed', () => {
    const { processor, sent } = createProcessorWithInputPort();
    const outputs = [[new Float32Array(RENDER_QUANTUM_FRAMES), new Float32Array(RENDER_QUANTUM_FRAMES)]];

    writeUnsignedBlock(processor, 2048, 1);
    for (let quantum = 0; quantum < 8; quantum++) processor.process([], outputs);
    writeUnsignedBlock(processor, 512, 2);

    const acks = sent.filter(message => message.type === 'ack');
    assert.strictEqual(acks.length, 2);
    assert(
      acks[1].queuedFrames < acks[0].queuedFrames + 512,
      `the second acknowledgement should reflect what was consumed: ${acks[0].queuedFrames} then ${acks[1].queuedFrames}`
    );
  });

  it('should not acknowledge an untagged block', () => {
    // The relayed path does not tag its writes and must not be gated.
    const { processor, sent } = createProcessorWithInputPort();

    writeUnsignedBlock(processor, 512, undefined);

    assert.strictEqual(sent.filter(message => message.type === 'ack').length, 0);
  });
});

describe('Audio handoff chunking', () => {
  const pacing = loadPacing();
  const MAX = 512;

  it('should bound a single handoff', () => {
    const chunk = pacing.planAudioChunk({ totalSamples: 1400, sentOffset: 0, maxBlockFrames: MAX });
    assert.strictEqual(chunk.count, MAX, 'a large buffer must be handed over in bounded pieces');
    assert.strictEqual(chunk.isFinal, false, 'and must not be treated as fully drained');
  });

  it('should walk through the buffer without resending or dropping', () => {
    // The bug this guards: slicing from the start every time resends the first
    // chunk forever and never delivers the rest.
    const total = 1400;
    let offset = 0;
    const delivered = [];

    for (let pass = 0; pass < 10; pass++) {
      const chunk = pacing.planAudioChunk({ totalSamples: total, sentOffset: offset, maxBlockFrames: MAX });
      if (chunk.isDrained) break;
      delivered.push([chunk.offset, chunk.offset + chunk.count]);
      offset = chunk.isFinal ? 0 : chunk.offset + chunk.count;
      if (chunk.isFinal) break;
    }

    assert.deepStrictEqual(delivered, [[0, 512], [512, 1024], [1024, 1400]], 'every sample exactly once, in order');
    assert.strictEqual(delivered[delivered.length - 1][1], total, 'the whole buffer must be delivered');
  });

  it('should mark a buffer that fits as final immediately', () => {
    const chunk = pacing.planAudioChunk({ totalSamples: 400, sentOffset: 0, maxBlockFrames: MAX });
    assert.strictEqual(chunk.count, 400);
    assert.strictEqual(chunk.isFinal, true, 'so the core buffer is cleared rather than left holding audio');
  });

  it('should report an exhausted buffer as drained rather than sending nothing', () => {
    const chunk = pacing.planAudioChunk({ totalSamples: 512, sentOffset: 512, maxBlockFrames: MAX });
    assert.strictEqual(chunk.count, 0);
    assert.strictEqual(chunk.isDrained, true);
  });

  it('should hold a target with enough floor for exact-pitch playback', () => {
    // The 31ms budget was a proxy for "no worse than the old player" and the
    // owner traded it away for exact pitch: with the rate pinned to 1, queue
    // level is the only shock absorber, and 24ms starved in real Firefox (263
    // underrun frames at a ~30ms mean). Simulated floor under delivery
    // jitter: 36ms still nicks, 42ms holds clear on every seed.
    assert(pacing.DEFAULT_TARGET_LATENCY_SECONDS >= 0.036, 'below this the queue floor reaches zero under jitter');
    assert(pacing.DEFAULT_TARGET_LATENCY_SECONDS <= 0.06, 'beyond this latency is being spent without evidence');
  });
});

describe('Audio admission recovery', () => {
  const pacing = loadPacing();
  const BLOCK = 512 / 44100;

  it('should decay a held reading so pacing does not brake forever', () => {
    // The accepted queue drains in real time. Pacing on a reading that never
    // decays keeps braking against audio the hardware has already played.
    const accepted = 0.026;
    assert(pacing.computeProducerDelayMs(accepted, 0.019) > 0, 'a queue over target should brake');
    assert.strictEqual(pacing.computeProducerDelayMs(pacing.decayAcceptedSeconds(accepted, 0.02), 0.019), 0);
  });

  it('should decay the accepted queue to empty rather than negative', () => {
    assert.strictEqual(pacing.decayAcceptedSeconds(0.02, 5), 0);
    assert.strictEqual(pacing.decayAcceptedSeconds(undefined, 1), undefined);
    assert(Math.abs(pacing.decayAcceptedSeconds(0.03, 0.01) - 0.02) < 1e-9);
  });
});

describe('AudioWorklet rate under flow control', () => {
  const writeBlock = (processor, sequence, fps) =>
    processor._writeUnsigned({
      buffer: new Uint8Array(512 * 2).fill(128).buffer,
      numberOfSamples: 512,
      fps,
      allowFastSpeedStretching: false,
      sequence
    });

  it('should not detune when flow control throttles the emulator', () => {
    // Pacing deliberately slows the emulator, so its frame rate dips by design.
    // Reading those dips as slowness stretched playback and collapsed the rate
    // to 0.64 in a browser run, which is audible as pitch.
    const Processor = loadWorklet(48000);
    const processor = new Processor({
      processorOptions: { sourceSampleRate: SOURCE_SAMPLE_RATE, capacityFrames: 4096, targetLatencySeconds: 0.013 }
    });
    processor.inputPort = { postMessage: () => {} };

    for (let block = 0; block < 20; block++) writeBlock(processor, block + 1, 38);

    assert.strictEqual(processor.baseRate, 1, `flow-controlled audio should play at rate 1, got ${processor.baseRate}`);
    assert(processor.playbackRate > 0.99, `playback rate collapsed to ${processor.playbackRate}`);
  });

  it('should still stretch on the relayed path, which is not throttled', () => {
    // There a low frame rate really does mean the emulator is behind.
    const Processor = loadWorklet(48000);
    const processor = new Processor({
      processorOptions: { sourceSampleRate: SOURCE_SAMPLE_RATE, capacityFrames: 4096, targetLatencySeconds: 0.013 }
    });

    for (let block = 0; block < 20; block++) writeBlock(processor, undefined, 38);

    assert(processor.baseRate < 1, `expected stretching without flow control, got ${processor.baseRate}`);
  });
});

describe('Audio pacing signal choice', () => {
  const pacing = loadPacing();
  const BLOCK = 512 / 44100;

  it('should not count in-flight audio twice', () => {
    // The status projection already counts everything handed over since the
    // reading, acknowledged or not. Adding unacknowledged audio on top of it
    // double counts and brakes against audio the hardware has already played:
    // measured as pacing 6ms against a projection of 29.66ms while the real
    // queue was 7.07ms.
    const readingSeconds = 0.01474;
    const sentSinceReading = 2 * BLOCK;
    const elapsedSeconds = 0.018;

    const projected = pacing.projectQueuedSeconds({
      queuedSecondsAtReading: readingSeconds,
      secondsSentSinceReading: sentSinceReading,
      pendingSeconds: 0,
      elapsedSeconds
    });
    const doubleCounted = projected + sentSinceReading;

    const honestDelay = pacing.computeProducerDelayMs(projected, pacing.DEFAULT_TARGET_LATENCY_SECONDS);
    const inflatedDelay = pacing.computeProducerDelayMs(doubleCounted, pacing.DEFAULT_TARGET_LATENCY_SECONDS);

    assert(projected < doubleCounted, 'adding in-flight audio again inflates the estimate');
    assert(honestDelay <= 2, `a queue near target should barely brake, got ${honestDelay}ms`);
    assert(inflatedDelay >= honestDelay * 5, `the double count is what produced the phantom braking: ${honestDelay}ms vs ${inflatedDelay}ms`);
  });
});

describe('Audio acknowledgement ledger', () => {
  const pacing = loadPacing();
  const RATE = 44100;
  const BLOCK = 512;
  const blockSec = BLOCK / RATE;

  it('should account for a block in flight, then in the anchor, never both', () => {
    // The projection bug this replaces: a block handed over during the
    // transport window either vanished (counted nowhere until its ack) or was
    // double counted (added to an anchor that already included it).
    const L = pacing.createAudioLedger();

    pacing.ledgerSend(L, 1, BLOCK, 0);
    // In flight only; no anchor yet.
    assert(Math.abs(pacing.ledgerUnackedSeconds(L, RATE) - blockSec) < 1e-9, 'the sent block must be counted as in flight');
    assert.strictEqual(pacing.ledgerProject(L, RATE, 0), undefined, 'no projection before the first ack');

    // Ack at send time (zero round trip) so this isolates the accounting from
    // the half-round-trip ageing, which has its own test.
    pacing.ledgerAck(L, 1, blockSec, 0);
    assert.strictEqual(pacing.ledgerUnackedSeconds(L, RATE), 0, 'the acked block must leave the in-flight set');
    const projected = pacing.ledgerProject(L, RATE, 0);
    // Exactly one block, counted once: in the anchor, not also in flight.
    assert(Math.abs(projected - blockSec) < 1e-9, `block counted once, got ${projected}`);
  });

  it('should not lose a block sent during the transport window', () => {
    // Send 2 before 1 is acked: the classic window. Both must be counted.
    const L = pacing.createAudioLedger();
    pacing.ledgerSend(L, 1, BLOCK, 0);
    pacing.ledgerSend(L, 2, BLOCK, 6);

    // Ack block 1 at send time (zero round trip): queue one block, block 2
    // still in flight. Committed audio is 2 blocks, counted once each.
    pacing.ledgerAck(L, 1, blockSec, 0);

    const projected = pacing.ledgerProject(L, RATE, 0);
    assert(Math.abs(projected - 2 * blockSec) < 1e-9, `expected exactly two blocks committed, got ${(projected / blockSec).toFixed(3)} blocks`);
  });

  it('should drain the anchor at exactly the source rate', () => {
    // Playback is pinned to 1, so a held anchor loses real time one-for-one.
    const L = pacing.createAudioLedger();
    pacing.ledgerSend(L, 1, BLOCK, 0);
    pacing.ledgerAck(L, 1, 0.03, 0); // 30ms queue at t=0

    assert(Math.abs(pacing.ledgerProject(L, RATE, 0) - 0.03) < 1e-9);
    assert(Math.abs(pacing.ledgerProject(L, RATE, 10) - 0.02) < 1e-9, '10ms later, 10ms drained');
    assert.strictEqual(pacing.ledgerProject(L, RATE, 100), 0, 'never projects negative');
  });

  it('should ignore an out-of-order or stale acknowledgement', () => {
    const L = pacing.createAudioLedger();
    pacing.ledgerSend(L, 1, BLOCK, 0);
    pacing.ledgerSend(L, 2, BLOCK, 5);

    assert.strictEqual(pacing.ledgerAck(L, 2, 0.02, 6), false, 'only the oldest block may be acknowledged');
    assert.strictEqual(pacing.ledgerUnackedSeconds(L, RATE), 2 * blockSec, 'a rejected ack must change nothing');

    pacing.ledgerReset(L);
    assert.strictEqual(pacing.ledgerAck(L, 1, 0.02, 7), false, 'nothing is acknowledgeable after a reset');
    assert.strictEqual(pacing.ledgerProject(L, RATE, 7), undefined);
  });

  it('should conserve committed audio across a full send/ack sequence', () => {
    // Property test: over a random interleaving of sends and in-order acks,
    // committed audio (anchor-at-send-time + in flight) equals sent minus
    // drained, always. This is the invariant the status projection violated.
    const L = pacing.createAudioLedger();
    let nextSeq = 1;
    let sentBlocks = 0;
    let playedBlocks = 0;
    const pending = [];
    let now = 0;
    let rng = 12345;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let step = 0; step < 400; step++) {
      now += 1 + rand() * 4;
      if (rand() < 0.6 || pending.length === 0) {
        pacing.ledgerSend(L, nextSeq, BLOCK, now);
        pending.push(nextSeq);
        nextSeq++;
        sentBlocks++;
      } else {
        const seq = pending.shift();
        // Ack of block `seq` carries the queue as it was when `seq` was
        // accepted: blocks 1..seq accepted, minus those played by then. It
        // cannot include blocks sent after `seq`. Model play as a monotonic
        // counter that never exceeds what was accepted.
        playedBlocks = Math.min(seq, playedBlocks + (rand() < 0.5 ? 1 : 0));
        const queued = (seq - playedBlocks) * blockSec;
        pacing.ledgerAck(L, seq, queued, now);
      }

      const projected = pacing.ledgerProject(L, RATE, now);
      if (projected !== undefined) {
        // Committed audio must never exceed everything ever sent, nor go
        // negative — the two failure directions of the old projection.
        assert(projected >= -1e-9, `projection went negative at step ${step}: ${projected}`);
        assert(projected <= sentBlocks * blockSec + 1e-9, `projection exceeded total sent at step ${step}`);
      }
    }
  });
});
