/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const PROCESSOR_NAME = 'wasmboy-audio-output';
const DEFAULT_CAPACITY_FRAMES = 4096;
const STATUS_INTERVAL_RENDER_QUANTA = 8;

// The emulator's sample clock and the audio hardware's are independent, so the
// queue is an integrator of their difference and drifts without bound: it ends
// up wherever the producer's throttle leaves it, then empties or overflows.
// These govern a PI controller that trims playback rate to hold the queue at a
// target depth, which is what actually sets output latency.
const DEFAULT_TARGET_LATENCY_SECONDS = 0.024;
// The two directions are not symmetric, because the fixes available are not.
//
// Queue above target means the emulator is ahead, and pacing can slow it for
// free, so the resampler barely has to move: 0.5% is about four cents.
//
// Queue below target means the emulator cannot keep up, and pacing has no
// answer for that, since it can only ever slow the producer down. Consuming
// more slowly is the only thing left, so it gets real authority. 2% is about a
// third of a semitone, and is much less objectionable than a gap in the audio.
const MAX_DRIFT_TRIM_UP = 0.005;
const MAX_DRIFT_TRIM_DOWN = 0.02;
const DRIFT_PROPORTIONAL_GAIN = 0.15;
const DRIFT_INTEGRAL_GAIN = 0.02;
// Below this relative error the queue is close enough; correcting inside it
// would modulate pitch continuously for no benefit.
const DRIFT_DEADBAND = 0.05;

class WasmBoyAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = (options && options.processorOptions) || {};
    this.capacityFrames = processorOptions.capacityFrames || DEFAULT_CAPACITY_FRAMES;
    this.sourceSampleRate = processorOptions.sourceSampleRate || 44100;

    const targetLatencySeconds = processorOptions.targetLatencySeconds || DEFAULT_TARGET_LATENCY_SECONDS;
    this.targetFrames = Math.max(128, Math.min(Math.round(targetLatencySeconds * this.sourceSampleRate), this.capacityFrames >> 1));

    // Start at the target rather than at some smaller threshold, so playback
    // begins with the headroom it is meant to run with instead of climbing to
    // it. Recover from an underrun on less, to keep the silent gap short; the
    // controller refills the rest.
    this.startThresholdFrames = processorOptions.startThresholdFrames || this.targetFrames;
    this.rePrimeThresholdFrames = Math.max(128, Math.round(this.targetFrames / 3));
    this.leftRing = new Float32Array(this.capacityFrames);
    this.rightRing = new Float32Array(this.capacityFrames);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queuedFrames = 0;
    this.readFraction = 0;
    // baseRate is what the emulator asks for (frame rate and speed). driftTrim
    // is the controller's correction. playbackRate is the product, so the two
    // cannot overwrite each other.
    this.baseRate = 1;
    this.driftTrim = 0;
    this.driftIntegral = 0;
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
    this.driftTrim = 0;
    this.driftIntegral = 0;
    this._applyRates();
    this._reportStatus();
  }

  _applyRates() {
    this.playbackRate = Math.max(0.01, this.baseRate * (1 + this.driftTrim));
  }

  // Hold the queue at targetFrames by consuming slightly faster when we are
  // behind the target and slightly slower when ahead. The integral term ends
  // up holding the steady mismatch between the two clocks, which is what stops
  // the queue drifting; proportional alone would leave a standing offset.
  _updateDriftCompensation(elapsedSeconds) {
    if (!this.primed || this.targetFrames <= 0) {
      return;
    }

    const relativeError = (this.queuedFrames - this.targetFrames) / this.targetFrames;

    if (Math.abs(relativeError) > DRIFT_DEADBAND) {
      this.driftIntegral += relativeError * elapsedSeconds * DRIFT_INTEGRAL_GAIN;
      this.driftIntegral = Math.max(-MAX_DRIFT_TRIM_DOWN, Math.min(MAX_DRIFT_TRIM_UP, this.driftIntegral));
    }

    const trim = relativeError * DRIFT_PROPORTIONAL_GAIN + this.driftIntegral;
    this.driftTrim = Math.max(-MAX_DRIFT_TRIM_DOWN, Math.min(MAX_DRIFT_TRIM_UP, trim));
    this._applyRates();
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
    const threshold = this.hasStarted ? this.rePrimeThresholdFrames : this.startThresholdFrames;
    if (this.queuedFrames >= threshold) {
      this.primed = true;
      this.hasStarted = true;
    }
  }

  _write(left, right, playbackRate) {
    if (playbackRate && playbackRate > 0) {
      this.baseRate = playbackRate;
      this._applyRates();
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
    const sequence = message['sequence'];
    // Frame rate stretching exists for an emulator that cannot keep up. Under
    // flow control the emulator is throttled on purpose, so its frame rate dips
    // by design and stretching would read those as slowness and detune the
    // output. Measured collapsing playback rate to 0.64.
    if (sequence === undefined) {
      this._updatePlaybackRate(message['fps'], message['allowFastSpeedStretching']);
    } else {
      this.baseRate = this.speed;
      this._applyRates();
    }

    for (let frame = 0; frame < write.frameCount; frame++) {
      const sourceIndex = (write.sourceOffset + frame) << 1;
      this.leftRing[this.writeIndex] = this._unsignedSampleToFloat(input[sourceIndex]);
      this.rightRing[this.writeIndex] = this._unsignedSampleToFloat(input[sourceIndex + 1]);
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this._finishWrite(write.frameCount);

    // Acknowledge acceptance, not receipt, and report the queue as it stands
    // now that the block is in it. This is the only measurement the producer
    // needs: it is exact, and it cannot describe a queue the block has not
    // reached yet.
    if (sequence !== undefined && this.inputPort) {
      this.inputPort.postMessage({
        type: 'ack',
        sequence: sequence,
        queuedFrames: this.queuedFrames,
        queuedSeconds: this.queuedFrames / this.sourceSampleRate
      });
    }
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
    this.baseRate = 1;
    if ((fps < 57 || allowFastSpeedStretching) && this.speed === 1) {
      this.baseRate = Math.max(0.01, fps / 60);
    }
    this.baseRate *= this.speed;
    this._applyRates();
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
    this.statusSequence = (this.statusSequence || 0) + 1;

    const status = {
      type: 'status',
      sequence: this.statusSequence,
      queuedFrames: this.queuedFrames,
      // How long the queue takes to drain at the current rate.
      latencySeconds: this.queuedFrames / (this.sourceSampleRate * this.playbackRate),
      // How much audio is buffered, independent of how fast it is being
      // consumed. The producer supplies content, so this is what it should
      // pace against: dividing by playbackRate understates the backlog exactly
      // when the consumer is stretching.
      queuedSeconds: this.queuedFrames / this.sourceSampleRate,
      droppedFrames: this.droppedFrames,
      underrunFrames: this.underrunFrames,
      targetFrames: this.targetFrames,
      targetLatencySeconds: this.targetFrames / this.sourceSampleRate,
      driftTrim: this.driftTrim,
      playbackRate: this.playbackRate
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

    this._updateDriftCompensation(leftOutput.length / sampleRate);

    this.renderQuantumCount++;
    if (this.renderQuantumCount >= STATUS_INTERVAL_RENDER_QUANTA) {
      this.renderQuantumCount = 0;
      this._reportStatus();
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, WasmBoyAudioProcessor);
