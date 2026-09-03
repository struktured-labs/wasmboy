// Unit tests for the stable-key cartridge RAM helpers. These are the parts a
// stranded-save or clobbered-save bug would live in, so they are tested here
// without a browser; the end-to-end persistence is covered by the browser
// harness.

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The module is ESM; load it with the export keyword stripped.
const load = () => {
  const file = path.resolve(__dirname, '../../lib/memory/ram-storage.js');
  const sandbox = { Uint8Array, Array, Number, Math };
  vm.createContext(sandbox);
  const source = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  const names = [...fs.readFileSync(file, 'utf8').matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  vm.runInContext(`${source}\n${names.map(n => `this.${n} = ${n};`).join('\n')}`, sandbox, { filename: file });
  return sandbox;
};

const ram = load();
const BACKING = 0x20000;

describe('Cartridge RAM storage helpers', () => {
  it('should crop RAM to exactly the declared size', () => {
    const backing = new Uint8Array(BACKING);
    backing[0] = 1;
    backing[32760] = 42; // Quintra's sentinel byte
    backing[40000] = 99; // in the unused upper region

    const cropped = ram.cropCartridgeRam(backing, 32768);
    assert.strictEqual(cropped.length, 32768);
    assert.strictEqual(cropped[0], 1);
    assert.strictEqual(cropped[32760], 42, 'the sentinel inside the declared size must survive');
  });

  it('should zero-pad when the source is shorter than the declared size', () => {
    const cropped = ram.cropCartridgeRam(new Uint8Array([1, 2, 3]), 32768);
    assert.strictEqual(cropped.length, 32768);
    assert.strictEqual(cropped[0], 1);
    assert.strictEqual(cropped[100], 0, 'bytes past the source must read back as zero');
  });

  it('should only accept a positive size within the backing', () => {
    assert.strictEqual(ram.isValidStorageSize(32768, BACKING), true);
    assert.strictEqual(ram.isValidStorageSize(BACKING, BACKING), true);
    assert.strictEqual(ram.isValidStorageSize(BACKING + 1, BACKING), false);
    assert.strictEqual(ram.isValidStorageSize(0, BACKING), false);
    assert.strictEqual(ram.isValidStorageSize(-1, BACKING), false);
    assert.strictEqual(ram.isValidStorageSize(1.5, BACKING), false);
  });

  it('should take the freshest timestamp across every dated field', () => {
    const R = new Uint8Array(1);
    assert.strictEqual(ram.ramTimestamp(undefined), 0);
    assert.strictEqual(ram.ramTimestamp({ cartridgeRam: R, cartridgeRamSavedAt: 500 }), 500);
    // cartridgeRamSavedAt is authoritative: a newer metadata date must NOT inflate it.
    assert.strictEqual(ram.ramTimestamp({ cartridgeRam: R, cartridgeRamSavedAt: 300, cartridgeRom: { date: 9999 } }), 300);
    // Legacy without the field falls back to metadata proxy.
    assert.strictEqual(ram.ramTimestamp({ cartridgeRam: R, cartridgeRom: { date: 700 } }), 700);
    assert.strictEqual(ram.ramTimestamp({ cartridgeRam: R, saveStates: [{ date: 900 }, { date: 100 }] }), 900);
    assert.strictEqual(ram.ramTimestamp({ cartridgeRom: { date: 700 } }), 0, 'no RAM means no RAM timestamp');
  });

  it('should never replace newer RAM with an older write', () => {
    // The stale-timestamp guard, on the save path and on autosave recovery.
    assert.strictEqual(ram.shouldReplaceRam(undefined, 100), true, 'an empty slot always accepts');
    assert.strictEqual(ram.shouldReplaceRam({ cartridgeRam: new Uint8Array(1), cartridgeRamSavedAt: 500 }, 900), true);
    assert.strictEqual(
      ram.shouldReplaceRam({ cartridgeRam: new Uint8Array(1), cartridgeRamSavedAt: 900 }, 500),
      false,
      'older must not win'
    );
    assert.strictEqual(
      ram.shouldReplaceRam({ cartridgeRam: new Uint8Array(1), cartridgeRamSavedAt: 500 }, 500),
      false,
      'a tie keeps the stored copy'
    );
    // A legacy record with only a metadata-proxy date is protected too.
    assert.strictEqual(
      ram.shouldReplaceRam({ cartridgeRam: new Uint8Array(1), cartridgeRom: { date: 900 } }, 500),
      false,
      'older must not overwrite a legacy proxy date'
    );
    assert.strictEqual(
      ram.shouldReplaceRam({ cartridgeRam: new Uint8Array(1), cartridgeRom: { date: 900 } }, 1200),
      true,
      'newer overwrites a legacy proxy date'
    );
  });

  it('should migrate from the newest same-title record that carries RAM', () => {
    // Users who skip ROM revisions leave several header-keyed records; take the
    // newest that actually has battery RAM.
    const older = { record: { cartridgeRam: new Uint8Array([1]), cartridgeRom: { date: 100 } } };
    const newer = { record: { cartridgeRam: new Uint8Array([2]), cartridgeRom: { date: 800 } } };
    const noRam = { record: { cartridgeRom: { date: 999 } } };

    const chosen = ram.chooseMigrationSource([older, newer, noRam]);
    assert.strictEqual(chosen.record.cartridgeRom.date, 800, 'newest with RAM wins, RAM-less record ignored');
  });

  it('should migrate a legacy record that has RAM but no cartridgeRom metadata', () => {
    // Some old saves have cartridgeRam and saveStates but no cartridgeRom/title.
    const legacy = { record: { cartridgeRam: new Uint8Array([7]), saveStates: [{ date: 400 }] } };
    const chosen = ram.chooseMigrationSource([legacy]);
    assert.strictEqual(chosen.record.cartridgeRam[0], 7, 'a metadata-less record is still a valid RAM source');
    assert.strictEqual(ram.ramTimestamp(legacy.record), 400);
  });

  it('should return nothing to migrate when no candidate carries RAM', () => {
    assert.strictEqual(ram.chooseMigrationSource([{ record: { cartridgeRom: { date: 1 } } }]), undefined);
    assert.strictEqual(ram.chooseMigrationSource([]), undefined);
  });
});

describe('Binary key normalization', () => {
  const ram = load();
  const makeHeader = () => {
    const h = new Uint8Array(27);
    for (let i = 0; i < 16; i++) h[i] = 65 + i; // title bytes
    return h;
  };

  it('should read the title from a Uint8Array key', () => {
    assert.strictEqual(ram.titleFromHeaderKey(makeHeader()), Array.from(makeHeader().subarray(0, 16)).join(','));
  });

  it('should read the title from a raw ArrayBuffer key (the browser shape)', () => {
    const expected = ram.titleFromHeaderKey(makeHeader());
    assert.strictEqual(ram.titleFromHeaderKey(makeHeader().buffer), expected, 'an ArrayBuffer key must resolve identically');
  });

  it('should read the title from a DataView key', () => {
    const expected = ram.titleFromHeaderKey(makeHeader());
    assert.strictEqual(ram.titleFromHeaderKey(new DataView(makeHeader().buffer)), expected);
  });

  it('should reject a key too short to hold a title', () => {
    assert.strictEqual(ram.titleFromHeaderKey(new Uint8Array(4)), undefined);
    assert.strictEqual(ram.titleFromHeaderKey(new ArrayBuffer(4)), undefined);
    assert.strictEqual(ram.titleFromHeaderKey('a-string-key'), undefined);
  });

  it('should not let a newer different-title record win migration', () => {
    // Title matching is upstream of selection: only same-title records reach
    // chooseMigrationSource, so a newer other game cannot be chosen here.
    const titleA = new Uint8Array(27);
    titleA.fill(1, 0, 16);
    const titleB = new Uint8Array(27);
    titleB.fill(2, 0, 16);
    assert.notStrictEqual(ram.titleFromHeaderKey(titleA), ram.titleFromHeaderKey(titleB));
  });
});
