'use strict';
/**
 * The top-bar chip's on/off (Q2, PR #113), kept install-wide in the same store as the other window-wide UI state.
 * `read()` is true / false, or null when nothing usable is stored: a missing file, a corrupt one, a value that is not a real
 * boolean, or a store that throws all mean "never set", which the caller reads as ON (the default). `write(on)` replaces
 * whatever is there (a corrupt file included: this is regenerable state).
 *
 * `watch` follows the other windows: other project windows are other main processes sharing the file, so it is polled
 * (fs.watchFile survives the store's temp-and-rename writes), exactly as app/layout-bridge.js watchLayout does.
 */
const fs = require('fs');

const KEY = 'resource-chip';

function createChipStore(store, key = KEY) {
  return {
    read() {
      try {
        const v = store.read(key, {});
        return v && typeof v.show === 'boolean' ? v.show : null;
      } catch { return null; }
    },
    write(on) { store.update(key, {}, () => ({ show: on })); },
  };
}

/** watch({ file, onChange, intervalMs, watchFile, unwatchFile }) -> stop(). `onChange()` runs on every change of the file. */
function watchChip({ file, onChange, intervalMs = 500, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile }) {
  const listener = () => { try { onChange(); } catch { /* a window going away */ } };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

module.exports = { createChipStore, watchChip, KEY };
