// A/B against mGBA: the same music, captured from both emulators' cores.
//
// The render harness proves the library is faithful to the core and that runs
// are reproducible. Neither says the core is RIGHT: the wave channel played at
// a quarter volume for years, and every internal check agreed with itself.
// Catching that class needs a second emulator's ear.
//
// The reference is a committed capture of mGBA's mix for a passage of music
// from a ROM already in this repo, taken with the small libmgba program next to
// it. mGBA is not needed at test time. Comparison is rate-independent
// (envelope RMS over wall-clock windows, Goertzel at the reference's strongest
// tones), so neither side is resampled and the resampler cannot be what is
// actually measured.
//
// These are REGRESSION thresholds, not correctness targets. The baseline
// records how close the current core gets; the test fails when it drifts
// further away. When the core genuinely improves, re-baseline deliberately:
//
//   node test/audio/capture-channels.js --rom test/performance/testroms/tobutobugirl/tobutobugirl.gb \
//     --dmg --start 120 --end 480 --out /tmp/ab
//   then update reference/audio-ab-baseline.json from a fresh compare.

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const { compare } = require('./helpers/audio-compare');
const baseline = require('./reference/audio-ab-baseline.json');

const REFERENCE = path.resolve(__dirname, 'reference', baseline.reference);
const ROM = path.resolve(__dirname, '../performance/testroms/tobutobugirl/tobutobugirl.gb');
const CAPTURE_DIR = path.resolve(__dirname, '../../tmp/audio-ab-capture');

describe('Audio A/B against mGBA', function() {
  this.timeout(180000);

  let result;

  before(() => {
    // Fresh process, fresh capture of the same frames the reference covers.
    execFileSync(
      'node',
      [
        path.resolve(__dirname, '../audio/capture-channels.js'),
        '--rom',
        ROM,
        '--dmg',
        '--start',
        String(baseline.startFrame),
        '--end',
        String(baseline.endFrame),
        '--out',
        CAPTURE_DIR
      ],
      { encoding: 'utf8' }
    );

    result = compare(REFERENCE, baseline.referenceRate, path.join(CAPTURE_DIR, 'tobutobugirl.mix.wav'), 44100);
  });

  it('should keep the envelope at least as close to mGBA as the baseline', () => {
    assert(
      result.envelopeCorr >= baseline.thresholds.minEnvelopeCorr,
      `envelope correlation ${result.envelopeCorr.toFixed(4)} fell below ${baseline.thresholds.minEnvelopeCorr} ` +
        `(baseline ${baseline.measured.envelopeCorr})`
    );
  });

  it('should keep the spectrum at least as close to mGBA as the baseline', () => {
    // This is the axis the wave-channel bug lived on: fundamentals matched
    // while the harmonic balance was wrong.
    assert(
      result.spectrumCorr >= baseline.thresholds.minSpectrumCorr,
      `spectrum correlation ${result.spectrumCorr.toFixed(4)} fell below ${baseline.thresholds.minSpectrumCorr} ` +
        `(baseline ${baseline.measured.spectrumCorr})`
    );
  });

  it('should not drift further from mGBA in time', () => {
    assert(
      Math.abs(result.lagMs) <= baseline.thresholds.maxAbsLagMs,
      `alignment lag ${result.lagMs}ms exceeded ${baseline.thresholds.maxAbsLagMs}ms (baseline ${baseline.measured.lagMs}ms)`
    );
  });

  it('should report where the distance is, for whoever improves it next', () => {
    // Not an assertion; the per-band picture is the actionable part of a
    // failure and worth having in the log on success too.
    result.spectrum.forEach(band => {
      const delta = band.candidate - band.reference;
      console.log(
        `      ${String(band.frequency).padStart(5)}Hz  mgba=${band.reference.toFixed(3)}  ` +
          `wasmboy=${band.candidate.toFixed(3)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`
      );
    });
  });
});
