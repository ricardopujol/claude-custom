'use strict';
/**
 * The tab shell's decisions (PR 2, worktree tabs), with every effect injected.
 *
 * app/main.js is the only file that touches Electron, sockets and child
 * processes; it builds the `deps` below and forwards events. Everything that
 * DECIDES -- which port a starting tab gets, what a poll observes, which tab a
 * message came from, what "Go to that session" does, what the probe driver
 * accepts -- is here, so it can be tested without a window.
 *
 * THE MODEL. `host/tab-lifecycle.js` is the reducer (which worktrees are tabs);
 * `app/tab-model.js` joins it with the runtime facts kept here (which tab has a
 * host and a view, what each tab's renderer last reported) into what the strip
 * draws. A tab is a record `{ key, cwd, branch, isDev, port, token, view,
 * started, starting, error, status, closed }`; `key` is `normPath(cwd)`, the
 * one spelling every comparison uses.
 *
 * THE RULES THAT COST SOMETHING (each has a test):
 *   - Port choice AND spawn go through ONE promise chain. Two tabs whose paths
 *     hash to the same port would otherwise both see it free and both take it.
 *   - `resolvePort` is asked AT THE MOMENT a tab starts, never at open: another
 *     tab's spawn may have taken the port in between.
 *   - `listening` is `true` for a started tab whose host answers, `false` ONLY
 *     for a started (not starting) tab whose port REFUSED the connection
 *     (host/port-probe.js), and LEFT OUT otherwise. The reducer reads `false`
 *     as "confirmed gone" and removes a merged worktree's folder on it, so a
 *     probe that timed out, a starting host and an unstarted one are all "not
 *     known" (PR 3, plan S3). A host exits with its claude, so a refusal is
 *     "the session ended".
 *   - A poll reads the merged markers BEFORE it probes the hosts
 *     (observeWorktrees), so a host seen listening in that poll ran after the
 *     merge was marked.
 *   - Every `remove` gets exactly one removeResult (runRemove), even when the
 *     remover throws.
 *   - A tab the `+` made doesn't start its session until Contract E has
 *     finished, and a setup failure never keeps it from starting (criterion 10).
 *   - A poll that can't list worktrees produces NO observation; one that lists
 *     no dev is ignored by the reducer. Either way every tab stays.
 *   - Absence is never a number: a tab's port and token are null until known.
 */

const path = require('path');
const lifecycle = require('../host/tab-lifecycle');
const { parsePorcelain, tabWorktrees } = require('../host/worktree-list');
const { checkBranch } = require('../host/worktree-ops');
const { normPath, isInside } = require('../host/project-layout');
const tabModel = require('./tab-model');
const tabStatusLib = require('./tab-status');
const occupancyDisplay = require('./occupancy-display');
const { planGoTo } = require('./go-to-session');

// --- pure helpers ------------------------------------------------------------

/** A promise chain: `run(fn)` starts `fn` after every earlier `fn` settled. */
function createQueue() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn());
      // The chain must survive a failure; the CALLER still sees the rejection.
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/**
 * The reducer's `listening` map, keyed by normPath, for every started tab:
 * `true` when its port answers, `false` when it refused. A timeout, a throw or
 * any other answer leaves the tab out.
 */
async function captureListening(tabs, probe) {
  const out = {};
  // A tab whose port already refused has no host of its own any more: whatever
  // answers on that port later is ANOTHER tab's host and must never vouch for
  // it (PR #80 Dexter F2). It is watched again once it starts again.
  const started = [...tabs].filter(t => t.started === true && t.starting !== true && t.ended !== true
    && Number.isInteger(t.port));
  const answers = await Promise.all(started.map(async (t) => {
    try { return await probe(t.port); } catch { return 'unknown'; }
  }));
  started.forEach((t, i) => {
    if (answers[i] === 'listening') out[t.key] = true;
    else if (answers[i] === 'refused') out[t.key] = false;
  });
  return out;
}

/**
 * The worktrees and merged markers (Contract B) of one poll, from `git
 * worktree list --porcelain` text, or null when there is no text (git failed):
 * no observation at all. Each marker is read with the branch git lists in THIS
 * poll (host/merged-marker.js compares it strictly), never for dev, and a
 * reader that throws means "not merged".
 *
 * Called BEFORE the poll probes the hosts: a `listening: true` captured after
 * the marker was read proves the host ran after the merge, which is what the
 * reducer's hostSeen means.
 */
function observeWorktrees(porcelain, container, readMarker) {
  if (typeof porcelain !== 'string') return null;
  const worktrees = tabWorktrees(parsePorcelain(porcelain), container);
  const merged = {};
  for (const w of worktrees) {
    if (w.isDev || typeof w.branch !== 'string' || w.branch === '') continue;
    let marker = null;
    try { marker = readMarker(w.path, w.branch); } catch { marker = null; }
    if (marker) merged[normPath(w.path)] = true;
  }
  return { worktrees, merged };
}

// What a tab says when no port could be found or refused for its folder.
const NO_PORT_ERROR = 'no usable port for this folder';

const noWindowText = (h) => `That session is in another claude-custom (pid ${h.pid}, port ${h.port}) ` +
  'with no window open. Open its project to see it.';

const cleanLock = (s) => (typeof s === 'string' && s ? s : null);

/** What a renderer may say about itself, cut down to the five known fields. */
// The drawer's rule for "is this session at rest?" -- one copy, so the re-check here agrees with it.
const { sessionBusyWhy } = require('./git-actions');
const busyWhy = (status) => sessionBusyWhy(status);

function sanitizeStatus(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    working: o.working === true,
    needsInput: o.needsInput === true,
    finished: o.finished === true,
    lock: cleanLock(o.lock),
    health: typeof o.health === 'string' && o.health !== '' ? o.health : null,
    turn: tabStatusLib.TURNS.includes(o.turn) ? o.turn : null,
  };
}

// --- the shell ---------------------------------------------------------------

/**
 * deps:
 *   mode            'tabs' | 'single'
 *   container       tabs mode: the project root (`<root>\dev` is the anchor)
 *   cwd             single mode: the one folder
 *   launchedFrom    the folder the launcher was given (initial selection)
 *   git.list()      -> Promise<string>  `git worktree list --porcelain` text; rejects on failure
 *   git.marker(path, branch) -> marker | null   host/merged-marker.js readMergedMarker (Contract B)
 *   ops.available() -> { create, setup, remove }   which contract scripts exist (host/worktree-ops.js)
 *   ops.create({ container, branch }) -> Promise<{ ok, path, branch, warning } | { ok: false, error }>  (A)
 *   ops.setup({ path, onLine })       -> Promise<{ ok, result } | { ok: false, error, log }>     (E)
 *   ops.remove({ path })              -> Promise<{ ok, already } | { ok: false, kept, reason } | { ok: false, error }>  (C)
 *   hosts.choosePort(tab)  -> Promise<{ port, action: 'spawn'|'attach' } | null>
 *   hosts.probe(port)      -> Promise<'listening'|'refused'|'unknown'>  (host/port-probe.js)
 *   hosts.spawn({ tab, port, token })      starts a detached host (may throw)
 *   hosts.wait(port)       -> Promise<boolean>  the host came up
 *   hosts.tokenFor(port)   -> string | null     a RUNNING host's token
 *   hosts.tokenFile(port)  -> string | null     ONLY `hosts/<port>.token`: written by
 *                                               the host that won the bind, and nobody else
 *   hosts.newToken()       -> string
 *   hosts.control({ port, token, msg })    -> Promise<{ ok, reply? , error? }>
 *   hosts.identity({ install, port }), hosts.readToken(install, port)  (planGoTo's)
 *   views.create(tab)      -> view          shows the tab's renderer
 *   views.destroy(tab)
 *   views.send(tab, channel, payload)
 *   views.owns(tab, sender)-> boolean       the view's webContents is `sender`
 *   occupancy.claims()     -> [claim]    the LIVE worktree-occupancy claims (host/occupancy-service.js); optional
 *   now()                  -> ms         the clock the "4 min" labels read; optional
 *   ui.confirmClose(tab)   -> Promise<boolean>
 *   ui.changed(snapshot)
 *   ui.focusWindow()       restore + show + focus + flash
 *   ui.isFocused()
 *   log(...)
 */
// Every host function the shell calls. A missing one used to throw INSIDE a
// start, where it became a tab error and a view that never appeared.
const HOST_DEPS = ['choosePort', 'probe', 'spawn', 'wait', 'tokenFor', 'tokenFile', 'newToken', 'control',
  'identity', 'readToken'];
// The same, for the worktree contract scripts (PR 3).
const OPS_DEPS = ['available', 'create', 'setup', 'remove'];

// How many tabs closed by hand the `+` menu offers to reopen.
const REOPEN_MAX = 10;

// The Git drawer: how many folders one tabStates answer covers, and how long Type /merged waits for the
// target page to say it typed (its spaced keys and read-back take under a second).
const TAB_STATES_MAX = 200;
const TYPE_ANSWER_MS = 5000;
// The branches /merged never runs on: it merges a lane INTO these
const INTEGRATION = ['develop', 'main', 'master'];

const errorText = (err) => (err && err.message) || String(err);

function createShell(deps) {
  const {
    mode = 'tabs', container = null, cwd = null, launchedFrom = null,
    git, hosts, ops, views, ui, log = () => {},
    // #40: `markFor(branch)` -> { id, emoji, meaning } | null. Optional.
    marks = null,
    // Worktree occupancy (#44 + #47): `claims()` -> the live claims. Optional; a reader that fails draws none.
    occupancy = null,
    now = Date.now,
    // How long Type /merged waits for the target page's answer; injected so a test doesn't wait.
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    // Type /merged's own re-check (PR #93 Miguel I3): `openFor(folder, branch)` -> true / false / null
    // (gh can't say). Absent: never confirmed, so never typed.
    prs = null,
  } = deps;
  for (const k of HOST_DEPS) {
    if (!hosts || typeof hosts[k] !== 'function') throw new TypeError(`createShell: hosts.${k} is required`);
  }
  for (const k of OPS_DEPS) {
    if (!ops || typeof ops[k] !== 'function') throw new TypeError(`createShell: ops.${k} is required`);
  }
  if (!git || typeof git.marker !== 'function') throw new TypeError('createShell: git.marker is required');

  const queue = createQueue();
  const tabs = new Map();        // key -> record
  let state = lifecycle.initial();
  let selectedKey = null;
  let polling = false;
  let lastError = null;
  let closeNotice = null;        // a hand close whose stop failed; cleared by the next selection
  let destroyed = false;
  // PR 3. `create` is the strip's branch form: null, or { phase: 'input' } /
  // { phase: 'running', branch } / { phase: 'failed', branch, error }.
  let create = null;
  const pendingBranches = new Set();   // branches Contract A is creating right now
  const setups = new Map();            // key -> { running, line, error, log }  (Contract E)
  const createdWarnings = new Map();   // key -> Contract A's optional warning
  let selectWhenListed = null;         // a tab to select as soon as a poll lists it
  // Type /merged: the type-command requests waiting for their page's answer, by id
  const typing = new Map();
  let typingSeq = 0;
  const typingMerged = new Set();     // the tabs a Type /merged is typing into right now
  let closedByHand = [];               // [{ key, path, branch }], most recent first

  const keyOf = normPath;

  function runtime() {
    const rt = new Map();
    for (const t of tabs.values()) {
      rt.set(t.key, {
        started: t.started, port: t.port, token: t.token, status: t.status,
        setup: setups.has(t.key) ? { ...setups.get(t.key) } : null,
        createdWarning: createdWarnings.get(t.key) || null,
      });
    }
    return rt;
  }

  function scriptsAvailable() {
    try {
      const a = ops.available() || {};
      return { create: a.create === true, setup: a.setup === true, remove: a.remove === true };
    } catch {
      return { create: false, setup: false, remove: false };
    }
  }

  // A tab whose worktree Contract A is still making, or Contract E is still
  // setting up, doesn't start its session yet (criterion 10).
  const setupHolds = (tab) => (typeof tab.branch === 'string' && pendingBranches.has(tab.branch))
    || (setups.has(tab.key) && setups.get(tab.key).running === true);

  // A mark is decoration: a reader that fails draws none and never takes the strip down.
  function readMark(branch) {
    if (!marks || typeof marks.markFor !== 'function' || typeof branch !== 'string') return null;
    try { return marks.markFor(branch) || null; } catch (err) {
      log('[shell] marks.markFor threw:', err && err.message);
      return null;
    }
  }

  // The live claims, or none: decoration, so a reader that fails or answers oddly never takes the strip down.
  function readClaims() {
    if (!occupancy || typeof occupancy.claims !== 'function') return [];
    try {
      const c = occupancy.claims();
      return Array.isArray(c) ? c : [];
    } catch (err) {
      log('[shell] occupancy.claims threw:', err && err.message);
      return [];
    }
  }

  /**
   * The branch a tab is on NOW: the reducer's, which follows `git switch`. The
   * record's `branch` is the one it opened on and never moves (Dexter #87 F1).
   */
  function branchOf(key) {
    const t = state.tabs.find(x => keyOf(x.path) === key);
    return t && typeof t.branch === 'string' && t.branch !== '' ? t.branch : null;
  }

  function model() {
    const claims = readClaims();
    const at = now();
    return tabModel.stripModel(state, runtime(), selectedKey, { keyOf }).map((e) => {
      const t = tabs.get(e.key);
      // The strip paints these; it decides nothing (PR 3: badge and phase line).
      return {
        ...e, starting: !!(t && t.starting), startError: t ? t.error : null,
        badge: tabModel.badgeFor(e), phaseText: tabModel.phaseText(e), mark: readMark(branchOf(e.key)),
        // #44 + #47: the hatched edge. The warning is this tab's OWN reported turn, nothing guessed.
        occupancy: occupancyDisplay.tabOccupancy(claims, e.key, { keyOf, turn: t && t.status ? t.status.turn : null, now: at }),
      };
    });
  }

  // What one tab's page is told: the claims that sit in its folder (its banner and keystroke confirm) and the
  // ones its own session launched (its hub cards). Only what changed is sent.
  const EMPTY_OCCUPANCY = JSON.stringify({ here: [], launched: [] });
  function pushOccupancy() {
    const claims = readClaims();
    for (const tab of tabs.values()) {
      if (!tab.view) continue;
      const payload = occupancyDisplay.viewPayload(claims, tab.key, { keyOf });
      const text = JSON.stringify(payload);
      if (text === tab.occupancySent) continue;
      tab.occupancySent = text;
      try { views.send(tab, 'occupancy', payload); } catch (err) { log('[shell] sending occupancy threw:', err && err.message); }
    }
  }

  /** The payload for the page that asked (its first paint), or null for a sender that is no tab's page. */
  function occupancyFor(sender) {
    const tab = tabForSender(sender);
    if (!tab) return null;
    const payload = occupancyDisplay.viewPayload(readClaims(), tab.key, { keyOf });
    tab.occupancySent = JSON.stringify(payload);
    return payload;
  }

  function snapshot() {
    const m = model();
    const sel = m.find(e => e.selected);
    return {
      model: m, selectedKey: sel ? sel.key : null, tabs: [...tabs.values()], notice: lastError, closeNotice, mode,
      create: create ? { ...create } : null,
    };
  }

  function publish() {
    if (destroyed) return;
    try { ui.changed(snapshot()); } catch (err) { log('[shell] ui.changed threw:', err && err.message); }
    pushOccupancy();
  }

  const tabByKey = (key) => tabs.get(key) || null;
  const tabForSender = (sender) => {
    for (const t of tabs.values()) if (t.view && views.owns(t, sender)) return t;
    return null;
  };
  const isTabView = (sender) => tabForSender(sender) !== null;

  function newRecord(entry) {
    return {
      key: keyOf(entry.path), cwd: entry.path, branch: entry.branch === undefined ? null : entry.branch,
      isDev: entry.isDev === true, port: null, token: null, view: null,
      started: false, starting: false, error: null, status: null, closed: false, startPromise: null, pending: null,
      attachPromise: null, unconfirmed: null, ended: false, occupancySent: EMPTY_OCCUPANCY,
    };
  }

  // Create the tab's view. The session is running by now (attached or spawned).
  function present(tab, port, token) {
    tab.port = port;
    tab.token = token;
    tab.view = views.create(tab);
    tab.occupancySent = EMPTY_OCCUPANCY;     // a fresh page knows nothing yet
    tab.started = true;
    tab.ended = false;          // a host of its own again: watched again (Dexter F2)
    // A host given up on earlier, if it ever binds, meets this one's lock and
    // exits on its own (session-gate idleExit): nothing left to warn about.
    tab.unconfirmed = null;
  }

  // At open: a tab whose session is ALREADY running gets its view now (its
  // markers should show). One that isn't records nothing and starts nothing.
  // The promise is kept so a hand close can wait for it (Dexter, PR #75 R2-3).
  function attachIfRunning(tab) {
    tab.attachPromise = queue.run(async () => {
      if (tab.closed || tab.started || tab.starting || destroyed) return;
      let chosen = null;
      try { chosen = await hosts.choosePort(tab); } catch (err) { log('[shell] port probe failed:', err && err.message); }
      if (!chosen || chosen.action !== 'attach' || tab.closed || tab.started || tab.starting) return;
      const token = hosts.tokenFor(chosen.port);
      if (!token) { log(`[shell] ${tab.key}: a host is on ${chosen.port} but its token can't be read`); return; }
      present(tab, chosen.port, token);
    }).then(publish, publish);
    return tab.attachPromise;
  }

  // First selection: choose the port NOW, spawn if nobody serves this folder,
  // wait for it, then draw. One chain, so two tabs can't take one port.
  function start(tab) {
    if (tab.started) return Promise.resolve();
    if (tab.starting) return tab.startPromise;
    // Started when its setup ends (createWorktree), not before.
    if (setupHolds(tab)) { publish(); return Promise.resolve(); }
    tab.starting = true;
    tab.error = null;
    publish();
    tab.startPromise = queue.run(async () => {
      let spawned = false;
      let port = null;
      let token = null;
      try {
        if (tab.closed || destroyed) return;
        if (tab.started) return;
        const chosen = await hosts.choosePort(tab);
        if (!chosen) throw new Error(NO_PORT_ERROR);
        port = chosen.port;
        // Dexter, PR #75 F2: a spawn whose wait timed out left a host that may
        // still be coming up. Retry must not spawn a second one onto its port.
        const pend = tab.pending && tab.pending.port === port ? tab.pending : null;
        tab.pending = null;
        if (pend && chosen.action === 'attach') {
          token = pend.token;                      // the ORIGINAL host, its ORIGINAL token
        } else if (pend) {
          // Still not answering: give that host one more wait, spawn nothing.
          // A second failure forgets it, so the next Retry may spawn afresh
          // (a loser of the bind no longer touches the token files). A hand
          // close still says it may be running (Dexter, PR #75 R2-3).
          if (!(await hosts.wait(port))) {
            tab.unconfirmed = pend;
            throw new Error(`the host did not come up on port ${port} in time`);
          }
          token = pend.token;
        } else if (chosen.action === 'attach') {
          token = hosts.tokenFor(port);
          if (!token) throw new Error(`a host is on port ${port} but its token can't be read`);
        } else {
          token = hosts.newToken();
          hosts.spawn({ tab, port, token });
          spawned = true;
          if (!(await hosts.wait(port))) {
            tab.pending = { port, token };
            throw new Error(`the host did not come up on port ${port} in time`);
          }
        }
        // Dexter, PR #75 R2-2: present the token of whoever BOUND the port. Only
        // the winner of the bind writes `hosts/<port>.token` (F2), so the file
        // names the host actually listening; a token kept or generated here is
        // only a guess about who that is. It stands in only while the file isn't
        // written yet -- our own host, just past its bind.
        token = hosts.tokenFile(port) || token;
        if (tab.closed || destroyed) {
          // Closed while starting: don't leave the host we just made behind.
          if (spawned) hosts.control({ port, token, msg: { type: 'stop' } }).catch(() => {});
          return;
        }
        present(tab, port, token);
      } catch (err) {
        tab.error = (err && err.message) || String(err);
        log(`[shell] ${tab.key}: start failed: ${tab.error}`);
      } finally {
        tab.starting = false;
        publish();
      }
    });
    return tab.startPromise;
  }

  function sendSelected(tab) {
    if (tab.status) tab.status = tabStatusLib.afterSelected(tab.status);
    if (tab.view) views.send(tab, 'tab-selected');
  }

  /** Select a tab, starting it (or retrying a failed start) as needed. */
  function select(key) {
    const next = tabModel.select(model(), key);
    if (next === null) return Promise.resolve();
    closeNotice = null;
    selectedKey = next;
    const tab = tabByKey(next);
    let started = Promise.resolve();
    if (tab) {
      sendSelected(tab);
      if (!tab.started && !tab.starting) started = start(tab);
    }
    publish();
    return started;
  }

  // Execute the reducer's actions. `before` is the model from BEFORE the state
  // changed, which is what afterClose needs.
  function apply(actions, before) {
    let reselect = false;
    for (const a of actions) {
      const key = keyOf(a.path);
      if (a.type === 'open') {
        if (tabs.has(key)) continue;
        const entry = state.tabs.find(t => keyOf(t.path) === key) || { path: a.path, branch: a.branch, isDev: false };
        const tab = newRecord(entry);
        tabs.set(key, tab);
        attachIfRunning(tab);
      } else if (a.type === 'stop') {
        const t = tabByKey(key);
        if (t && t.started && t.port && t.token) {
          hosts.control({ port: t.port, token: t.token, msg: { type: 'stop' } })
            .then(r => log(`[shell] stop ${t.key}: ${r && r.ok ? 'sent' : (r && r.error)}`), () => {});
        }
      } else if (a.type === 'close') {
        const t = tabByKey(key);
        if (!t) continue;
        t.closed = true;
        if (t.view) { try { views.destroy(t); } catch (err) { log('[shell] destroy failed:', err && err.message); } }
        t.view = null;
        tabs.delete(key);
        // A setup still running keeps holding the folder's session, so a
        // Reopen meanwhile can't start it early (PR #80 Dexter F1).
        if (!(setups.has(key) && setups.get(key).running === true)) setups.delete(key);
        createdWarnings.delete(key);
        if (key === selectedKey) {
          selectedKey = tabModel.afterClose(before, key, selectedKey);
          reselect = true;
        }
      } else if (a.type === 'error') {
        const t = tabByKey(key);
        if (t) t.error = a.error;
      } else if (a.type === 'mark-merged') {
        // The strip draws it from state.tabs; the session keeps running (W4).
        log(`[shell] ${key}: merged (${a.branch})`);
      } else if (a.type === 'remove') {
        runRemove(a.path);
      }
    }
    if (reselect && selectedKey !== null) select(selectedKey);
    publish();
  }

  // Contract C, for a tab the reducer moved to `removing`: its session ended
  // after the merge. Exactly one removeResult per remove, whatever happens.
  function runRemove(p) {
    Promise.resolve()
      .then(() => ops.remove({ path: p }))
      .then(r => r, err => ({ ok: false, error: errorText(err) }))
      .then((r) => {
        if (destroyed) return;
        const what = r && r.ok === true ? (r.already ? 'already removed' : 'removed')
          : (r && r.kept === true ? `kept: ${r.reason}` : `failed: ${r && r.error}`);
        log(`[shell] remove ${keyOf(p)}: ${what}`);
        const before = model();
        const { state: next, actions } = lifecycle.removeResult(state, p, r);
        state = next;
        apply(actions, before);
      });
  }

  function reconcileWith(observation) {
    const before = model();
    const { state: next, actions } = lifecycle.reconcile(state, observation);
    state = next;
    apply(actions, before);
    if (selectWhenListed !== null && tabs.has(selectWhenListed)) {
      const k = selectWhenListed;
      selectWhenListed = null;
      select(k);
    } else if (selectedKey === null || !tabs.has(selectedKey)) {
      const first = tabModel.initialSelection(state.tabs, launchedFrom, { keyOf, isInside });
      if (first !== null && tabs.has(first)) select(first);
    }
  }

  /** One poll. One at a time: a tick that finds one running does nothing. */
  async function poll() {
    if (mode !== 'tabs' || polling || destroyed) return;
    polling = true;
    try {
      let text = null;
      try {
        text = await git.list();
        lastError = null;
      } catch (err) {
        lastError = `can't list worktrees: ${(err && err.message) || err}`;
        log('[shell]', lastError);
      }
      // Captured now, reconciled now, in this order, before the next poll
      // starts: the markers first, then the hosts (see observeWorktrees).
      const seen = observeWorktrees(text, container, git.marker);
      const listening = await captureListening(tabs.values(), hosts.probe);
      // Refused once: that session ended. Its port is free for another tab.
      for (const [k, v] of Object.entries(listening)) {
        const t = tabs.get(k);
        if (v === false && t) t.ended = true;
      }
      if (seen) reconcileWith({ ...seen, listening });
      else publish();
    } finally {
      polling = false;
    }
  }

  /** The window opened: build the tabs and start the selected one. */
  async function open() {
    if (mode === 'single') {
      const entry = { path: cwd, branch: null, isDev: true };
      state = { tabs: [{ ...entry, phase: 'live', hostSeen: false }], dismissed: [] };
      const tab = newRecord(entry);
      tabs.set(tab.key, tab);
      selectedKey = tab.key;
      publish();
      await start(tab);
      return tab;
    }
    await poll();
    return null;
  }

  /** Hand close: confirm, then the reducer's `stop` + `close`. Nothing on disk. */
  async function closeTab(key) {
    const tab = tabByKey(key);
    if (!tab || tab.isDev || mode !== 'tabs') return { ok: false, error: 'not closable' };
    const phaseNow = (state.tabs.find(t => keyOf(t.path) === key) || {}).phase;
    if (phaseNow === 'removing') return { ok: false, error: 'its folder is being removed' };   // Dexter F4
    let yes = false;
    try { yes = (await ui.confirmClose(tab)) === true; } catch { yes = false; }
    if (!yes) return { ok: false, cancelled: true };
    if (!tabs.has(key)) return { ok: true };     // gone while the dialog was up
    // Dexter, PR #75 F3: a tab still attaching has no host to stop YET. Let the
    // start finish (it is bounded by the host wait), then stop what it presented.
    if (tab.starting && tab.startPromise) {
      try { await tab.startPromise; } catch { /* start() reports its own errors */ }
      if (!tabs.has(key)) return { ok: true };
    }
    // Dexter, PR #75 R2-3: an open-time attach never sets `starting`. Let a
    // queued one finish too, so the session it finds can be stopped.
    if (!tab.started && tab.attachPromise) {
      try { await tab.attachPromise; } catch { /* attachIfRunning logs its own */ }
      if (!tabs.has(key)) return { ok: true };
    }
    const label = (model().find(e => e.key === key) || {}).label || tab.branch || tab.cwd;
    let target = null;
    let failure = null;
    if (tab.started && tab.port && tab.token) target = { port: tab.port, token: tab.token };
    else if (tab.pending) target = { port: tab.pending.port, token: tab.pending.token };
    else {
      // Nothing presented and nothing pending: ask once more whether a host
      // serves this folder (an attach that couldn't read the token, a host that
      // bound after the shell gave up on it). Through the queue, like a start.
      let found = null;
      try { found = await queue.run(() => hosts.choosePort(tab)); } catch { found = null; }
      if (found && found.action === 'attach') {
        const token = hosts.tokenFile(found.port) || hosts.tokenFor(found.port);
        if (token) target = { port: found.port, token };
        else failure = `a host is on port ${found.port} but its token can't be read`;
      } else if (tab.unconfirmed) {
        failure = `its host on port ${tab.unconfirmed.port} never answered`;
      }
    }
    const before = model();
    const { state: next, actions } = lifecycle.closeByHand(state, tab.cwd);
    state = next;
    // The `+` menu offers it back (Ricardo, 2026-09-30), most recent first.
    closedByHand = [{ key, path: tab.cwd, branch: tab.branch }, ...closedByHand.filter(c => c.key !== key)];
    // The stop is sent here, where its outcome can be seen, not fire-and-forget.
    apply(actions.filter(a => a.type !== 'stop'), before);
    if (target) {
      try {
        const r = await hosts.control({ ...target, msg: { type: 'stop' } });
        if (!r || r.ok !== true) failure = (r && r.error) || 'no answer';
      } catch (err) {
        failure = (err && err.message) || String(err);
      }
    }
    if (failure !== null) {
      closeNotice = `Couldn't end the session in ${label}: ${failure}. It may still be running.`;
      log(`[shell] ${key}: ${closeNotice}`);
      publish();
      return { ok: true, stopError: failure };
    }
    if (target) log(`[shell] stop ${key}: sent`);
    return { ok: true };
  }

  // --- `+`: a new worktree (Contract A, then E), and reopening a closed tab ---

  /**
   * *New branch…*: Contract A makes the worktree, a poll gives it a tab (and
   * selects it), Contract E sets it up with its progress on the tab, and only
   * then does its session start (criterion 10). A setup failure still starts
   * it, with the error on the tab. One creation at a time.
   */
  async function createWorktree(branch) {
    if (mode !== 'tabs') return { ok: false, error: 'not a project window' };
    if (create && create.phase === 'running') return { ok: false, error: 'already creating one' };
    const wanted = typeof branch === 'string' ? branch.trim() : '';
    const refused = checkBranch(wanted);
    if (refused) {
      create = { phase: 'failed', branch: wanted, error: refused };
      publish();
      return { ok: false, error: refused };
    }
    create = { phase: 'running', branch: wanted };
    pendingBranches.add(wanted);
    publish();

    let made;
    try { made = await ops.create({ container, branch: wanted }); } catch (err) { made = { ok: false, error: errorText(err) }; }
    if (!made || made.ok !== true) {
      pendingBranches.delete(wanted);
      const error = (made && made.error) || 'new-worktree.ps1 failed';
      if (!destroyed) { create = { phase: 'failed', branch: wanted, error }; publish(); }
      return { ok: false, error };
    }

    const key = keyOf(made.path);
    const withSetup = scriptsAvailable().setup;
    // Held from here, so the poll that lists it can't start its session early.
    if (withSetup) setups.set(key, { running: true, line: null, error: null, log: null });
    if (typeof made.warning === 'string' && made.warning) createdWarnings.set(key, made.warning);
    pendingBranches.delete(wanted);
    create = null;
    selectWhenListed = key;
    log(`[shell] created ${made.branch} at ${made.path}`);
    await poll();

    if (withSetup) {
      let s;
      try {
        s = await ops.setup({
          path: made.path,
          onLine: (line) => {
            const cur = setups.get(key);
            if (!cur || cur.running !== true) return;
            cur.line = line;
            publish();
          },
        });
      } catch (err) {
        s = { ok: false, error: errorText(err), log: null };
      }
      // A tab closed by hand meanwhile keeps no error for a later reopen. One
      // git simply hasn't listed yet keeps it (PR #80 Dexter F3): "no tab" is
      // not "closed".
      if ((s && s.ok === true) || state.dismissed.includes(key)) setups.delete(key);
      else setups.set(key, { running: false, line: null, error: (s && s.error) || 'setup failed', log: (s && s.log) || null });
      log(`[shell] setup ${key}: ${s && s.ok === true ? 'done' : `failed: ${s && s.error}`}`);
      if (destroyed) return { ok: true, path: made.path };
      publish();
    }
    const tab = tabByKey(key);
    if (tab && key === selectedKey && !tab.started && !tab.starting) start(tab);
    return { ok: true, path: made.path };
  }

  /**
   * The strip's branch form opens (`+` -> *New branch…*, Ctrl+T). The menu's
   * greyed-out rule (plusMenu().create) is this one: a key can't open what the
   * menu shows disabled.
   */
  function openCreate() {
    if (!plusMenu().create.enabled) return false;
    create = { phase: 'input' };
    publish();
    return true;
  }

  /** Esc / ✕ on the form. A creation that is running can't be called off. */
  function cancelCreate() {
    if (!create || create.phase === 'running') return false;
    create = null;
    publish();
    return true;
  }

  /** Tabs closed by hand that git still lists, most recent first. */
  function reopenable() {
    return closedByHand
      .filter(c => state.dismissed.includes(c.key))
      .slice(0, REOPEN_MAX)
      .map(c => ({ key: c.key, label: typeof c.branch === 'string' && c.branch ? c.branch : path.basename(c.path) }));
  }

  /** *Reopen* / Ctrl+Shift+T: no key reopens the most recent one. */
  async function reopen(key) {
    const list = reopenable();
    const target = key === undefined ? list[0] : list.find(c => c.key === key);
    if (!target) return { ok: false, error: 'nothing to reopen' };
    const entry = closedByHand.find(c => c.key === target.key);
    state = lifecycle.reopen(state, entry.path).state;
    closedByHand = closedByHand.filter(c => c.key !== target.key);
    selectWhenListed = target.key;
    await poll();
    return { ok: true };
  }

  /** What the `+` menu offers. */
  function plusMenu() {
    const busy = !!(create && create.phase === 'running');
    const scripts = scriptsAvailable();
    let why = null;
    if (mode !== 'tabs') why = 'not a project window';
    else if (busy) why = 'creating…';
    else if (!scripts.create) why = 'worktree scripts not installed';
    return { create: { enabled: why === null, why }, reopen: mode === 'tabs' ? reopenable() : [] };
  }

  /**
   * The window came back to the front: the selected tab is looked at now, so
   * whatever it was holding for you (a finished turn, an urgent need) is seen. A
   * look is selected AND focused, whichever arrives last (PR #90 Dexter F1).
   */
  function looked() {
    const tab = tabByKey(selectedKey);
    if (!tab || !tab.status || !(tab.status.needsInput || tab.status.finished)) return false;
    tab.status = tabStatusLib.afterSelected(tab.status);
    if (tab.view) views.send(tab, 'tab-selected');
    publish();
    return true;
  }

  /** A renderer's own status. Kept as-is except: you're looking at it. */
  function report(sender, status) {
    const tab = tabForSender(sender);
    if (!tab) return false;
    let next = sanitizeStatus(status);
    if ((next.needsInput || next.finished) && tab.key === selectedKey && ui.isFocused()) {
      next = tabStatusLib.afterSelected(next);
      views.send(tab, 'tab-selected');     // the page clears its own pending flag
    }
    if (tabStatusLib.sameStatus(tab.status, next)) return true;
    tab.status = next;
    publish();
    return true;
  }

  /** The receiving side of a host `raise`: that window comes forward. */
  function raise(sender) {
    const tab = tabForSender(sender);
    if (!tab) return false;
    select(tab.key);
    ui.focusWindow();
    return true;
  }

  /** The tab whose view sent an attention message: a click selects it. */
  function attentionClick(sender) {
    const tab = tabForSender(sender);
    if (!tab) return false;
    select(tab.key);
    ui.focusWindow();
    return true;
  }

  /**
   * *Jump to its tab*, for the Git panel (documentation/PLAN_GIT_TREE.md): select the tab whose
   * worktree is `folder`, however its path is spelled. Always answers something to say.
   */
  async function selectFolder(sender, folder) {
    if (!isTabView(sender)) return { kind: 'explain', text: "That tab's window can't be found." };
    if (typeof folder !== 'string' || !folder) return { kind: 'explain', text: 'That branch has no worktree folder.' };
    const key = keyOf(folder);
    if (!model().some(e => e.key === key)) {
      return { kind: 'explain', text: `${path.basename(folder)} has no tab open in this window.` };
    }
    await userSelect(key);
    return { kind: 'select-tab' };
  }

  /**
   * What the Git drawer needs to know about the tabs of the worktrees it lists (Enhancement #46):
   * [{ folder, open, started, known, working, needsInput }] in the order asked, `folder` as it was
   * spelled. `known` is whether that tab's session has REPORTED yet: until it has, working and
   * needsInput are null (unknown), never false -- an idle session and one nobody has heard from are not
   * the same. Blank or non-string folders are dropped, and the answer is bounded.
   */
  function tabStates(sender, folders) {
    if (!isTabView(sender) || !Array.isArray(folders)) return [];
    const out = [];
    for (const folder of folders) {
      if (out.length >= TAB_STATES_MAX) break;
      if (typeof folder !== 'string' || !folder) continue;
      const key = keyOf(folder);
      const e = model().find(x => x.key === key);
      const t = tabByKey(key);
      const st = t && t.status ? t.status : null;
      out.push({
        folder, open: !!e, started: !!e && e.started === true, known: !!e && e.started === true && !!st,
        working: e && st ? st.working === true : null, needsInput: e && st ? st.needsInput === true : null,
        // the host's measure of the main session (host/turn-state.js), and the session lock
        turn: e && st ? st.turn : null, lock: e && st ? st.lock : null,
      });
    }
    return out;
  }

  /**
   * The target page's answer to a `type-command` (main.js `tab:typed`). Only the page that was asked,
   * for a request still waiting, counts.
   */
  function typed(sender, reply) {
    const tab = tabForSender(sender);
    if (!tab || !reply || typeof reply !== 'object') return false;
    const w = typing.get(reply.id);
    if (!w || w.key !== tab.key) return false;
    typing.delete(reply.id);
    w.resolve({
      ok: reply.ok === true,
      reason: typeof reply.reason === 'string' && reply.reason ? reply.reason : null,
      box: typeof reply.box === 'string' ? reply.box : '',
    });
    return true;
  }

  /** Asks `tab`'s own page to type `command` into its box; its answer, or null if none came in time. */
  function askToType(tab, command) {
    const id = ++typingSeq;
    const reply = new Promise(resolve => typing.set(id, { key: tab.key, resolve }));
    views.send(tab, 'type-command', { id, command });
    return Promise.race([reply, sleep(TYPE_ANSWER_MS).then(() => null)]).then((r) => { typing.delete(id); return r; });
  }

  /**
   * *Type /merged*, for the Git drawer (Enhancement #46): select the branch's tab and have ITS OWN PAGE
   * type `/merged` into its box. NEVER Enter: the person presses it (Ricardo, PR #93 Dexter R2-1). No
   * hook can say a turn is really over -- another Stop hook can block the first Stop, and the turn goes on
   * with tools nothing here sees -- so an automatic Enter could queue /merged into a working session.
   * The drawer only enables it for an open PR whose tab is at rest; this re-checks the tab
   * (it may have started a turn since the drawer drew) with the drawer's own rule, and explains instead
   * of typing into a busy session. The page types the top bar's way (PR #93 Dexter F3 / Miguel I2): it
   * judges its own screen (nothing into a dialog or a multi-line draft), clears a single-line draft
   * first, enters vim INSERT if needed, and answers ok only once the box reads back exactly `/merged`.
   * Always answers { kind: 'typed', branch, cleared } or { kind: 'explain', text }.
   */
  async function typeMerged(sender, folder, wanted) {
    if (!isTabView(sender)) return { kind: 'explain', text: "That tab's window can't be found." };
    if (typeof folder !== 'string' || !folder) return { kind: 'explain', text: 'That branch has no worktree folder.' };
    if (typeof wanted !== 'string' || !wanted) return { kind: 'explain', text: 'Type /merged needs to know which branch it is for.' };
    // PR #93 Miguel I3: never on an integration branch, whatever the renderer asked
    if (INTEGRATION.includes(wanted)) return { kind: 'explain', text: `/merged merges a lane: never on ${wanted}.` };
    const key = keyOf(folder);
    const entry = model().find(e => e.key === key);
    const tab = tabByKey(key);
    const name = path.basename(folder);
    if (!entry || !tab) return { kind: 'explain', text: `${name} has no tab open in this window.` };
    if (!tab.started || !Number.isInteger(tab.port) || !tab.token) return { kind: 'explain', text: `${name}'s tab hasn't started a session yet.` };
    if (!tab.status) return { kind: 'explain', text: `${name}'s session hasn't reported what it's doing yet.` };
    // PR #93 Dexter F6: the drawer names a BRANCH; the worktree may have switched since it drew
    const on = branchOf(key);
    if (on !== wanted) return { kind: 'explain', text: `${name} is on ${on || 'no branch'} now, not ${wanted}: refresh the Git panel.` };
    const why = busyWhy(tab.status);
    if (why) return { kind: 'explain', text: `${name}'s session ${why}.` };
    // One at a time per tab (PR #93 Dexter F4 / Miguel I1): a double click or a held Enter passes every
    // check above twice before the session's turn opens, and the keys would interleave into /merged/merged.
    if (typingMerged.has(key)) return { kind: 'explain', text: `Already sending /merged to ${name}'s session.` };
    typingMerged.add(key);
    try {
      // PR #93 Miguel I3: main confirms the open PR itself (gh, in that worktree), never on the renderer's word
      let open = null;
      try { open = prs && typeof prs.openFor === 'function' ? await prs.openFor(folder, wanted) : null; } catch { open = null; }
      if (open === false) return { kind: 'explain', text: `${wanted} has no open PR: /merged has nothing to merge.` };
      if (open !== true) return { kind: 'explain', text: `Couldn't confirm with gh that ${wanted} has an open PR, so nothing was typed.` };
      // gh took a moment: the session may have started a turn meanwhile
      const still = tab.status ? busyWhy(tab.status) : "hasn't reported what it's doing";
      if (still) return { kind: 'explain', text: `${name}'s session ${still}.` };
      const branch = wanted;
      await userSelect(key);
      const r = await askToType(tab, '/merged');
      if (!r) return { kind: 'explain', text: `Couldn't confirm /merged reached ${name}'s session: its page didn't answer.` };
      if (!r.ok) return { kind: 'explain', text: `Didn't send /merged to ${name}'s session: ${r.reason || 'its page refused'}.` };
      return { kind: 'typed', branch, cleared: r.box !== '' };
    } finally {
      typingMerged.delete(key);
    }
  }

  /** *Go to that session*, for the blocked pane. Always answers something to say. */
  async function goTo(sender, holder) {
    if (!isTabView(sender)) return { kind: 'explain', text: "That session's window can't be found." };
    const byPort = new Map();
    for (const t of tabs.values()) if (Number.isInteger(t.port)) byPort.set(t.port, t.key);
    const plan = planGoTo(holder, {
      tabsByPort: byPort,
      readIdentity: hosts.identity,
      readToken: hosts.readToken,
    });
    if (plan.kind === 'select-tab') {
      select(plan.key);
      return { kind: 'select-tab' };
    }
    if (plan.kind !== 'raise') return plan;
    const r = await hosts.control({ port: plan.port, token: plan.token, msg: { type: 'raise' } });
    if (!r || !r.ok) {
      return { kind: 'explain', text: `Couldn't reach that session: ${(r && r.error) || 'no answer'}.` };
    }
    const windows = r.reply && r.reply.windows;
    if (windows === 0) return { kind: 'explain', text: noWindowText(holder) };
    return { kind: 'raised' };
  }

  /** What the context menu / Session menu for a tab offers. */
  function menuState(key) {
    const e = model().find(x => x.key === key);
    if (!e) return { key, override: false, close: false };
    return { key, override: e.lockGlyph === 'blocked', close: e.closable === true && mode === 'tabs' };
  }

  function override(key) {
    const tab = tabByKey(key);
    if (!tab || !tab.view) return false;
    if (!menuState(key).override) return false;
    views.send(tab, 'lock-override');
    return true;
  }

  function step(n) {
    const m = model();
    const sel = m.find(e => e.selected);
    const next = tabModel.neighbour(m, sel ? sel.key : null, n);
    return next === null ? Promise.resolve() : userSelect(next);
  }

  // A selection the PERSON made (a click, Ctrl+Tab) wins over a tab the shell
  // was waiting to select once git lists it (PR #80 Miguel G1): that tab still
  // opens, it just doesn't take the selection later.
  function userSelect(key) {
    selectWhenListed = null;
    return select(key);
  }

  /** view query: which close button the blocked pane offers. */
  function tabmodeOf(tab) {
    if (mode === 'single') return 'single';
    return tab.isDev ? 'dev' : 'tab';
  }

  function destroy() { destroyed = true; }

  return {
    open, poll, select: userSelect, closeTab, report, raise, attentionClick, goTo, selectFolder, tabStates, typeMerged, typed, menuState, override,
    createWorktree, openCreate, cancelCreate, plusMenu, reopen, looked,
    next: () => step(1), previous: () => step(-1),
    isTabView, tabForSender, tabByKey, tabmodeOf, snapshot, model, destroy, branchOf, occupancyFor,
    // #40: something the model reads changed outside the shell (a tab's mark).
    refresh: publish,
    // Exposed for tests and the probe driver.
    _tabs: tabs, _state: () => state,
  };
}

// --- native menu text ----------------------------------------------------------------

/**
 * Text for an Electron menu label. A single `&` marks the next letter as the
 * item's mnemonic (and isn't drawn), so a branch like `feat/r&d` would lose
 * its `&`: doubled, it is drawn as one (PR #80 Miguel G3).
 */
function menuText(s) {
  return typeof s === 'string' ? s.replace(/&/g, '&&') : '';
}

// --- keyboard focus ----------------------------------------------------------------

/**
 * Should main give the keyboard to the selected tab's view now, and which view
 * holds it afterwards? `lastFocused` is the view that has the keyboard, or null
 * when nothing does.
 *
 * Dexter F4 / Miguel M1, PR #75: keyed on a CHANGED SELECTION, a view created
 * for a tab that was already selected (first launch, Ctrl+Tab onto an unstarted
 * tab) never got focus, and keystrokes went to the strip. So it is keyed on the
 * VIEW: focus the selected view when the window is focused and that view
 * doesn't have the keyboard.
 *
 * Dexter R2-4: selecting a tab with NO view (still starting, or failed) leaves
 * the keyboard on the strip, so `lastFocused` becomes null. Without that, A ->
 * B (no view) -> A still believed A had the keyboard and never focused it.
 * Main also clears it when the strip page itself takes focus (a click on it).
 */
function focusStep(lastFocused, { windowFocused, selectedView, stripBusy = false } = {}) {
  // PR 3: the branch form is in the strip page. While it is open, every
  // publish (3 s poll, status reports) would otherwise hand the keyboard back
  // to the view mid-typing. Null, so the view is focused again once it closes.
  if (stripBusy === true) return { focus: false, lastFocused: null };
  if (!selectedView) return { focus: false, lastFocused: null };
  if (windowFocused === true && selectedView !== lastFocused) return { focus: true, lastFocused: selectedView };
  return { focus: false, lastFocused: lastFocused === undefined ? null : lastFocused };
}

// --- keyboard shortcuts ------------------------------------------------------------

/**
 * There is no application menu bar, so the shortcuts live in main's
 * `before-input-event`. This is the DECISION: an Electron `input` -> which
 * shortcut it is, or null. Null means "leave it alone": every key not named
 * here must reach xterm untouched (Ctrl+C / Ctrl+V / Shift+Enter are the app's
 * own). Only a keyDown counts, so one press cannot fire on both edges.
 * Auto-repeat is main's call, not this function's: main still swallows a
 * repeating Ctrl+Tab (it must not type Tab into the terminal) but only acts once.
 */
function shortcutFor(input) {
  if (!input || typeof input !== 'object' || input.type !== 'keyDown' || typeof input.key !== 'string') return null;
  const key = input.key.toLowerCase();
  if (key === 'f12') return 'devtools';
  // #35: a new tab is a new worktree. Ctrl+Alt+T, not Ctrl+T: the CLI owns that
  // one (it toggles its task list), and every key not named here reaches it.
  if (key === 't' && input.control && input.alt && !input.shift) return 'new-branch';
  if (!input.control || input.alt) return null;
  if (key === 'tab') return input.shift ? 'prev-tab' : 'next-tab';
  if (key === 'i' && input.shift) return 'devtools';
  // PR 3: reopen the last tab closed by hand, as a browser does.
  if (key === 't' && input.shift) return 'reopen-tab';
  // Layout pass L1 (#1): only the terminal shows. Main's, so it works from any
  // tab view and the key never reaches the pty.
  if (key === 'f' && input.shift) return 'focus-mode';
  return null;
}

/**
 * Will the shortcut `action` do anything right now? Main swallows a key only
 * when it will: New branch… on a greyed-out `+` item (a single-folder window, no
 * worktree scripts, a creation running) leaves its key to the terminal, so a key
 * the app can't use isn't taken from the CLI for nothing (PR #90 Dexter F2).
 */
function shortcutWillAct(action, shell) {
  if (action === 'new-branch') return shell.plusMenu().create.enabled === true;
  return true;
}

// --- the probe driver's command handling ----------------------------------------

// The shortest token the driver will run with. The probe sends 32 hex chars.
const PROBE_TOKEN_MIN = 16;
// The selected view's probe actions (layout pass L1): named, so the driver can
// never hand the page a string of code to run.
const VIEW_PROBE_ACTIONS = new Set(['state', 'move', 'select', 'toggleAll', 'dropOwn', 'measure', 'openMenu', 'closeMenu', 'secretRedraw', 'reconnect', 'focusState',
  // dockable panels D1: verify/probe-dock-tree.js
  'boxes', 'layout', 'dock', 'hide', 'show', 'foldAll', 'drag', 'tabClick', 'gutter', 'gutterRace', 'abortedDrag', 'menuTick', 'menuButton', 'squeeze',
  // layout pass L3: verify/probe-git-tree.js
  'gitState', 'gitRefresh', 'gitHover', 'gitPin', 'gitJump', 'gitRerender', 'gitKey', 'gitFocus',
  // Enhancement #46: the drawer's actions, the swing, the tabs' states, and a session's screen
  'gitAct', 'gitMotion', 'gitTabs', 'gitScreen',
  // PR #93: type into the selected tab's own session (the probe's stand-in CLI box)
  'gitTermInput',
  // backlog #51: verify/probe-wand.js reads the wand and operates its controls
  'wandState', 'wandClick', 'wandSetField', 'wandDrag', 'wandFocus', 'wandKey',
  // backlog #34: verify/probe-video-background.js
  'bgState', 'bgStyle', 'bgMatch',
  // backlog #44 + #47: the occupancy banner, confirm and card line, and a probe keystroke / click / turn
  'occState', 'occKey', 'occClick', 'occTurn']);

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && require('crypto').timingSafeEqual(x, y);
}

/**
 * One line of newline-JSON from the probe -> a reply object. NEVER throws.
 * `api` is main's: { state, select(label), close(label), key(key, modifiers),
 * screenshot(file), create(branch), reopen(), cancelCreate(), quit() }.
 * Anything else is refused by name, so a typo in the probe is a
 * failure it can see rather than a command that silently did nothing.
 *
 * Miguel, PR #75 M4: every line must carry `token`, the secret the probe put in
 * CLAUDE_CUSTOM_TABS_PROBE_TOKEN. Loopback isn't a boundary -- any web page can
 * POST a body to 127.0.0.1 -- and `screenshot` writes a file. A driver started
 * without a real token refuses everything rather than trusting anyone.
 */
async function handleProbeCommand(line, api, expectedToken) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return { ok: false, error: 'not JSON' }; }
  if (typeof expectedToken !== 'string' || expectedToken.length < PROBE_TOKEN_MIN) {
    return { ok: false, error: 'probe driver has no token' };
  }
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'no cmd' };
  if (typeof cmd.token !== 'string' || !sameSecret(cmd.token, expectedToken)) return { ok: false, error: 'bad token' };
  if (typeof cmd.cmd !== 'string') return { ok: false, error: 'no cmd' };
  try {
    switch (cmd.cmd) {
      case 'state': return { ok: true, ...(await api.state()) };
      case 'select': return await api.select(String(cmd.label));
      case 'close': return await api.close(String(cmd.label));
      case 'key': {
        // A synthetic key sent to the SELECTED view: proves before-input-event is wired.
        if (typeof cmd.key !== 'string' || !cmd.key) return { ok: false, error: 'key needs a key' };
        if (cmd.modifiers !== undefined && !Array.isArray(cmd.modifiers)) return { ok: false, error: 'key modifiers must be a list' };
        return await api.key(cmd.key, (cmd.modifiers || []).map(String));
      }
      case 'screenshot':
        // Only ever a picture: never a path to some other file it could clobber.
        if (typeof cmd.file !== 'string' || !/\.png$/i.test(cmd.file)) return { ok: false, error: 'screenshot needs a .png file' };
        return await api.screenshot(cmd.file);
      case 'create':
        if (typeof cmd.branch !== 'string') return { ok: false, error: 'create needs a branch' };
        return await api.create(cmd.branch);
      case 'reopen': return await api.reopen();
      // #40: what the Mark ▸ menu's click does, without a mouse.
      case 'mark':
        if (typeof cmd.branch !== 'string' || cmd.branch === '') return { ok: false, error: 'mark needs a branch' };
        if (cmd.id !== null && typeof cmd.id !== 'string') return { ok: false, error: 'mark needs an id (or null)' };
        return await api.mark(cmd.branch, cmd.id);
      case 'markMenu':
        if (typeof cmd.branch !== 'string' || cmd.branch === '') return { ok: false, error: 'markMenu needs a branch' };
        return await api.markMenu(cmd.branch);
      case 'cancelCreate': return await api.cancelCreate();
      // #31: what the window's own `focus` event does, without an OS to hand over focus.
      case 'windowFocus': return await api.windowFocus();
      case 'view':
        // Layout pass L1: one of the selected view's NAMED probe actions
        // (renderer.js window.__dockProbe), never a string of code.
        if (typeof cmd.action !== 'string' || !VIEW_PROBE_ACTIONS.has(cmd.action)) {
          return { ok: false, error: 'view needs a known action' };
        }
        return await api.view(cmd.action, cmd.args && typeof cmd.args === 'object' ? cmd.args : {});
      // #34: the window minimised or restored as the OS would, and the OS's reduced-motion setting
      // emulated -- the two inputs of the background video's play rule a probe can't reach by hand.
      case 'window-state':
        if (cmd.state !== 'minimize' && cmd.state !== 'restore') return { ok: false, error: 'window-state needs minimize or restore' };
        return await api.windowState(cmd.state);
      case 'reduced-motion':
        if (typeof cmd.on !== 'boolean') return { ok: false, error: 'reduced-motion needs true or false' };
        return await api.reducedMotion(cmd.on);
      case 'quit': return await api.quit();
      // The strip's ▾ menu, without a native popup nobody can click.
      case 'background': return await api.background();
      case 'background-stop':
        if (!(Number.isInteger(cmd.port) && cmd.port > 0 && cmd.port < 65536)) return { ok: false, error: 'background-stop needs a port' };
        return await api.backgroundStop(cmd.port);
      case 'background-open':
        if (!(Number.isInteger(cmd.port) && cmd.port > 0 && cmd.port < 65536)) return { ok: false, error: 'background-open needs a port' };
        return await api.backgroundOpen(cmd.port);
      case 'background-stop-all': return await api.backgroundStopAll();
      default: return { ok: false, error: `unknown command: ${cmd.cmd}` };
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * The driver's socket reader: chunks in, complete non-blank lines out. A peer
 * that sends more than `maxBytes` without a newline gets `overflow` and is cut
 * off, so the buffer can't grow without bound (Miguel, PR #75 M4).
 */
function probeLineReader(maxBytes) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const lines = [];
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push(line);
      }
      if (buf.length > maxBytes) { buf = ''; return { lines: [], overflow: true }; }
      return { lines, overflow: false };
    },
  };
}

module.exports = {
  createShell, createQueue, captureListening, observeWorktrees, sanitizeStatus,
  handleProbeCommand, VIEW_PROBE_ACTIONS, probeLineReader, noWindowText, shortcutFor, shortcutWillAct, focusStep, menuText, NO_PORT_ERROR,
};
