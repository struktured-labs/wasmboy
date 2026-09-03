// Common test functions
const commonTest = require('../common-test');

// Wasm Boy library
const WasmBoy = require('../../dist/wasmboy.wasm.cjs').WasmBoy;

// File management
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Assertion
const assert = require('assert');

// Golden file handling
const { goldenFileCompareOrCreate } = require('../golden-compare');

// Some Timeouts for specified test roms
const TEST_ROM_DEFAULT_TIMEOUT = 7500;
const TEST_ROM_TIMEOUT = {};
TEST_ROM_TIMEOUT['cpu_instrs/cpu_instrs.gb'] = 20500;
TEST_ROM_TIMEOUT['cgb_sound/cgb_sound.gb'] = 25500;

// Print our version
console.log(`WasmBoy version: ${WasmBoy.getVersion()}`);

WasmBoy.config({
  headless: true,
  gameboySpeed: 100.0,
  isGbcEnabled: true
});

const resetWasmBoyAccuracy = async () => {
  // Initialize wasmBoy headless, with a speed option
  await WasmBoy.reset({
    headless: true,
    gameboySpeed: 100.0,
    isGbcEnabled: true
  });
};

const resetWasmBoyPerformance = async () => {
  // Initialize wasmBoy headless, with a speed option
  await WasmBoy.reset({
    headless: true,
    gameboySpeed: 100.0,
    isGbcEnabled: true,
    audioBatchProcessing: true,
    audioAccumulateSamples: true,
    tileRendering: true,
    tileCaching: true
  });
};

// Audio Golden Test
// TODO: Remove this with an actual accuracy
// sound test
describe('audio golden test', () => {
  // Define our wasmboy instance
  // Not using arrow functions, as arrow function timeouts were acting up
  beforeEach(function(done) {
    // Set a timeout of 7500, takes a while for wasm module to parse
    this.timeout(7500);

    const asyncTask = async () => {
      await resetWasmBoyAccuracy();

      // Read the test rom a a Uint8Array and pass to wasmBoy
      const testRomArray = new Uint8Array(fs.readFileSync('./test/performance/testroms/back-to-color/back-to-color.gbc'));

      await WasmBoy.loadROM(testRomArray);
      done();
    };
    asyncTask().catch(done);
  });

  it('should have the same audio buffer', function(done) {
    // Set our timeout
    this.timeout(TEST_ROM_DEFAULT_TIMEOUT + 2000);

    const asyncTask = async () => {
      // Run some frames
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('clearAudioBuffer');
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);

      // Execute a few frames
      const memoryStart = await WasmBoy._getWasmConstant('AUDIO_BUFFER_LOCATION');
      const memorySize = await WasmBoy._getWasmConstant('AUDIO_BUFFER_SIZE');
      // - 20 to not include the overrun in the audio buffer
      const memory = await WasmBoy._getWasmMemorySection(memoryStart, memoryStart + memorySize - 20);

      // Get the memory as a normal array
      const audioArray = [];
      for (let i = 0; i < memory.length; i++) {
        audioArray.push(memory[i]);
      }

      goldenFileCompareOrCreate('./test/accuracy/sound-test.golden.output.json', audioArray);
      done();
    };
    asyncTask().catch(done);
  });
});

// Common mobile options tests
describe('performance options golden test', () => {
  // Define our wasmboy instance
  // Not using arrow functions, as arrow function timeouts were acting up
  beforeEach(function(done) {
    // Set a timeout of 7500, takes a while for wasm module to parse
    this.timeout(7500);

    const asyncTask = async () => {
      await resetWasmBoyPerformance();

      // Read the test rom a a Uint8Array and pass to wasmBoy
      const testRomArray = new Uint8Array(fs.readFileSync('./test/performance/testroms/tobutobugirl/tobutobugirl.gb'));

      await WasmBoy.loadROM(testRomArray);
      done();
    };
    asyncTask().catch(done);
  });

  it('should have the same graphics / audio buffer', function(done) {
    // Set our timeout
    this.timeout(TEST_ROM_DEFAULT_TIMEOUT + 2000);

    const asyncTask = async () => {
      // Run some frames
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('clearAudioBuffer');
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);
      await WasmBoy._runWasmExport('executeMultipleFrames', [60]);

      // Compare graphics
      const graphicsMemoryStart = await WasmBoy._getWasmConstant('FRAME_LOCATION');
      const graphicsMemorySize = await WasmBoy._getWasmConstant('FRAME_SIZE');
      // - 20 to not include the overrun in the audio buffer
      const graphicsMemory = await WasmBoy._getWasmMemorySection(graphicsMemoryStart, graphicsMemoryStart + graphicsMemorySize);

      // Get the memory as a normal array
      const graphicsArray = [];
      for (let i = 0; i < graphicsMemory.length; i++) {
        graphicsArray.push(graphicsMemory[i]);
      }

      goldenFileCompareOrCreate('./test/accuracy/performance-options-test.graphics.golden.output.json', graphicsArray);

      // Compare audio
      const audioMemoryStart = await WasmBoy._getWasmConstant('AUDIO_BUFFER_LOCATION');
      const audioMemorySize = await WasmBoy._getWasmConstant('AUDIO_BUFFER_SIZE');
      // - 20 to not include the overrun in the audio buffer
      const audioMemory = await WasmBoy._getWasmMemorySection(audioMemoryStart, audioMemoryStart + audioMemorySize - 20);

      // Get the memory as a normal array
      const audioArray = [];
      for (let i = 0; i < audioMemory.length; i++) {
        audioArray.push(audioMemory[i]);
      }

      goldenFileCompareOrCreate('./test/accuracy/performance-options-test.sound.golden.output.json', audioArray);

      done();
    };
    asyncTask().catch(done);
  });
});

// Graphical Golden Test(s)
// Simply screenshot the end result of the accuracy test
const testRomsPath = './test/accuracy/testroms';

commonTest.getDirectories(testRomsPath).forEach(directory => {
  // Get all test roms for the directory
  const testRoms = commonTest.getAllRomsInDirectory(directory);

  // Create a describe for the directory
  describe(directory, () => {
    // Describe for each test rom
    testRoms.forEach(testRom => {
      describe(testRom, () => {
        const timeToWaitForTestRom = TEST_ROM_TIMEOUT[testRom] || TEST_ROM_DEFAULT_TIMEOUT;

        it('should match the expected output in the .output file. If it does not exist, create the file.', function() {
          const childTimeout = timeToWaitForTestRom + 25000;
          this.timeout(childTimeout + 5000);

          const helper = path.resolve(__dirname, 'helpers/run-accuracy-rom.js');
          try {
            execFileSync(
              process.execPath,
              [helper, '--dir', directory, '--rom', testRom, '--wait', String(timeToWaitForTestRom)],
              {
                encoding: 'utf8',
                stdio: ['ignore', 'ignore', 'pipe'],
                timeout: childTimeout
              }
            );
          } catch (error) {
            const detail = String(error.stderr || error.message || '').trim();
            throw new Error(`${testRom} did not match its golden output: ${detail}`);
          }
        });
      });
    });
  });
});
