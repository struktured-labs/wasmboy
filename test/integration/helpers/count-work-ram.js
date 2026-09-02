// Reports how much work RAM is non-zero after a fresh load, for a given
// randomizeStartupRam setting. Runs standalone because memory is cleared only
// on the first load, so two settings cannot be measured in one process.
const fs = require('fs');
const path = require('path');
const { WasmBoy } = require('../../../dist/wasmboy.wasm.cjs.js');

const randomizeStartupRam = process.argv[2] === 'true';
const rom = path.resolve(__dirname, '../../performance/testroms/back-to-color/back-to-color.gbc');

(async () => {
  await WasmBoy.config({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true, randomizeStartupRam });
  await WasmBoy.loadROM(new Uint8Array(fs.readFileSync(rom)));

  const location = await WasmBoy._getWasmConstant('WORK_RAM_LOCATION');
  const size = await WasmBoy._getWasmConstant('WORK_RAM_SIZE');
  const ram = await WasmBoy._getWasmMemorySection(location, location + size);

  console.log(JSON.stringify({ nonZero: ram.filter(byte => byte !== 0).length, total: ram.length }));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
