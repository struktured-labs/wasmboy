#!/usr/bin/env node
// Render a ROM to a frame and print its hash, through either the core alone or
// the whole library. Runs standalone so each measurement gets a fresh process:
// the library is a singleton that clears memory only on first load, so two
// measurements in one process would report the first one's leftovers.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FRAME_BYTES = 160 * 144 * 3;

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
}

const romBytes = new Uint8Array(fs.readFileSync(path.resolve(args.rom)));
const frames = parseInt(args.frames, 10);

// The library sends these for its default options. The core has to be given the
// same ones or the two are not comparable.
const CORE_CONFIG = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0];

const renderThroughCore = async () => {
  const getWasmBoyCore = require('../../../dist/core/getWasmBoyWasmCore.cjs.js');
  const core = await getWasmBoyCore();
  const wasmboy = core.instance.exports;
  const memory = new Uint8Array(wasmboy.memory.buffer);

  memory.set(romBytes, wasmboy.CARTRIDGE_ROM_LOCATION);
  wasmboy.config.apply(null, CORE_CONFIG);
  wasmboy.executeMultipleFrames(frames);

  return Buffer.from(memory.slice(wasmboy.FRAME_LOCATION, wasmboy.FRAME_LOCATION + FRAME_BYTES));
};

const renderThroughLib = async () => {
  const { WasmBoy } = require('../../../dist/wasmboy.wasm.cjs.js');

  await WasmBoy.config({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true });
  await WasmBoy.loadROM(romBytes);

  // The worker RPC times out after one second by default. A cold CI runner can
  // take longer than that to run several hundred frames, which surfaces as a
  // spurious "Message dropped". Run in small batches with a generous timeout so
  // slowness never reads as a failure.
  const BATCH = 60;
  const TIMEOUT_MS = 30000;
  for (let done = 0; done < frames; done += BATCH) {
    await WasmBoy._runWasmExport('executeMultipleFrames', [Math.min(BATCH, frames - done)], TIMEOUT_MS);
  }

  const location = await WasmBoy._getWasmConstant('FRAME_LOCATION');
  return Buffer.from(await WasmBoy._getWasmMemorySection(location, location + FRAME_BYTES));
};

(async () => {
  const frame = args.path === 'core' ? await renderThroughCore() : await renderThroughLib();
  console.log(crypto.createHash('sha256').update(frame).digest('hex'));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
