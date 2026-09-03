// Regression tests driving the real WasmBoyMemoryService save/load paths against
// an in-memory IndexedDB, guarding the save-rollback conflict bug: a stale
// header RAM must never overwrite a newer stable save. The mock clones on
// get/set and compares binary keys by content, matching the semantics the bug
// depends on.

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ---- Faithful in-memory IndexedDB ------------------------------------------
const makeIdb = () => {
  const store = new Map(); // serialized key -> { key, value }
  const ser = k => (typeof k === 'string' ? 's:' + k : 'b:' + Array.from(k).join(','));
  const cloneKey = k => (typeof k === 'string' ? k : Uint8Array.from(k));
  return {
    _store: store,
    _get: k => (store.get(ser(k)) || {}).value, // raw peek for assertions
    get: k => Promise.resolve(structuredClone((store.get(ser(k)) || {}).value)),
    set: (k, v) => {
      store.set(ser(k), { key: cloneKey(k), value: structuredClone(v) });
      return Promise.resolve();
    },
    update: (k, updater) => {
      const current = structuredClone((store.get(ser(k)) || {}).value);
      const next = updater(current);
      if (next !== undefined) {
        store.set(ser(k), { key: cloneKey(k), value: structuredClone(next) });
      }
      return Promise.resolve();
    },
    delete: k => {
      store.delete(ser(k));
      return Promise.resolve();
    },
    clear: () => {
      store.clear();
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...store.values()].map(e => e.key))
  };
};

// ---- Load the real WasmBoyMemoryService under stubbed imports --------------
const loadMemoryService = idbKeyval => {
  const ramSrc = fs.readFileSync(path.resolve(__dirname, '../../lib/memory/ram-storage.js'), 'utf8').replace(/^export /gm, '');
  const memSrc = fs
    .readFileSync(path.resolve(__dirname, '../../lib/memory/memory.js'), 'utf8')
    .replace(/^import\b[^;]*;/gm, '') // drop every import (idb, worker, ram-storage, ...)
    .replace(/^export const WasmBoyMemory.*$/gm, '')
    .replace(/^export /gm, '');

  const sandbox = {
    idbKeyval,
    WORKER_MESSAGE_TYPE: { SET_MEMORY: 'SET_MEMORY' },
    MEMORY_TYPE: { CARTRIDGE_RAM: 'CARTRIDGE_RAM' },
    getEventData: () => ({}),
    fetchROMAsByteArray: () => {},
    getSaveState: () => ({}),
    initializeAutoSave: () => {},
    structuredClone,
    Uint8Array,
    Array,
    Object,
    Number,
    Math,
    Date,
    Promise,
    String,
    Error,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(`${ramSrc}\n${memSrc}\nthis.WasmBoyMemoryService = WasmBoyMemoryService;`, sandbox, {
    filename: 'memory.js'
  });
  return sandbox.WasmBoyMemoryService;
};

// A cartridge header where bytes 0..15 are the title and the tail (checksum)
// distinguishes ROM revisions of the same game.
const makeHeader = (revision = 0) => {
  const h = new Uint8Array(27);
  for (let i = 0; i < 16; i++) h[i] = 0x40 + i; // fixed title = same game
  h[26] = revision; // revision-specific tail
  return h;
};

const filled = (size, byteAt, value) => {
  const a = new Uint8Array(size);
  a[byteAt] = value;
  return a;
};

const STORAGE_KEY = 'quintra-sram';
const SIZE = 32768;
const MARK = 32760; // Quintra's sentinel offset, inside the declared size

// Build a service instance wired for stable-key storage, with the worker and
// ROM-info dependencies stubbed to just capture what loadCartridgeRam applies.
const makeService = (WasmBoyMemoryService, idb, { header = makeHeader(0), cartridgeRam } = {}) => {
  const svc = new WasmBoyMemoryService();
  svc.cartridgeHeader = header;
  svc.cartridgeRom = makeHeader(0); // stand-in ROM bytes; title region matches
  svc.cartridgeRomFileName = 'quintra.gb';
  svc.cartridgeRam = cartridgeRam;
  svc.cartridgeRamStorageKey = STORAGE_KEY;
  svc.cartridgeRamStorageSize = SIZE;
  svc.loadedCartridgeMemoryState = { ROM: true, RAM: false };
  svc.getCartridgeInfo = () => Promise.resolve({ titleAsString: 'quintra' });
  svc.worker = { postMessage: () => Promise.resolve({}) };
  return svc;
};

const WasmBoyMemoryService = loadMemoryService(makeIdb());

describe('Stable-key cartridge RAM persistence (real service)', () => {
  it('saveLoadedCartridge must not let a stale cached header RAM survive the write', async () => {
    // The clobber: the header record holds an OLD save; the live session RAM is
    // newer. saveLoadedCartridge reads that stale record at the top of the task.
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const header = makeHeader(0);

    await idb.set(header, {
      cartridgeRam: filled(SIZE, MARK, 0xa1), // OLD RAM 'A'
      cartridgeRamSavedAt: 1000,
      cartridgeRom: { header, date: 1000 }
    });
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 1500 });

    const svc = makeService(WMS, idb, { header, cartridgeRam: filled(SIZE, MARK, 0xc3) }); // CURRENT 'C'
    await svc.saveLoadedCartridge();

    assert.strictEqual(idb._get(header).cartridgeRam[MARK], 0xc3, 'header record must hold the CURRENT RAM, not the stale cached copy');
    assert.notStrictEqual(idb._get(header).cartridgeRam[MARK], 0xa1, 'the old cached RAM must not reappear in the header record');
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRam[MARK], 0xc3, 'the stable record must hold the CURRENT RAM');
    // RAM and its capture time move together: the header record's timestamp now
    // describes the CURRENT bytes.
    assert(idb._get(header).cartridgeRamSavedAt > 1500, 'header RAM timestamp must advance with the new bytes');
  });

  it('a save then reload returns the current RAM and never rolls back across reloads', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const header = makeHeader(0);
    await idb.set(header, { cartridgeRam: filled(SIZE, MARK, 0xa1), cartridgeRamSavedAt: 1000, cartridgeRom: { header, date: 1000 } });
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 1500 });

    const svc = makeService(WMS, idb, { header, cartridgeRam: filled(SIZE, MARK, 0xc3) });
    await svc.saveLoadedCartridge();

    // Two reload cycles: the loaded RAM must stay the current save.
    for (let i = 0; i < 2; i++) {
      const reload = makeService(WMS, idb, { header });
      await reload.loadCartridgeRam();
      assert.strictEqual(reload.cartridgeRam[MARK], 0xc3, `reload ${i} must load the current RAM, not a stale copy`);
    }
  });

  it('migration keeps the newer stable save over an older same-title revision', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    // Legacy revision (different key, same title) with an OLDER real save.
    await idb.set(makeHeader(1), {
      cartridgeRam: filled(SIZE, MARK, 0xa1),
      cartridgeRamSavedAt: 100,
      cartridgeRom: { header: makeHeader(1), date: 100 }
    });
    // Stable record with a NEWER save.
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 200 });

    const svc = makeService(WMS, idb, { header: makeHeader(2) });
    await svc.loadCartridgeRam();
    assert.strictEqual(svc.cartridgeRam[MARK], 0xb2, 'the newer stable save must win');
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRam[MARK], 0xb2, 'the stable record must be untouched');
  });

  it('migration adopts a genuinely newer same-title revision and dual-writes it', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const legacy = makeHeader(1);
    await idb.set(legacy, {
      cartridgeRam: filled(SIZE, MARK, 0xa1),
      cartridgeRamSavedAt: 300,
      cartridgeRom: { header: legacy, date: 300 }
    });
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 200 });

    const current = makeHeader(2);
    const svc = makeService(WMS, idb, { header: current });
    await svc.loadCartridgeRam();
    assert.strictEqual(svc.cartridgeRam[MARK], 0xa1, 'the genuinely newer legacy save must be adopted');
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRam[MARK], 0xa1, 'stable must be updated to the adopted RAM');
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRamSavedAt, 300, 'the adopted saveʼs own timestamp must be preserved');
    assert.strictEqual(
      idb._get(current).cartridgeRam[MARK],
      0xa1,
      'the adopted RAM must be dual-written to the current header for rollback'
    );
  });

  it('a stale header RAM with a fresh METADATA date must not win over the stable save', async () => {
    // The exact bug: an old bundle bumped cartridgeRom.date but left stale RAM.
    // Ranking by cartridgeRamSavedAt (authoritative) keeps the real stable save;
    // ranking by the metadata date (the old behavior) would roll it back.
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const legacy = makeHeader(1);
    await idb.set(legacy, {
      cartridgeRam: filled(SIZE, MARK, 0xa1),
      cartridgeRamSavedAt: 150, // the RAM is genuinely old
      cartridgeRom: { header: legacy, date: 9999 } // but the metadata date is fresh
    });
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 200 });

    const svc = makeService(WMS, idb, { header: makeHeader(2) });
    await svc.loadCartridgeRam();
    assert.strictEqual(svc.cartridgeRam[MARK], 0xb2, 'the newer stable save must win over stale RAM with a fresh metadata date');
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRam[MARK], 0xb2, 'stable must not be rolled back');
  });

  it('crops an oversized stable record to the configured size on restore', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    // A corrupt/legacy stable record holding the full 128KiB backing.
    const oversized = new Uint8Array(0x20000);
    oversized[MARK] = 0xb2;
    await idb.set(STORAGE_KEY, { cartridgeRam: oversized, cartridgeRamSavedAt: 5000 });

    const svc = makeService(WMS, idb, { header: makeHeader(0) });
    await svc.loadCartridgeRam();
    assert.strictEqual(svc.cartridgeRam.length, SIZE, 'restore must enforce the configured size, not the backing');
    assert.strictEqual(svc.cartridgeRam[MARK], 0xb2, 'the payload inside the declared size must survive');
  });

  it('keeps the stable record RAM-only', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const header = makeHeader(0);
    // Pre-seed the stable key with a foreign field to prove the writer discards it.
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0x11), cartridgeRamSavedAt: 10, saveStates: [{ date: 1 }] });

    const svc = makeService(WMS, idb, { header, cartridgeRam: filled(SIZE, MARK, 0xc3) });
    await svc.saveLoadedCartridge();
    assert.deepStrictEqual(
      Object.keys(idb._get(STORAGE_KEY)).sort(),
      ['cartridgeRam', 'cartridgeRamSavedAt'],
      'the stable record must carry only RAM and its timestamp'
    );
  });

  it('an older save cannot overwrite a newer one under the stable key', async () => {
    const idb = makeIdb();
    const WMS = loadMemoryService(idb);
    const header = makeHeader(0);
    await idb.set(STORAGE_KEY, { cartridgeRam: filled(SIZE, MARK, 0xb2), cartridgeRamSavedAt: 5000 });

    // A save whose bytes are older than what is stored: the guard must refuse it.
    const svc = makeService(WMS, idb, { header, cartridgeRam: filled(SIZE, MARK, 0xa1) });
    await svc._persistCartridgeRam(svc.cartridgeRam, 1000, undefined, undefined, header);
    assert.strictEqual(idb._get(STORAGE_KEY).cartridgeRam[MARK], 0xb2, 'the newer stored RAM must survive an older write');
  });
});
