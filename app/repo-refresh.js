'use strict';
/**
 * When the Files tab re-reads things (PR #95 Dexter D4, Miguel M1). Pure scheduling; app/repo-files-panel.js
 * supplies what to read.
 *
 *   createRefresher({ reloadTree, loadOverlay, isShown, now, setTimer, clearTimer }) ->
 *     onChanged()          the host says the worktree changed
 *     shown()              the tab was shown (or shown again)
 *     askOverlay({ urgent }) read the overlay now (urgent) or when the interval allows
 *     isStale()            something changed while the tab was hidden and has not been caught up on
 *
 * THE OVERLAY re-reads transcripts (the active one grows every turn), so it runs at most every
 * OVERLAY_EVERY_MS. A change that lands while a read is RUNNING is not dropped: it sets a dirty mark and one
 * follow-up runs after the read (D4: the old guard returned early and the late change was lost until some
 * unrelated event, so the last edit of a turn could stay unmarked).
 *
 * A HIDDEN TAB DOES NOTHING (M1): every change used to re-list the tree and re-read the transcripts for a panel
 * nobody was looking at, all through a busy session. Now a change while hidden only marks the tab stale, and
 * showing it catches up once.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoRefresh`.
 */
(function (root) {

const OVERLAY_EVERY_MS = 5000;

function createRefresher({ reloadTree, loadOverlay, isShown, now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  let busy = false;
  let dirty = false;
  let dirtyUrgent = false;
  let stale = false;
  let lastAt = -Infinity;
  let timer = null;

  async function run() {
    busy = true;
    lastAt = now();
    try { await loadOverlay(); } catch { /* the loader reports its own failures */ } finally { busy = false; }
    if (dirty) { const urgent = dirtyUrgent; dirty = false; dirtyUrgent = false; askOverlay({ urgent }); }
  }

  function askOverlay({ urgent = false } = {}) {
    if (busy) { dirty = true; dirtyUrgent = dirtyUrgent || urgent; return; }
    const wait = urgent ? 0 : OVERLAY_EVERY_MS - (now() - lastAt);
    if (wait <= 0) {
      if (timer !== null) { clearTimer(timer); timer = null; }
      run();
      return;
    }
    if (timer === null) timer = setTimer(() => { timer = null; askOverlay({ urgent: true }); }, wait);
  }

  function onChanged() {
    if (!isShown()) { stale = true; return; }
    reloadTree();
    askOverlay();
  }

  // The host re-read the overlay and found it changed (a tool_result landed after the file change, R2-1). Not a
  // poll: the host KNOWS, so it reads at once, interval aside; hidden, it only marks the tab stale.
  function onOverlayReady() {
    if (!isShown()) { stale = true; return; }
    askOverlay({ urgent: true });
  }

  function shown() {
    if (stale) { stale = false; reloadTree(); }
    askOverlay({ urgent: true });
  }

  return { onChanged, onOverlayReady, shown, askOverlay, isStale: () => stale };
}

const API = { createRefresher, OVERLAY_EVERY_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoRefresh = API;

})(typeof window !== 'undefined' ? window : globalThis);
