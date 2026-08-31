// WasmBoy Type Definitions
// https://github.com/torch2424/wasmBoy

// =============================================================================
// GBC Colorization Palette Options
// =============================================================================

/**
 * Valid GBC colorization palette names for original Game Boy games
 */
export type GbcColorizationPalette =
  | 'wasmboygb'
  | 'brown'
  | 'red'
  | 'darkbrown'
  | 'green'
  | 'darkgreen'
  | 'inverted'
  | 'pastelmix'
  | 'orange'
  | 'yellow'
  | 'blue'
  | 'darkblue'
  | 'grayscale';

// =============================================================================
// Save State Types
// =============================================================================

/**
 * Internal memory state stored in a save state
 */
export interface WasmBoyMemoryState {
  /** Internal emulator state */
  wasmBoyInternalState: Uint8Array;
  /** Palette memory for GBC */
  wasmBoyPaletteMemory: Uint8Array;
  /** Game Boy memory (VRAM, WRAM, etc.) */
  gameBoyMemory: Uint8Array;
  /** Cartridge RAM (battery-backed save data) */
  cartridgeRam: Uint8Array;
}

/**
 * A save state snapshot of the emulator
 */
export interface SaveState {
  /** The memory state at the time of save */
  wasmboyMemory: WasmBoyMemoryState;
  /** Timestamp when the save state was created */
  date: number;
  /** Whether this is an auto-save state */
  isAuto: boolean;
  /** Version of WasmBoy that produced this save state */
  wasmboyVersion?: string;
}

/**
 * A save state that has been through JSON.parse, so its typed arrays have
 * decayed to plain number arrays. `loadState` accepts this shape as well.
 */
export interface ParsedSaveState {
  wasmboyMemory: { [K in keyof WasmBoyMemoryState]: Uint8Array | number[] };
  date: number;
  isAuto: boolean;
  wasmboyVersion?: string;
}

// =============================================================================
// Cartridge Types
// =============================================================================

/**
 * Detailed information about the loaded cartridge ROM
 */
export interface CartridgeInfo {
  /** Raw cartridge header bytes */
  header: Uint8Array;
  /** Complete ROM data */
  ROM: Uint8Array;
  /** Cartridge RAM data (if any) */
  RAM: Uint8Array | undefined;
  /** Nintendo logo bytes (0x104-0x133) */
  nintendoLogo: Uint8Array;
  /** Game title bytes (0x134-0x143) */
  title: Uint8Array;
  /** Game title as string */
  titleAsString: string;
  /** Manufacturer code (0x13F-0x142) */
  manufacturerCode: Uint8Array;
  /** CGB flag (0x143) - 0x80 = GBC compatible, 0xC0 = GBC only */
  CGBFlag: number;
  /** New licensee code (0x144-0x145) */
  newLicenseeCode: Uint8Array;
  /** SGB flag (0x146) */
  SGBFlag: number;
  /** Cartridge type (0x147) - indicates MBC type and features */
  cartridgeType: number;
  /** ROM size code (0x148) */
  ROMSize: number;
  /** RAM size code (0x149) */
  RAMSize: number;
  /** Destination code (0x14A) - 0x00 = Japan, 0x01 = Overseas */
  destinationCode: number;
  /** Old licensee code (0x14B) */
  oldLicenseeCode: number;
  /** Mask ROM version number (0x14C) */
  maskROMVersionNumber: number;
  /** Header checksum (0x14D) */
  headerChecksum: number;
  /** Global checksum (0x14E-0x14F) */
  globalChecksum: Uint8Array;
}

/**
 * Saved cartridge ROM information
 */
export interface CartridgeRom {
  /** ROM data */
  ROM: Uint8Array;
  /** Cartridge header */
  header: Uint8Array;
  /** Original file name */
  fileName: string;
  /** Date when saved */
  date: number;
  /** Additional user-provided info */
  [key: string]: unknown;
}

/**
 * A saved cartridge object stored in IndexedDB
 */
export interface CartridgeObject {
  /** Saved ROM information */
  cartridgeRom?: CartridgeRom;
  /** Cartridge info parsed from header */
  cartridgeInfo?: CartridgeInfo;
  /** Battery-backed RAM */
  cartridgeRam?: Uint8Array;
  /** Array of save states for this cartridge */
  saveStates?: SaveState[];
}

// =============================================================================
// Load Options
// =============================================================================

/**
 * Options for loading ROM files from URLs
 */
export interface LoadOptions {
  /** HTTP headers to use when fetching ROM from URL */
  headers?: Record<string, string>;
  /** Override the filename (used for save identification) */
  fileName?: string;
}

// =============================================================================
// Boot ROM Types
// =============================================================================

/**
 * Supported boot ROM types
 */
export type BootROMType = 'GB' | 'GBC';

/**
 * A saved boot ROM object
 */
export interface BootROMObject {
  /** Boot ROM data */
  ROM: Uint8Array;
  /** Display name */
  name: string;
  /** Boot ROM type */
  type: BootROMType;
  /** Date when added */
  date: number;
  /** Additional user-provided info */
  [key: string]: unknown;
}

// =============================================================================
// Controller Types
// =============================================================================

/**
 * Joypad button state
 */
export interface JoypadState {
  UP: boolean;
  RIGHT: boolean;
  DOWN: boolean;
  LEFT: boolean;
  A: boolean;
  B: boolean;
  SELECT: boolean;
  START: boolean;
}

// =============================================================================
// Audio Types
// =============================================================================

/**
 * Individual Game Boy audio channel with Web Audio API support
 */
export interface GbChannelWebAudio {
  /** Channel identifier */
  readonly id: string;
  /** Whether the channel is muted */
  readonly muted: boolean;
  /** Get the current audio context time */
  getCurrentTime(): number | undefined;
  /** Get the scheduled play time */
  getPlayTime(): number | undefined;
  /** Resume the audio context (for autoplay policy) */
  resumeAudioContext(): void;
  /** Cancel all queued audio */
  cancelAllAudio(stopCurrentAudio?: boolean): void;
  /** Mute this channel */
  mute(): void;
  /** Unmute this channel */
  unmute(): void;
  /** Check if there's a recording available */
  hasRecording(): boolean;
  /** Start recording audio from this channel */
  startRecording(): void;
  /** Stop recording audio */
  stopRecording(): void;
  /** Download the recording as a WAV file */
  downloadRecordingAsWav(filename?: string): void;
  /** Get the recording as a base64-encoded WAV string */
  getRecordingAsWavBase64EncodedString(): string | undefined;
  /** Get the recording as an AudioBuffer */
  getRecordingAsAudioBuffer(): AudioBuffer | undefined;
}

/**
 * Collection of Game Boy audio channels
 */
export interface GbAudioChannels {
  /** Master mixed output */
  master: GbChannelWebAudio;
  /** Square wave channel 1 with sweep */
  channel1: GbChannelWebAudio;
  /** Square wave channel 2 */
  channel2: GbChannelWebAudio;
  /** Wave channel */
  channel3: GbChannelWebAudio;
  /** Noise channel */
  channel4: GbChannelWebAudio;
}

// =============================================================================
// Plugin Types
// =============================================================================

/**
 * WasmBoy plugin interface
 * Follows a similar pattern to Rollup plugins
 */
export interface WasmBoyPlugin {
  /** Plugin name (required) */
  name: string;
  /**
   * Called when graphics are updated
   * @param rgbaArray - The RGBA pixel data array (modify in place)
   */
  graphics?: (rgbaArray: Uint8ClampedArray) => void;
  /**
   * Called when audio is played
   * @param audioContext - The Web Audio API context
   * @param headAudioNode - The source audio node
   * @param channelId - The channel identifier
   * @returns An AudioNode to insert into the audio graph, or undefined
   */
  audio?: (audioContext: AudioContext, headAudioNode: AudioNode, channelId: string) => AudioNode | void;
  /**
   * Called when a save state is created
   * @param saveStateObject - The save state (modify in place)
   */
  saveState?: (saveStateObject: SaveState) => void;
  /**
   * Called when canvas is set up
   * @param canvasElement - The canvas element
   * @param canvasContext - The 2D rendering context
   * @param canvasImageData - The ImageData object
   */
  canvas?: (canvasElement: HTMLCanvasElement, canvasContext: CanvasRenderingContext2D, canvasImageData: ImageData) => void;
  /** Called when a breakpoint is hit */
  breakpoint?: () => void;
  /** Called when emulator is ready */
  ready?: () => void;
  /** Called when emulation starts/resumes */
  play?: () => void;
  /** Called when emulation pauses */
  pause?: () => void;
  /** Called when ROM is loaded and emulation starts for the first time */
  loadedAndStarted?: () => void;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * WasmBoy configuration options
 */
export interface WasmBoyConfig {
  /** Run in headless mode without rendering (default: false) */
  headless?: boolean;
  /** Disable automatic pause when browser tab is hidden (default: false) */
  disablePauseOnHidden?: boolean;
  /** Enable audio output (default: true) */
  isAudioEnabled?: boolean;
  /** Enable audio debugging - outputs individual channels (default: false) */
  enableAudioDebugging?: boolean;
  /** Target frame rate for the emulator (default: 60) */
  gameboyFrameRate?: number;
  /** Number of frames to skip for performance (default: 0) */
  frameSkip?: number;
  /** Use boot ROM if available (default: true) */
  enableBootROMIfAvailable?: boolean;
  /** Enable Game Boy Color mode (default: true) */
  isGbcEnabled?: boolean;
  /** Enable GBC colorization for original GB games (default: true) */
  isGbcColorizationEnabled?: boolean;
  /** GBC colorization palette for original GB games (default: null) */
  gbcColorizationPalette?: GbcColorizationPalette | null;
  /** Enable batch processing for audio (default: false) */
  audioBatchProcessing?: boolean;
  /** Enable batch processing for graphics (default: false) */
  graphicsBatchProcessing?: boolean;
  /** Enable batch processing for timers (default: false) */
  timersBatchProcessing?: boolean;
  /** Disable per-scanline rendering for graphics (default: false) */
  graphicsDisableScanlineRendering?: boolean;
  /** Accumulate audio samples (default: false) */
  audioAccumulateSamples?: boolean;
  /** Enable tile rendering mode (default: false) */
  tileRendering?: boolean;
  /** Enable tile caching (default: false) */
  tileCaching?: boolean;
  /** Maximum number of auto save states to keep (default: 10) */
  maxNumberOfAutoSaveStates?: number;
  /**
   * Speed multiplier - sets gameboyFrameRate = speed * 60
   * This is an alias that converts to gameboyFrameRate
   */
  gameboySpeed?: number;
  /**
   * Callback for graphics updates
   * @param imageDataArray - The RGBA pixel data
   */
  updateGraphicsCallback?: ((imageDataArray: Uint8ClampedArray) => void) | null;
  /**
   * Callback for audio updates
   * @param audioContext - The Web Audio API context
   * @param audioBufferSourceNode - The source node for the audio
   * @param channelId - The channel identifier ('master', 'channel1', etc.)
   * @returns An AudioNode to insert into the audio graph, or void
   */
  updateAudioCallback?:
    | ((audioContext: AudioContext, audioBufferSourceNode: AudioBufferSourceNode, channelId: string) => AudioNode | void)
    | null;
  /**
   * Callback for save state events
   * @param saveStateObject - The save state that was created
   */
  saveStateCallback?: ((saveStateObject: SaveState) => void) | null;
  /** Callback for breakpoint events */
  breakpointCallback?: (() => void) | null;
  /** Called when emulator is ready */
  onReady?: (() => void) | null;
  /** Called when emulator starts playing */
  onPlay?: (() => void) | null;
  /** Called when emulator pauses */
  onPause?: (() => void) | null;
  /** Called when ROM is loaded and emulation starts */
  onLoadedAndStarted?: (() => void) | null;
  /** Called after a canvas is attached, with the canvas that was set */
  setCanvasCallback?: ((canvasElement: HTMLCanvasElement) => void) | null;
  /**
   * URLs for externally hosted workers. Set these when your Content Security
   * Policy does not allow the default inlined `blob:` workers.
   */
  workerUrls?: WasmBoyWorkerUrls | null;
  /**
   * URL for an externally hosted wasm core, for policies that disallow
   * fetching the default `data:` core.
   */
  wasmCoreUrl?: string | null;
}

/**
 * URLs of self-hosted worker bundles.
 */
export interface WasmBoyWorkerUrls {
  /** Use `wasmboy.ts.worker.js` when loading the TypeScript core bundle */
  lib?: string;
  graphics?: string;
  audio?: string;
  controller?: string;
  memory?: string;
}

// =============================================================================
// Core Type (WASM vs TS)
// =============================================================================

/**
 * The type of core being used
 */
export type CoreType = 'WASM' | 'TS';

// =============================================================================
// Main WasmBoy Interface
// =============================================================================

/**
 * The main WasmBoy API
 */
export interface WasmBoyInstance {
  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Configure WasmBoy with options and set the canvas element
   * @param wasmBoyOptions - Configuration options
   * @param canvasElement - The canvas element to render to (optional in headless mode)
   */
  config(wasmBoyOptions?: WasmBoyConfig, canvasElement?: HTMLCanvasElement): Promise<void>;

  /**
   * Get the current configuration
   */
  getConfig(): WasmBoyConfig;

  /**
   * Get the type of core being used (WASM or TS)
   */
  getCoreType(): CoreType | undefined;

  /**
   * Set the canvas element for rendering
   * @param canvasElement - The canvas element
   */
  setCanvas(canvasElement: HTMLCanvasElement): Promise<void>;

  /**
   * Get the current canvas element
   */
  getCanvas(): HTMLCanvasElement | undefined;

  // -------------------------------------------------------------------------
  // Boot ROM Management
  // -------------------------------------------------------------------------

  /**
   * Add a boot ROM for use with games
   * @param type - The type of boot ROM ('GB' or 'GBC')
   * @param file - The boot ROM file (URL string, File, or Uint8Array)
   * @param loadOptions - Optional options for loading (headers, fileName)
   * @param additionalInfo - Optional additional metadata to store
   */
  addBootROM(
    type: BootROMType,
    file: string | File | Uint8Array,
    loadOptions?: LoadOptions,
    additionalInfo?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Get all saved boot ROMs
   */
  getBootROMs(): Promise<BootROMObject[]>;

  // -------------------------------------------------------------------------
  // ROM Loading
  // -------------------------------------------------------------------------

  /**
   * Load a ROM into the emulator
   * @param ROM - The ROM to load (URL string, File, or Uint8Array)
   * @param loadOptions - Optional options for loading (headers, fileName)
   */
  loadROM(ROM: string | File | Uint8Array, loadOptions?: LoadOptions): Promise<void>;

  // -------------------------------------------------------------------------
  // Playback Control
  // -------------------------------------------------------------------------

  /**
   * Start or resume emulation
   */
  play(): Promise<void>;

  /**
   * Pause emulation
   */
  pause(): Promise<void>;

  /**
   * Reset the emulator, optionally with new configuration
   * @param wasmBoyOptions - Optional new configuration
   */
  reset(wasmBoyOptions?: WasmBoyConfig): Promise<void>;

  // -------------------------------------------------------------------------
  // State Queries
  // -------------------------------------------------------------------------

  /**
   * Check if emulation is currently playing
   */
  isPlaying(): boolean;

  /**
   * Check if emulation is currently paused
   */
  isPaused(): boolean;

  /**
   * Check if the emulator is ready (initialized and ROM loaded)
   */
  isReady(): boolean;

  /**
   * Check if a ROM has been loaded and started playing at least once
   */
  isLoadedAndStarted(): boolean;

  /**
   * Check if currently running in Game Boy Color mode
   */
  isGBC(): Promise<boolean>;

  /**
   * Get the current frames per second
   */
  getFPS(): number;

  /**
   * Get the library version
   */
  getVersion(): string;

  // -------------------------------------------------------------------------
  // Speed Control
  // -------------------------------------------------------------------------

  /**
   * Set the emulation speed multiplier
   * @param speed - Speed multiplier (1.0 = normal, 2.0 = 2x speed, etc.)
   */
  setSpeed(speed: number): void;

  // -------------------------------------------------------------------------
  // Save States
  // -------------------------------------------------------------------------

  /**
   * Create a save state of the current emulator state
   * @returns The created save state
   */
  saveState(): Promise<SaveState>;

  /**
   * Get all save states for the currently loaded cartridge
   */
  getSaveStates(): Promise<SaveState[]>;

  /**
   * Load a save state
   * @param saveState - The save state to load
   */
  loadState(saveState: SaveState | ParsedSaveState): Promise<void>;

  /**
   * Delete a save state
   * @param saveState - The save state to delete
   */
  deleteState(saveState: SaveState): Promise<void>;

  // -------------------------------------------------------------------------
  // Cartridge Memory Management
  // -------------------------------------------------------------------------

  /**
   * Get all saved cartridges/memory from IndexedDB
   */
  getSavedMemory(): Promise<CartridgeObject[]>;

  /**
   * Save the currently loaded cartridge to IndexedDB
   * @param additionalInfo - Optional additional metadata to store
   */
  saveLoadedCartridge(additionalInfo?: Record<string, unknown>): Promise<CartridgeObject>;

  /**
   * Delete a saved cartridge from IndexedDB
   * @param cartridge - The cartridge object to delete
   */
  deleteSavedCartridge(cartridge: CartridgeObject): Promise<CartridgeObject>;

  // -------------------------------------------------------------------------
  // Controller/Joypad
  // -------------------------------------------------------------------------

  /**
   * The ResponsiveGamepad instance for advanced controller configuration
   */
  ResponsiveGamepad: unknown;

  /**
   * Enable the default joypad input handling
   */
  enableDefaultJoypad(): void;

  /**
   * Disable the default joypad input handling
   */
  disableDefaultJoypad(): void;

  /**
   * Manually set the joypad button state. Setting state manually also turns
   * off the default polling so the two cannot fight over the same buttons.
   *
   * Await the result before advancing frames: it resolves once the core has
   * acknowledged the state, and a press that is not awaited can land after
   * the frame it was meant to affect.
   *
   * @param state - The button state
   */
  setJoypadState(state: JoypadState): Promise<void>;

  /**
   * Capture the current frame as raw RGBA image data (160 x 144 x 4 bytes).
   *
   * Reads the core frame buffer directly, so it works headless and does not
   * require a canvas.
   */
  screenshot(): Promise<Uint8ClampedArray>;

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  /**
   * Resume the audio context (required for autoplay policy compliance)
   */
  resumeAudioContext(): void;

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  /**
   * Add a plugin to WasmBoy
   * @param plugin - The plugin object
   * @returns A function to remove the plugin
   */
  addPlugin(plugin: WasmBoyPlugin): () => void;

  // -------------------------------------------------------------------------
  // Debug/Internal API (prefixed with _)
  // -------------------------------------------------------------------------

  /**
   * Get the audio channels for debugging
   * @internal
   */
  _getAudioChannels(): GbAudioChannels;

  /**
   * Get information about the loaded cartridge
   * @internal
   */
  _getCartridgeInfo(): Promise<CartridgeInfo>;

  /**
   * Run a specific number of frames
   * @param frames - Number of frames to run
   * @internal
   */
  _runNumberOfFrames(frames: number): Promise<void>;

  /**
   * Run a WebAssembly export function
   * @param exportKey - The name of the export to run
   * @param parameters - Parameters to pass to the function
   * @param timeout - Optional timeout in milliseconds
   * @returns The return value from the WASM function
   * @internal
   */
  _runWasmExport(exportKey: string, parameters: number[], timeout?: number): Promise<number | undefined>;

  /**
   * Get a section of WASM memory
   * @param start - Start address
   * @param end - End address
   * @returns The memory section as Uint8Array
   * @internal
   */
  _getWasmMemorySection(start: number, end: number): Promise<Uint8Array | undefined>;

  /**
   * Get a WASM constant value
   * @param constantKey - The name of the constant
   * @returns The constant value
   * @internal
   */
  _getWasmConstant(constantKey: string): Promise<number | undefined>;

  /**
   * Get the total number of steps executed as a string
   * @param radix - Optional radix for number formatting (default: 10)
   * @returns The step count as a string
   * @internal
   */
  _getStepsAsString(radix?: number): Promise<string>;

  /**
   * Get the total number of CPU cycles executed as a string
   * @param radix - Optional radix for number formatting (default: 10)
   * @returns The cycle count as a string
   * @internal
   */
  _getCyclesAsString(radix?: number): Promise<string>;
}

// =============================================================================
// Module Export
// =============================================================================

/**
 * The main WasmBoy instance
 */
export const WasmBoy: WasmBoyInstance;

// Default export for ES modules
export default WasmBoy;
