// Web worker for wasmboy lib
// Will be used for running wasm, and controlling child workers.

import { postMessage, onMessage } from '../../worker/workerapi';
import { getEventData } from '../../worker/util';
import { getSmartWorkerMessage } from '../../worker/smartworker';
import { WORKER_MESSAGE_TYPE } from '../../worker/constants';

// Convert our uint8 into a float sample
const getUnsignedAudioSampleAsFloat = audioSample => {
  // Silence is encoded as 129 (the core stores value + 1 around a 128 centre).
  // The old decode centred on 128, so true silence came out as +1/127 — the
  // 0.00787 the Pokemon Blue comment used to describe — and a gate was added
  // to hide it. The gate was crossover distortion on everything quiet. Decode
  // around the true centre and no gate is needed. Divided down because PCM is
  // loud.
  return (audioSample - 129) / 127 / 2.5;
};

const getAudioChannelBuffersFromBuffer = (audioBuffer, numberOfSamples) => {
  // Create our buffers as Float 32 Array
  // https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer/getChannelData
  // Number of samples divided by two, since we split into each channel
  const leftChannelBuffer = new Float32Array(numberOfSamples);
  const rightChannelBuffer = new Float32Array(numberOfSamples);

  // Our index on our left/right buffers
  let bufferIndex = 0;

  // Our total number of stereo samples
  let numberOfSamplesForStereo = numberOfSamples * 2;

  // Left Channel
  for (let i = 0; i < numberOfSamplesForStereo; i = i + 2) {
    leftChannelBuffer[bufferIndex] = getUnsignedAudioSampleAsFloat(audioBuffer[i]);
    bufferIndex++;
  }

  // Reset the buffer index
  bufferIndex = 0;

  // Right Channel
  for (let i = 1; i < numberOfSamplesForStereo; i = i + 2) {
    rightChannelBuffer[bufferIndex] = getUnsignedAudioSampleAsFloat(audioBuffer[i]);
    bufferIndex++;
  }

  return {
    left: leftChannelBuffer.buffer,
    right: rightChannelBuffer.buffer
  };
};

// Worker port for the lib
let libWorkerPort;
let audioOutputPort;

const audioOutputMessageHandler = event => {
  const message = event.data || event;
  // Status can arrive before the lib port is connected. Throwing here would
  // take the queue reading out of the loop for the rest of the run, and the
  // emulator would free-run with nothing telling it to slow down.
  if (message.type === 'ack' && libWorkerPort) {
    libWorkerPort.postMessage(
      getSmartWorkerMessage({
        type: WORKER_MESSAGE_TYPE.AUDIO_ACK,
        sequence: message.sequence,
        queuedSeconds: message.queuedSeconds,
        queuedFrames: message.queuedFrames
      })
    );
    return;
  }

  if (message.type === 'status' && libWorkerPort) {
    libWorkerPort.postMessage(
      getSmartWorkerMessage({
        type: WORKER_MESSAGE_TYPE.AUDIO_LATENCY,
        latency: message.latencySeconds,
        queuedSeconds: message.queuedSeconds,
        sequence: message.sequence
      })
    );
  }
};

const libMessageHandler = event => {
  const eventData = getEventData(event);

  // Handle update method transfrables
  if (!eventData.message) {
    return;
  }

  // Handle our messages from the lib thread
  switch (eventData.message.type) {
    case WORKER_MESSAGE_TYPE.GET_CONSTANTS_DONE: {
      postMessage(getSmartWorkerMessage(eventData.message, eventData.messageId));
      return;
    }

    case WORKER_MESSAGE_TYPE.UPDATED: {
      if (audioOutputPort && !eventData.message.channel1Buffer) {
        const audioBuffer = eventData.message.audioBuffer;
        audioOutputPort.postMessage(
          {
            type: 'write-unsigned',
            buffer: audioBuffer,
            numberOfSamples: eventData.message.numberOfSamples,
            fps: eventData.message.fps,
            allowFastSpeedStretching: eventData.message.allowFastSpeedStretching,
            sequence: eventData.message.audioBlockSequence
          },
          [audioBuffer]
        );
        return;
      }

      // Process the memory buffer and pass back to the main thread
      // For Each Possible Buffer

      const message = {
        type: WORKER_MESSAGE_TYPE.UPDATED,
        numberOfSamples: eventData.message.numberOfSamples,
        fps: eventData.message.fps,
        allowFastSpeedStretching: eventData.message.allowFastSpeedStretching
      };
      const messageTransferables = [];

      const audioDebuggingChannelBufferKeys = ['audioBuffer', 'channel1Buffer', 'channel2Buffer', 'channel3Buffer', 'channel4Buffer'];
      audioDebuggingChannelBufferKeys.forEach(channelBufferKey => {
        if (!eventData.message[channelBufferKey]) {
          return;
        }

        const audioBufferAsArray = new Uint8Array(eventData.message[channelBufferKey]);
        const audioChannelBuffers = getAudioChannelBuffersFromBuffer(audioBufferAsArray, eventData.message.numberOfSamples);

        message[channelBufferKey] = {};
        message[channelBufferKey].left = audioChannelBuffers.left;
        message[channelBufferKey].right = audioChannelBuffers.right;

        messageTransferables.push(audioChannelBuffers.left);
        messageTransferables.push(audioChannelBuffers.right);
      });

      postMessage(getSmartWorkerMessage(message), messageTransferables);
      return;
    }
  }
};

const messageHandler = event => {
  // Handle our messages from the main thread
  const eventData = getEventData(event);
  switch (eventData.message.type) {
    case WORKER_MESSAGE_TYPE.CONNECT: {
      // Set our lib port
      libWorkerPort = eventData.message.ports[0];
      onMessage(libMessageHandler, libWorkerPort);

      // Simply post back that we are ready
      postMessage(getSmartWorkerMessage(undefined, eventData.messageId));
      return;
    }

    case WORKER_MESSAGE_TYPE.GET_CONSTANTS: {
      // Forward to our lib worker
      libWorkerPort.postMessage(getSmartWorkerMessage(eventData.message, eventData.messageId));
      return;
    }

    case WORKER_MESSAGE_TYPE.CONNECT_AUDIO_OUTPUT: {
      if (audioOutputPort && audioOutputPort.close) audioOutputPort.close();
      audioOutputPort = eventData.message.ports[0];
      onMessage(audioOutputMessageHandler, audioOutputPort);
      return;
    }

    case WORKER_MESSAGE_TYPE.AUDIO_LATENCY: {
      // Forward to our lib worker
      libWorkerPort.postMessage(getSmartWorkerMessage(eventData.message, eventData.messageId));
      return;
    }

    default: {
      //handle other messages from main
      console.log(eventData);
    }
  }
};

onMessage(messageHandler);
