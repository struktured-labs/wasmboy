// End-to-end smoke test from a consumer's point of view: install wasmboy as a
// dependency and drive a GBC ROM headlessly through the public API, exercising
// the features this fork added. This is the shape a game project would use for
// automated gameplay testing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Resolve the installed package from the scratch project this is run in,
// not from this file's own location inside the repo.
const resolveFromCwd = id => require(require.resolve(id, { paths: [process.cwd()] }));
const { WasmBoy } = resolveFromCwd('wasmboy');

const ROM = path.resolve(__dirname, '../performance/testroms/back-to-color/back-to-color.gbc');

const NEUTRAL = { UP: false, RIGHT: false, DOWN: false, LEFT: false, A: false, B: false, SELECT: false, START: false };

const frames = n => WasmBoy._runWasmExport('executeMultipleFrames', [n]);

const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    return 0;
  } catch (e) {
    console.log(`  FAIL  ${label}: ${e.message}`);
    return 1;
  }
};

const main = async () => {
  let failures = 0;
  console.log(`wasmboy version: ${WasmBoy.getVersion()}`);

  await WasmBoy.config({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true });

  // Headless string ROM paths (upstream-291).
  await WasmBoy.loadROM(ROM);
  failures += check('loads a GBC ROM from a file path headlessly', () => {
    assert.strictEqual(WasmBoy.isReady(), true);
  });

  // back-to-color.gbc runs a long intro; it is genuinely blank before ~frame 480.
  await frames(600);

  // Canvas-free frame capture (upstream-293).
  const shot = await WasmBoy.screenshot();
  failures += check('captures a frame without a canvas', () => {
    assert(shot instanceof Uint8ClampedArray);
    assert.strictEqual(shot.length, 160 * 144 * 4);
  });

  failures += check('the captured frame is not blank', () => {
    const distinct = new Set();
    for (let i = 0; i < shot.length; i += 4) distinct.add(shot[i]);
    assert(distinct.size > 1, `only ${distinct.size} distinct luminance value(s)`);
  });

  // Deterministic input (upstream-375): awaited presses land on the frame meant.
  await WasmBoy.setJoypadState({ ...NEUTRAL, START: true });
  await frames(1);
  await WasmBoy.setJoypadState(NEUTRAL);
  await frames(30);
  failures += check('accepts awaited joypad input', () => {
    assert.strictEqual(WasmBoy.isReady(), true);
  });

  // Save states carry a producer version (upstream-294) and survive JSON (upstream-314).
  const state = await WasmBoy.saveState();
  failures += check('save states record the producing version', () => {
    assert.strictEqual(state.wasmboyVersion, WasmBoy.getVersion());
  });

  const parsed = JSON.parse(JSON.stringify(state, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  await WasmBoy.loadState(parsed);
  failures += check('reloads a JSON round-tripped save state', () => {
    assert(parsed.wasmboyMemory.gameBoyMemory.length > 0, 'load consumed the caller state');
  });

  // Restoring one checkpoint repeatedly is the automated-testing pattern.
  const checkpoint = await WasmBoy.saveState();
  await frames(60);
  const expected = Buffer.from(await WasmBoy.screenshot());
  const restoreAndRun = async () => {
    await WasmBoy.loadState(checkpoint);
    await frames(60);
    return Buffer.from(await WasmBoy.screenshot());
  };
  const first = await restoreAndRun();
  const second = await restoreAndRun();
  failures += check('restores the same checkpoint twice', () => {
    assert.strictEqual(Buffer.compare(first, expected), 0, 'first restore diverged');
    assert.strictEqual(Buffer.compare(second, expected), 0, 'second restore diverged');
  });

  // Determinism: same ROM, same input, same frame — what gameplay testing needs.
  const captureAfterReset = async () => {
    await WasmBoy.reset({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true });
    await WasmBoy.loadROM(ROM);
    await frames(120);
    return WasmBoy.screenshot();
  };
  const runA = await captureAfterReset();
  const runB = await captureAfterReset();
  failures += check('two identical runs produce an identical frame', () => {
    assert.strictEqual(Buffer.compare(Buffer.from(runA), Buffer.from(runB)), 0);
  });

  // TypeScript definitions ship with the package.
  failures += check('ships TypeScript definitions', () => {
    const pkg = resolveFromCwd('wasmboy/package.json');
    const typesPath = require.resolve(`wasmboy/${pkg.types}`, { paths: [process.cwd()] });
    assert(fs.existsSync(typesPath), `missing ${pkg.types}`);
  });

  console.log(failures === 0 ? '\nALL CONSUMER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(e => {
  console.error('ERROR', e);
  process.exit(1);
});
