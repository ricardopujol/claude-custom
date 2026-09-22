'use strict';
/**
 * Persistent state for the harness features.
 *
 *   .harness/state/loadout.json    items equipped per agent
 *   .harness/state/vault.json      bug bestiary
 *   .harness/state/map.json        files seen, per project
 *   .harness/state/stats.json      counters, cooldowns, streaks
 *
 * ONE FILE PER CONCERN, not a single blob: a corrupt write then costs one
 * feature instead of all of them, and the diffs stay readable.
 *
 * The host owns every write. The GUI reads through the control protocol and
 * never writes. The hook helper reads `loadout.json` directly, which is what
 * lets equipped items keep working when the GUI is closed — the harness must
 * not become a requirement for a plain terminal session.
 *
 * Every read defaults rather than throwing. All of this is regenerable
 * convenience state; none of it is worth an exception on a hot path, and a
 * feature silently resetting beats a session going down.
 */

const fs = require('fs');
const { renameWithRetry } = require('./atomic-write');
const path = require('path');

// Names are used as filenames. They may come from feature code today and from
// config later, so traversal is refused rather than sanitised.
function assertSafeName(name) {
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`store: unsafe name ${JSON.stringify(name)}`);
  }
}

function createStore({ dir }) {
  if (!dir) throw new Error('createStore: dir is required');

  const pathOf = (name) => {
    assertSafeName(name);
    return path.join(dir, `${name}.json`);
  };

  function read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(pathOf(name), 'utf8'));
    } catch (err) {
      // A traversal attempt is a programming error and must surface; a missing
      // or corrupt file is normal and must not.
      if (/unsafe name/.test(err.message)) throw err;
      return fallback;
    }
  }

  function write(name, value) {
    const file = pathOf(name);
    fs.mkdirSync(dir, { recursive: true });

    // Write-and-rename. A hard exit part-way through a plain write leaves a
    // truncated file that reads as corrupt and silently resets the feature --
    // observed in this project when app.exit() zeroed a PNG immediately after a
    // synchronous write. Rename is atomic, so a reader sees old or new, never
    // half.
    const temp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    // Retried, because on Windows the rename is the fragile half: EPERM /
    // EACCES / EBUSY whenever anything holds a handle for a moment, and the
    // antivirus scan of the file we just wrote routinely does. MEASURED here
    // 2026-09-18. It still THROWS if the rename never succeeds -- a write
    // reported as done while the file was never replaced would be worse than
    // the failure it hides. See host/atomic-write.js.
    try {
      renameWithRetry(temp, file);
    } catch (err) {
      // Dexter, Finding 9. Bounded -- one temp per (pid, name), overwritten by
      // the next write from this process -- but a stale .tmp beside a settings
      // file reads as corruption to whoever finds it, and the caller still
      // gets the original error.
      try { fs.unlinkSync(temp); } catch { /* nothing more we can do about it */ }
      throw err;
    }
    return value;
  }

  function update(name, fallback, fn) {
    return write(name, fn(read(name, fallback)));
  }

  return { read, write, update, pathOf, dir };
}

module.exports = { createStore };
