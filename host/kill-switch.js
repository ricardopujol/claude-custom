'use strict';
/**
 * The stop path that doesn't depend on the agent (documentation/PLAN_SAFETY_NET.md, lane 2). Two parts, both pure here; the host
 * wires them (host/host.js, "the kill switch").
 *
 * THE SENTINEL KILL SWITCH. A file appearing stops the session's claude tree:
 *   <claude home>\STOP-ALL                 every host on the machine (the claude home is ~/.claude, from os.homedir())
 *   <project>\dev\.claude-custom\STOP      this project's hosts (the same `<dev>\.claude-custom\` the look and secrets live in)
 * The host polls them (watch) every second, so a trip lands well inside the plan's 5 s. On a trip the host kills the claude tree by
 * its pid through host/kill-tree.js (never by name), says which file did it in host.log, the diagnostics pane and the tab, and leaves
 * the file where it is: a host that starts while one exists doesn't spawn claude at all. The trip fires ONCE while any sentinel stays;
 * once every one is gone it re-arms, and a fresh tab (close it, reopen it) starts normally. The watcher never deletes a sentinel.
 *
 * THE NIGHT BUDGET. A /bedtime run (host/bedtime-state.js, through host/night-status.js's payload) is hard-stopped NIGHT_BUDGET_MS
 * after the FIRST night start, whatever the agent does, once. The anchor is the first night's start, not the current night's: the
 * agent can end a night (`ScheduleWakeup({ stop: true })`) and start another, so a budget keyed on "the night" would reset (Dexter F1,
 * PR #210). The anchor is saved (`save`) and loaded (`load`) so a replaced host keeps it, and a night may set a fresh anchor only
 * once the old one is NIGHT_FRESH_AFTER_MS old (the next evening). The deadline is checked against the wall clock on a 1 s poll, not
 * one long timer, so a laptop that slept through it trips on waking (Miguel Y3). At or past the deadline it kills only while a night
 * is on (`nightNow`), and a new night after the deadline is killed at once. bedtime-state's MAX_NIGHT_MS (12 h) is a different thing:
 * the cap after which the chip stops calling a run a night. A budget at or over it could never see its night, so the budget stays under it.
 *
 *   stopAllHome({ seam, home }) -> the folder STOP-ALL is in
 *   sentinelsFor({ claudeHome, stateRoot }) -> [path]               STOP-ALL first; no project, no STOP
 *   watch({ sentinelPaths, intervalMs, onTrip, onClear, exists, setInterval, clearInterval }) -> { check(), stop() }
 *       onTrip({ sentinel, scope })   scope 'all' | 'project'; check() answers the present sentinel (or null) at once, and trips
 *       onClear()                     once, when the last sentinel that tripped it is gone
 *   createNightBudget({ budgetMs, freshAfterMs, onExpire, nightNow, now, load, save, setInterval, clearInterval }) -> { update(payload), stop() }
 *       onExpire({ startedAt, deadline })       startedAt is the anchor
 *   loadAnchor(file, { read }) -> ms | null, saveAnchor(file, ms, { write, mkdir })   the anchor file, { anchor }
 *   describeStop(stop) -> the one line the host logs and shows
 *   createStopper({ term, stopPty, killChildTree, log, notify }) -> { stop(info) -> stopped?, state(), clearRefused() }   says why, then kills, once
 *   createLinger({ graceMs, now }) -> { update(stopped, windowCount) -> leave? }   a refused host with no window goes
 *   requestStopAll({ file, confirm, write, mkdir, now }) -> { outcome: 'written' | 'cancelled' | 'failed', error? }   the button's half
 */
const fs = require('fs');
const path = require('path');

const STOP_ALL = 'STOP-ALL';
const PROJECT_STOP = 'STOP';
const NIGHT_BUDGET_MS = (8 * 60 + 30) * 60_000;
// A new night gets a fresh budget only once the first night's start is this old (the next evening). Ricardo's Q3b.
const NIGHT_FRESH_AFTER_MS = 16 * 60 * 60_000;
const POLL_MS = 1000;
const LINGER_MS = 20_000;

const nonEmpty = (s) => typeof s === 'string' && s !== '';

function sentinelsFor({ claudeHome, stateRoot } = {}) {
  const out = [];
  if (nonEmpty(claudeHome)) out.push(path.join(claudeHome, STOP_ALL));
  if (nonEmpty(stateRoot)) out.push(path.join(stateRoot, '.claude-custom', PROJECT_STOP));
  return out;
}

// Where STOP-ALL lives: ~/.claude from the home folder, NOT the CLI's config dir (a CLAUDE_CONFIG_DIR would move one host's sentinel
// away from every other's, and "every host on the machine" needs one place). The claude-home probe seam (host/probe-seams.js
// `claudeHome`, logged when set) stands in for it, so a probe never writes the real one. Main's STOP ALL button uses the same.
function stopAllHome({ seam, home } = {}) {
  if (nonEmpty(seam)) return seam;
  return nonEmpty(home) ? path.join(home, '.claude') : null;
}

function scopeOf(sentinel) {
  if (!nonEmpty(sentinel)) return null;
  return path.basename(sentinel) === STOP_ALL ? 'all' : 'project';
}

const positiveMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function watch({
  sentinelPaths, intervalMs = POLL_MS, onTrip = () => {}, onClear = () => {}, exists = fs.existsSync,
  setInterval: every = setInterval, clearInterval: cancel = clearInterval,
} = {}) {
  if (!positiveMs(intervalMs)) throw new Error('kill-switch watch: intervalMs must be a positive number of ms');
  const paths = Array.isArray(sentinelPaths) ? sentinelPaths.filter(nonEmpty) : [];
  let tripped = null;               // the sentinel that tripped, while any sentinel is still there

  const isThere = (p) => { try { return exists(p) === true; } catch { return false; } };

  function check() {
    const found = paths.find(isThere) || null;
    if (found === null) {                                        // every one gone: re-armed
      if (tripped !== null) {
        tripped = null;
        try { onClear(); } catch { /* a listener never stops the watch */ }
      }
      return null;
    }
    if (tripped === null) {
      tripped = found;
      try { onTrip({ sentinel: found, scope: scopeOf(found) }); } catch { /* a listener never stops the watch */ }
    }
    return found;
  }

  const timer = every(check, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { check, stop: () => cancel(timer) };
}

function createNightBudget({
  budgetMs = NIGHT_BUDGET_MS, freshAfterMs = NIGHT_FRESH_AFTER_MS, onExpire = () => {}, nightNow = () => null, now = Date.now,
  load = () => null, save = () => {}, setInterval: every = setInterval, clearInterval: cancel = clearInterval, intervalMs = POLL_MS,
} = {}) {
  if (!positiveMs(budgetMs)) throw new Error('kill-switch night budget: budgetMs must be a positive number of ms');
  if (!positiveMs(freshAfterMs) || freshAfterMs <= budgetMs) throw new Error('kill-switch night budget: freshAfterMs must be longer than budgetMs');
  let anchor = null;                // the FIRST night start still inside freshAfterMs: the deadline is anchor + budgetMs
  let timer = null;
  let fired = false;

  const startOf = (p) => (p && typeof p === 'object' && typeof p.startedAt === 'number' && Number.isFinite(p.startedAt) ? p.startedAt : null);

  function unpoll() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  // Wall clock on a 1 s poll, not one long timeout: a laptop that slept through the deadline trips on its first tick after waking.
  function poll() {
    if (timer !== null || fired) return;
    timer = every(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function tick() {
    if (fired || anchor === null) return;
    const t = now();
    if (t - anchor >= freshAfterMs) { anchor = null; unpoll(); return; }       // that run is long over: the next night starts afresh
    if (t < anchor + budgetMs) return;
    if (startOf(nightNow()) === null) return;                                 // past the deadline, but no night is on: nothing to stop
    fired = true;
    unpoll();
    try { onExpire({ startedAt: anchor, deadline: anchor + budgetMs }); } catch { /* the host's handler logs its own failures */ }
  }

  // A host restarted mid-night finds the anchor on disk: the new host's first "night" is not a new run (Dexter F1, PR #210).
  try {
    const saved = load();
    if (typeof saved === 'number' && Number.isFinite(saved) && saved <= now() && now() - saved < freshAfterMs) { anchor = saved; poll(); }
  } catch { /* unreadable: no anchor */ }

  function update(payload) {
    if (fired) return;
    const startedAt = startOf(payload);
    if (startedAt === null) return;                  // a night that ended does not disarm: the agent can start another one
    if (anchor === null || now() - anchor >= freshAfterMs) {
      anchor = startedAt;
      try { save(anchor); } catch { /* the budget still holds in memory */ }
    }
    poll();
    tick();
  }

  return { update, stop: unpoll };
}

// The anchor file: { anchor: <ms> }. Atomic write is the host's (injected); a missing or odd file is simply no anchor.
function loadAnchor(file, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (!nonEmpty(file)) return null;
  try {
    const doc = JSON.parse(read(file));
    return doc && typeof doc === 'object' && typeof doc.anchor === 'number' && Number.isFinite(doc.anchor) ? doc.anchor : null;
  } catch { return null; }
}

function saveAnchor(file, anchor, { write, mkdir = (d) => fs.mkdirSync(d, { recursive: true }) } = {}) {
  if (!nonEmpty(file)) throw new Error('no anchor path');
  mkdir(path.dirname(file));
  write(file, JSON.stringify({ anchor }));
}

function hoursMinutes(ms) {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function describeStop(stop) {
  if (!stop || typeof stop !== 'object') return '';
  if (stop.kind === 'night-budget') {
    const started = typeof stop.startedAt === 'number' ? new Date(stop.startedAt).toISOString() : 'an unknown time';
    return `Night budget: this /bedtime night started at ${started} and ran ${hoursMinutes(stop.budgetMs || NIGHT_BUDGET_MS)}, so its claude was stopped. A fresh tab starts normally.`;
  }
  const where = nonEmpty(stop.sentinel) ? stop.sentinel : 'a stop file';
  if (stop.kind === 'refused') return `Kill switch: ${where} exists, so claude was not started. Delete that file, then close and reopen this tab.`;
  return `Kill switch: ${where} appeared, so this session's claude was stopped. Delete that file, then close and reopen this tab to start again.`;
}

/**
 * The host's one stop (a trip, a refusal at start, the night budget): said FIRST (host.log, then `notify`, which tells the windows and
 * writes the line into the tab), then the tracked pty is ended through host/pty-stop.js with kill-tree's killChildTree: by the pty's
 * own pid, proven by its start time, once. Never by name. Once per host: a host that stopped exits with its claude, and one that
 * refused stays refused until it is replaced, so a second stop has nothing to add.
 */
function createStopper({ term, stopPty, killChildTree, log = () => {}, notify = () => {}, now = Date.now } = {}) {
  let state = null;
  return {
    stop(info) {
      if (state !== null) return false;
      const text = describeStop(info);
      state = { ...info, at: now(), text };
      try { log(`[kill-switch] ${text}`); } catch { /* the kill below still runs */ }
      try { notify(state); } catch { /* ...and so does it here */ }
      const t = term();
      if (t) stopPty(t, { killChildTree });
      return true;
    },
    state: () => state,
    // A refusal is not a kill: once the file is gone the host may start its session (Dexter F4 / Miguel Y1, PR #210). A trip or the
    // night budget stays, because that host's claude is dead and the host leaves with it.
    clearRefused() {
      if (state === null || state.kind !== 'refused') return false;
      state = null;
      return true;
    },
  };
}

function createLinger({ graceMs = LINGER_MS, now = Date.now } = {}) {
  let since = null;
  return {
    update(stopped, windowCount) {
      if (!stopped || windowCount !== 0) { since = null; return false; }
      if (since === null) since = now();
      return now() - since >= graceMs;
    },
  };
}

async function requestStopAll({ file, confirm, write, mkdir = (d) => fs.mkdirSync(d, { recursive: true }), now = Date.now } = {}) {
  if (!nonEmpty(file)) return { outcome: 'failed', error: 'no STOP-ALL path' };
  let yes = false;
  try { yes = (await confirm()) === true; } catch { yes = false; }
  if (!yes) return { outcome: 'cancelled' };
  try {
    mkdir(path.dirname(file));
    write(file, `${new Date(now()).toISOString()} written by the claude-custom STOP ALL button. Delete this file to let sessions start again.\n`);
    return { outcome: 'written' };
  } catch (err) {
    return { outcome: 'failed', error: (err && err.message) || String(err) };
  }
}

module.exports = {
  stopAllHome, sentinelsFor, scopeOf, watch, createNightBudget, describeStop, createStopper, createLinger, requestStopAll,
  loadAnchor, saveAnchor, NIGHT_BUDGET_MS, NIGHT_FRESH_AFTER_MS, POLL_MS, STOP_ALL, PROJECT_STOP,
};
