// Test the general WasmBoy Library

// Common test functions
const commonTest = require('../common-test');

// Wasm Boy library
const WasmBoy = require('../../dist/wasmboy.wasm.cjs.js').WasmBoy;

// File management
const fs = require('fs');

// Assertion
const assert = require('assert');

// Initialize wasmBoy headless, with a speed option
const WASMBOY_INITIALIZE_OPTIONS = {
  headless: true,
  gameboySpeed: 100.0,
  isGbcEnabled: true
};

const createFakeCanvas = () => {
  const context = {
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4)
    }),
    clearRect: () => {},
    putImageData: () => {}
  };

  return {
    width: 0,
    height: 0,
    style: '',
    getContext: type => {
      assert.strictEqual(type, '2d');
      return context;
    }
  };
};

const WasmBoyJoypadState = {
  UP: false,
  RIGHT: false,
  DOWN: false,
  LEFT: false,
  A: false,
  B: false,
  SELECT: false,
  START: false
};

// Function for playing WasmBoy for a short amount of time
const playWasmBoy = () => {
  let playResolve = undefined;
  const playPromise = new Promise(resolve => {
    playResolve = resolve;
  });

  WasmBoy.play().then(() => {
    setTimeout(() => {
      WasmBoy.pause().then(() => {
        playResolve();
      });
    }, 100);
  });

  return playPromise;
};

// Path to roms we want to test
const testRomsPath = './test/performance/testroms';
// Read the test rom a a Uint8Array and pass to wasmBoy
const getTestRomArray = () => new Uint8Array(fs.readFileSync(`${testRomsPath}/back-to-color/back-to-color.gbc`));

// Print our version
console.log(`WasmBoy version: ${WasmBoy.getVersion()}`);

describe('WasmBoy Lib', () => {
  // Define our wasmboy instance
  // Not using arrow functions, as arrow function timeouts were acting up
  beforeEach(function(done) {
    // Set a timeout of 5000, takes a while for wasm module to parse
    this.timeout(7500);

    // Reset WasmBoy, and then load the rom
    WasmBoy.config(WASMBOY_INITIALIZE_OPTIONS)
      .then(() => {
        return WasmBoy.loadROM(getTestRomArray());
      })
      .then(() => {
        done();
      });
  });

  it('should initialize work ram with random garbage bytes', async () => {
    const workRamLocation = await WasmBoy._getWasmConstant('WORK_RAM_LOCATION');
    const workRamSize = await WasmBoy._getWasmConstant('WORK_RAM_SIZE');
    const workRam = await WasmBoy._getWasmMemorySection(workRamLocation, workRamLocation + workRamSize);

    assert(
      workRam.some(value => value !== 0),
      true
    );
  });

  it('should be able to save/load state', async () => {
    // Play a snippet of WasmBoy
    await playWasmBoy();

    // Save State
    const saveState = await WasmBoy.saveState();

    // Play a snippet of WasmBoy
    await playWasmBoy();

    // Load State
    await WasmBoy.loadState(saveState);

    // Save State
    const saveStateTwo = await WasmBoy.saveState();

    // Save State should be the same
    const saveStateInternalState = new Uint8Array(saveState.wasmboyMemory.wasmBoyInternalState);
    const saveStateTwoInternalState = new Uint8Array(saveState.wasmboyMemory.wasmBoyInternalState);
    for (let i = 0; i < saveStateInternalState.length; i++) {
      assert(saveStateInternalState[i] === saveStateTwoInternalState[i], true);
    }
  });

  it('should load a ROM from a file path in headless mode', async () => {
    await WasmBoy.config(WASMBOY_INITIALIZE_OPTIONS);
    await WasmBoy.loadROM(`${testRomsPath}/back-to-color/back-to-color.gbc`);

    assert.strictEqual(WasmBoy.isReady(), true);
  });

  it('should report playing state inside the onPlay callback', async () => {
    let onPlayIsPlaying = undefined;

    await WasmBoy.config({
      ...WASMBOY_INITIALIZE_OPTIONS,
      onPlay: () => {
        onPlayIsPlaying = WasmBoy.isPlaying();
      }
    });
    await WasmBoy.loadROM(getTestRomArray());

    await WasmBoy.play();
    await WasmBoy.pause();

    assert.strictEqual(onPlayIsPlaying, true);
  });

  it('should be able to get a screenshot image data array', async () => {
    await playWasmBoy();

    const screenshot = await WasmBoy.screenshot();

    assert(screenshot instanceof Uint8ClampedArray);
    assert.strictEqual(screenshot.length, 160 * 144 * 4);
    assert.strictEqual(screenshot[3], 255);
  });

  it('should tag save states with the WasmBoy version', async () => {
    const saveState = await WasmBoy.saveState();

    assert.strictEqual(saveState.wasmboyVersion, WasmBoy.getVersion());
  });

  it('should be able to load a JSON parsed save state', async () => {
    await playWasmBoy();

    const saveState = await WasmBoy.saveState();
    const parsedSaveState = JSON.parse(JSON.stringify(saveState, (key, value) => (ArrayBuffer.isView(value) ? Array.from(value) : value)));

    await playWasmBoy();

    await WasmBoy.loadState(parsedSaveState);

    const saveStateAfterLoad = await WasmBoy.saveState();
    assert(new Uint8Array(saveStateAfterLoad.wasmboyMemory.wasmBoyInternalState).length > 0);
    assert(new Uint8Array(saveStateAfterLoad.wasmboyMemory.wasmBoyPaletteMemory).length > 0);
    assert(new Uint8Array(saveStateAfterLoad.wasmboyMemory.gameBoyMemory).length > 0);
    assert(new Uint8Array(saveStateAfterLoad.wasmboyMemory.cartridgeRam).length > 0);
  });

  it('should call the set canvas callback after setting a canvas', async () => {
    const canvasElement = createFakeCanvas();
    let callbackCanvasElement = undefined;

    await WasmBoy.config({
      ...WASMBOY_INITIALIZE_OPTIONS,
      setCanvasCallback: nextCanvasElement => {
        callbackCanvasElement = nextCanvasElement;
      }
    });

    await WasmBoy.setCanvas(canvasElement);

    assert.strictEqual(callbackCanvasElement, canvasElement);
    assert.strictEqual(WasmBoy.getCanvas(), canvasElement);
  });

  it('should let manual joypad state take over default polling', async () => {
    const responsiveGamepad = WasmBoy.ResponsiveGamepad;
    const backends = [responsiveGamepad.Keyboard, responsiveGamepad.Gamepad, responsiveGamepad.TouchInput];
    const originals = backends.map(backend => ({
      backend,
      enable: backend.enable,
      disable: backend.disable
    }));

    backends.forEach(backend => {
      backend.enable = () => {};
      backend.disable = () => {};
    });

    try {
      WasmBoy.enableDefaultJoypad();
      assert.strictEqual(responsiveGamepad.isEnabled(), true);

      const setJoypadStatePromise = WasmBoy.setJoypadState({
        ...WasmBoyJoypadState,
        UP: true
      });

      assert.strictEqual(typeof setJoypadStatePromise.then, 'function');

      await setJoypadStatePromise;
      assert.strictEqual(responsiveGamepad.isEnabled(), false);
    } finally {
      if (responsiveGamepad.isEnabled()) {
        WasmBoy.disableDefaultJoypad();
      }

      originals.forEach(original => {
        original.backend.enable = original.enable;
        original.backend.disable = original.disable;
      });
    }
  });

  it('should keep externally hosted worker and wasm asset URLs in config', async () => {
    const workerUrls = {
      lib: '/assets/wasmboy/worker/wasmboy.wasm.worker.js',
      graphics: '/assets/wasmboy/worker/graphics.worker.js',
      audio: '/assets/wasmboy/worker/audio.worker.js',
      controller: '/assets/wasmboy/worker/controller.worker.js',
      memory: '/assets/wasmboy/worker/memory.worker.js'
    };
    const wasmCoreUrl = '/assets/wasmboy/core/core.untouched.wasm';

    await WasmBoy.config({
      ...WASMBOY_INITIALIZE_OPTIONS,
      workerUrls,
      wasmCoreUrl
    });

    const config = WasmBoy.getConfig();
    assert.deepStrictEqual(config.workerUrls, workerUrls);
    assert.strictEqual(config.wasmCoreUrl, wasmCoreUrl);
  });

  it('should save loadable state when frames were driven without play', async () => {
    // Headless callers advance frames directly and never start the play loop,
    // which is the only thing that pushes memory back from the worker.
    await WasmBoy.config(WASMBOY_INITIALIZE_OPTIONS);
    await WasmBoy.loadROM(getTestRomArray());
    await WasmBoy._runWasmExport('executeMultipleFrames', [60]);

    const saveState = await WasmBoy.saveState();

    Object.keys(saveState.wasmboyMemory).forEach(key => {
      const memory = saveState.wasmboyMemory[key];
      assert(memory !== undefined, `${key} was undefined`);
      assert(memory.length > 0, `${key} was empty`);
    });

    // A state whose memory is missing still serializes and still looks like a
    // save state, and only fails later on load, so load it here.
    await WasmBoy.loadState(saveState);
  });

  it('should keep save state memory typed after loading a state', async () => {
    await playWasmBoy();

    const saveState = await WasmBoy.saveState();
    await WasmBoy.loadState(saveState);

    const afterLoad = await WasmBoy.saveState();
    Object.keys(afterLoad.wasmboyMemory).forEach(key => {
      assert(afterLoad.wasmboyMemory[key] instanceof Uint8Array, `${key} was not a Uint8Array`);
    });

    // The shape has to survive JSON, which is how states get persisted.
    const parsed = JSON.parse(JSON.stringify(afterLoad, (key, value) => (ArrayBuffer.isView(value) ? Array.from(value) : value)));
    assert(Array.isArray(parsed.wasmboyMemory.cartridgeRam), 'cartridgeRam did not survive JSON');
    await WasmBoy.loadState(parsed);
  });
});
