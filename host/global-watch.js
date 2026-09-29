'use strict';
/**
 * Watches the folder of the global default picture (.harness/portraits/_global)
 * so a change made by ANOTHER project window reaches this one (Dexter F3,
 * PR #64).
 *
 * Every project window is its own Electron main and its own host, but the
 * uploads folder and the toggle store are install-wide. Without this, a Reset
 * in window P left window Q's idle agents pointing at a deleted file (a broken
 * image) until each agent's next mood change.
 *
 * `onChange` is debounced: one upload is several filesystem events (temp file,
 * rename, utimes, removal of other formats) and the repaint it triggers is
 * cheap but not free. The watched folder is created if missing, because
 * fs.watch cannot watch a path that does not exist yet and the very first
 * global picture is the case that matters.
 *
 * A watcher dies with its folder (Dexter N4, PR #64 round 2): deleting
 * `_global` in Explorer ends the handle with an error, or reports a `rename`
 * naming the folder itself. Either way the folder is re-created and watched
 * again after a pause (not in a tight loop), a failed re-arm is retried, and
 * the deletion is itself reported as a change.
 *
 * The watcher is best effort and never throws: a platform that cannot watch
 * leaves the app exactly as it was before this module (each window repaints
 * its own changes), and says so once in the log.
 */
const fs = require('fs');
const path = require('path');

function watchGlobalDir(dir, onChange, {
  watch = fs.watch, mkdirSync = fs.mkdirSync, delayMs = 150, rearmMs = 1000,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimer = clearTimeout, log = console.log,
} = {}) {
  let timer = null;
  let rearmTimer = null;
  let watcher = null;
  let closed = false;
  const folder = path.basename(dir);

  const report = () => {
    if (closed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (closed) return;
      try { onChange(); } catch (err) { log('[host] global picture repaint failed:', err && err.message); }
    }, delayMs);
  };

  function arm() {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, (eventType, filename) => {
      if (closed) return;
      if (eventType === 'rename' && filename && String(filename) === folder) scheduleRearm();
      report();
    });
    if (watcher && typeof watcher.on === 'function') {
      // A watcher that dies later (folder removed) must not crash the host, and
      // must not be the end of following other windows.
      watcher.on('error', (err) => {
        log('[host] global picture watcher stopped:', err && err.message);
        scheduleRearm();
      });
    }
  }

  function scheduleRearm() {
    if (closed || rearmTimer !== null) return;
    try { if (watcher) watcher.close(); } catch { /* already dead */ }
    watcher = null;
    rearmTimer = setTimer(() => {
      rearmTimer = null;
      if (closed) return;
      try {
        arm();
        report();          // the folder was gone: whatever it held has changed
      } catch (err) {
        log('[host] cannot watch the global picture folder; retrying:', err && err.message);
        scheduleRearm();
      }
    }, rearmMs);
  }

  try {
    arm();
  } catch (err) {
    log('[host] cannot watch the global picture folder; other windows will not follow changes:', err && err.message);
  }
  return {
    close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (rearmTimer !== null) { clearTimer(rearmTimer); rearmTimer = null; }
      try { if (watcher) watcher.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { watchGlobalDir };
