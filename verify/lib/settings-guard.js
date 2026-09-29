'use strict';
/**
 * Snapshot files a probe's `/model` may rewrite, and put them back byte for byte.
 *
 * Written against Miguel's PR #67 review (M1): the probe restored settings only
 * in a `finally`, and process-hygiene's SIGINT handler ends with
 * `process.exit(130)`, which skips every pending `finally`. A Ctrl+C mid-run left
 * ~/.claude/settings.json modified. `restore()` is SYNCHRONOUS, so it is safe on
 * the 'exit' event -- which DOES fire for process.exit() -- and `installExitRestore`
 * registers it there. Call it BEFORE anything that can rewrite the files.
 */
const fs = require('fs');

function createSettingsGuard(files) {
  const snapshot = new Map(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
  let exitListener = null;

  // Returns the files that had changed (and are now put back). Idempotent.
  function restore() {
    const changed = [];
    for (const [f, before] of snapshot) {
      const now = fs.existsSync(f) ? fs.readFileSync(f) : null;
      if (before === null ? now === null : (now !== null && before.equals(now))) continue;
      changed.push(f);
      if (before === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, before);
    }
    return changed;
  }

  function installExitRestore() {
    if (exitListener) return;
    exitListener = () => { try { restore(); } catch { /* nothing more can be done at exit */ } };
    process.on('exit', exitListener);
  }

  function uninstallExitRestore() {
    if (!exitListener) return;
    process.removeListener('exit', exitListener);
    exitListener = null;
  }

  return { restore, installExitRestore, uninstallExitRestore, _snapshot: snapshot };
}

module.exports = { createSettingsGuard };
