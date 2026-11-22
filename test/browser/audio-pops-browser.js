// Regression: no clicks when a slow device starves the audio queue.
//
// Reported on the Tesla in-car browser (Chromium on a weak CPU): popping. The
// producer there misses deadlines, the ring runs dry, and the worklet cut the
// output to exactly zero and jumped back when blocks resumed — a click at each
// edge. This replays a seeded late-and-bursty delivery schedule through the
// built worklet in headless Chromium, at the 44.1 kHz context the player asks
// for and at 48 kHz (what a device gets when the requested rate is refused),
// and counts sample-to-sample jumps that a clean tone cannot make.
//
// The page is served without COOP/COEP, so it is not cross-origin isolated and
// SharedArrayBuffer is unavailable — the path a car browser takes. The audio
// path must not need it.
//
// Realtime CPU throttling is measured separately (Quintra's
// tools/measure_web_audio_pops.mjs, against a real game in a real browser);
// it is not reproducible enough to gate on. The stall schedule here is the
// deterministic stand-in for it.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HERE = __dirname;
const WORKLET = process.env.WASMBOY_WORKLET || path.join(HERE, '..', '..', 'dist', 'worker', 'audio.worklet.js');
const OPTIONAL = process.env.WASMBOY_BROWSER_OPTIONAL === '1';

let chromium;
let loadError;
try {
  chromium = require('playwright').chromium;
} catch (error) {
  loadError = error;
}

const serve = () =>
  http.createServer((req, res) => {
    const routes = {
      '/': { file: path.join(HERE, 'driver.html'), type: 'text/html' },
      '/audio.worklet.js': { file: WORKLET, type: 'application/javascript' }
    };
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

// A weak CPU (CDP 4-6x throttling is the realtime analogue): the producer
// manages 92% of real time, stalls 80 ms every ~0.46 s (main-thread work, GC),
// and every block lands up to 60% of a block early or late. The steady schedule is the control: it must be click-free both
// before and after, or the detector is measuring the tone, not the fault.
const STARVED = { seconds: 6, stallEveryBlocks: 40, stallMs: 80, jitter: 0.6, producerSpeed: 0.92 };
const STEADY = { seconds: 3, stallEveryBlocks: 0, stallMs: 0, jitter: 0.2 };

describe('AudioWorklet under a starved producer', function() {
  this.timeout(120000);
  let browser;
  let server;
  let port;
  const results = {};

  before(async function() {
    if (!chromium) {
      if (OPTIONAL) {
        this.skip();
        return;
      }
      throw new Error(`Playwright is required to verify browser audio. ${loadError ? loadError.message : ''}`);
    }
    server = serve();
    await new Promise(resolve => server.listen(0, 'localhost', resolve));
    port = server.address().port;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    if (Object.keys(results).length) console.log('      pops:', JSON.stringify(results));
  });

  const run = async (contextRate, schedule) => {
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${port}/`, { timeout: 15000 });
      return await page.evaluate(opts => window.renderStarved(opts), {
        workletUrl: `http://localhost:${port}/audio.worklet.js`,
        contextRate,
        targetLatencySeconds: 0.042,
        ...schedule
      });
    } finally {
      await page.close();
    }
  };

  [44100, 48000].forEach(rate => {
    it(`plays a steady tone click-free at ${rate} Hz`, async () => {
      const r = await run(rate, STEADY);
      results[`steady@${rate}`] = r.pops;
      assert.strictEqual(r.contextRate, rate);
      assert.strictEqual(r.crossOriginIsolated, false, 'driver must run without SharedArrayBuffer');
      assert.strictEqual(r.pops, 0, `steady delivery clicked ${r.pops} times (largest step ${r.largestStep.toFixed(4)})`);
    });

    it(`does not click when starved at ${rate} Hz`, async () => {
      const r = await run(rate, STARVED);
      results[`starved@${rate}`] = {
        pops: r.pops,
        underrunFrames: r.underrunFrames,
        underrunEvents: r.underrunEvents,
        targetS: r.finalTargetSeconds
      };
      assert.strictEqual(r.crossOriginIsolated, false);
      // The schedule must actually starve the queue, or zero clicks is vacuous.
      assert.ok(r.underrunFrames > 0.2 * rate, `schedule did not starve the queue (${r.underrunFrames} underrun frames)`);
      assert.ok(r.underrunEvents > 0, 'no underrun episodes reported');
      assert.ok(r.finalTargetSeconds > 0.042, `target did not adapt (${r.finalTargetSeconds})`);
      assert.strictEqual(
        r.pops,
        0,
        `${r.pops} clicks under starvation (largest step ${r.largestStep.toFixed(4)} > ${r.threshold.toFixed(4)}, ${
          r.underrunFrames
        } underrun frames)`
      );
    });
  });
});
