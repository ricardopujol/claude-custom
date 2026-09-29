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
 * The watcher is best effort and never throws: a platform that cannot watch
 * leaves the app exactly as it was before this module (each window repaints
 * its own changes), and says so once in the log.
 */
const fs = require('fs');

function watchGlobalDir(dir, onChange, {
  watch = fs.watch, mkdirSync = fs.mkdirSync, delayMs = 150,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console.log,
} = {}) {
  let timer = null;
  let watcher = null;
  let closed = false;
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, () => {
      if (closed) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        if (closed) return;
        try { onChange(); } catch (err) { log('[host] global picture repaint failed:', err && err.message); }
      }, delayMs);
    });
    if (watcher && typeof watcher.on === 'function') {
      // A watcher that dies later (folder removed) must not crash the host.
      watcher.on('error', (err) => log('[host] global picture watcher stopped:', err && err.message));
    }
  } catch (err) {
    log('[host] cannot watch the global picture folder; other windows will not follow changes:', err && err.message);
  }
  return {
    close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      try { if (watcher) watcher.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { watchGlobalDir };
