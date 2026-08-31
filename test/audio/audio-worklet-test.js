const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const loadProcessor = outputSampleRate => {
  let implementation;
  class AudioWorkletProcessorMock {
    constructor() {
      this.port = {
        messages: [],
        onmessage: undefined,
        postMessage: message => this.port.messages.push(message)
      };
    }
  }

  const source = fs.readFileSync(path.join(__dirname, '../../lib/audio/worklet/audio.worklet.js'), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorMock,
    Float32Array,
    Math,
    sampleRate: outputSampleRate,
    registerProcessor: (name, processor) => {
      assert.strictEqual(name, 'wasmboy-audio-output');
      implementation = processor;
    }
  });
  return implementation;
};

describe('WasmBoy AudioWorklet ring buffer', () => {
  let Processor;

  before(() => {
    Processor = loadProcessor(44100);
  });

  const write = (processor, left, right, playbackRate = 1) => {
    processor.port.onmessage({
      data: {
        type: 'write',
        left: new Float32Array(left).buffer,
        right: new Float32Array(right).buffer,
        playbackRate
      }
    });
  };

  const render = (processor, frameCount) => {
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    processor.process([], [[left, right]]);
    return { left: Array.from(left), right: Array.from(right) };
  };

  it('preserves stereo samples in order', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 8, startThresholdFrames: 1 } });
    write(processor, [1, 2, 3], [4, 5, 6]);

    const output = render(processor, 3);
    assert.deepStrictEqual(output.left, [1, 2, 3]);
    assert.deepStrictEqual(output.right, [4, 5, 6]);
    assert.strictEqual(processor.queuedFrames, 0);
  });

  it('drops the oldest audio instead of growing without bound', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 4, startThresholdFrames: 1 } });
    write(processor, [1, 2, 3], [1, 2, 3]);
    write(processor, [4, 5, 6], [4, 5, 6]);

    assert.deepStrictEqual(render(processor, 4).left, [3, 4, 5, 6]);
    assert.strictEqual(processor.droppedFrames, 2);
  });

  it('outputs silence on underrun and reports queue status', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 8, startThresholdFrames: 1 } });
    assert.deepStrictEqual(render(processor, 2).left, [0, 0]);
    assert.strictEqual(processor.underrunFrames, 0);

    write(processor, [1], [1]);
    assert.deepStrictEqual(render(processor, 2).left, [1, 0]);
    assert.strictEqual(processor.underrunFrames, 1);

    processor.port.onmessage({ data: { type: 'reset' } });
    const status = processor.port.messages[processor.port.messages.length - 1];
    assert.strictEqual(status.type, 'status');
    assert.strictEqual(status.queuedFrames, 0);
  });

  it('supports fractional playback rates', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 8, startThresholdFrames: 1 } });
    write(processor, [0, 1, 2, 3], [0, 1, 2, 3], 0.5);

    assert.deepStrictEqual(render(processor, 4).left, [0, 0.5, 1, 1.5]);
    assert.strictEqual(processor.queuedFrames, 2);
  });

  it('resamples 44.1 kHz input for a 48 kHz output device', () => {
    const Processor48k = loadProcessor(48000);
    const processor = new Processor48k({
      processorOptions: { capacityFrames: 8, sourceSampleRate: 44100, startThresholdFrames: 1 }
    });
    write(processor, [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]);

    const output = render(processor, 4).left;
    const expected = [0, 0.91875, 1.8375, 2.75625];
    output.forEach((sample, index) => {
      assert.ok(Math.abs(sample - expected[index]) < 0.00001);
    });
  });

  it('converts raw interleaved emulator samples on a direct port', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 8, startThresholdFrames: 1 } });
    const inputPort = {
      messages: [],
      onmessage: undefined,
      postMessage(message) {
        this.messages.push(message);
      }
    };
    processor.port.onmessage({ data: { type: 'connect', port: inputPort } });
    inputPort.onmessage({
      data: {
        type: 'write-unsigned',
        buffer: new Uint8Array([255, 1, 128, 128]).buffer,
        numberOfSamples: 2,
        fps: 60,
        allowFastSpeedStretching: false
      }
    });

    const output = render(processor, 2);
    assert.ok(Math.abs(output.left[0] - 0.4) < 0.00001);
    assert.ok(Math.abs(output.right[0] + 0.4) < 0.00001);
    assert.strictEqual(output.left[1], 0);
    assert.strictEqual(output.right[1], 0);

    processor.port.onmessage({ data: { type: 'reset' } });
    assert.strictEqual(inputPort.messages[inputPort.messages.length - 1].type, 'status');
  });

  it('applies emulator speed to direct audio playback', () => {
    const processor = new Processor({ processorOptions: { capacityFrames: 8, startThresholdFrames: 1 } });
    processor.port.onmessage({ data: { type: 'set-speed', speed: 2 } });
    processor.port.onmessage({
      data: {
        type: 'write-unsigned',
        buffer: new Uint8Array([255, 255, 128, 128, 1, 1]).buffer,
        numberOfSamples: 3,
        fps: 60,
        allowFastSpeedStretching: false
      }
    });

    const output = render(processor, 2).left;
    assert.ok(Math.abs(output[0] - 0.4) < 0.00001);
    assert.ok(Math.abs(output[1] + 0.4) < 0.00001);
    assert.strictEqual(processor.queuedFrames, 0);
  });
});
