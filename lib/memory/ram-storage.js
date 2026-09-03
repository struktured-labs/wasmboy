// Pure helpers for stable-key cartridge RAM persistence: crop to the declared
// size, rank competing copies by recency, and match records for the same game
// across ROM revisions whose header (the default key) changes.

// Persist exactly the declared SRAM size, not the full 128KiB backing.
export function cropCartridgeRam(ram, size) {
  const cropped = new Uint8Array(size);
  if (ram) {
    cropped.set(ram.subarray(0, Math.min(size, ram.length)));
  }
  return cropped;
}

export function isValidStorageSize(size, backingSize) {
  return Number.isInteger(size) && size > 0 && size <= backingSize;
}

// When the RAM was captured. cartridgeRamSavedAt is authoritative and travels
// with the bytes; legacy records without it fall back to a metadata-date proxy.
export function ramTimestamp(record) {
  if (!record || record.cartridgeRam === undefined) {
    return 0;
  }
  if (record.cartridgeRamSavedAt !== undefined) {
    return record.cartridgeRamSavedAt;
  }
  let proxy = 0;
  if (record.cartridgeRom && record.cartridgeRom.date) {
    proxy = record.cartridgeRom.date;
  }
  if (Array.isArray(record.saveStates)) {
    for (const saveState of record.saveStates) {
      if (saveState && saveState.date) {
        proxy = Math.max(proxy, saveState.date);
      }
    }
  }
  return proxy;
}

// A write must never replace RAM newer than what is stored; a tie is a no-op.
// Existing recency comes from ramTimestamp, so a legacy record carrying only a
// metadata-proxy date is still protected from an older write.
export function shouldReplaceRam(existing, incomingSavedAt) {
  if (!existing || existing.cartridgeRam === undefined) {
    return true;
  }
  return incomingSavedAt > ramTimestamp(existing);
}

// IndexedDB hands a binary key back as ArrayBuffer or a typed view, and under
// WebDriver it is cross-realm, so instanceof and ArrayBuffer.isView both lie.
// Identify by the Object tag and byteLength instead.
function asBytes(key) {
  if (!key) {
    return undefined;
  }
  const tag = Object.prototype.toString.call(key);
  if (tag === '[object ArrayBuffer]') {
    return new Uint8Array(key);
  }
  if (key.buffer && typeof key.byteOffset === 'number' && typeof key.byteLength === 'number') {
    return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  }
  if (typeof key.length === 'number') {
    return key;
  }
  return undefined;
}

// Title bytes 0x0134-0x0143 identify the game across revisions.
export function titleFromHeaderKey(headerKey) {
  const bytes = asBytes(headerKey);
  if (!bytes || bytes.length < 16) {
    return undefined;
  }
  return Array.from(bytes.subarray(0, 16)).join(',');
}

export function titleFromRecord(record, headerKey) {
  if (record && record.cartridgeRom && record.cartridgeRom.header) {
    return titleFromHeaderKey(record.cartridgeRom.header);
  }
  return titleFromHeaderKey(headerKey);
}

// The newest candidate that carries RAM. Callers pass only same-title records,
// so title matching stays separate from recency selection.
export function chooseMigrationSource(candidates) {
  let best;
  let bestTime = -1;
  for (const candidate of candidates) {
    if (!candidate.record || candidate.record.cartridgeRam === undefined) {
      continue;
    }
    const time = ramTimestamp(candidate.record);
    if (time > bestTime) {
      bestTime = time;
      best = candidate;
    }
  }
  return best;
}
