const assert = require('assert');
const WasmBoy = require('../../dist/wasmboy.wasm.cjs.js').WasmBoy;

describe('WasmBoy virtual controller', () => {
  afterEach(() => WasmBoy.clearVirtualJoypadState());

  it('normalizes and exposes virtual inputs', () => {
    WasmBoy.setVirtualJoypadState({ UP: 1, A: true });

    assert.deepStrictEqual(WasmBoy.getJoypadState(), {
      UP: true,
      RIGHT: false,
      DOWN: false,
      LEFT: false,
      A: true,
      B: false,
      SELECT: false,
      START: false
    });
  });

  it('clears virtual inputs', () => {
    WasmBoy.setVirtualJoypadState({ B: true });
    WasmBoy.clearVirtualJoypadState();

    assert.deepStrictEqual(WasmBoy.getJoypadState(), {});
  });
});
