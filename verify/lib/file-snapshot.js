'use strict';
/**
 * Snapshot a file's exact bytes (or its absence) and put it back.
 *
 * Written for Miguel's PR #68 review, B1: verify/probe-loadout.js deleted the
 * REAL `.harness/state/loadout.json` at start and end without reading it, so
 * running the probe on a checkout where somebody had a belt destroyed the belt,
 * and a Ctrl+C left the probe's own belt on disk for real spawns to pick up.
 *
 * `restore()` is idempotent and never throws: it runs from a SIGINT handler,
 * where an exception would hide the very cleanup it was written to do. It
 * writes to a temp file and renames (CLAUDE.md: never open a file with 'w'
 * before you are sure the write succeeds).
 */
const fs = require('fs');

function snapshotFile(file) {
  let original = null;          // null = the file did not exist
  try { original = fs.readFileSync(file); } catch { original = null; }
  let restored = false;
  return {
    existed: original !== null,
    restore() {
      if (restored) return true;
      try {
        if (original === null) {
          try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        } else {
          const tmp = `${file}.restore${process.pid}`;
          fs.writeFileSync(tmp, original);
          fs.renameSync(tmp, file);
        }
        restored = true;
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { snapshotFile };
