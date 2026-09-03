// Compare two audio captures of the same emulated passage, independent of
// their sample rates.
//
// The captures are analysed in place rather than resampled onto each other, so
// the comparison cannot be flattered or damaged by the quality of a resampler:
// envelopes are RMS over fixed wall-clock windows, and tones are measured with
// Goertzel at explicit frequencies, both of which work at any rate.
//
// Reports three things:
//   lagMs           where the envelopes align best, by cross-correlation
//   envelopeCorr    Pearson correlation of the aligned envelopes
//   spectrum        relative magnitude at the reference's strongest tones
const fs = require('fs');

const ENVELOPE_WINDOW_SECONDS = 0.01;
const MAX_LAG_SECONDS = 0.05;

const loadS16Stereo = (file, rate) => {
  // A .wav is the same stream with a 44 byte header in front.
  const raw = file.endsWith('.wav') ? fs.readFileSync(file).subarray(44) : fs.readFileSync(file);
  const samples = new Float64Array(Math.floor(raw.length / 4));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (raw.readInt16LE(i * 4) + raw.readInt16LE(i * 4 + 2)) / 2 / 32768;
  }
  return { samples, rate };
};

// The core's unsigned byte encoding, interleaved stereo, mixed to mono.
const loadU8Stereo = (file, rate) => {
  const raw = fs.readFileSync(file);
  const samples = new Float64Array(raw.length / 2);
  for (let i = 0; i < samples.length; i++) {
    const left = (raw[i * 2] - 1) / 127 - 1;
    const right = (raw[i * 2 + 1] - 1) / 127 - 1;
    samples[i] = (left + right) / 2;
  }
  return { samples, rate };
};

const removeMean = signal => {
  let mean = 0;
  for (const value of signal.samples) mean += value;
  mean /= signal.samples.length;
  for (let i = 0; i < signal.samples.length; i++) signal.samples[i] -= mean;
  return signal;
};

const envelope = signal => {
  const window = Math.round(signal.rate * ENVELOPE_WINDOW_SECONDS);
  const bins = Math.floor(signal.samples.length / window);
  const rms = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const value = signal.samples[bin * window + i];
      sum += value * value;
    }
    rms[bin] = Math.sqrt(sum / window);
  }
  const peak = Math.max(...rms);
  if (peak > 0) for (let bin = 0; bin < bins; bin++) rms[bin] /= peak;
  return rms;
};

const pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  return varA && varB ? cov / Math.sqrt(varA * varB) : 0;
};

const bestAlignment = (reference, candidate) => {
  const maxLagBins = Math.round(MAX_LAG_SECONDS / ENVELOPE_WINDOW_SECONDS);
  let best = { lagBins: 0, corr: -Infinity };
  for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
    const a = lag >= 0 ? reference.subarray(lag) : reference;
    const b = lag >= 0 ? candidate : candidate.subarray(-lag);
    const corr = pearson(a, b);
    if (corr > best.corr) best = { lagBins: lag, corr };
  }
  return { lagMs: best.lagBins * ENVELOPE_WINDOW_SECONDS * 1000, envelopeCorr: best.corr };
};

const goertzel = (signal, frequency) => {
  const n = signal.samples.length;
  const k = (2 * Math.PI * frequency) / signal.rate;
  const coefficient = 2 * Math.cos(k);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = signal.samples[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2) / n;
};

// Find the reference's strongest tones by scanning a musical range, so the
// spectrum comparison follows the material rather than a hardcoded list.
const strongestTones = (signal, count) => {
  const magnitudes = [];
  for (let frequency = 100; frequency <= 4000; frequency += 10) {
    magnitudes.push({ frequency, magnitude: goertzel(signal, frequency) });
  }
  magnitudes.sort((a, b) => b.magnitude - a.magnitude);

  const picked = [];
  for (const tone of magnitudes) {
    if (picked.every(existing => Math.abs(existing.frequency - tone.frequency) > 50)) {
      picked.push(tone);
      if (picked.length === count) break;
    }
  }
  return picked.sort((a, b) => a.frequency - b.frequency);
};

const compare = (referenceFile, referenceRate, candidateFile, candidateRate, options) => {
  const reference = removeMean(loadS16Stereo(referenceFile, referenceRate));
  const candidate = removeMean(
    candidateFile.endsWith('.wav') ? loadS16Stereo(candidateFile, candidateRate) : loadU8Stereo(candidateFile, candidateRate)
  );

  const alignment = bestAlignment(envelope(reference), envelope(candidate));

  const tones = strongestTones(reference, (options && options.tones) || 6);
  const referencePeak = Math.max(...tones.map(tone => tone.magnitude));
  const candidateMagnitudes = tones.map(tone => goertzel(candidate, tone.frequency));
  const candidatePeak = Math.max(...candidateMagnitudes);

  const spectrum = tones.map((tone, i) => ({
    frequency: tone.frequency,
    reference: tone.magnitude / referencePeak,
    candidate: candidatePeak > 0 ? candidateMagnitudes[i] / candidatePeak : 0
  }));

  const spectrumCorr = pearson(
    Float64Array.from(spectrum.map(band => band.reference)),
    Float64Array.from(spectrum.map(band => band.candidate))
  );

  return { ...alignment, spectrum, spectrumCorr };
};

module.exports = { compare };

if (require.main === module) {
  const [referenceFile, referenceRate, candidateFile, candidateRate] = process.argv.slice(2);
  const result = compare(referenceFile, parseInt(referenceRate, 10), candidateFile, parseInt(candidateRate, 10));
  console.log(JSON.stringify(result, null, 2));
}
