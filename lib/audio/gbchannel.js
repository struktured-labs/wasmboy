// Gameboy Channel Output
// With outputting to Web Audio API

import { WasmBoyPlugins } from '../plugins/plugins';

import toWav from 'audiobuffer-to-wav';
import audioWorkletUrl from '../../dist/worker/audio.worklet.js';

// Define our performance constants
// Both of these make it sound off
// Latency controls how much delay audio has, larger = more delay, goal is to be as small as possible
// Time remaining controls how far ahead we can be., larger = more frames rendered before playing a new set of samples. goal is to be as small as possible. May want to adjust this number according to performance of device
// These magic numbers just come from preference, can be set as options
const DEFAULT_AUDIO_LATENCY_IN_MILLI = 25;
// Some constants that use the ones above that will allow for faster performance
const DEFAULT_AUDIO_LATENCY_IN_SECONDS = DEFAULT_AUDIO_LATENCY_IN_MILLI / 1000;
const MAX_SCHEDULED_AUDIO_LATENCY_IN_SECONDS = 0.1;
const AUDIO_WORKLET_NAME = 'wasmboy-audio-output';
const AUDIO_WORKLET_CAPACITY_FRAMES = 4096;

// Seems like the super quiet popping, and the wace form spikes in the visualizer,
// are caused by the sample rate :P
// Thus need to figure out why that is.
const WASMBOY_SAMPLE_RATE = 44100;

export default class GbChannelWebAudio {
  constructor(id) {
    this.id = id;

    this.audioContext = undefined;
    this.audioBuffer = undefined;
    // The play time for our audio samples
    this.audioPlaytime = undefined;
    this.audioSources = [];
    this.audioWorkletNode = undefined;
    this.audioWorkletPromise = undefined;
    this.audioWorkletInitializing = false;
    this.audioWorkletReady = false;
    this.audioWorkletStarted = false;
    this.audioWorkletLatencySeconds = 0;
    this.audioWorkletStats = undefined;

    // Gain Node for muting
    this.gainNode = undefined;
    this.muted = false;
    this.libMuted = false;

    // Our buffer for recording PCM Samples as they come
    this.recording = false;
    this.recordingLeftBuffers = undefined;
    this.recordingRightBuffers = undefined;
    this.recordingAudioBuffer = undefined;
    this.recordingAnchor = undefined;
  }

  createAudioContextIfNone() {
    if (!this.audioContext && typeof window !== 'undefined') {
      // Get our Audio context
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      // Ask for the emulator's own rate. At 44100 the worklet's read ratio is
      // exactly 1, so its linear interpolation degenerates to pass-through and
      // the final conversion to the device rate is done by the browser's own
      // resampler, the way the pre-worklet scheduled-buffer path had it.
      try {
        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: WASMBOY_SAMPLE_RATE });
      } catch (error) {
        // Not every platform honors a requested rate.
        this.audioContext = new AudioContext({ latencyHint: 'interactive' });
      }

      // Set up our nodes
      // Seems like closure compiler will optimize this out
      // Thus, need to do a very specifc type check if statement here.
      if (!!this.audioContext === true) {
        this.gainNode = this.audioContext.createGain();
        if (this.muted || this.libMuted) {
          this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
        }
      }
    }
  }

  getCurrentTime() {
    this.createAudioContextIfNone();

    if (!this.audioContext) {
      return;
    }

    return this.audioContext.currentTime;
  }

  getPlayTime() {
    if (this.audioWorkletReady && this.audioContext) {
      return this.audioContext.currentTime + this.audioWorkletLatencySeconds;
    }
    return this.audioPlaytime;
  }

  resumeAudioContext() {
    if (!this.audioContext) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
      this.audioPlaytime = this.audioContext.currentTime;
    }
  }

  playAudio(numberOfSamples, leftChannelBuffer, rightChannelBuffer, playbackRate, updateAudioCallback) {
    if (!this.audioContext) {
      return;
    }

    // Get our buffers as floats
    const leftChannelBufferAsFloat = new Float32Array(leftChannelBuffer);
    const rightChannelBufferAsFloat = new Float32Array(rightChannelBuffer);

    if (this.recording) {
      this.recordingLeftBuffers.push(new Float32Array(leftChannelBufferAsFloat));
      this.recordingRightBuffers.push(new Float32Array(rightChannelBufferAsFloat));
    }

    this._initializeAudioWorklet(updateAudioCallback);
    if (this.audioWorkletReady) {
      this._playAudioWorklet(numberOfSamples, leftChannelBufferAsFloat, rightChannelBufferAsFloat, playbackRate);
      return;
    }

    // Create an audio buffer, with a left and right channel
    this.audioBuffer = this.audioContext.createBuffer(2, numberOfSamples, WASMBOY_SAMPLE_RATE);
    this._setSamplesToAudioBuffer(this.audioBuffer, leftChannelBufferAsFloat, rightChannelBufferAsFloat);

    // Get an AudioBufferSourceNode.
    // This is the AudioNode to use when we want to play an AudioBuffer
    let source = this.audioContext.createBufferSource();

    // set the buffer in the AudioBufferSourceNode
    source.buffer = this.audioBuffer;

    // Set our playback rate for time resetretching
    source.playbackRate.setValueAtTime(playbackRate, this.audioContext.currentTime);

    // Set up our "final node", as in the one that will be connected
    // to the destination (output)
    let finalNode = source;

    // Call our callback/plugins, if we have one
    if (updateAudioCallback) {
      const responseNode = updateAudioCallback(this.audioContext, finalNode, this.id);
      if (responseNode) {
        finalNode = responseNode;
      }
    }

    // Call our plugins
    WasmBoyPlugins.runHook({
      key: 'audio',
      params: [this.audioContext, finalNode, this.id],
      callback: hookResponse => {
        if (hookResponse) {
          finalNode.connect(hookResponse);
          finalNode = hookResponse;
        }
      }
    });

    // Lastly, apply our gain node to mute/unmute
    if (this.gainNode) {
      finalNode.connect(this.gainNode);
      finalNode = this.gainNode;
    }

    // connect the AudioBufferSourceNode to the
    // destination so we can hear the sound
    finalNode.connect(this.audioContext.destination);

    // Check if we made it in time
    // Idea from: https://github.com/binji/binjgb/blob/master/demo/demo.js
    let audioContextCurrentTime = this.audioContext.currentTime;
    let audioContextCurrentTimeWithLatency = audioContextCurrentTime + DEFAULT_AUDIO_LATENCY_IN_SECONDS;
    this.audioPlaytime = this.audioPlaytime || audioContextCurrentTimeWithLatency;
    if (this.audioPlaytime - audioContextCurrentTime > MAX_SCHEDULED_AUDIO_LATENCY_IN_SECONDS) {
      // Video always renders the newest emulated frame, so retaining a large
      // queue here makes every sound visibly stale. Keep a source that has
      // already started, discard only future sources, and resume close to the
      // hardware clock.
      this.cancelAllAudio(false);
      this.audioPlaytime = audioContextCurrentTimeWithLatency;
    }
    if (this.audioPlaytime < audioContextCurrentTime) {
      // We took too long, or something happen and hiccup'd the emulator, reset audio playback times
      this.cancelAllAudio();
      this.audioPlaytime = audioContextCurrentTimeWithLatency;
    }

    // start the source playing
    const sourceStartTime = this.audioPlaytime;
    source.start(sourceStartTime);

    // Set our new audio playtime goal
    const sourcePlaybackLength = numberOfSamples / (WASMBOY_SAMPLE_RATE * playbackRate);
    this.audioPlaytime = this.audioPlaytime + sourcePlaybackLength;

    // Drop bookkeeping for sources the audio clock has already consumed.
    this.audioSources = this.audioSources.filter(audioSource => audioSource.endTime > audioContextCurrentTime);

    // Add the source so queued audio can be pruned if it becomes stale.
    const audioSource = {
      source: source,
      startTime: sourceStartTime,
      endTime: this.audioPlaytime
    };
    this.audioSources.push(audioSource);
    source.onended = () => {
      const index = this.audioSources.indexOf(audioSource);
      if (index >= 0) this.audioSources.splice(index, 1);
    };
  }

  prepareAudioOutput(updateAudioCallback, targetLatencySeconds) {
    if (targetLatencySeconds && targetLatencySeconds > 0) {
      this.audioTargetLatencySeconds = targetLatencySeconds;
    }
    this.createAudioContextIfNone();
    return this._initializeAudioWorklet(updateAudioCallback);
  }

  createAudioInputPort() {
    if (!this.audioWorkletNode || typeof window.MessageChannel !== 'function') return;
    const channel = new window.MessageChannel();
    this.audioWorkletNode.port.postMessage({ type: 'connect', port: channel.port1 }, [channel.port1]);
    return channel.port2;
  }

  setSpeed(speed) {
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'set-speed', speed: speed });
    }
  }

  cancelAllAudio(stopCurrentAudio) {
    if (!this.audioContext) {
      return;
    }

    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'reset' });
      this.audioWorkletLatencySeconds = 0;
    }

    // Cancel all audio That was queued to play
    const currentTime = this.audioContext.currentTime;
    this.audioSources = this.audioSources.filter(audioSource => {
      if (stopCurrentAudio || audioSource.startTime > currentTime) {
        audioSource.source.stop();
        return false;
      }
      return audioSource.endTime > currentTime;
    });

    // Reset our audioPlaytime
    this.audioPlaytime = currentTime + DEFAULT_AUDIO_LATENCY_IN_SECONDS;
  }

  _initializeAudioWorklet(updateAudioCallback) {
    if (this.audioWorkletReady) return Promise.resolve(true);
    if (this.audioWorkletPromise) return this.audioWorkletPromise;
    if (!this.audioContext.audioWorklet || typeof window.AudioWorkletNode !== 'function') {
      return Promise.resolve(false);
    }

    this.audioWorkletInitializing = true;
    this.audioWorkletPromise = this.audioContext.audioWorklet
      .addModule(audioWorkletUrl)
      .then(() => {
        const node = new window.AudioWorkletNode(this.audioContext, AUDIO_WORKLET_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            capacityFrames: AUDIO_WORKLET_CAPACITY_FRAMES,
            sourceSampleRate: WASMBOY_SAMPLE_RATE,
            targetLatencySeconds: this.audioTargetLatencySeconds
          }
        });
        node.port.onmessage = event => {
          const message = event.data || {};
          if (message['type'] === 'status') {
            this.audioWorkletLatencySeconds = message['latencySeconds'];
            this.audioWorkletStats = message;
          }
        };
        this.audioWorkletNode = node;
        this.audioWorkletReady = true;
        this._connectAudioNode(node, updateAudioCallback);
        return true;
      })
      .catch(error => {
        console.warn('WasmBoy AudioWorklet unavailable; using scheduled buffers.', error);
        return false;
      })
      .then(ready => {
        this.audioWorkletInitializing = false;
        return ready;
      });
    return this.audioWorkletPromise;
  }

  _connectAudioNode(node, updateAudioCallback) {
    let finalNode = node;
    if (updateAudioCallback) {
      const responseNode = updateAudioCallback(this.audioContext, finalNode, this.id);
      if (responseNode) finalNode = responseNode;
    }

    WasmBoyPlugins.runHook({
      key: 'audio',
      params: [this.audioContext, finalNode, this.id],
      callback: hookResponse => {
        if (hookResponse) {
          finalNode.connect(hookResponse);
          finalNode = hookResponse;
        }
      }
    });

    if (this.gainNode) {
      finalNode.connect(this.gainNode);
      finalNode = this.gainNode;
    }
    finalNode.connect(this.audioContext.destination);
  }

  _playAudioWorklet(numberOfSamples, left, right, playbackRate) {
    if (!this.audioWorkletStarted) {
      this.audioSources.forEach(audioSource => audioSource.source.stop());
      this.audioSources = [];
      this.audioWorkletStarted = true;
    }

    const latency = numberOfSamples / (WASMBOY_SAMPLE_RATE * playbackRate);
    const capacityLatency = AUDIO_WORKLET_CAPACITY_FRAMES / (WASMBOY_SAMPLE_RATE * playbackRate);
    this.audioWorkletLatencySeconds = Math.min(capacityLatency, this.audioWorkletLatencySeconds + latency);
    this.audioWorkletNode.port.postMessage(
      {
        type: 'write',
        left: left.buffer,
        right: right.buffer,
        playbackRate: playbackRate
      },
      [left.buffer, right.buffer]
    );
  }

  mute() {
    if (!this.muted) {
      this._setGain(0);
      this.muted = true;
    }
  }

  unmute() {
    if (this.muted) {
      this._setGain(1);
      this.muted = false;
    }
  }

  hasRecording() {
    return !!this.recordingAudioBuffer;
  }

  startRecording() {
    if (!this.recording) {
      this.recording = true;
      this.recordingLeftBuffers = [];
      this.recordingRightBuffers = [];
      this.recordingAudioBuffer = undefined;
    }
  }

  stopRecording() {
    // Check if we were recoridng
    if (!this.recording) {
      return;
    }

    this.recording = false;

    // Create a left/right buffer from all the buffers stored
    const createBufferFromBuffers = buffers => {
      let totalLength = 0;
      buffers.forEach(buffer => {
        totalLength += buffer.length;
      });

      const totalBuffer = new Float32Array(totalLength);
      let currentLength = 0;
      buffers.forEach(buffer => {
        totalBuffer.set(buffer, currentLength);
        currentLength += buffer.length;
      });

      return totalBuffer;
    };

    const totalLeftBuffer = createBufferFromBuffers(this.recordingLeftBuffers);
    const totalRightBuffer = createBufferFromBuffers(this.recordingRightBuffers);
    this.recordingAudioBuffer = this.audioContext.createBuffer(2, totalLeftBuffer.length, WASMBOY_SAMPLE_RATE);
    this._setSamplesToAudioBuffer(this.recordingAudioBuffer, totalLeftBuffer, totalRightBuffer);

    this.recordingLeftBuffer = undefined;
    this.recordingRightBuffer = undefined;
  }

  downloadRecordingAsWav(filename) {
    if (!this.recordingAudioBuffer) {
      return;
    }

    // Check if we need to create our anchor tag
    // Which is used to download the audio
    if (!this.recordingAnchor) {
      this.recordingAnchor = document.createElement('a');
      document.body.appendChild(this.recordingAnchor);
      this.recordingAnchor.style = 'display: none';
    }

    // Create our wav as a downloadable blob
    const wav = toWav(this.recordingAudioBuffer);
    const blob = new window.Blob([new DataView(wav)], {
      type: 'audio/wav'
    });

    // Create our url / download name
    const url = window.URL.createObjectURL(blob);
    this.recordingAnchor.href = url;
    let downloadName;
    if (filename) {
      downloadName = `${filename}.wav`;
    } else {
      const shortDateWithTime = new Date().toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      downloadName = `wasmboy-${shortDateWithTime}.wav`;
    }
    this.recordingAnchor.download = downloadName;

    // Download our wav
    this.recordingAnchor.click();
    window.URL.revokeObjectURL(url);
  }

  getRecordingAsWavBase64EncodedString() {
    if (!this.recordingAudioBuffer) {
      return;
    }

    // Create our wav as a downloadable blob
    const wav = toWav(this.recordingAudioBuffer);
    const base64String = this._arrayBufferToBase64(wav);

    return `data:audio/wav;base64,${base64String}`;
  }

  getRecordingAsAudioBuffer() {
    return this.recordingAudioBuffer;
  }

  _libMute() {
    this.libMuted = true;
    if (this.audioContext) this._setGain(0);
  }

  _libUnmute() {
    if (this.libMuted) {
      this.libMuted = false;
      if (this.audioContext) this._setGain(1);
    }
  }

  _setGain(gain) {
    this.createAudioContextIfNone();
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
    }
  }

  _setSamplesToAudioBuffer(audioBuffer, leftChannelSamples, rightChannelSamples) {
    if (audioBuffer.copyToChannel) {
      audioBuffer.copyToChannel(leftChannelSamples, 0, 0);
      audioBuffer.copyToChannel(rightChannelSamples, 1, 0);
    } else {
      // Safari fallback
      audioBuffer.getChannelData(0).set(leftChannelSamples);
      audioBuffer.getChannelData(1).set(rightChannelSamples);
    }
  }

  // https://stackoverflow.com/questions/9267899/arraybuffer-to-base64-encoded-string/38858127
  _arrayBufferToBase64(buffer) {
    let binary = '';
    let bytes = new Uint8Array(buffer);
    let len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}
