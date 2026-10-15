'use strict';
/**
 * What every window knows about worktree occupancy (backlog #44 + #47, DESIGN_WORKTREE_OCCUPANCY.md).
 *
 * Watches the claim folder (host/occupancy-store.js), keeps ONLY the claims whose launching host is proven
 * alive (host/occupancy-live.js), and says when that set changed. Used by the Electron main process: it
 * feeds the strip's marks, each tab's banner and the hub's card line from one list.
 *
 *   current()  the live claims          state()  'ok' | 'missing' | 'unreadable'
 *   known(f)   true only when "no claim in folder f" can be believed: a pass has finished, the claim folder was
 *              readable and no claim naming f (its worktree or an `also`) was left unproven (the OS couldn't be
 *              asked). With no folder: no claim anywhere was left unproven. A Ctrl+click close (#77) needs it: an
 *              empty list from a service that couldn't look is not "no agents", and one unprovable claim doubts
 *              only the folders it names (Dexter R2).
 *   refresh()  re-read and re-judge     start() / close()
 *
 * TRUTH RULES
 *   - Absence is never "free": an unlistable folder is `unreadable` (logged once), and shows nothing.
 *   - A killed host writes no file event, so a timer re-judges every TICK_MS; a dead claim goes dark by
 *     itself. A READER never deletes anything (the next producer's sweep does).
 *   - When the OS can't be asked, a claim ALREADY proven live stays (nothing says it died), and one never
 *     proven never appears. Proof is remembered per (agent, host pid, host start time), so a rewritten
 *     file naming another host has to be proven again.
 *   - What counts as a change is the SET and what the claims say about where; `lastAt` and `count` don't
 *     (they only feed a label). While claims are live the owner is told again every LABEL_MS anyway, so
 *     "4 min" doesn't go stale.
 *   - It never throws, and a throwing onChange or startTimes can't wedge it.
 */

const fs = require('fs');
const { watchGlobalDir } = require('./global-watch');
const { readAll } = require('./occupancy-store');
const { judge, LIVE, UNKNOWN, UNPROVEN } = require('./occupancy-live');
const { normPath } = require('./project-layout');

const TICK_MS = 10_000;
const LABEL_MS = 30_000;

const proofKey = c => `${c.agentId}|${c.hostPid}|${c.hostStartedAt}`;
const signatureOf = claims => JSON.stringify([...claims]
  .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))
  .map(c => [c.agentId, c.agent, c.worktree, c.also, c.fromBranch, c.fromRoot, c.sessionId, c.hostPid, c.hostStartedAt, c.firstAt]));

function createOccupancyService({
  dir, ensureDir = () => {}, startTimes, onChange = () => {}, fsImpl = fs, watch = watchGlobalDir,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimer = clearTimeout, now = Date.now, log = console.log, tickMs = TICK_MS,
} = {}) {
  let live = [];
  let state = 'missing';
  let signature = signatureOf([]);
  let lastNotifiedAt = 0;
  let running = null;
  let again = false;
  let trusted = false;
  let doubted = new Set();   // the folders an unproven claim names
  let doubtAll = false;      // an unproven claim that names no usable folder doubts every one
  let closed = false;
  let watcher = null;
  let timer = null;
  const proven = new Set();
  const logged = new Set();

  const logOnce = (key, ...args) => { if (!logged.has(key)) { logged.add(key); log(...args); } };

  async function pass() {
    const read = readAll(dir, { fsImpl });
    if (read.state === 'unreadable') logOnce(`unreadable|${read.error}`, '[occupancy] the claim folder can\'t be read; showing none:', read.error);
    for (const s of read.skipped) logOnce(`${s.file}|${s.reason}`, `[occupancy] skipped ${s.file}: ${s.reason}`);
    state = read.state;

    const judged = read.claims.length ? await judge(read.claims, startTimes) : [];
    const next = [];
    const present = new Set();
    const unprovenIn = new Set();
    let unnamed = false;
    for (const { claim, verdict } of judged) {
      const key = proofKey(claim);
      present.add(key);
      if ((verdict === UNKNOWN || verdict === UNPROVEN) && !proven.has(key)) {   // hidden, but it might be an agent at work
        const named = [claim.worktree, ...(Array.isArray(claim.also) ? claim.also : [])].map(normPath).filter(n => n !== null);
        for (const n of named) unprovenIn.add(n);
        if (named.length === 0) unnamed = true;
      }
      if (verdict === LIVE) { proven.add(key); next.push(claim); } else if (verdict === UNKNOWN && proven.has(key)) next.push(claim);
      else proven.delete(key);
    }
    for (const key of [...proven]) if (!present.has(key)) proven.delete(key);

    live = next;
    trusted = read.state !== 'unreadable';
    doubted = unprovenIn;
    doubtAll = unnamed;
    const sig = signatureOf(next);
    const t = now();
    const changed = sig !== signature;
    const labelDue = next.length > 0 && t - lastNotifiedAt >= LABEL_MS;
    signature = sig;
    if (!closed && (changed || labelDue)) {
      lastNotifiedAt = t;
      try { onChange(); } catch (err) { log('[occupancy] onChange threw:', err && err.message); }
    }
  }

  // Overlapping refreshes (a burst of file events plus the timer) collapse into the one running plus at
  // most one follow-up, so the OS is asked once per burst, not once per event.
  function refresh() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do {
          again = false;
          try { await pass(); } catch (err) { trusted = false; log('[occupancy] refresh failed:', err && err.message); }
        } while (again);
      } finally { running = null; }
    })();
    return running;
  }

  function schedule() {
    if (closed) return;
    timer = setTimer(async () => {
      timer = null;
      await refresh();
      schedule();
    }, tickMs);
  }

  function start() {
    if (closed) return;
    try {
      watcher = watch(dir, () => { refresh(); }, { mkdirSync: ensureDir, log, what: 'worktree occupancy' });
    } catch (err) {
      log('[occupancy] cannot watch the claim folder; the timer still checks:', err && err.message);
    }
    refresh();
    schedule();
  }

  function close() {
    closed = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    try { if (watcher && typeof watcher.close === 'function') watcher.close(); } catch { /* already closed */ }
    watcher = null;
  }

  return {
    current: () => live.slice(), state: () => state, known: (folder) => {
      if (!trusted || doubtAll) return false;
      if (folder === undefined) return doubted.size === 0;
      const n = normPath(folder);
      return n !== null && !doubted.has(n);
    }, refresh, start, close,
    _ensureDir: ensureDir, _tickMs: tickMs,
  };
}

module.exports = { createOccupancyService, TICK_MS, LABEL_MS, signatureOf };
