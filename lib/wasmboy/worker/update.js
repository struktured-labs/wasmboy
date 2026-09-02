// Start our update and render process
// Can't time by raf, as raf is not garunteed to be 60fps
// Need to run like a web game, where updates to the state of the core are done a 60 fps
// but we can render whenever the user would actually see the changes browser side in a raf
// https://developer.mozilla.org/en-US/docs/Games/Anatomy

// Imports
import { postMessage } from '../../worker/workerapi';
import { getSmartWorkerMessage } from '../../worker/smartworker';
import { WORKER_MESSAGE_TYPE, MEMORY_TYPE } from '../../worker/constants';

// Memory
import { getCartridgeRam } from './memory/ram.js';
import { getGameBoyMemory } from './memory/gameboymemory.js';
import { getPaletteMemory } from './memory/palettememory.js';
import { getInternalState } from './memory/internalstate.js';

// Timestamps
import { getPerformanceTimestamp } from '../../common/common';
import { addTimeStamp, waitForTimeStampsForFrameRate } from './timestamp';

// Audio pacing control
import { computeProducerDelayMs, projectQueuedSeconds, DEFAULT_TARGET_LATENCY_SECONDS } from '../../audio/pacing';

// Transferring
import { transferGraphics } from './graphics/transfer';

const AUDIO_SAMPLE_RATE = 44100;

// What is queued right now, as best the producer can know it.
//
// A status reading is a measurement of the past: it arrives every few
// milliseconds at best, and the emulator can hand over two 512-sample blocks
// inside one video frame, so pacing on the bare reading acts on a queue that
// has already moved. Worse, the decision happens before the block being sent
// is added, so a burst is invisible to the very control meant to restrain it.
//
// Anchor on the reading, add everything sent since it was taken plus the block
// about to go, and subtract what the hardware has drained in the meantime.
const getProjectedAudioLatency = (libWorker, pendingSamples) => {
  if (libWorker.audioQueuedSecondsAtReading === undefined) {
    return libWorker.currentAudioLatencyInSeconds;
  }

  return projectQueuedSeconds({
    queuedSecondsAtReading: libWorker.audioQueuedSecondsAtReading,
    secondsSentSinceReading: libWorker.audioSecondsSentSinceReading,
    pendingSeconds: pendingSamples / AUDIO_SAMPLE_RATE,
    elapsedSeconds: (getPerformanceTimestamp() - libWorker.audioReadingTimestamp) / 1000
  });
};

const getTargetAudioLatency = libWorker => {
  const target = libWorker.options && libWorker.options.audioTargetLatencyInSeconds;
  return target > 0 ? target : DEFAULT_TARGET_LATENCY_SECONDS;
};
// Pass over samples once we have enough worth playing:
// https://www.reddit.com/r/EmuDev/comments/5gkwi5/gb_apu_sound_emulation/
const AUDIO_BUFFER_SIZE = 512;

// FPS measuring
let currentHighResTime;
let currentFps;
let gameboyFrameRateWithSpeed;

// interval to set timeout
let intervalRate;

function scheduleNextUpdate(libWorker) {
  // Get our high res time
  const highResTime = getPerformanceTimestamp();

  // Find how long it has been since the last timestamp
  const timeSinceLastTimestamp = highResTime - libWorker.fpsTimeStamps[libWorker.fpsTimeStamps.length - 1];

  // Get the next time we should update using our interval rate
  let nextUpdateTime = intervalRate - timeSinceLastTimestamp;
  if (nextUpdateTime < 0) {
    nextUpdateTime = 0;
  }

  // Lastly, increase by our lib worker speed
  if (libWorker.speed && libWorker.speed > 0) {
    nextUpdateTime = nextUpdateTime / libWorker.speed;
  }

  libWorker.updateId = setTimeout(() => {
    update(libWorker);
  }, Math.floor(nextUpdateTime));
}

// Function to run an update on the emulator itself
export function update(libWorker, passedIntervalRate) {
  // Don't run if paused
  if (libWorker.paused) {
    return true;
  }

  // Set the intervalRate if it was passed
  if (passedIntervalRate !== undefined) {
    intervalRate = passedIntervalRate;
  }

  // Set a timestamp for this moment
  // And make sure we are on track for FPS
  currentFps = libWorker.getFPS();
  gameboyFrameRateWithSpeed = libWorker.options.gameboyFrameRate + 1;

  if (libWorker.speed && libWorker.speed > 0) {
    gameboyFrameRateWithSpeed = gameboyFrameRateWithSpeed * libWorker.speed;
  }

  if (currentFps > gameboyFrameRateWithSpeed) {
    // Pop a timestamp off of the front
    // This is to avoid infinite loop here on loadstate
    libWorker.fpsTimeStamps.shift();
    scheduleNextUpdate(libWorker);
    return true;
  } else {
    currentHighResTime = addTimeStamp(libWorker);
  }

  // Check if we are outputting audio
  const shouldCheckAudio = !libWorker.options.headless && !libWorker.pauseFpsThrottle && libWorker.options.isAudioEnabled;

  // Execute
  // Wrapped in promise to better handle audio slowdowns and things of that sort
  const executePromise = new Promise(resolve => {
    // Update (Execute a frame)
    let response;
    if (shouldCheckAudio) {
      executeAndCheckAudio(libWorker, resolve);
    } else {
      response = libWorker.wasmInstance.exports.executeFrame();
      resolve(response);
    }
  });

  executePromise.then(response => {
    // Handle our update() response
    if (response >= 0) {
      // Pass messages to everyone
      postMessage(
        getSmartWorkerMessage({
          type: WORKER_MESSAGE_TYPE.UPDATED,
          fps: currentFps,
          audioLatencySeconds: libWorker.lastAudioLatencySeconds,
          audioProjectedLatencySeconds: libWorker.lastAudioProjectedLatencySeconds,
          audioReadingAgeMs: libWorker.lastAudioReadingAgeMs,
          audioReadingSequence: libWorker.audioReadingSequence,
          audioPacingDelayMs: libWorker.lastAudioPacingDelayMs
        })
      );

      // Check if we have frameskip
      let shouldSkipRenderingFrame = false;
      if (libWorker.options.frameSkip && libWorker.options.frameSkip > 0) {
        libWorker.frameSkipCounter++;

        if (libWorker.frameSkipCounter <= libWorker.options.frameSkip) {
          shouldSkipRenderingFrame = true;
        } else {
          libWorker.frameSkipCounter = 0;
        }
      }

      // Transfer Graphics
      if (!shouldSkipRenderingFrame) {
        transferGraphics(libWorker);
      }

      // Transfer Memory for things like save states
      const memoryObject = {
        type: WORKER_MESSAGE_TYPE.UPDATED
      };
      memoryObject[MEMORY_TYPE.CARTRIDGE_RAM] = getCartridgeRam(libWorker).buffer;
      memoryObject[MEMORY_TYPE.GAMEBOY_MEMORY] = getGameBoyMemory(libWorker).buffer;
      memoryObject[MEMORY_TYPE.PALETTE_MEMORY] = getPaletteMemory(libWorker).buffer;
      memoryObject[MEMORY_TYPE.INTERNAL_STATE] = getInternalState(libWorker).buffer;

      // Check for any undefined values
      Object.keys(memoryObject).forEach(key => {
        if (memoryObject[key] === undefined) {
          memoryObject[key] = new Uint8Array().buffer;
        }
      });

      libWorker.memoryWorkerPort.postMessage(getSmartWorkerMessage(memoryObject), [
        memoryObject[MEMORY_TYPE.CARTRIDGE_RAM],
        memoryObject[MEMORY_TYPE.GAMEBOY_MEMORY],
        memoryObject[MEMORY_TYPE.PALETTE_MEMORY],
        memoryObject[MEMORY_TYPE.INTERNAL_STATE]
      ]);

      // Check if we hit a breakpoint
      if (response === 2) {
        postMessage(
          getSmartWorkerMessage({
            type: WORKER_MESSAGE_TYPE.BREAKPOINT
          })
        );
      } else {
        scheduleNextUpdate(libWorker);
      }
    } else {
      postMessage(
        getSmartWorkerMessage({
          type: WORKER_MESSAGE_TYPE.CRASHED
        })
      );
      libWorker.paused = true;
    }
  });
}

// If audio is enabled, sync by audio
// Audio will pass us its forward latency, and if it is too far ahead,
// Then we can wait a little bit to let audio catch up
// 0.25 (quarter of a second), just felt right from testing :)
function executeAndCheckAudio(libWorker, resolve) {
  // Get our response
  let response = -1;
  response = libWorker.wasmInstance.exports.executeFrameAndCheckAudio(AUDIO_BUFFER_SIZE);

  // If our response is not 1, simply resolve
  if (response !== 1) {
    resolve(response);
  }

  // Do some audio magic
  if (response === 1) {
    // Get our audioQueueIndex
    const audioQueueIndex = libWorker.wasmInstance.exports.getNumberOfSamplesInAudioBuffer();

    // Pace off how much audio is already queued ahead of the hardware, so the
    // emulator is slaved to the audio clock rather than free-running with a
    // ceiling. Braking in proportion to the overshoot pulls the queue back to
    // the target; braking only past a ceiling parks it at that ceiling.
    const projectedLatency = getProjectedAudioLatency(libWorker, audioQueueIndex);
    const delayInMilli = computeProducerDelayMs(projectedLatency, getTargetAudioLatency(libWorker));

    // Recorded so getAudioDiagnostics can show what the producer acted on, how
    // old its reading was, and how far the projection had moved from it.
    // Backpressure that never arrives, backpressure that is stale, and
    // backpressure that is simply too weak all look alike from outside.
    libWorker.lastAudioLatencySeconds = libWorker.currentAudioLatencyInSeconds;
    libWorker.lastAudioProjectedLatencySeconds = projectedLatency;
    libWorker.lastAudioReadingAgeMs =
      libWorker.audioReadingTimestamp === undefined ? undefined : getPerformanceTimestamp() - libWorker.audioReadingTimestamp;
    libWorker.lastAudioPacingDelayMs = delayInMilli;

    if (delayInMilli > 0) {
      setTimeout(() => {
        sendAudio(libWorker, audioQueueIndex);
        waitForTimeStampsForFrameRate(libWorker);
        executeAndCheckAudio(libWorker, resolve);
      }, delayInMilli);
    } else {
      sendAudio(libWorker, audioQueueIndex);
      executeAndCheckAudio(libWorker, resolve);
    }
  }
}

function sendAudio(libWorker, audioQueueIndex) {
  // Count it against the anchor immediately, so a second block in the same
  // frame is paced knowing the first one went.
  libWorker.audioSecondsSentSinceReading = (libWorker.audioSecondsSentSinceReading || 0) + audioQueueIndex / AUDIO_SAMPLE_RATE;

  // Send out our audio
  // audioQueueIndex * 2, because audio Queue index represents 1 sample,
  // for left AND right channel. Therefore the end index is, twice
  // of the audioQueueIndex

  // Build our message bits
  const audioBuffer = libWorker.wasmByteMemory.slice(
    libWorker.WASMBOY_SOUND_OUTPUT_LOCATION,
    libWorker.WASMBOY_SOUND_OUTPUT_LOCATION + audioQueueIndex * 2
  ).buffer;
  const message = {
    type: WORKER_MESSAGE_TYPE.UPDATED,
    audioBuffer,
    numberOfSamples: audioQueueIndex,
    fps: currentFps,
    allowFastSpeedStretching: libWorker.options.gameboyFrameRate > 60
  };
  const messageTransferrables = [audioBuffer];

  // If audio debugging is enabled, we gotta send a lot more
  if (libWorker.options && libWorker.options.enableAudioDebugging) {
    // Channel 1
    const channel1Buffer = libWorker.wasmByteMemory.slice(
      libWorker.WASMBOY_CHANNEL_1_OUTPUT_LOCATION,
      libWorker.WASMBOY_CHANNEL_1_OUTPUT_LOCATION + audioQueueIndex * 2
    ).buffer;
    message.channel1Buffer = channel1Buffer;
    messageTransferrables.push(channel1Buffer);

    // Channel 2
    const channel2Buffer = libWorker.wasmByteMemory.slice(
      libWorker.WASMBOY_CHANNEL_2_OUTPUT_LOCATION,
      libWorker.WASMBOY_CHANNEL_2_OUTPUT_LOCATION + audioQueueIndex * 2
    ).buffer;
    message.channel2Buffer = channel2Buffer;
    messageTransferrables.push(channel2Buffer);

    // Channel 3
    const channel3Buffer = libWorker.wasmByteMemory.slice(
      libWorker.WASMBOY_CHANNEL_3_OUTPUT_LOCATION,
      libWorker.WASMBOY_CHANNEL_3_OUTPUT_LOCATION + audioQueueIndex * 2
    ).buffer;
    message.channel3Buffer = channel3Buffer;
    messageTransferrables.push(channel3Buffer);

    // Channel 4
    const channel4Buffer = libWorker.wasmByteMemory.slice(
      libWorker.WASMBOY_CHANNEL_4_OUTPUT_LOCATION,
      libWorker.WASMBOY_CHANNEL_4_OUTPUT_LOCATION + audioQueueIndex * 2
    ).buffer;
    message.channel4Buffer = channel4Buffer;
    messageTransferrables.push(channel4Buffer);
  }

  libWorker.audioWorkerPort.postMessage(getSmartWorkerMessage(message), messageTransferrables);
  libWorker.wasmInstance.exports.clearAudioBuffer();
}
