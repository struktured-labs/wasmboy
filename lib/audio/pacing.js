// Producer-side pacing for the audio path.
//
// The emulator generates audio at whatever rate it runs; the audio hardware
// consumes at its own clock. Something has to reconcile them. Correcting on the
// consumer side means resampling, which is audible as pitch once the correction
// gets large, so the emulator is paced off the audio queue instead and the
// resampler is left as a fine trim.
//
// The queue depth is the whole signal: above target the emulator is ahead and
// should wait before handing over the next block, below target it should run.
// Braking proportionally to the overshoot converges on the target. Braking only
// once past a fixed ceiling, which is what this replaced, leaves the queue
// sitting at that ceiling, because nothing pulls it back down.

// Fraction of the overshoot to wait out per block. Below 1 so the queue is
// approached rather than overshot into an underrun.
export const PRODUCER_PACING_GAIN = 0.6;

// Never stall the emulator for more than about two frames: audio pacing must
// not visibly hitch video, and a longer wait is better spread over more blocks.
export const MAX_PRODUCER_DELAY_MS = 32;

// Held latency. The queue does not peak at target plus a whole block, because
// it drains while blocks are in flight: measured peaks sit a few milliseconds
// over target, and below this the output starves before the budget is reached.
// 24ms was the lowest value that ran two 30s browser gates with no underruns.
export const DEFAULT_TARGET_LATENCY_SECONDS = 0.024;

// Largest handoff the worklet accepts at once. The core hands over about 1024
// frames at a time, so 512 splits that into two blocks that can be in flight
// together; 768 split it unevenly into 768 and 256 and did not raise the
// acknowledgement rate at all.
export const MAX_ACCEPTED_BLOCK_FRAMES = 512;

// How much queue the relayed path gets on top of the requested target. Blocks
// reach the worklet via the main thread there, so they arrive as late as the
// main thread is busy, and only buffer depth absorbs that. Rate control cannot:
// it corrects the average, and this is variance.
export const RELAYED_PATH_EXTRA_LATENCY_SECONDS = 0.022;

export function getEffectiveTargetLatencySeconds(targetLatencySeconds, isDirectOutput) {
  const target = targetLatencySeconds > 0 ? targetLatencySeconds : DEFAULT_TARGET_LATENCY_SECONDS;
  return isDirectOutput ? target : target + RELAYED_PATH_EXTRA_LATENCY_SECONDS;
}

// One accepted handoff sets how far above target the queue can sit, so it is
// bounded. The remainder resumes from the offset; the caller clears the core
// buffer only on the final chunk.
export function planAudioChunk(state) {
  const { totalSamples, sentOffset, maxBlockFrames } = state || {};
  const offset = sentOffset || 0;
  const remaining = (totalSamples || 0) - offset;

  if (remaining <= 0) {
    return { offset, count: 0, isFinal: true, isDrained: true };
  }

  const count = Math.min(remaining, maxBlockFrames);
  return { offset, count, isFinal: offset + count >= totalSamples, isDrained: false };
}

// Delivery is ordered and reliable while both ports live, so a missing
// acknowledgement is a broken path, not lateness. Kept far longer than any
// pacing interval so jitter cannot trip it.
export const AUDIO_ACK_WATCHDOG_MS = 100;

// More than one block may be outstanding, because a single one in flight caps
// throughput at one chunk per acknowledgement round trip, which is below real
// time. What is bounded instead is the audio already committed: what the
// worklet has accepted plus what is on its way to it.
export const MAX_AUDIO_BLOCKS_IN_FLIGHT = 2;

// The accepted queue drains in real time. Held without decay it eventually
// blocks admission forever: nothing is admitted, so nothing is acknowledged, so
// the reading never changes.
export function decayAcceptedSeconds(acceptedSeconds, elapsedSeconds) {
  if (acceptedSeconds === undefined) {
    return undefined;
  }
  return Math.max(0, acceptedSeconds - Math.max(0, elapsedSeconds || 0));
}

// Only the window, deliberately. A hard latency ceiling here stalls the
// producer before emulation runs, and those stalls were long enough to drag the
// measured frame rate down and starve the output. Latency is held by pacing the
// interval between handoffs instead, which slows the producer without stopping
// it.
export function evaluateAdmission(state) {
  const { ackActive, blocksInFlight, oldestWaitedMs } = state || {};

  if (!ackActive) {
    return { admit: true, timedOut: false };
  }

  if ((blocksInFlight || 0) > 0 && (oldestWaitedMs || 0) >= AUDIO_ACK_WATCHDOG_MS) {
    return { admit: false, timedOut: true };
  }

  return { admit: (blocksInFlight || 0) < MAX_AUDIO_BLOCKS_IN_FLIGHT, timedOut: false };
}

// What is queued right now, as best the producer can know it.
//
// A status reading measures the past: it arrives every few milliseconds at
// best, and the emulator can hand over two blocks inside one video frame. The
// pacing decision also happens before the block being sent is added, so a
// burst is invisible to the control meant to restrain it. Anchor on the
// reading, add what has been sent since plus the block about to go, and
// subtract what the hardware drained meanwhile.
export function projectQueuedSeconds(reading) {
  const { queuedSecondsAtReading, secondsSentSinceReading, pendingSeconds, elapsedSeconds } = reading || {};
  if (queuedSecondsAtReading === undefined) {
    return undefined;
  }

  const projected = queuedSecondsAtReading + (secondsSentSinceReading || 0) + (pendingSeconds || 0) - Math.max(0, elapsedSeconds || 0);

  return Math.max(0, projected);
}

// Milliseconds the emulator should wait before handing over the next audio
// block, given how much audio is already queued ahead of the hardware.
export function computeProducerDelayMs(latencySeconds, targetLatencySeconds) {
  if (!(latencySeconds > 0)) {
    // No reading yet, or the queue is empty and needs filling either way.
    return 0;
  }

  const target = targetLatencySeconds > 0 ? targetLatencySeconds : DEFAULT_TARGET_LATENCY_SECONDS;
  const overshootSeconds = latencySeconds - target;
  if (overshootSeconds <= 0) {
    return 0;
  }

  const delayMs = overshootSeconds * 1000 * PRODUCER_PACING_GAIN;
  return Math.min(Math.round(delayMs), MAX_PRODUCER_DELAY_MS);
}
