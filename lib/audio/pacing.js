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

export const DEFAULT_TARGET_LATENCY_SECONDS = 0.026;

// How much queue the relayed path gets on top of the requested target. Blocks
// reach the worklet via the main thread there, so they arrive as late as the
// main thread is busy, and only buffer depth absorbs that. Rate control cannot:
// it corrects the average, and this is variance.
export const RELAYED_PATH_EXTRA_LATENCY_SECONDS = 0.022;

export function getEffectiveTargetLatencySeconds(targetLatencySeconds, isDirectOutput) {
  const target = targetLatencySeconds > 0 ? targetLatencySeconds : DEFAULT_TARGET_LATENCY_SECONDS;
  return isDirectOutput ? target : target + RELAYED_PATH_EXTRA_LATENCY_SECONDS;
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
