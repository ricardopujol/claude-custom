'use strict';
/**
 * Tell this host when `loadout.json` changes underneath it (PR #68, Dexter F1).
 *
 * The loadout is INSTALL-WIDE and two hosts at once is the advertised
 * multi-project mode. The hook re-reads the file on every spawn, so a second
 * host's spawns obey a belt its own windows never heard about: host A equips
 * haiku, host B's card stays empty while B's next spawn runs on haiku. Nothing
 * broadcast from A reaches B's clients, so B has to notice the file itself.
 *
 * Same idea as the portraits `_global` watcher on PR #64 (that file is not on
 * develop, so this is a small independent copy of the idea, not the file):
 *   - watch the DIRECTORY, not the file. The store writes by rename, which
 *     replaces the inode; a watch on the file itself goes deaf after the first
 *     write on some platforms.
 *   - filter to `loadout.json` (a null filename, which some platforms send, is
 *     treated as "maybe").
 *   - DEBOUNCE: one write is several events (temp file, rename).
 *   - RE-ARM on error: a watcher that died silently is a belt that never
 *     refreshes again, with nothing anywhere saying so.
 *
 * The callback is told nothing but "look again"; deciding whether anything
 * really changed (and whether it was this host's own write) is the caller's
 * job, in host/loadout-control.js `changed()`. Whatever it broadcasts must be
 * `quiet` (PR #64 N1): an echo must never touch a refusal on screen.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'loadout.json';

function watchLoadout({ dir, onChange, debounceMs = 150, watch = fs.watch, rearmMs = 2000 } = {}) {
  if (!dir) throw new Error('watchLoadout: dir is required');
  if (typeof onChange !== 'function') throw new Error('watchLoadout: onChange is required');

  let watcher = null;
  let timer = null;
  let rearm = null;
  let closed = false;

  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (closed) return;
      try { onChange(); } catch { /* a bad callback must not kill the watcher */ }
    }, debounceMs);
  };

  function arm() {
    if (closed) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the watch below will say */ }
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename === null || filename === undefined || String(filename) === FILE) fire();
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already dead */ }
        watcher = null;
        if (closed) return;
        clearTimeout(rearm);
        rearm = setTimeout(arm, rearmMs);
        // Something may have changed while the watcher was down.
        fire();
      });
    } catch {
      watcher = null;
      if (!closed) { clearTimeout(rearm); rearm = setTimeout(arm, rearmMs); }
    }
  }

  arm();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(rearm);
      try { if (watcher) watcher.close(); } catch { /* already closed */ }
    },
    path: path.join(dir, FILE),
  };
}

module.exports = { watchLoadout, FILE };
