// The acknowledgement ledger: exact accounting of committed audio.
//
// The status projection it replaces had two measured failures in real Firefox:
// blocks handed over during a status's transport window vanished from the
// accounting (20ms under-read, queue grew to 52ms unbraked), and later the
// bias flipped (3.7ms over-read while underruns accrued). Both are variance,
// and variance in the pacing signal spends queue headroom.
//
// The ledger's claim is structural: every block lives in exactly one place —
// in flight until its acknowledgement arrives, then inside the anchor, because
// the acknowledgement carries the queue with that block included. These tests
// prove the claim over adversarial schedules, then measure what the tighter
// signal buys at 24/32/42ms targets under delivery jitter.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PACING = path.resolve(__dirname, '../../lib/audio/pacing.js');
const WORKLET = path.resolve(__dirname, '../../lib/audio/worklet/audio.worklet.js');

const SRC_RATE = 44100;
const BLOCK = 512;
const BLOCK_SECONDS = BLOCK / SRC_RATE;

const load = (file, extraGlobals) => {
  const sandbox = Object.assign({ Math, Float32Array, Uint8Array }, extraGlobals || {});
  vm.createContext(sandbox);
  const source = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  const names = [
    ...[...fs.readFileSync(file, 'utf8').matchAll(/^export function (\w+)/gm)].map(m => m[1]),
    ...[...fs.readFileSync(file, 'utf8').matchAll(/^export const (\w+)/gm)].map(m => m[1])
  ];
  vm.runInContext(`${source}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, sandbox, { filename: file });
  return sandbox;
};

const pacing = load(PACING);

// A reference world the ledger is checked against: true queue drains in real
// time, blocks land after a transport delay, acknowledgements return after
// another delay carrying the true post-write queue.
const createWorld = () => {
  const world = {
    now: 0,
    trueQueue: 0,
    lastDrainAt: 0,
    pendingArrivals: [],
    pendingAcks: [],
    ledger: pacing.createAudioLedger()
  };

  const drain = () => {
    world.trueQueue = Math.max(0, world.trueQueue - (world.now - world.lastDrainAt) / 1000);
    world.lastDrainAt = world.now;
  };

  return {
    ledger: world.ledger,
    advanceTo(t) {
      while (true) {
        const nextArrival = world.pendingArrivals[0];
        const nextAck = world.pendingAcks[0];
        const nextAt = Math.min(nextArrival ? nextArrival.at : Infinity, nextAck ? nextAck.at : Infinity, t);
        world.now = nextAt;
        drain();
        if (nextArrival && nextArrival.at === nextAt && nextAt < Infinity) {
          world.pendingArrivals.shift();
          world.trueQueue += BLOCK_SECONDS;
          world.pendingAcks.push({ at: nextAt + nextArrival.ackDelay, sequence: nextArrival.sequence, queued: world.trueQueue });
          world.pendingAcks.sort((a, b) => a.at - b.at);
          continue;
        }
        if (nextAck && nextAck.at === nextAt && nextAt < Infinity) {
          world.pendingAcks.shift();
          pacing.ledgerAck(world.ledger, nextAck.sequence, nextAck.queued, nextAck.at * 1000);
          continue;
        }
        break;
      }
      world.now = t;
      drain();
    },
    send(sequence, transportDelay, ackDelay) {
      pacing.ledgerSend(world.ledger, sequence, BLOCK, world.now * 1000);
      world.pendingArrivals.push({ at: world.now + transportDelay, sequence, ackDelay });
      world.pendingArrivals.sort((a, b) => a.at - b.at);
    },
    trueQueueSeconds: () => world.trueQueue,
    project: () => pacing.ledgerProject(world.ledger, SRC_RATE, world.now * 1000)
  };
};

describe('Acknowledgement ledger accounting', () => {
  it('should account a block sent during another block\'s transport window exactly once', () => {
    // The schedule that broke the status projection: block 2 leaves while
    // block 1 is still in transit, and block 1's acknowledgement arrives with
    // both outstanding. The counter-zeroing design lost block 2 here.
    const w = createWorld();
    w.advanceTo(0.001);
    w.send(1, 0.004, 0.004);
    w.advanceTo(0.003);
    w.send(2, 0.004, 0.004); // inside block 1's transport window
    w.advanceTo(0.009); // block 1 acked at t=0.009; block 2 arrived at 0.007

    const projected = w.project();
    const truth = w.trueQueueSeconds();
    // The projection counts block 2