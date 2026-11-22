/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const PROCESSOR_NAME = 'wasmboy-audio-output';
const DEFAULT_CAPACITY_FRAMES = 16384;
const STATUS_INTERVAL_RENDER_QUANTA = 8;

// The emulator's sample clock and the audio hardware's are independent, so the
// queue is an integrator of their difference and drifts without bound: it ends
// up wherever the producer's throttle leaves it, then empties or overflows.
// These govern a PI controller that trims playback rate to hold the queue at a
// target depth, which is what actually sets output latency.
const DEFAULT_TARGET_LATENCY_SECONDS = 0.042;
// Playback rate is exactly 1 in normal operation. Queue above target is
// pacing's job, and pitching up to drain it put a constant offset on the
// output — 0.5% is 8.6 cents, which a listener comparing against hardware
// noticed. A PI with only downward authority is worse still: its integral
// ratchets to the negative clamp and the trim oscillates between 0 and -2%,
// which is a slow vibrato. Simulated before shipping; it does exactly that.
//
// What remains is a starvation guard: pacing can only ever slow the producer,
// so when the queue is nearly empty, consuming more slowly is the only thing
// left. The trim ramps in below half target and reaches -2% — a third of a
// semitone — only with the queue about to run dry, where it beats a gap.
const MAX_DRIFT_TRIM_DOWN = 0.02;

// Every place the output can jump — the ring running dry, playback starting or
// resuming, frames dropped on overflow — used to be a hard step: straight to 0
// on an underrun, straight back to the signal when blocks resumed. Game Boy
// output sits on a DC level, so even a quiet passage stepped by a tenth of full
// scale, which is a click. On a slow device (the Tesla in-car browser) the
// queue runs dry several times a second and the clicks become popping.
// Instead, the step is carried as an offset that decays with this time
// constant: an underrun glides to silence and a resume glides in. 3 ms is
// short enough to be inaudible as a fade and long enough that no single
// sample moves more than a clean tone does.
const DEFAULT_DECLICK_TIME_CONSTANT_SECONDS = 0.003;

// A device that underruns at the requested depth needs more headroom, and the
// only way to get it is to hold more queue. Each underrun episode raises the
// target by this factor, up to the ceiling; the status report carries the new
// target to the producer, which paces to it. Latency stays at the requested
// value on any device that keeps up.
const ADAPTIVE_TARGET_GROWTH = 1.5;
const DEFAULT_MAX_TARGET_LATENCY_SECONDS = 0.1;

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
    const maxTargetLatencySeconds =
      processorOptions.maxTargetLatencySeconds !== undefined
        ? processorOptions.maxTargetLatencySeconds
        : DEFAULT_MAX_TARGET_LATENCY_SECONDS;
    this.maxTargetFrames = Math.max(
      this.targetFrames,
      Math.min(Math.round(maxTargetLatencySeconds * this.sourceSampleRate), this.capacityFrames >> 1)
    );
    this.underrunEvents = 0;
    const declickSeconds =
      processorOptions.declickTimeConstantSeconds !== undefined
        ? processorOptions.declickTimeConstantSeconds
        : DEFAULT_DECLICK_TIME_CONSTANT_SECONDS;
    // Per-sample decay at the output rate. 0 disables declicking (exact ring
    // mechanics, for tests).
    this.declickDecay = declickSeconds > 0 ? Math.exp(-1 / (declickSeconds * sampleRate)) : 0;
    this.lastLeft = 0;
    this.lastRight = 0;
    this.declickLeft = 0;
    this.declickRight = 0;
    this.discontinuity = false;
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
    this._applyRates();
    this._reportStatus();
  }

  _applyRates() {
    this.playbackRate = Math.max(0.01, this.baseRate * (1 + this.driftTrim));
  }

  _updateDriftCompensation(elapsedSeconds) {
    if (!this.primed || this.targetFrames <= 0) {
      return;
    }

    const lowWaterFrames = this.targetFrames >> 1;
    let trim = 0;
    if (this.queuedFrames < lowWaterFrames) {
      // Square root, so a small persistent deficit finds equilibrium with the
      // queue still well above empty: a linear ramp balanced a 1% slow
      // producer at a quarter of the low-water mark, one scheduling hiccup
      // from a gap.
      trim = -MAX_DRIFT_TRIM_DOWN * Math.sqrt(1 - this.queuedFrames / lowWaterFrames);
    }

    this.driftTrim = trim;
    this._applyRates();
  }

  _dropOldest(frameCount) {
    const framesToDrop = Math.min(frameCount, this.queuedFrames);
    this.readIndex = (this.readIndex + framesToDrop) % this.capacityFrames;
    this.queuedFrames -= framesToDrop;
    this.readFraction = 0;
    this.droppedFrames += framesToDrop;
    if (framesToDrop > 0 && this.primed) this.discontinuity = true;
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
      if (!this.primed) this.discontinuity = true;
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
    // Silence is encoded as 129 (the core stores value + 1 around a 128
    // centre). The old decode centred on 128, so silence came out as +1/127
    // and a gate was added to hide it. The gate was a deadzone two and a half
    // quantisation steps wide, which is crossover distortion on everything
    // quiet: measured at 26.4dB SNR on real game music. Decode around the true
    // centre and no gate is needed.
    return (sample - 129) / 127 / 2.5;
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
      this._onUnderrun();
    }
  }

  _onUnderrun() {
    this.underrunEvents++;
    if (this.targetFrames >= this.maxTargetFrames) return;
    this.targetFrames = Math.min(this.maxTargetFrames, Math.round(this.targetFrames * ADAPTIVE_TARGET_GROWTH));
    this.rePrimeThresholdFrames = Math.max(128, Math.round(this.targetFrames / 3));
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
      underrunEvents: this.underrunEvents,
      targetFrames: this.targetFrames,
      targetLatencySeconds: this.targetFrames / this.sourceSampleRate,
      driftTrim: this.driftTrim,
      playbackRate: this.playbackRate
    };
    this.port.postMessage(status);
    if (this.inputPort) this.inputPort.postMessage(status);
  }

  _emit(leftOutput, rightOutput, frame) {
    if (rightOutput) {
      leftOutput[frame] = this.lastLeft;
      rightOutput[frame] = this.lastRight;
    } else {
      leftOutput[frame] = (this.lastLeft + this.lastRight) * 0.5;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOutput = output[0];
    // A mono destination gets the downmix; aliasing right onto left would
    // overwrite the left channel with the right.
    const rightOutput = output[1];
    const decay = this.declickDecay;
    for (let frame = 0; frame < leftOutput.length; frame++) {
      if (!this.primed) {
        // Glide from wherever the output was to silence instead of cutting.
        this.lastLeft *= decay;
        this.lastRight *= decay;
        this.declickLeft = 0;
        this.declickRight = 0;
        this._emit(leftOutput, rightOutput, frame);
        if (this.hasStarted) this.underrunFrames++;
        continue;
      }

      const left = this._readSample(this.leftRing);
      const right = this._readSample(this.rightRing);
      this._advanceReadPosition();
      if (this.discontinuity) {
        // Start the new segment where the output already is, then let the
        // offset decay so the signal takes over within a few milliseconds.
        this.discontinuity = false;
        if (decay > 0) {
          this.declickLeft = this.lastLeft - left;
          this.declickRight = this.lastRight - right;
        }
      }
      this.declickLeft *= decay;
      this.declickRight *= decay;
      this.lastLeft = left + this.declickLeft;
      this.lastRight = right + this.declickRight;
      this._emit(leftOutput, rightOutput, frame);
    }

    // The decays approach zero forever; flush them before they go subnormal,
    // which is slow on some ARM and Atom cores (in-car head units among them).
    if (Math.abs(this.lastLeft) < 1e-15) this.lastLeft = 0;
    if (Math.abs(this.lastRight) < 1e-15) this.lastRight = 0;
    if (Math.abs(this.declickLeft) < 1e-15) this.declickLeft = 0;
    if (Math.abs(this.declickRight) < 1e-15) this.declickRight = 0;

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
