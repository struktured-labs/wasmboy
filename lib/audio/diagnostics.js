// Reporting for the audio output path.
//
// Latency measurement from outside the library kept coming back ambiguous:
// asking for direct output and getting it look the same as asking for it and
// silently falling back, and a queue that grows because the producer never
// hears about it looks the same as one that grows because the producer hears
// and cannot keep up. Those need opposite fixes, so they have to be
// distinguishable.
//
// This module imports nothing, so both the audio service and the worker
// message handler can use it without creating a cycle between them.

let producerLatencySeconds;
let producerPacingDelayMs;
let producerExtra = {};

// The emulator worker reports what it saw and what it did about it, once per
// frame. Undefined means it has not reported yet, which is itself the answer to
// "is backpressure reaching the producer".
export function setProducerPacing(latencySeconds, pacingDelayMs, extra) {
  producerLatencySeconds = latencySeconds;
  producerPacingDelayMs = pacingDelayMs;
  producerExtra = extra || {};
}

export function resetProducerPacing() {
  producerLatencySeconds = undefined;
  producerPacingDelayMs = undefined;
  producerExtra = {};
}

export function getProducerPacing() {
  return {
    latencySeconds: producerLatencySeconds,
    pacingDelayMs: producerPacingDelayMs,
    // What the producer actually paced against, how stale its anchor was, and
    // which reading it came from. A reading that is fresh but wrong and one
    // that is right but old need different fixes.
    projectedLatencySeconds: producerExtra.projectedLatencySeconds,
    readingAgeMs: producerExtra.readingAgeMs,
    readingSequence: producerExtra.readingSequence
  };
}

// Kept a pure function of its inputs so it can be tested without a browser.
// The previous version read fields that nothing ever assigned, and reported a
// confidently wrong answer rather than an obviously missing one.
export function buildAudioDiagnostics(state) {
  const { options, workletActive, directOutputActive, effectiveTargetLatencySeconds, workletStats, producer } = state || {};
  const config = options || {};

  return {
    workletActive: Boolean(workletActive),
    directOutputRequested: Boolean(config.audioWorkletDirectOutput),
    directOutputActive: Boolean(directOutputActive),
    // Direct output is refused while the debugger is on, which is the most
    // common reason for asking for it and not getting it.
    audioDebuggingEnabled: Boolean(config.enableAudioDebugging),
    requestedTargetLatencySeconds: config.audioTargetLatencyInSeconds,
    effectiveTargetLatencySeconds,
    producer: producer || { latencySeconds: undefined, pacingDelayMs: undefined },
    worklet: workletStats
  };
}
