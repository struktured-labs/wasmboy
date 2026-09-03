// Verify the audio path in a real browser engine, in CI.
//
// The Node audio tests run our worklet source under a hand-built stub of the
// AudioWorklet globals. That is enough for the arithmetic, but it is not the
// browser: the distortion that shipped lived in the DSP, and the only way to be
// sure the DSP is right is to run it where it actually runs. This drives the
// real, built worklet inside headless Chromium and compares its output to the
// ideal transparent decode of the same capture.
//
// OfflineAudioContext renders deterministically and faster than realtime, so
// this is reproducible and CI-safe. It certifies the audio CONTENT — that
// nothing in the decode, gate or resample colours the signal. It does not
// certify realtime scheduling; underruns under a live scheduler are a separate,
// non-deterministic question the browser gate owns.
//
// Needs Playwright's Chromium. If it is not installed the suite skips rather
// than fails, so the core CI stays green on machines without a browser; the
// dedicated browser CI job installs it.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HERE = __dirname;
// The capture is a committed fixture; the worklet is read live from the build,
// so the test always exercises the current dist rather than a stale copy.
const CAPTURE = path.join(HERE, 'qi-mix.u8');
const WORKLET = path.join(HERE, '..', '..', 'dist', 'worker', 'audio.worklet.js');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (error) {
  try {
    // Local dev fallback: another project on this machine has Playwright.
    chromium = require('/home/struktured/projects/element-desktop/node_modules/playwright').chromium;
  } catch (innerError) {
    chromium = undefined;
  }
}
if (!chromium) {
  // eslint-disable-next-line no-console
  console.log('    (browser audio suite skipped: Playwright not installed)');
}

const serve = () => {
  const routes = {
    '/': { file: path.join(HERE, 'driver.html'), type: 'text/html' },
    '/audio.worklet.js': { file: WORKLET, type: 'application/javascript' }
  };
  return http.createServer((req, res) => {
    const route = routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    fs.readFile(route.file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': route.type });
      res.end(data);
    });
  });
};

const pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : 0;
};

// Ideal transparent decode of the capture, decimated by the same fixed step the
// browser used, so the two align after a lag search for the priming delay.
const idealDecode = decimate => {
  const raw = fs.readFileSync(CAPTURE);
  const frames = raw.length / 2;
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = ((raw[i * 2] - 129) / 127 / 2.5 + (raw[i * 2 + 1] - 129) / 127 / 2.5) / 2;
  }
  let rms = 0;
  for (const v of mono) rms += v * v;
  rms = Math.sqrt(rms / frames);

  let exactZero = 0;
  for (const v of mono) if (v === 0) exactZero++;

  const trace = [];
  for (let i = 0; i < frames; i += decimate) trace.push(mono[i]);
  return { trace, rms, exactZeroFraction: exactZero / frames };
};

// Best correlation over a small lag window: the worklet primes before it emits,
// so its output leads or lags the reference by a handful of decimated samples.
const bestCorrelation = (a, b) => {
  let best = -Infinity;
  for (let lag = -8; lag <= 8; lag++) {
    const x = lag >= 0 ? a.slice(lag) : a;
    const y = lag >= 0 ? b : b.slice(-lag);
    best = Math.max(best, pearson(x, y));
  }
  return best;
};

(chromium ? describe : describe.skip)('AudioWorklet in a real browser', function() {
  this.timeout(60000);

  const samplesB64 = fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE).toString('base64') : '';

  const renderWith = async targetLatencySeconds => {
    const server = serve();
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${port}/`);
      return await page.evaluate(opts => window.renderThroughWorklet(opts), {
        workletUrl: `http://localhost:${port}/audio.worklet.js`,
        samplesB64,
        contextRate: 44100,
        targetLatencySeconds
      });
    } finally {
      await browser.close();
      server.close();
    }
  };

  it('should render the capture transparently at a native-rate context', async () => {
    const result = await renderWith(0.042);
    const ideal = idealDecode(result.decimate);

    assert.strictEqual(result.contextRate, 44100);
    assert(result.emitted > 400000, `expected the whole capture to play, got ${result.emitted} frames`);
    assert(result.nonZero > result.emitted * 0.5, 'expected mostly non-silent output');

    // Level: the centred decode neither adds the old +1/127 offset nor scales.
    assert(
      Math.abs(result.rms - ideal.rms) / ideal.rms < 0.03,
      `output RMS ${result.rms.toFixed(5)} is more than 3% off the ideal ${ideal.rms.toFixed(5)}`
    );

    // Gate fingerprint. Genuine silence (byte 129) decodes to exactly zero, so
    // the reference has some; the noise gate adds more by flattening a whole
    // band around silence. An excess over the reference is the gate returning.
    const zeroExcess = result.exactlyZeroFraction - ideal.exactZeroFraction;
    assert(
      zeroExcess < 0.015,
      `${(zeroExcess * 100).toFixed(1)}% more samples are exactly zero than the reference — the noise gate is colouring quiet audio`
    );

    // Shape: at a native-rate context the path is pass-through, so the output
    // is the ideal decode delayed by priming. Lag-search past that delay.
    const correlation = bestCorrelation(result.trace, ideal.trace);
    assert(correlation > 0.95, `waveform correlation ${correlation.toFixed(4)} below 0.95 — the DSP is colouring the signal`);
  });
});
