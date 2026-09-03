#!/usr/bin/env node
// Hash video and work RAM straight after a fresh load, before the game has run.
// Independent of what any particular ROM does with memory, so it catches
// non-deterministic startup state that a game-specific test would miss.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
}

(async () => {
  const { WasmBoy } = require('../../../dist/wasmboy.wasm.cjs.js');

  await WasmBoy.config({
    headless: true,
    gameboySpeed: 100.0,
    isGbcEnabled: true,
    randomizeStartupRam: args.randomize === 'true'
  });
  await WasmBoy.loadROM(new Uint8Array(fs.readFileSync(path.resolve(args.rom))));

  const hash = crypto.createHash('sha256');
  let nonZero = 0;
  let total = 0;

  for (const region of ['WORK_RAM', 'VIDEO_RAM']) {
    const location = await WasmBoy._getWasmConstant(`${region}_LOCATION`);
    const size = await WasmBoy._getWasmConstant(`${region}_SIZE`);
    const bytes = await WasmBoy._getWasmMemorySection(location, location + size);
    hash.update(Buffer.from(bytes));
    nonZero += bytes.filter(byte => byte !== 0).length;
    total += bytes.length;
  }

  console.log(JSON.stringify({ hash: hash.digest('hex'), nonZero, total }));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
