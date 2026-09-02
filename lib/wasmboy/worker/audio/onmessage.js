import { postMessage, onMessage } from '../../../worker/workerapi';
import { getPerformanceTimestamp } from '../../../common/common';
import { WORKER_MESSAGE_TYPE } from '../../../worker/constants';
import { getEventData } from '../../../worker/util';
import { getSmartWorkerMessage } from '../../../worker/smartworker';

// Function to handler audio worker on message to the libWorker
export function audioWorkerOnMessage(libWorker, event) {
  // Handle our messages from the main thread
  const eventData = getEventData(event);

  switch (eventData.message.type) {
    case WORKER_MESSAGE_TYPE.GET_CONSTANTS: {
      libWorker.WASMBOY_SOUND_OUTPUT_LOCATION = libWorker.wasmInstance.exports.AUDIO_BUFFER_LOCATION.valueOf();
      libWorker.WASMBOY_CHANNEL_1_OUTPUT_LOCATION = libWorker.wasmInstance.exports.CHANNEL_1_BUFFER_LOCATION.valueOf();
      libWorker.WASMBOY_CHANNEL_2_OUTPUT_LOCATION = libWorker.wasmInstance.exports.CHANNEL_2_BUFFER_LOCATION.valueOf();
      libWorker.WASMBOY_CHANNEL_3_OUTPUT_LOCATION = libWorker.wasmInstance.exports.CHANNEL_3_BUFFER_LOCATION.valueOf();
      libWorker.WASMBOY_CHANNEL_4_OUTPUT_LOCATION = libWorker.wasmInstance.exports.CHANNEL_4_BUFFER_LOCATION.valueOf();

      // Forward to our lib worker
      libWorker.audioWorkerPort.postMessage(
        getSmartWorkerMessage(
          {
            type: WORKER_MESSAGE_TYPE.GET_CONSTANTS_DONE,
            WASMBOY_SOUND_OUTPUT_LOCATION: libWorker.wasmInstance.exports.AUDIO_BUFFER_LOCATION.valueOf()
          },
          eventData.messageId
        )
      );
      return;
    }

    case WORKER_MESSAGE_TYPE.AUDIO_ACK: {
      // Acceptance of a specific block. Anything that is not the block we are
      // waiting on is late, from before a watchdog reset, and describes a
      // queue that no longer exists.
      const inFlight = libWorker.audioInFlightBlocks || [];
      // Acknowledgements arrive in order, so anything that is not the oldest
      // outstanding block is from before a watchdog reset and describes a queue
      // that no longer exists. Matching loosely would drop the blocks it skipped.
      if (inFlight.length === 0 || inFlight[0].sequence !== eventData.message.sequence) {
        return;
      }

      libWorker.audioAckActive = true;
      libWorker.audioAcceptedQueuedSeconds = eventData.message.queuedSeconds;
      libWorker.audioAcceptedAt = getPerformanceTimestamp();
      libWorker.audioInFlightBlocks = inFlight.slice(1);
      libWorker.audioLastAckSequence = eventData.message.sequence;
      return;
    }

    case WORKER_MESSAGE_TYPE.AUDIO_LATENCY: {
      libWorker.currentAudioLatencyInSeconds = eventData.message.latency;

      // Readings arrive every few milliseconds at best and can arrive much
      // later than that. Pacing on the bare number means acting on a queue
      // that has moved on, so keep the reading as an anchor and track what has
      // happened since it was taken.
      const queuedSeconds = eventData.message.queuedSeconds;
      libWorker.audioQueuedSecondsAtReading = queuedSeconds !== undefined ? queuedSeconds : eventData.message.latency;
      libWorker.audioReadingSequence = eventData.message.sequence;
      libWorker.audioReadingTimestamp = getPerformanceTimestamp();
      libWorker.audioSecondsSentSinceReading = 0;
      return;
    }
  }
}
