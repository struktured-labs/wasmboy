// Integration test for the audio pacing feedback loop.
//
// The unit tests prove the ledger's arithmetic in isolation. This wires the
// real worklet processor to the real ledger through a message transport and
// asserts the property that actually matters end to end, and that a released
// build violated: the producer's estimate of committed audio must track the
// worklet's true state within the transport lag.
//
// "Committed audio" is what the producer has sent that the hardware has not yet
// played: the worklet's real queue plus everything in transit toward it. If the
// producer's estimate drifts below that by more than a round trip, it stops
// applying backpressure and the queue overflows or the pitch bends to drain it;
// if it drifts above, it brakes against audio already gone and starves. The
// status projection this replaced drifted the low way by 20ms in a real
// browser. The ledger must not, at any jitter.
//
// The test is jitter-agnostic on purpose, and its scope is deliberately
// limited. A Node model cannot reproduce Firefox's scheduler — proven three
// ways while building this: the model cannot reproduce the known-good real
// 42ms result, and both a correct status projection and even a deliberately
// broken one pass the tracking bound here because the two-block credit window
// keeps too little audio outstanding for the error to grow. So this does NOT
// certify the browser's audible behaviour, and does not prove the ledger
// superior to a correct projection. It is a REGRESSION GUARD: it wires the real
// worklet to the real pacing loop and fails if a future change breaks the
// tracking relationship grossly, across a sweep of transport delays. The
// audible property is certified only by the real-browser gate.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_RATE = 44100;
const BLOCK = 512;
const RENDER_QUANTUM = 128;

const loadModule = relativePath => {
  const file = path.resolve(__dirname, relativePath);
  const sandbox = { Math, Boolean };
  vm.createContext(sandbox);
  const source = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  const names = [
    ...[...fs.readFileSync(file, 'utf8').matchAll(/^export function (\w+)/gm)].map(m => m[1]),
    ...[...fs.readFileSync(file, 'utf8').matchAll(/^export const (\w+)/gm)].map(m => m[1])
  ];
  vm.runInContext(`${source}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, sandbox, { filename: file });
  return sandbox;
};

const loadWorklet = contextRate => {
  const file = path.resolve(__dirname, '../../lib/audio/worklet/audio.worklet.js');
  let registered;
  const sandbox = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: () => {}, onmessage: undefined };
      }
    },
    registerProcessor: (n, c) => {
      registered = c;
    },
    sampleRate: contextRate,
    Float32Array,
    Uint8Array,
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return registered;
};

const pacing = loadModule('../../lib/audio/pacing.js');

// A one-directional FIFO pipe with a per-item delay. Real MessagePort delivery
// is ordered, so an item never arrives before one sent earlier.
const makePipe = () => {
  const items = [];
  return {
    send(payload, nowMs, delayMs) {
      const arriveAt = Math.max(items.length ? items[items.length - 1].arriveAt : nowMs, nowMs + delayMs);
      items.push({ payload, arriveAt });
    },
    drain(nowMs, deliver) {
      while (items.length && items[0].arriveAt <= nowMs) deliver(items.shift().payload);
    }
  };
};

// Drive the real worklet + real ledger through pipes with a given delay model,
// sampling the tracking error at every render quantum.
const runLoop = ({ contextRate, delayModel, seconds, seed }) => {
  const Processor = loadWorklet(contextRate);
  const processor = new Processor({
    processorOptions: { sourceSampleRate: SRC_RATE, capacityFrames: 8192, targetLatencySeconds: 0.042 }
  });
  const outputs = [[new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]];

  const ledger = pacing.createAudioLedger();
  const toWorklet = makePipe();
  const fromWorklet = makePipe();

  const quantumMs = (RENDER_QUANTUM / contextRate) * 1000;
  const blockMs = (BLOCK / SRC_RATE) * 1000;

  let rng = seed >>> 0;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 0x100000000);

  let nowMs = 0;
  let nextSendMs = 0;
  let sequence = 0;
  let framesInTransit = 0; // toward the worklet, not yet accepted
  let worstError = 0;

  const endMs = seconds * 1000;
  while (nowMs < endMs) {
    // Producer: pace on the ledger's projection, one block per round.
    const projected = pacing.ledgerProject(ledger, SRC_RATE, nowMs);
    const delayMs = projected === undefined ? 0 : pacing.computeProducerDelayMs(projected / 1, 0.042);
    if (nowMs >= nextSendMs && ledger.inFlight.length < pacing.MAX_AUDIO_BLOCKS_IN_FLIGHT) {
      sequence++;
      pacing.ledgerSend(ledger, sequence, BLOCK, nowMs);
      framesInTransit += BLOCK;
      toWorklet.send({ sequence, frames: BLOCK }, nowMs, delayModel(rand));
      nextSendMs = nowMs + blockMs + delayMs;
    }

    // Worklet accepts blocks (FIFO) and acks each on acceptance.
    toWorklet.drain(nowMs, ({ sequence: seq, frames }) => {
      const buffer = new Uint8Array(frames * 2).fill(129);
      processor._writeUnsigned({ buffer: buffer.buffer, numberOfSamples: frames, fps: 60, sequence: seq });
      framesInTransit -= frames;
      fromWorklet.send({ sequence: seq, queuedSeconds: processor.queuedFrames / SRC_RATE }, nowMs, delayModel(rand));
    });

    // Producer receives acks (FIFO).
    fromWorklet.drain(nowMs, ({ sequence: seq, queuedSeconds }) => {
      pacing.ledgerAck(ledger, seq, queuedSeconds, nowMs);
    });

    processor.process([], outputs);
    nowMs += quantumMs;

    // Truth the producer cannot see directly: the worklet's real queue plus
    // every block still on the wire toward it. That is exactly what the
    // producer's projection is trying to estimate.
    const trueSeconds = processor.queuedFrames / SRC_RATE + framesInTransit / SRC_RATE;

    const estimate = pacing.ledgerProject(ledger, SRC_RATE, nowMs);
    if (estimate !== undefined && nowMs > 500) {
      worstError = Math.max(worstError, Math.abs(estimate - trueSeconds));
    }
  }
  return { worstErrorMs: worstError * 1000 };
};

describe('Audio pacing loop tracking', function() {
  this.timeout(60000);

  // The tracking bound: the estimate may lag the truth by the audio in flight
  // plus one round trip of drain, and no more. Everything past that is the
  // estimator being wrong rather than merely late.
  const boundMs = delayMs => 2 * (BLOCK / SRC_RATE) * 1000 + 2 * delayMs + 5;

  const delays = [
    { name: 'zero delay', model: () => 0, ms: 0 },
    { name: 'fixed 8ms', model: () => 8, ms: 8 },
    { name: 'fixed 20ms', model: () => 20, ms: 20 },
    { name: 'jittery 0-15ms', model: rand => rand() * 15, ms: 15 },
    { name: 'bursty 5ms + 40ms spikes', model: rand => (rand() < 0.1 ? 40 : 5), ms: 40 },
    { name: 'adversarial 0-60ms', model: rand => rand() * 60, ms: 60 }
  ];

  delays.forEach(delay => {
    it(`should track the true queue within the transport bound under ${delay.name}`, () => {
      let worst = 0;
      for (const seed of [1, 7, 23, 101]) {
        const { worstErrorMs } = runLoop({ contextRate: 48000, delayModel: delay.model, seconds: 20, seed });
        worst = Math.max(worst, worstErrorMs);
      }
      const bound = boundMs(delay.ms);
      assert(worst <= bound, `tracking error ${worst.toFixed(1)}ms exceeded the ${bound.toFixed(1)}ms transport bound`);
    });
  });

  it('should hold the bound at a native-rate context too', () => {
    // The deployed configuration: 44.1kHz context, playback pinned to 1.
    let worst = 0;
    for (const seed of [3, 31]) {
      const { worstErrorMs } = runLoop({ contextRate: 44100, delayModel: rand => rand() * 15, seconds: 20, seed });
      worst = Math.max(worst, worstErrorMs);
    }
    assert(worst <= boundMs(15), `tracking error ${worst.toFixed(1)}ms exceeded the bound at 44.1kHz`);
  });
});
