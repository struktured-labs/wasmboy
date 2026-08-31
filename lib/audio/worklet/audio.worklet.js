/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const PROCESSOR_NAME = 'wasmboy-audio-output';
const DEFAULT_CAPACITY_FRAMES = 4096;
const STATUS_INTERVAL_RENDER_QUANTA = 8;

class WasmBoyAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = (options && options.processorOptions) || {};
    this.capacityFrames = processorOptions.capacityFrames || DEFAULT_CAPACITY_FRAMES;
    this.sourceSampleRate = processorOptions.sourceSampleRate || 44100;
    this.startThresholdFrames = processorOptions.startThresholdFrames || 512;
    this.leftRing = new Float32Array(this.capacityFrames);
    this.rightRing = new Float32Array(this.capacityFrames);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.readFraction = 0;
    this.playbackRate = 1;
    this.speed = 1;
    this.fpsHistory = new Float32Array(171);
    this.fpsHistoryCount = 0;
    this.fpsHistoryIndex = 0;
    this.fpsHistorySum = 0;
    this.lastFps = 60;
    this.droppedFrames = 0;
    this.underrunFrames = 0;
    this.renderQuantumCount = 0;
    this.primed = false;
    this.hasStarted = false;

    this.inputPort = undefined;
    this.port.onmessage = event => this._handleMessage(event.data || {});
  }

  _handleMessage(message) {
    if (message['type'] === 'connect') {
      if (this.inputPort && this.inputPort.close) this.inputPort.close();
      this.inputPort = message['port'];
      this.inputPort.onmessage = event => this._handleMessage(event.data || {});
    } else if (message['type'] === 'write') {
      this._write(new Float32Array(message['left']), new Float32Array(message['right']), message['playbackRate']);
    } else if (message['type'] === 'write-unsigned') {
      this._writeUnsigned(message);
    } else if (message['type'] === 'set-speed') {
      this.speed = message['speed'];
      this._resetFpsHistory();
    } else if (message['type'] === 'reset') {
      this._reset();
    }
  }

  _reset() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.readFraction = 0;
    this.primed = false;
    this.hasStarted = false;
    this._reportStatus();
  }

  _dropOldest(frameCount) {
    const framesToDrop = Math.min(frameCount, this.queuedFrames);
    this.readIndex = (this.readIndex + framesToDrop) % this.capacityFrames;
    this.queuedFrames -= framesToDrop;
    this.readFraction = 0;
    this.droppedFrames += framesToDrop;
  }

  _prepareWrite(frameCount) {
    let sourceOffset = 0;
    if (frameCount >= this.capacityFrames) {
      sourceOffset = frameCount - this.capacityFrames;
      frameCount = this.capacityFrames;
      this._dropOldest(this.queuedFrames);
    } else {
      const overflowFrames = this.queuedFrames + frameCount - this.capacityFrames;
      if (overflowFrames > 0) this._dropOldest(overflowFrames);
    }
    return { frameCount, sourceOffset };
  }

  _finishWrite(frameCount) {
    this.queuedFrames += frameCount;
    if (this.queuedFrames >= this.startThresholdFrames) {
      this.primed = true;
      this.hasStarted = true;
    }
  }

  _write(left, right, playbackRate) {
    if (playbackRate && playbackRate > 0) {
      this.playbackRate = playbackRate;
    }
    const write = this._prepareWrite(Math.min(left.length, right.length));

    for (let frame = 0; frame < write.frameCount; frame++) {
      this.leftRing[this.writeIndex] = left[write.sourceOffset + frame];
      this.rightRing[this.writeIndex] = right[write.sourceOffset + frame];
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this._finishWrite(write.frameCount);
  }

  _writeUnsigned(message) {
    const input = new Uint8Array(message['buffer']);
    const write = this._prepareWrite(Math.min(message['numberOfSamples'], input.length >> 1));
    this._updatePlaybackRate(message['fps'], message['allowFastSpeedStretching']);

    for (let frame = 0; frame < write.frameCount; frame++) {
      const sourceIndex = (write.sourceOffset + frame) << 1;
      this.leftRing[this.writeIndex] = this._unsignedSampleToFloat(input[sourceIndex]);
      this.rightRing[this.writeIndex] = this._unsignedSampleToFloat(input[sourceIndex + 1]);
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this._finishWrite(write.frameCount);
  }

  _unsignedSampleToFloat(sample) {
    const value = ((sample - 1) / 127 - 1) / 2.5;
    return Math.abs(value) < 0.008 ? 0 : value;
  }

  _resetFpsHistory() {
    this.fpsHistoryCount = 0;
    this.fpsHistoryIndex = 0;
    this.fpsHistorySum = 0;
  }

  _updatePlaybackRate(currentFps, allowFastSpeedStretching) {
    currentFps = currentFps || 60;
    if (Math.abs(currentFps - this.lastFps) >= 15) this._resetFpsHistory();
    this.lastFps = currentFps;

    if (this.fpsHistoryCount < this.fpsHistory.length) {
      this.fpsHistoryCount++;
    } else {
      this.fpsHistorySum -= this.fpsHistory[this.fpsHistoryIndex];
    }
    this.fpsHistory[this.fpsHistoryIndex] = currentFps;
    this.fpsHistorySum += currentFps;
    this.fpsHistoryIndex = (this.fpsHistoryIndex + 1) % this.fpsHistory.length;

    let fps = currentFps;
    if (this.fpsHistoryCount >= 57) fps = Math.floor(this.fpsHistorySum / this.fpsHistoryCount);
    this.playbackRate = 1;
    if ((fps < 57 || allowFastSpeedStretching) && this.speed === 1) {
      this.playbackRate = Math.max(0.01, fps / 60);
    }
    this.playbackRate *= this.speed;
  }

  _readSample(channelRing) {
    if (this.queuedFrames === 0) return 0;

    const currentSample = channelRing[this.readIndex];
    if (this.queuedFrames === 1 || this.readFraction === 0) return currentSample;

    const nextIndex = (this.readIndex + 1) % this.capacityFrames;
    const nextSample = channelRing[nextIndex];
    return currentSample + (nextSample - currentSample) * this.readFraction;
  }

  _advanceReadPosition() {
    this.readFraction += (this.sourceSampleRate / sampleRate) * this.playbackRate;
    const framesToConsume = Math.floor(this.readFraction);
    if (framesToConsume === 0) return;

    const consumedFrames = Math.min(framesToConsume, this.queuedFrames);
    this.readIndex = (this.readIndex + consumedFrames) % this.capacityFrames;
    this.queuedFrames -= consumedFrames;
    this.readFraction -= consumedFrames;
    if (this.queuedFrames === 0) {
      this.readFraction = 0;
      this.primed = false;
    }
  }

  _reportStatus() {
    const status = {
      type: 'status',
      queuedFrames: this.queuedFrames,
      latencySeconds: this.queuedFrames / (this.sourceSampleRate * this.playbackRate),
      droppedFrames: this.droppedFrames,
      underrunFrames: this.underrunFrames
    };
    this.port.postMessage(status);
    if (this.inputPort) this.inputPort.postMessage(status);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOutput = output[0];
    const rightOutput = output[1] || output[0];
    for (let frame = 0; frame < leftOutput.length; frame++) {
      if (!this.primed) {
        leftOutput[frame] = 0;
        rightOutput[frame] = 0;
        if (this.hasStarted) this.underrunFrames++;
        continue;
      }

      leftOutput[frame] = this._readSample(this.leftRing);
      rightOutput[frame] = this._readSample(this.rightRing);
      this._advanceReadPosition();
    }

    this.renderQuantumCount++;
    if (this.renderQuantumCount >= STATUS_INTERVAL_RENDER_QUANTA) {
      this.renderQuantumCount = 0;
      this._reportStatus();
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, WasmBoyAudioProcessor);
