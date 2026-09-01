// Type-level checks for lib/types/index.d.ts.
//
// This file is never executed and never bundled; `npm run test:types` compiles
// it so the published type definitions stay in step with the library's actual
// surface. Anything the emulator can do from JavaScript should be expressible
// here without a cast.

import { WasmBoy, WasmBoyConfig, SaveState, ParsedSaveState, JoypadState } from '../../lib/types';

const neutralJoypad: JoypadState = {
  UP: false,
  RIGHT: false,
  DOWN: false,
  LEFT: false,
  A: false,
  B: false,
  SELECT: false,
  START: false
};

// Externally hosted assets, for deployments whose CSP forbids blob: and data:.
const cspConfig: WasmBoyConfig = {
  headless: true,
  isGbcEnabled: true,
  workerUrls: {
    lib: '/assets/wasmboy/worker/wasmboy.wasm.worker.js',
    graphics: '/assets/wasmboy/worker/graphics.worker.js',
    audio: '/assets/wasmboy/worker/audio.worker.js',
    controller: '/assets/wasmboy/worker/controller.worker.js',
    memory: '/assets/wasmboy/worker/memory.worker.js'
  },
  wasmCoreUrl: '/assets/wasmboy/core/core.untouched.wasm',
  audioWorkletDirectOutput: true,
  audioTargetLatencyInSeconds: 0.028,
  setCanvasCallback: canvasElement => {
    const width: number = canvasElement.width;
    return width;
  }
};

const headlessRun = async (): Promise<void> => {
  await WasmBoy.config(cspConfig);

  // A string ROM resolves as a file path when headless.
  await WasmBoy.loadROM('./test/performance/testroms/tobutobugirl/tobutobugirl.gb');

  // setJoypadState resolves once the core has the state, so it is awaitable and
  // a press can be sequenced against the frame it should affect.
  await WasmBoy.setJoypadState({ ...neutralJoypad, START: true });
  await WasmBoy._runWasmExport('executeMultipleFrames', [1]);
  await WasmBoy.setJoypadState(neutralJoypad);

  // Frame capture works without a canvas.
  const frame: Uint8ClampedArray = await WasmBoy.screenshot();
  const samples: number = frame.length;

  // Save states identify the version that produced them.
  const saveState: SaveState = await WasmBoy.saveState();
  const producedBy: string | undefined = saveState.wasmboyVersion;

  // A save state that has been through JSON round-tripping loads too.
  const parsed: ParsedSaveState = JSON.parse(JSON.stringify(saveState));
  await WasmBoy.loadState(parsed);
  await WasmBoy.loadState(saveState);

  if (samples !== 160 * 144 * 4 || producedBy === '') {
    throw new Error('unreachable; keeps the bindings used');
  }
};

export default headlessRun;
