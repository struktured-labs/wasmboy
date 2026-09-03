// Verify the audio DSP in a real browser engine.
//
// The Node audio tests run the worklet under a stub of the AudioWorklet
// globals. The distortion that shipped lived in the DSP, so this runs the built
// worklet in headless Chromium and compares its output to the ideal transparent
// decode. OfflineAudioContext renders deterministically, so it certifies audio
// content, not realtime scheduling.
//
// Playwright is a devDependency, so this is expected to run. It skips only when
// explicitly allowed (WASMBOY_BROWSER_OPTIONAL=1, for a dev machine with no
// browser); the dedicated test:browser command does not set that and fails hard
// when the browser is missing, so the CI job cannot pass with zero tests.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HERE = __dirname;
const CAPTURE = path.join(HERE, 'qi-mix.u8');
const WORKLET = path.join(HERE, '..', '..', 'dist', 'worker', 'audio.worklet.js');
const OPTIONAL = process.env.WASMBOY_BROWSER_OPTIONAL === '1';

let chromium;
let loadError;
try {
  chromium = require('playwright').chromium;
} catch (error) {
  loadError = error;
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

// Ideal transparent decode, decimated by the browser's step so the two align
// after a lag search for the priming delay.
const idealDecode = decimate => {
  const raw = fs.readFileSync(CAPTURE);
  const frames = raw.length / 2;
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = ((raw[i * 2] - 129) / 127 / 2.5 + (raw[i * 2 + 1] - 129) / 127 / 2.5) / 2;
  }
  let rms = 0;
  let exactZero = 0;
  for (const v of mono) {
    rms += v * v;
    if (v === 0) exactZero++;
  }
  const trace = [];
  for (let i = 0; i < frames; i += decimate) trace.push(mono[i]);
  return { trace, rms: Math.sqrt(rms / frames), exactZeroFraction: exactZero / frames };
};

const bestCorrelation = (a, b) => {
  let best = -Infinity;
  for (let lag = -8; lag <= 8; lag++) {
    const x = lag >= 0 ? a.slice(lag) : a;
    const y = lag >= 0 ? b : b.slice(-lag);
    best = Math.max(best, pearson(x, y));
  }
  return best;
};

describe('AudioWorklet in a real browser', function() {
  this.timeout(60000);

  before(function() {
    // Fail loudly when the dedicated command runs without a browser; skip only
    // when the caller opted in. A silent skip is how the job passed with zero
    // tests.
    if (!chromium) {
      if (OPTIONAL) {
        this.skip();
        return;
      }
      throw new Error(`Playwright is required to verify browser audio. ${loadError ? loadError.message : ''}`);
    }
  });

  const renderWith = async targetLatencySeconds => {
    const server = serve();
    await new Promise(resolve => server.listen(0, 'localhost', resolve));
    const port = server.address().port;
    // --no-sandbox is required on CI runners. localhost is a guaranteed secure
    // context, which the AudioWorklet module load needs.
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${port}/`, { timeout: 15000 });
      return await page.evaluate(opts => window.renderThroughWorklet(opts), {
        workletUrl: `http://localhost:${port}/audio.worklet.js`,
        samplesB64: fs.readFileSync(CAPTURE).toString('base64'),
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

    // Gate fingerprint: genuine silence (byte 129) decodes to zero, so the
    // reference has some; an excess is the noise gate flattening quiet audio.
    const zeroExcess = result.exactlyZeroFraction - ideal.exactZeroFraction;
    assert(zeroExcess < 0.015, `${(zeroExcess * 100).toFixed(1)}% more exact-zero samples than the reference — the noise gate is back`);

    // Shape: pass-through at a native rate, lag-searched past the priming delay.
    const correlation = bestCorrelation(result.trace, ideal.trace);
    assert(correlation > 0.95, `waveform correlation ${correlation.toFixed(4)} below 0.95 — the DSP is colouring the signal`);
  });
});
