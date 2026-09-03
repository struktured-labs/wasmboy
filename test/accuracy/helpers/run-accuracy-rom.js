#!/usr/bin/env node
// A fresh process prevents one ROM's memory from leaking through reset().
const fs = require('fs');
const path = require('path');

const { WasmBoy } = require('../../../dist/wasmboy.wasm.cjs.js');
const commonTest = require('../../common-test');
const { goldenImageDataArrayCompare } = require('../../golden-compare');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
}

const main = async () => {
  const waitMs = parseInt(args.wait, 10);
  const romPath = path.join(args.dir, args.rom);
  const goldenPath = path.join(args.dir, args.rom.replace('.gb', '.golden.output.json'));

  await WasmBoy.config({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true });
  await WasmBoy.loadROM(new Uint8Array(fs.readFileSync(romPath)));
  await WasmBoy.play();
  await new Promise(resolve => setTimeout(resolve, waitMs));
  await WasmBoy.pause();

  const frame = await commonTest.getImageDataFromFrame();
  await goldenImageDataArrayCompare(goldenPath, frame, args.dir, args.rom);
};

main()
  .then(() => process.exit(0))
  .catch(error => {
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exit(1);
  });
