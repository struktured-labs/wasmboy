// https://github.com/torch2424/responsive-gamepad
import { ResponsiveGamepad } from 'responsive-gamepad';

import ResponsiveGamepadPluginGB from './gbplugin';

import { WORKER_MESSAGE_TYPE } from '../worker/constants';
import { getEventData } from '../worker/util';

const JOYPAD_INPUTS = ['UP', 'RIGHT', 'DOWN', 'LEFT', 'A', 'B', 'SELECT', 'START'];

class WasmBoyControllerService {
  constructor() {
    // Our wasm instance
    this.worker = undefined;
    this.isEnabled = false;
    this.virtualJoypadState = undefined;

    // Bind Repsonsive Gamepad to this
    this.ResponsiveGamepad = ResponsiveGamepad;

    ResponsiveGamepad.addPlugin(ResponsiveGamepadPluginGB());
  }

  initialize() {
    if (!this.isEnabled) {
      this.enableDefaultJoypad();
    }

    return Promise.resolve();
  }

  setWorker(worker) {
    this.worker = worker;
  }

  updateController() {
    if (!this.isEnabled && !this.virtualJoypadState) {
      return {};
    }

    const controllerState = this.getJoypadState();

    // Set the new controller state on the instance
    this.setJoypadState(controllerState);

    // Return the controller state in case we need something from it
    return controllerState;
  }

  getJoypadState() {
    const controllerState = this.isEnabled ? Object.assign({}, ResponsiveGamepad.getState()) : {};
    if (this.virtualJoypadState) {
      JOYPAD_INPUTS.forEach(input => {
        controllerState[input] = !!controllerState[input] || this.virtualJoypadState[input];
      });
    }
    return controllerState;
  }

  setVirtualJoypadState(controllerState) {
    if (!controllerState) {
      this.clearVirtualJoypadState();
      return;
    }
    this.virtualJoypadState = {};
    JOYPAD_INPUTS.forEach(input => {
      this.virtualJoypadState[input] = !!controllerState[input];
    });
  }

  clearVirtualJoypadState() {
    this.virtualJoypadState = undefined;
    if (!this.isEnabled && this.worker) this.setJoypadState({});
  }

  setJoypadState(controllerState) {
    const setJoypadStateParamsAsArray = [
      controllerState.UP ? 1 : 0,
      controllerState.RIGHT ? 1 : 0,
      controllerState.DOWN ? 1 : 0,
      controllerState.LEFT ? 1 : 0,
      controllerState.A ? 1 : 0,
      controllerState.B ? 1 : 0,
      controllerState.SELECT ? 1 : 0,
      controllerState.START ? 1 : 0
    ];

    this.worker.postMessageIgnoreResponse({
      type: WORKER_MESSAGE_TYPE.SET_JOYPAD_STATE,
      setJoypadStateParamsAsArray
    });
  }

  enableDefaultJoypad() {
    this.isEnabled = true;

    ResponsiveGamepad.enable();
  }

  disableDefaultJoypad() {
    this.isEnabled = false;

    ResponsiveGamepad.disable();
  }
}

export const WasmBoyController = new WasmBoyControllerService();
