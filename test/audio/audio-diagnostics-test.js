// getAudioDiagnostics has to describe the run that actually happened.
//
// The first version read four fields that nothing ever assigned, so it reported
// workletActive=false and directOutputActive=false during a run where the
// worklet was live and direct output was in use. That is worse than having no
// diagnostics: a harness measuring latency trusted it and drew the wrong
// conclusion about which path it was on.
//
// The assembly is a pure function so these can pin it without a browser, and so
// a missing assignment shows up here rather than as a confidently wrong answer.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const load = relativePath => {
  const file = path.resolve(__dirname, relativePath);
  const sandbox = { Math, Boolean };
  vm.createContext(sandbox);
  const source = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  const names = [...fs.readFileSync(file, 'utf8').matchAll(/^export function (\w+)/gm)].map(match => match[1]);
  const exposure = names.map(name => `this.${name} = ${name};`).join('\n');
  vm.runInContext(`${source}\n${exposure}`, sandbox, { filename: file });
  return sandbox;
};

const diagnostics = load('../../lib/audio/diagnostics.js');
const pacing = load('../../lib/audio/pacing.js');

describe('Audio diagnostics', () => {
  it('should report direct output as active when it was asked for and taken', () => {
    const options = { audioWorkletDirectOutput: true, audioTargetLatencyInSeconds: 0.026 };
    const report = diagnostics.buildAudioDiagnostics({
      options,
      workletActive: true,
      directOutputActive: true,
      effectiveTargetLatencySeconds: pacing.getEffectiveTargetLatencySeconds(0.026, true)
    });

    // The specific thing that was wrong: config said true, diagnostics said false.
    assert.strictEqual(report.directOutputRequested, true);
    assert.strictEqual(report.directOutputActive, true);
    assert.strictEqual(report.workletActive, true);
    assert.strictEqual(report.effectiveTargetLatencySeconds, 0.026);
  });

  it('should distinguish asking for direct output from getting it', () => {
    // The worklet failed to load, so the request stands but the path is not live.
    const report = diagnostics.buildAudioDiagnostics({
      options: { audioWorkletDirectOutput: true },
      workletActive: false,
      directOutputActive: false
    });

    assert.strictEqual(report.directOutputRequested, true, 'the request should still be visible');
    assert.strictEqual(report.directOutputActive, false);
    assert.strictEqual(report.workletActive, false);
  });

  it('should surface the audio debugger as the reason direct output was refused', () => {
    const report = diagnostics.buildAudioDiagnostics({
      options: { audioWorkletDirectOutput: true, enableAudioDebugging: true },
      workletActive: true,
      directOutputActive: false
    });

    assert.strictEqual(report.directOutputRequested, true);
    assert.strictEqual(report.directOutputActive, false);
    assert.strictEqual(report.audioDebuggingEnabled, true, 'without this the refusal looks unexplained');
  });

  it('should report the relayed path running deeper than requested', () => {
    const effective = pacing.getEffectiveTargetLatencySeconds(0.026, false);
    const report = diagnostics.buildAudioDiagnostics({
      options: { audioWorkletDirectOutput: false, audioTargetLatencyInSeconds: 0.026 },
      workletActive: true,
      directOutputActive: false,
      effectiveTargetLatencySeconds: effective
    });

    assert.strictEqual(report.requestedTargetLatencySeconds, 0.026);
    assert(report.effectiveTargetLatencySeconds > report.requestedTargetLatencySeconds, 'the relayed path takes extra depth and should say so');
  });

  it('should show whether the queue reading ever reached the producer', () => {
    // A queue that grows because the producer was never told, and one that grows
    // because it was told and could not keep up, need opposite fixes.
    const neverReported = diagnostics.buildAudioDiagnostics({ options: {} });
    assert.strictEqual(neverReported.producer.latencySeconds, undefined, 'no reading yet must be visible as no reading');

    diagnostics.setProducerPacing(0.035, 5);
    const reported = diagnostics.buildAudioDiagnostics({ options: {}, producer: diagnostics.getProducerPacing() });
    assert.strictEqual(reported.producer.latencySeconds, 0.035);
    assert.strictEqual(reported.producer.pacingDelayMs, 5, 'the producer saw an overshoot and should be braking');

    diagnostics.resetProducerPacing();
    assert.strictEqual(diagnostics.getProducerPacing().latencySeconds, undefined);
  });

  it('should pass the worklet status through untouched', () => {
    const workletStats = { queuedFrames: 1538, latencySeconds: 0.0347, underrunFrames: 0, droppedFrames: 0, driftTrim: 0.005 };
    const report = diagnostics.buildAudioDiagnostics({ options: {}, workletStats });

    assert.deepStrictEqual(report.worklet, workletStats);
  });

  // The bug that motivated all of this was not in the function above. It was in
  // the caller: getDiagnostics read `this.workletActive` and friends, and
  // nothing in the file ever assigned them. Every unit test of the pure
  // function passed while the shipped answer was wrong, so this checks the
  // wiring the unit tests cannot see.
  it('should assign every field the audio service reports from', () => {
    const audioSource = fs.readFileSync(path.resolve(__dirname, '../../lib/audio/audio.js'), 'utf8');

    const call = audioSource.match(/buildAudioDiagnostics\(\{([\s\S]*?)\}\)/);
    assert(call, 'getDiagnostics should assemble its report through buildAudioDiagnostics');

    const readFields = [...call[1].matchAll(/this\.(\w+)/g)].map(match => match[1]);
    assert(readFields.length > 0, 'expected the report to be built from instance state');

    readFields.forEach(field => {
      const assigned = new RegExp(`this\\.${field}\\s*=`).test(audioSource);
      assert(assigned, `getDiagnostics reports this.${field}, but nothing in audio.js assigns it`);
    });
  });

  it('should not invent a path when nothing has initialized', () => {
    const report = diagnostics.buildAudioDiagnostics(undefined);

    assert.strictEqual(report.workletActive, false);
    assert.strictEqual(report.directOutputActive, false);
    assert.strictEqual(report.worklet, undefined);
  });
});
