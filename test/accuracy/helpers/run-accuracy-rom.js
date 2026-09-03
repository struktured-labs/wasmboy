#!/usr/bin/env node
// Run one accuracy ROM in a fresh process and compare its frame to the golden.
// A fresh process is a real power cycle: the library singleton retains emulator
// memory across reset(), so ROMs sharing a process leak state into each other.
// Exits 0 on match (or golden created), non-zero with the message on mismatch.
const fs = require('fs');
const path = require('path');

const { WasmBoy } = require('../../../dist/wasmboy.wasm.cjs.js');
const commonTest = require('../../common-test');
const { goldenImageDataArrayCompare } = require('../../golden-compare');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
}

const directory = args.dir;
const testRom = args.rom;
const waitMs = parseInt(args.wait, 10);

const main = async () => {
  await WasmBoy.reset({ headless: true, gameboySpeed: 100.0, isGbcEnabled: true });
  await WasmBoy.loadROM(new Uint8Array(fs.readFileSync(path.join(directory, testRom))));

  await WasmBoy.play();
  await new Promise(resolve => setTimeout(resolve, waitMs));
  await WasmBoy.pause();

  const goldenFile = path.join(directory, testRom.replace('.gb', '.golden.output.json'));
  const imageDataArray = await commonTest.getImageDataFromFrame();
  await goldenImageDataArrayCompare(goldenFile, imageDataArray, directory, testRom);
};

main()
  .then(() => process.exit(0))
  .catch(error => {
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exit(1);
  });
