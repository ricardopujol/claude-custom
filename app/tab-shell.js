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
const tabLanes = require('./tab-lanes');
const programStatusDisplay = require('./program-status-display');
const tabStatusLib = require('./tab-status');
const occupancyDisplay = require('./occupancy-display');
const { closeReason } = require('../host/close-safety');
const summaryDisplay = require('./summary-display');
const { planGoTo } = require('./go-to-session');
const { sideKeyOf, parentKeyOf, isSideKey, sideLabel } = require('../host/side-session');
// #119 A5: a branch tab's plain shell, a tab of the same kind of its own (host/shell-tab.js).
const { shellKeyOf, parentKeyOfShell, isShellKey, shellLabel } = require('../host/shell-tab');
const { joinNames } = require('./reader-unsaved');
const { SHUTDOWN_BOUND_MS } = require('../host/bounded-shutdown');

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

// #81: what a side tab says once its claude has ended.
const ENDING_TEXT = 'Ending its session…';     // #129: a tab whose host is being ended
const SIDE_ENDED_TEXT = "This side session has ended. Reopen it from this tab's menu.";
// #119 A5: ... and a shell tab once its shell has exited.
const SHELL_ENDED_TEXT = "This shell has exited. Restart it from this tab's menu.";

// The branch tab a side or shell tab belongs to, or null for any other key.
// What a companion tab is called in a sentence; null for any other key, so a third kind has to be named here.
const companionNounOf = (k) => (isSideKey(k) ? 'side session' : isShellKey(k) ? 'shell' : null);
const companionParentOf = (k) => (isSideKey(k) ? parentKeyOf(k) : isShellKey(k) ? parentKeyOfShell(k) : null);
const isCompanionEntry = (e) => !!e && (e.side === true || e.shell === true);

const noWindowText = (h) => `That session is in another claude-custom (pid ${h.pid}, port ${h.port}) ` +
  'with no window open. Open its project to see it.';

const cleanLock = (s) => (typeof s === 'string' && s ? s : null);

/** What a renderer may say about itself, cut down to the eight known fields. */
// The drawer's rule for "is this session at rest?" -- one copy, so the re-check here agrees with it.
const { sessionBusyWhy } = require('./git-actions');
const busyWhy = (status) => sessionBusyWhy(status);

function sanitizeStatus(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    working: o.working === true,
    needsInput: o.needsInput === true,
    finished: o.finished === true,
    messages: tabStatusLib.cleanCount(o.messages),
    lock: cleanLock(o.lock),
    health: typeof o.health === 'string' && o.health !== '' ? o.health : null,
    turn: tabStatusLib.TURNS.includes(o.turn) ? o.turn : null,
    night: o.night === true,
    summary: tabStatusLib.cleanSummary(o.summary),
    summaryNote: typeof o.summaryNote === 'string' && o.summaryNote !== '' && o.summaryNote.length <= 300 ? o.summaryNote : null,
    // OSC 7501 (BACKLOG #116): the CLI's own state, cut down to the four known fields; null for anything else.
    program: programStatusDisplay.clean(o.program),
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
 *   hosts.spawn({ tab, port, token })      starts a detached host (may throw); may return its child process, whose exit proves the host dead
 *   hosts.wait(port)       -> Promise<boolean>  the host came up
 *   hosts.tokenFor(port)   -> string | null     a RUNNING host's token
 *   hosts.tokenFile(port)  -> string | null     ONLY `hosts/<port>.token`: written by
 *                                               the host that won the bind, and nobody else
 *   hosts.newToken()       -> string
 *   hosts.control({ port, token, msg })    -> Promise<{ ok, reply? , error? }>
 *   hosts.identity({ install, port }), hosts.readToken(install, port)  (planGoTo's)
 *   hosts.laneHosts()  -> [{ port, cwd }] | null   the branch hosts the identity files list (optional; PR #227: a lane whose first look
 *                                               missed its host is looked for again only where one serves its folder)
 *   hosts.sideHosts() / hosts.shellHosts()  -> [{ port, cwd }] | null   the side / shell hosts the identity files list (optional;
 *                                               without one each tab is looked for the slow way, by a port walk)
 *   views.create(tab)      -> view          shows the tab's renderer
 *   views.destroy(tab)
 *   views.send(tab, channel, payload)
 *   views.owns(tab, sender)-> boolean       the view's webContents is `sender`
 *   occupancy.claims()     -> [claim]    the LIVE worktree-occupancy claims (host/occupancy-service.js); optional
 *   now()                  -> ms         the clock the "4 min" labels read; optional
 *   safety.facts(cwd)      -> Promise<{ dirtyCount, unpushedCount }>  the folder's git facts for a Ctrl+click close (#77); optional
 *   safety.readerUnsaved(tab) -> string|null  the file with unsaved edits in the tab's code reader (#50); optional
 *   ui.confirmClose(tab, { reason }?) -> Promise<boolean>   `reason` only when a Ctrl+click close wasn't safe
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

/** The strip's kept layout, strictly typed, or an empty one: a missing, throwing or odd layout is "nothing kept". */
function readLayout(layout, log) {
  const empty = { order: [], closed: [], pinned: [] };
  if (!layout || typeof layout.load !== 'function') return empty;
  try {
    const l = layout.load();
    if (!l || typeof l !== 'object') return empty;
    if (typeof l.error === 'string' && l.error !== '') log('[shell] layout:', l.error);   // saves will be refused: say why once (PR #227 Miguel S4)
    const closed = (Array.isArray(l.closed) ? l.closed : [])
      .filter(c => c && typeof c.key === 'string' && c.key !== '' && typeof c.path === 'string' && c.path !== '')
      .map(c => ({ key: c.key, path: c.path, branch: typeof c.branch === 'string' && c.branch !== '' ? c.branch : null }));
    const keys = (list) => (Array.isArray(list) ? list : []).filter((k, i, all) => typeof k === 'string' && k !== '' && all.indexOf(k) === i);
    return { order: (Array.isArray(l.order) ? l.order : []).filter(k => typeof k === 'string' && k !== ''), closed, pinned: keys(l.pinned) };
  } catch (err) {
    log('[shell] layout.load threw:', err && err.message);
    return empty;
  }
}

function createShell(deps) {
  // Usage counters are fire and forget: a throwing counter never aborts a tab's setup or removal.
  const countUse = (key) => { try { if (typeof deps.usage === 'function') deps.usage(key); } catch { /* counting never breaks a tab */ } };
  const {
    mode = 'tabs', container = null, cwd = null, launchedFrom = null,
    git, hosts, ops, views, ui, log = () => {},
    // #40: `markFor(branch)` -> { id, emoji, meaning } | null. Optional.
    marks = null,
    // #63: `warnFor(key)` -> { pct, level } | null, the tab's "over 40% CPU for 30 s" chip. Optional.
    resources = null,
    // Worktree occupancy (#44 + #47): `claims()` -> the live claims. Optional; a reader that fails draws none.
    occupancy = null,
    now = Date.now,
    // Usage counters (audit move 2): `deps.usage(key)`, fire and forget, optional (see countUse below).
    // How long Type /merged waits for the target page's answer; injected so a test doesn't wait.
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    // Type /merged's own re-check (PR #93 Miguel I3): `openFor(folder, branch)` -> true / false / null
    // (gh can't say). Absent: never confirmed, so never typed.
    prs = null,
    // #77: `facts(cwd)` -> { dirtyCount, unpushedCount } (null for a fact git couldn't give). Optional: without it
    // a Ctrl+click close always asks.
    safety = null,
    // BACKLOG #119 A6, a lane started from a GitHub issue. Optional:
    //   brief({ number, branch, worktree }) -> Promise<{ ok, issue, brief, existed } | { ok: false, error, issue }>
    //   forBranch(branch) -> { number, title, url } | null    the issue a branch the + form made came from (the cached list)
    issues = null,
    // BACKLOG #141: what the strip keeps between runs (host/strip-layout.js): `load()` -> { order, closed } and
    // `save({ order, closed })`. Optional; either may throw, and neither ever takes the strip down.
    layout = null,
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
  // What the strip kept from the last run (a layout that fails to read is an empty one): the drag order of the lanes, and the
  // lanes closed by hand, which stay closed (the reducer's `dismissed` is seeded from them).
  const kept = readLayout(layout, log);
  let state = { ...lifecycle.initial(), dismissed: kept.closed.map(c => c.key) };
  let order = kept.order;        // lane keys in the person's drag order (app/tab-lanes.js); develop is not in it
  let pinned = kept.pinned;      // lane keys the person pinned (BACKLOG #167): always on the strip, started at launch; develop is never in it
  let selectedKey = null;
  let polling = false;
  let lastError = null;
  let closeNotice = null;        // a hand close whose stop failed; cleared by the next selection
  // #129: the tabs a hand close kept because their host wouldn't end: key -> { text, tab }. The strip offers Stop on the newest. An entry
  // is the offer for THAT tab record only (PR #231 Dexter 3 / Miguel Y1): a tab that left or ended, or a new tab under the same key,
  // is not it, so a later x is a plain close and asks.
  const closeStuck = new Map();
  // #129 (PR #231 Dexter 4 / Miguel G3): the tabs whose host is being ended right now (the stop, the wait for it, the retry by pid: up to
  // a minute). Such a tab is in a closing state: not selectable, nothing is started or attached for it, the strip greys it and says so.
  const ending = new Set();
  const exitedHosts = new WeakSet();     // the `pending` records whose spawned child has exited: those hosts are dead (PR #231 Dexter M2)
  const stuckValid = (key, e) => !!e && tabs.get(key) === e.tab && e.tab.ended !== true && e.tab.closed !== true
    && (state.tabs.find(t => keyOf(t.path) === key) || {}).phase !== 'removing';
  const stuckFor = (key) => {
    const e = closeStuck.get(key);
    if (e && !stuckValid(key, e)) { closeStuck.delete(key); return null; }
    return e || null;
  };
  /** The offer the strip draws: the newest kept tab that is still that tab. */
  function stuckNow() {
    let out = null;
    for (const [key, e] of [...closeStuck]) {
      if (!stuckValid(key, e)) { closeStuck.delete(key); continue; }
      out = { key, text: e.text };
    }
    return out;
  }
  let destroyed = false;
  // PR 3. `create` is the strip's branch form: null, or { phase: 'input' } /
  // { phase: 'running', branch } / { phase: 'failed', branch, error }.
  let create = null;
  const pendingBranches = new Set();   // branches Contract A is creating right now
  const briefHolds = new Set();        // keys whose lane brief (#119 A6) is still being written: no session starts before it
  const setups = new Map();            // key -> { running, line, error, log }  (Contract E)
  const createdWarnings = new Map();   // key -> Contract A's optional warning
  const issueTabs = new Map();         // key -> { number, title, url }: the issue a tab's lane was started from (#119 A6)
  let selectWhenListed = null;        // a tab to select as soon as a poll lists it
  // Type /merged: the type-command requests waiting for their page's answer, by id
  const typing = new Map();
  let typingSeq = 0;
  const typingMerged = new Set();     // the tabs a Type /merged is typing into right now
  let closedByHand = kept.closed;      // [{ key, path, branch }], most recent first
  // BACKLOG #139, a merged tab closes by itself: its idle session is stopped (closeMergedPass), and the existing removal closes
  // the tab, which leaves the strip's notice (runRemove). Every tab that goes that way was drawn (it had a session); a lane that
  // never had a tab in this window (merged at open, no session) is left without one, with a log line (PR #236 Dexter 5).
  // `spared`: lanes the person brought back after the merge (any reopen of a closed row, or a merged lane started from its row),
  // never stopped by this path again in this window. `mergedTried`: tab records this path already stopped, or failed to stop
  // (kept with the Stop offer): never tried again (the bound on retries: one per record). `mergedBusy`: a merged close in flight.
  const spared = new Set();
  const reopening = new Set();         // lanes the person reopened that no poll has listed since: their first listing decides `spared`
  const mergedTried = new WeakSet();
  const mergedBusy = new Set();
  const mergedWhy = new Map();         // key -> the last reason a merged tab was kept, so the log says it once, not every poll
  let mergedNotice = null;             // "Closed <lane> (merged)": the strip's notice line; cleared by the next selection
  let lastMergedPass = Promise.resolve();

  const keyOf = normPath;
  // The develop worktree's key (host/worktree-list.js: `<container>\dev` is the anchor), known before git answers, so a develop
  // closed in an earlier run is the menus' first row from the first paint (BACKLOG #160).
  const devKey = mode === 'tabs' && typeof container === 'string' && container !== '' ? keyOf(path.join(container, 'dev')) : null;
  /** Develop is closed: git lists it (the reducer keeps it dismissed) and it has no tab. */
  const devClosed = () => devKey !== null && state.dismissed.includes(devKey) && !tabs.has(devKey);

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
    || (setups.has(tab.key) && setups.get(tab.key).running === true)
    || briefHolds.has(tab.key);

  // A mark is decoration: a reader that fails draws none and never takes the strip down.
  function readMark(branch) {
    if (!marks || typeof marks.markFor !== 'function' || typeof branch !== 'string') return null;
    try { return marks.markFor(branch) || null; } catch (err) {
      log('[shell] marks.markFor threw:', err && err.message);
      return null;
    }
  }

  // The CPU warning chip is decoration too: a reader that fails or answers oddly draws none.
  function readResourceWarn(key) {
    if (!resources || typeof resources.warnFor !== 'function') return null;
    try {
      const w = resources.warnFor(key);
      return w && Number.isFinite(w.pct) && (w.level === 'amber' || w.level === 'red') ? { pct: w.pct, level: w.level } : null;
    } catch (err) {
      log('[shell] resources.warnFor threw:', err && err.message);
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

  // The issue a tab's lane came from: the one this window started it from, else the one its branch name says when
  // the cached issue list has it. Decoration: a reader that fails or answers oddly draws none.
  function issueShape(i) {
    if (!i || typeof i !== 'object' || Array.isArray(i)) return null;
    if (!Number.isInteger(i.number) || i.number < 1) return null;
    return {
      number: i.number,
      title: typeof i.title === 'string' && i.title !== '' ? i.title : null,
      url: typeof i.url === 'string' && i.url !== '' ? i.url : null,
    };
  }

  function issueOf(key) {
    if (typeof key !== 'string') return null;
    const branch = branchOf(key);
    if (branch === null) return null;
    // The lane this window made: valid only while the tab is still on the branch it was made on (a git switch drops it).
    const mine = issueTabs.get(key);
    if (mine && mine.branch === branch) return issueShape(mine);
    if (!issues || typeof issues.forBranch !== 'function') return null;
    const tab = tabs.get(key);
    try { return issueShape(issues.forBranch(branch, tab ? tab.cwd : null)); } catch (err) {
      log('[shell] issues.forBranch threw:', err && err.message);
      return null;
    }
  }

  /**
   * The strip's entries with each branch tab's side session (BACKLOG #81) right after it. A side tab is not a worktree, so
   * the reducer's state never lists it; it is joined here, from the shell's own records.
   */
  function entriesWithSides() {
    // The side or shell tab showing, if one is (#119 A5: after its branch tab come its side tab, then its shell tab).
    const sideSelected = companionParentOf(selectedKey) !== null && tabs.has(selectedKey) ? selectedKey : null;
    // pickAny: false -- with develop closed and nothing chosen, nothing is selected (#160), never a lane nobody picked.
    // lastClosable: in a project window every tab closes, the last one too (the Lanes and + menus bring it back); the model owns
    // the rule (PR #236 Dexter 8, Miguel Y5). A single-folder window's one tab never closes.
    const base = tabModel.stripModel(state, runtime(), sideSelected ? companionParentOf(sideSelected) : selectedKey,
      { keyOf, order, pickAny: false, lastClosable: mode === 'tabs' });
    const out = [];
    for (const e of base) {
      const mine = tabs.get(e.key);
      // While its side tab is the one showing, the branch tab is not selected, so it can call for a look again.
      out.push(sideSelected !== null && e.selected
        ? { ...e, selected: false, pulse: tabModel.pulseFor(mine && mine.status ? mine.status : null) } : e);
      const sk = sideKeyOf(e.key);
      const rec = sk ? tabs.get(sk) : null;
      if (rec) out.push(sideEntry(e, rec, sideSelected === sk));
      const hk = shellKeyOf(e.key);
      const shellRec = hk ? tabs.get(hk) : null;
      if (shellRec) out.push(shellEntry(e, shellRec, sideSelected === hk));
    }
    return out;
  }

  /** A branch tab's shell (#119 A5): a small tab like the side tab, but not a reader. */
  function shellEntry(parent, rec, selected) {
    const st = rec.status;
    return {
      key: rec.key, label: shellLabel(parent.label), isDev: false, selected, started: rec.started === true,
      // A close of its own (Ricardo's look, 2026-10-26): it is a terminal, not a reader of its lane. Ending only with its branch
      // tab left develop's shell no way to end at all (develop had no close then; since #160 it has, and its shell goes with it).
      closable: true,
      working: !!st && st.working === true, needsInput: !!st && st.needsInput === true, night: false,
      summary: null, summaryNote: null, pulse: selected ? null : tabModel.pulseFor(st),
      lockGlyph: null, health: null, phase: null, error: null, note: null, setup: null, createdWarning: null,
      // OSC 7501 is a shell tab's only feed: the dots and the tooltip read the program's own state (app/tab-strip.js stripDots).
      program: st && st.program && typeof st.program === 'object' && !Array.isArray(st.program) ? st.program : null,
      shell: true, parentKey: parent.key,
    };
  }

  function sideEntry(parent, rec, selected) {
    const st = rec.status;
    return {
      key: rec.key, label: sideLabel(parent.label), isDev: false, selected, started: rec.started === true,
      // A close of its own (Ricardo's look, 2026-10-26: a side tab couldn't be closed). Closing it ends only this host; the branch
      // tab's session keeps running, and Open side session starts a fresh one.
      closable: true,
      working: !!st && st.working === true, needsInput: !!st && st.needsInput === true, night: false,
      summary: null, summaryNote: null, pulse: selected ? null : tabModel.pulseFor(st),
      lockGlyph: null, health: null, phase: null, error: null, note: null, setup: null, createdWarning: null,
      side: true, parentKey: parent.key, role: 'reader',
    };
  }

  function model() {
    const claims = readClaims();
    const at = now();
    return entriesWithSides().map((e) => {
      const t = tabs.get(e.key);
      // The strip paints these; it decides nothing (PR 3: badge and phase line).
      return {
        ...e, starting: !!(t && t.starting), startError: t ? t.error : null,
        // #167: a pinned lane (never develop, never a side or shell tab) is on the strip and starts at launch.
        pinned: !isCompanionEntry(e) && !e.isDev && pinned.includes(e.key),
        // Its session's host stopped answering after it ran (the strip keeps such a lane only while it is selected).
        ended: !!t && t.ended === true,
        // #129: its host is being ended (the strip greys it and says so; it can't be selected meanwhile).
        ending: ending.has(e.key),
        badge: tabModel.badgeFor(e),
        phaseText: ending.has(e.key) ? ENDING_TEXT
          : t && t.ended === true && e.side === true ? SIDE_ENDED_TEXT
          : t && t.ended === true && e.shell === true ? SHELL_ENDED_TEXT : tabModel.phaseText(e),
        mark: readMark(branchOf(e.key)),
        // #119 A6: the GitHub issue this lane was started from ({ number, title, url } or null).
        issue: isCompanionEntry(e) ? null : issueOf(e.key),
        // #119 A6: this tab's lane brief is being written, and its session waits for it.
        briefing: !isCompanionEntry(e) && briefHolds.has(e.key),
        // #63: the CPU warning chip ({ pct, level } or null).
        resourceWarn: readResourceWarn(e.key),
        // #44 + #47: the hatched edge. The warning is this tab's OWN reported turn, nothing guessed.
        // #151: develop's tab never wears it (an agent of another lane writes into dev\ all day, e.g. its brief under
        // documentation\). Display only: the claims, the Map and every close check still see that agent.
        occupancy: e.isDev ? null : occupancyDisplay.tabOccupancy(claims, e.key, { keyOf, turn: t && t.status ? t.status.turn : null, now: at }),
        // Backlog #39: the hover card's lines for this tab's local-model summary ([] when it has none).
        summaryLines: summaryDisplay.hoverLines(e.summary, at, e.summaryNote),
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
      const payload = occupancyDisplay.viewPayload(claims, tab.folderKey || tab.key, { keyOf });
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
    const payload = occupancyDisplay.viewPayload(readClaims(), tab.folderKey || tab.key, { keyOf });
    tab.occupancySent = JSON.stringify(payload);
    return payload;
  }

  function snapshot() {
    const m = model();
    const sel = m.find(e => e.selected);
    // 1B (documentation/DESIGN_TAB_STRIP.md): `model` is every lane; `strip` is the ones with a tab (a running session, or
    // the selected one) and `lanes` the rows of the Lanes menu for the rest. The strip draws `strip`, never `model`.
    const placed = tabLanes.placeLanes(m, closedRows());
    return {
      model: m, strip: placed.strip, lanes: placed.menu, selectedKey: sel ? sel.key : null, tabs: [...tabs.values()], notice: lastError, closeNotice, closeStuck: stuckNow(), mode,
      create: create ? { ...create } : null,
      devClosed: devClosed(),     // #160: the pane says how to bring it back when nothing is selected
      mergedNotice,               // #139: "Closed <lane> (merged)", an info line
    };
  }

  /** The tabs you can see (1B), in strip order, from a model. Ctrl+Tab and a close's neighbour only ever land here. */
  const visibleOf = (m) => tabLanes.placeLanes(m, []).strip;

  // Lanes reopened since git last listed the worktrees: state.tabs lags them, so a prune must not take their slot (PR #227 Dexter r2 A).
  const reopenedUnlisted = new Set();

  /** Save the strip's order and its closed lanes. Quiet: a layout that is missing, refuses or throws changes nothing on screen. */
  function persistLayout({ prune = true } = {}) {
    if (!layout || typeof layout.save !== 'function') return;
    const closed = closedByHand.filter(c => state.dismissed.includes(c.key));
    // An order only keeps lanes that still exist or can be reopened. It is pruned against git's list as the reducer holds it,
    // which is empty before the first poll and lags a reopen by one poll: neither may cost the person their order (PR #227 Dexter 1).
    if (prune && state.tabs.length > 0) {
      const known = new Set([...state.tabs.map(t => keyOf(t.path)), ...closed.map(c => c.key), ...reopenedUnlisted]);
      order = order.filter(k => known.has(k));
      // P7: a pin whose folder git no longer lists AT ALL is forgotten. Listed but not openable (detached mid-rebase, prunable,
      // initializing) is still listed: its pin stays (PR #250 Dexter 2). Before git has given a usable list nothing is pruned.
      if (listedKeys !== null) pinned = pinned.filter(k => listedKeys.has(k) || known.has(k));
    }
    try {
      const r = layout.save({ order, closed, pinned });
      if (r && r.ok === false) log('[shell] layout.save refused:', r.error);
    } catch (err) {
      log('[shell] layout.save threw:', err && err.message);
    }
  }

  /**
   * Drag to reorder (BACKLOG #141): the lane `key` goes just before `beforeKey`, or to the end for null. Develop is
   * first and never moves, and dropping on it means "first of the others". A side or shell tab moves with its lane, so
   * only a lane's own key is accepted. Saved.
   */
  function reorder(key, beforeKey) {
    if (mode !== 'tabs') return { ok: false, error: 'not a project window' };
    const m = model();
    const lanes = m.filter(e => !isCompanionEntry(e) && !e.isDev).map(e => e.key);
    if (typeof key !== 'string' || !lanes.includes(key)) return { ok: false, error: 'not a lane that can move' };
    const dev = m.find(e => e.isDev);
    let before = null;
    if (typeof beforeKey === 'string') {
      if (dev && beforeKey === dev.key) before = lanes[0];
      else if (lanes.includes(beforeKey)) before = beforeKey;
      else return { ok: false, error: 'not a lane to drop before' };
    }
    // the saved order as it stands (a lane closed by hand keeps its slot, PR #227 Dexter 6), then the lanes it doesn't name, as drawn
    const base = [...order, ...lanes.filter(k => !order.includes(k))];
    order = tabLanes.moveKey(base, key, before);
    persistLayout();
    publish();
    return { ok: true };
  }

  /**
   * Pin or unpin a lane (BACKLOG #167). Only a lane the strip lists can be pinned: not develop (always in the launch set), not a side
   * or shell tab. An unpin is allowed for any key that is pinned, listed or not. Saved.
   */
  function setPinned(key, on) {
    if (mode !== 'tabs') return { ok: false, error: 'not a project window' };
    if (typeof key !== 'string' || key === '') return { ok: false, error: 'not a lane' };
    const has = pinned.includes(key);
    if (on === false) {
      if (!has) return { ok: true };
    } else {
      if (!model().some(e => e.key === key && !isCompanionEntry(e) && !e.isDev)) return { ok: false, error: 'not a lane that can be pinned' };
      if (has) return { ok: true };
    }
    pinned = on === false ? pinned.filter(k => k !== key) : [...pinned, key];
    persistLayout();
    publish();
    return { ok: true };
  }
  const pin = (key) => setPinned(key, true);
  const unpin = (key) => setPinned(key, false);

  /**
   * The Pin / Unpin item of a lane tab's right-click menu: `{ show, pinned, label, target }`. Shown for a lane only (not develop, not a
   * side or shell tab, not a key the strip doesn't list). The labels are Claude's call, shown at Ricardo's live look.
   */
  function pinMenu(key) {
    const none = { show: false, pinned: false, label: '', target: null };
    if (mode !== 'tabs' || typeof key !== 'string' || key === '') return none;
    if (!model().some(e => e.key === key && !isCompanionEntry(e) && !e.isDev)) return none;
    const on = pinned.includes(key);
    return { show: true, pinned: on, label: on ? 'Unpin' : 'Pin (starts at launch)', target: key };
  }

  /**
   * The Lanes menu's rows (app/tab-lanes.js lanesMenuRows): `hiddenKeys` are the tabs the strip page couldn't fit (2A),
   * checked against what is really on the strip (develop and the selected tab are never hidden). The first lane closed by
   * hand carries the Ctrl+Shift+T shortcut, which reopens it.
   */
  function lanesMenu(hiddenKeys) {
    const placed = tabLanes.placeLanes(model(), closedRows());
    const asked = new Set((Array.isArray(hiddenKeys) ? hiddenKeys : []).filter(k => typeof k === 'string'));
    const hidden = placed.strip.filter(e => asked.has(e.key) && !isCompanionEntry(e) && !e.isDev && !e.selected);
    // The shortcut goes on the row it really reopens, the most recent close: develop is listed first whenever it is closed (#160).
    const next = reopenTarget();
    return tabLanes.lanesMenuRows(placed.menu, hidden).map((r) => (r.action === 'reopen' && next !== null && r.key === next
      ? { ...r, shortcut: 'Ctrl+Shift+T' } : r));
  }

  /** The key a plain Ctrl+Shift+T reopens (the most recent hand close), or null. */
  const reopenTarget = () => { const c = closedRows()[0]; return c ? c.key : null; };

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

  /**
   * A branch tab's side session: the same folder, a host of its own (the record's `side` flag makes main spawn it as a side
   * host and look for it as one). `branch` is the name the Resources panel and a close dialog show.
   */
  function newSideRecord(parent) {
    const rec = newRecord({ path: parent.cwd, branch: null, isDev: false });
    rec.key = sideKeyOf(parent.key);
    rec.side = true;
    rec.parentKey = parent.key;
    rec.folderKey = parent.key;
    rec.branch = sideLabel(parent.branch || path.basename(parent.cwd));
    return rec;
  }

  /** A branch tab's plain shell (#119 A5): the same folder, a host of its own that main spawns as a shell host and looks for as one. */
  function newShellRecord(parent) {
    const rec = newRecord({ path: parent.cwd, branch: null, isDev: false });
    rec.key = shellKeyOf(parent.key);
    rec.shell = true;
    rec.parentKey = parent.key;
    rec.folderKey = parent.key;
    rec.branch = shellLabel(parent.branch || path.basename(parent.cwd));
    return rec;
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
  // A lane whose host the first look missed (the walk's probe timed out under load, a token not readable yet) is looked for again
  // on the next polls, a few times and no more: 1B puts a lane on the strip because its session runs, so a miss mustn't be final
  // (PR #227 Dexter 4). Each look is a port walk, hence the small bound.
  const ATTACH_LOOKS = 4;
  function attachIfRunning(tab) {
    tab.attachLooks = (tab.attachLooks || 0) + 1;
    tab.attachBusy = true;
    tab.attachPromise = queue.run(async () => {
      if (tab.closed || tab.started || tab.starting || destroyed) return;
      let chosen = null;
      try { chosen = await hosts.choosePort(tab); } catch (err) { log('[shell] port probe failed:', err && err.message); }
      if (!chosen || chosen.action !== 'attach' || tab.closed || tab.started || tab.starting) return;
      const token = hosts.tokenFor(chosen.port);
      if (!token) { log(`[shell] ${tab.key}: a host is on ${chosen.port} but its token can't be read`); return; }
      // A retry after a start whose spawn timed out: the host it waited for is up, so the start's leftovers go (a stale `pending`
      // would make the next restart wait on this port and spawn nothing; the error would stay on a running tab) (PR #227 Dexter r2 D).
      tab.pending = null;
      tab.error = null;
      present(tab, chosen.port, token);
    }).then(() => { tab.attachBusy = false; publish(); }, () => { tab.attachBusy = false; publish(); });
    return tab.attachPromise;
  }

  /** Each poll: look again for the host of a lane that still has none, up to ATTACH_LOOKS looks in all. */
  function lookAgainForHosts() {
    // The identity files say which folders have a host: look only under those (a walk is a probe of many ports and shares the
    // start queue). A list that can't be had means every lane is looked for.
    const known = listHosts('laneHosts');
    const serving = known === null ? null : new Set(known.map(h => keyOf(h.cwd)));
    for (const t of tabs.values()) {
      if (serving !== null && !serving.has(t.key)) continue;
      if (t.started || t.starting || t.closed || t.ended || t.attachBusy || t.side || t.shell || ending.has(t.key)) continue;
      if ((t.attachLooks || 0) >= ATTACH_LOOKS) continue;
      attachIfRunning(t);
    }
  }

  // First selection: choose the port NOW, spawn if nobody serves this folder,
  // wait for it, then draw. One chain, so two tabs can't take one port.
  function start(tab) {
    if (ending.has(tab.key)) return Promise.resolve();     // its host is being ended: a start now would be dropped with it, unstopped
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
        // A side session never spawns into a folder that is being removed, or for a tab that closed during the walk (PR #149 R2-2).
        // (A host the walk FOUND is still attached below, and stopped if its tab closed: it is already running.)
        if (isCompanionEntry(tab) && chosen.action === 'spawn' && (tab.closed || destroyed || phaseOf(tab.parentKey) === 'removing')) return;
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
            // the branch tab closed during this wait: dropSide found no pending host to stop, so it is stopped here (Dexter F1, PR #216)
            if (tab.closed && isCompanionEntry(tab)) stopFromStart(tab, pend.port, pend.token);
            throw new Error(`the host did not come up on port ${port} in time`);
          }
          token = pend.token;
        } else if (chosen.action === 'attach') {
          token = hosts.tokenFor(port);
          if (!token) throw new Error(`a host is on port ${port} but its token can't be read`);
        } else {
          token = hosts.newToken();
          const rec = { port, token };
          const child = hosts.spawn({ tab, port, token });
          // The window spawned it, so the child's exit is proof the host is dead (PR #231 Dexter M2): a host that crashed while
          // starting leaves no file and no listener, and a close must not wait on it for ever.
          if (child && typeof child.once === 'function') {
            const died = () => { exitedHosts.add(rec); };
            child.once('exit', died);
            child.once('error', died);
          }
          spawned = true;
          if (!(await hosts.wait(port))) {
            tab.pending = rec;
            // a side tab closed meanwhile: dropSide ran before this host was recorded, so it is stopped here (Dexter 4)
            if (tab.closed && isCompanionEntry(tab)) stopFromStart(tab, port, token);
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
          // Closed while starting: don't leave the host we just made behind. A side tab's host is its own even when it was
          // FOUND (attached): nobody else will end it once its branch tab is gone (PR #149 Dexter 4).
          if (spawned || isCompanionEntry(tab)) stopFromStart(tab, port, token);
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

  /**
   * A branch tab whose claude exited keeps a dead page, and a click on it starts a session again (BACKLOG #140); a main tab's host resumes ITS OWN last conversation when it has one recorded (#166, host/main-session.js), else it is fresh: the page is
   * dropped and the record goes back to unstarted, so select() starts it as it retries a failed start. Side and shell tabs
   * have their own reopen; a folder being removed or already merged (finishing), or a reader with unsaved edits (#50), is left as it is.
   */
  function resetEnded(tab) {
    if (!tab.started || tab.ended !== true || isCompanionEntry(tab)) return;
    const phase = phaseOf(tab.key);
    if (phase === 'removing' || phase === 'finishing' || readerUnsavedOf(tab)) return;
    if (tab.view) { try { views.destroy(tab); } catch (err) { log('[shell] destroy failed:', err && err.message); } }
    tab.view = null;
    tab.started = false;
    tab.port = null;
    tab.token = null;
    tab.status = null;
  }

  /** Select a tab, starting it (or retrying a failed start) as needed; `restart`: a person's click also restarts an ended session. */
  function select(key, restart = false) {
    const next = tabModel.select(model(), key);
    if (next === null || ending.has(next)) return Promise.resolve();
    closeNotice = null;
    mergedNotice = null;
    // A tab that is looked at and worked in again is no longer the one that was asked to stop: the Stop offer goes (PR #231 Dexter M1),
    // so a later Stop is a plain close and asks (an edit made since would be lost otherwise).
    closeStuck.delete(next);
    mergedPoke(next);     // looked at: a merged lane's safe check looks again at once (P7)
    selectedKey = next;
    const tab = tabByKey(next);
    let started = Promise.resolve();
    if (tab) {
      if (restart) resetEnded(tab);
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
    let sideList;           // the side hosts the identity files list, read at most once per batch of actions (Miguel Y2)
    let shellList;          // ... and the shell hosts (#119 A5), the same way
    const openedNow = new Set();     // #139: a lane opened and marked merged in one batch came back (or was first seen) merged
    for (const a of actions) {
      const key = keyOf(a.path);
      if (a.type === 'open') {
        openedNow.add(key);
        if (tabs.has(key)) {
          // A record made before git answered (develop, P10): git lists it now, so it adopts its side and shell hosts like any tab,
          // from the same read as the rest of this batch.
          const early = tabs.get(key);
          if (early.early === true) {
            if (sideList === undefined) sideList = listSideHosts();
            adoptSide(early, sideList);
            if (shellList === undefined) shellList = listShellHosts();
            adoptShell(early, shellList);
          }
          continue;
        }
        const entry = state.tabs.find(t => keyOf(t.path) === key) || { path: a.path, branch: a.branch, isDev: false };
        const tab = newRecord(entry);
        tabs.set(key, tab);
        attachIfRunning(tab);
        if (sideList === undefined) sideList = listSideHosts();
        adoptSide(tab, sideList);
        if (shellList === undefined) shellList = listShellHosts();
        adoptShell(tab, shellList);
      } else if (a.type === 'stop') {
        const t = tabByKey(key);
        if (t && t.started && t.port && t.token) {
          hosts.control({ port: t.port, token: t.token, msg: { type: 'stop' } })
            .then(r => log(`[shell] stop ${t.key}: ${r && r.ok ? 'sent' : (r && r.error)}`), () => {});
        }
      } else if (a.type === 'close') {
        const t = tabByKey(key);
        if (!t) continue;
        // A side session lives and dies with its branch tab (#81).
        const sk = sideKeyOf(key);
        const hk = shellKeyOf(key);
        const sideShowing = (sk !== null && selectedKey === sk) || (hk !== null && selectedKey === hk);
        if (sk !== null) dropSide(sk, { stop: true });
        if (hk !== null) dropSide(hk, { stop: true });     // a shell (#119 A5) lives and dies with its branch tab too
        t.closed = true;
        if (t.view) { try { views.destroy(t); } catch (err) { log('[shell] destroy failed:', err && err.message); } }
        t.view = null;
        tabs.delete(key);
        // A setup still running keeps holding the folder's session, so a
        // Reopen meanwhile can't start it early (PR #80 Dexter F1).
        if (!(setups.has(key) && setups.get(key).running === true)) setups.delete(key);
        createdWarnings.delete(key);
        if (key === selectedKey || sideShowing) {
          // The model from before, without the side tab that went with it: it is not a neighbour to land on.
          // ... and only a tab you can see (1B): a close must not start a lane that is just a row in the Lanes menu.
          selectedKey = tabModel.afterClose(visibleOf(before).filter(e => e.parentKey !== key), key, key);
          reselect = true;
        }
      } else if (a.type === 'error') {
        const t = tabByKey(key);
        if (t) t.error = a.error;
      } else if (a.type === 'mark-merged') {
        // The strip draws it from state.tabs; the session keeps running (W4) until the merged close finds it safe (#139).
        log(`[shell] ${key}: merged (${a.branch})`);
        if (openedNow.has(key) && reopening.has(key)) spared.add(key);     // reopened by the person, merged already (Dexter 3)
      } else if (a.type === 'remove') {
        runRemove(a.path);
      }
    }
    for (const k of openedNow) reopening.delete(k);     // its first listing is the one that says whether it came back merged
    if (reselect && selectedKey !== null) select(selectedKey);
    publish();
  }

  // Contract C, for a tab the reducer moved to `removing`: its session ended
  // after the merge. Exactly one removeResult per remove, whatever happens.
  function runRemove(p) {
    // The side claude has this folder as its working folder: the remover can't take a busy folder, so it is ended first (Dexter 2).
    // ... and so is the lane's shell, whose working folder this is too (#119 A5).
    Promise.all([endSide(keyOf(p)), endShell(keyOf(p))])
      .then(() => ops.remove({ path: p }))
      .then(r => r, err => ({ ok: false, error: errorText(err) }))
      .then((r) => {
        if (destroyed) return;
        const what = r && r.ok === true ? (r.already ? 'already removed' : 'removed')
          : (r && r.kept === true ? `kept: ${r.reason}` : `failed: ${r && r.error}`);
        log(`[shell] remove ${keyOf(p)}: ${what}`);
        if (r && r.ok === true && !r.already) countUse('tab:merged-close');
        const before = model();
        const key = keyOf(p);
        const hadTab = tabs.has(key);
        const { state: next, actions } = lifecycle.removeResult(state, p, r);
        state = next;
        apply(actions, before);
        // #167 (P7): the merged close ignores a pin, and the pin goes with the lane (folder removed, or kept for its brief), in one save.
        if (r && (r.ok === true || r.kept === true) && pinned.includes(key)) { pinned = pinned.filter(k => k !== key); persistLayout(); }
        // #139 (P5): a merged lane's tab that the removal closed leaves "Closed <lane> (merged)" on the strip's notice line, after
        // apply (the selection it makes would clear it). A tab that was drawn always gets it, whoever ended its session.
        if (hadTab && !tabs.has(key)) {
          const label = (before.find(e => e.key === key) || {}).label || path.basename(p);
          mergedNotice = `Closed ${label} (merged)`;
          log(`[shell] ${key}: ${mergedNotice}`);
          publish();
        }
      });
  }

  // Every folder git listed in its last USABLE answer (one with develop in it), openable or not; null until there is one.
  let listedKeys = null;
  const usableAnswer = (o) => !!o && Array.isArray(o.worktrees) && o.worktrees.some(w => w && w.isDev === true);

  function reconcileWith(observation) {
    const before = model();
    const usable = usableAnswer(observation);
    if (usable) listedKeys = new Set(observation.worktrees.map(w => keyOf(w.path)));
    const { state: next, actions } = lifecycle.reconcile(state, observation);
    state = next;
    reopenedUnlisted.clear();     // git has answered: state.tabs is the truth again
    apply(actions, before);
    if (usable) settleEarlyTabs();
    // The reducer forgets a hand close once git stops listing the worktree: so does the saved list.
    const stillClosed = closedByHand.filter(c => state.dismissed.includes(c.key));
    if (stillClosed.length !== closedByHand.length) { closedByHand = stillClosed; persistLayout(); }
    // ... and a pin on a folder git stopped listing at all (P7; see persistLayout). An unusable answer is no answer: it prunes nothing.
    if (usable) {
      const listed = new Set([...listedKeys, ...closedByHand.map(c => c.key)]);
      if (pinned.some(k => !listed.has(k))) { pinned = pinned.filter(k => listed.has(k)); persistLayout(); }
    }
    if (selectWhenListed !== null && tabs.has(selectWhenListed)) {
      const k = selectWhenListed;
      selectWhenListed = null;
      select(k);
    } else if (selectedKey === null || !tabs.has(selectedKey)) {
      const first = firstSelection();
      if (first !== null) select(first);
    }
    if (usable) startLaunchSet();     // an unusable answer must not use up the once-per-window launch set (PR #250 Miguel Y2)
  }

  /**
   * A record made before git had answered (develop, P10) meets a USABLE git list (one with develop in it): it takes its branch (and
   * apply gave it its side and shell hosts, from the batch's one read). It is never stopped here: an attached session was alive before
   * this window and is the person's (Remote Control survives the window on purpose), and a list that does not name develop is
   * unusable (host/tab-lifecycle.js reconcile), which never reaches this (PR #250 Dexter 5).
   */
  function settleEarlyTabs() {
    for (const t of tabs.values()) {
      if (t.early !== true) continue;
      const entry = state.tabs.find(x => keyOf(x.path) === t.key);
      if (!entry) { log(`[shell] ${t.key}: started at launch; git's list names no such tab (left as it is)`); continue; }
      t.early = false;
      t.branch = entry.branch === undefined ? null : entry.branch;
    }
  }

  /**
   * The tab a window (or a selection that lost its tab) lands on: tabModel.initialSelection, which is the lane the window was
   * opened from, else develop. With develop closed (#160) its fallback would be the first lane, and selecting it STARTS it: only a
   * lane the window was opened from is taken then; otherwise nothing is selected and the pane says how to open one.
   */
  function firstSelection() {
    const first = tabModel.initialSelection(state.tabs, launchedFrom, { keyOf, isInside });
    if (first === null || !tabs.has(first)) return null;
    if (first === devKey) return first;
    const fallback = tabs.has(devKey) ? devKey : null;     // a closed develop has no tab (PR #236 Miguel G2)
    // #139 (Ricardo's notes of 2026-10-28/29: a window must not open on a lane that was already merged): a merged lane whose
    // session isn't running is never selected by the window itself, since selecting starts a claude in a folder on its way out.
    if (wasMerged(first) && !tabs.get(first).started) {
      if (mergedWhy.get(first) !== 'opened on') { mergedWhy.set(first, 'opened on'); log(`[shell] ${first}: merged; the window doesn't open on it`); }
      return fallback;
    }
    if (!devClosed()) return first;
    const named = typeof launchedFrom === 'string' && launchedFrom !== '' && (keyOf(launchedFrom) === first || isInside(launchedFrom, tabs.get(first).cwd));
    if (named) return first;
    // Otherwise the first tab whose session already runs (a restart finds them): selecting it starts nothing. None: nothing selected.
    const running = visibleOf(model()).find(e => !isCompanionEntry(e) && e.started === true && e.ended !== true);
    return running ? running.key : null;
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
      // #139: THIS poll's markers. A poll that couldn't list worktrees has none, and closes nothing.
      if (seen) closeMergedPass(seen.merged);
      lookAgainForHosts();
    } finally {
      polling = false;
    }
  }

  /**
   * BACKLOG #139 (Ricardo, 2026-11-05: "they should close when merge automatically"; 2026-11-06: "B: no Undo"): each poll, a branch
   * tab whose marker THIS poll read as merged, whose reducer phase is `finishing` and whose session is running is offered to
   * closeTabOnce's merged mode, which stops its session only if the lane is safe now (#77's rule, plus an idle lane and empty input
   * boxes) and otherwise keeps it with nothing asked; a later poll looks again (no timer of its own). The stop is its only act: the
   * existing flow then removes the folder (Contract C) and closes the tab, so a stop is offered only once the reducer has seen the
   * host running since the merge (`hostSeen`, what step 4 needs to move it to `removing`), and the next poll is run at once so the
   * removal starts without waiting 3 s. Not offered: develop (never merged), a side or shell tab (they go with their lane), a lane
   * the person brought back after its merge, a close already in flight, and a record this path already stopped or failed to stop
   * (kept with the Stop offer): at most one try per tab record, ever.
   */
  function closeMergedPass(merged) {
    const runs = [];
    mergedPolls++;
    for (const t of [...tabs.values()]) {
      if (t.isDev || isCompanionEntry(t) || t.key === devKey) continue;
      if (!merged || merged[t.key] !== true || !awaitsMergedClose(t.key)) { gitBackoff.delete(t.key); continue; }
      if (spared.has(t.key) || mergedTried.has(t) || mergedBusy.has(t.key) || closing.has(t.key) || ending.has(t.key)) continue;
      if (stuckFor(t.key) !== null) continue;     // a close already failed to end its host: the Stop offer is the person's to press
      if (!t.started || t.starting || t.ended === true) continue;     // no session: 1B gives it no tab, there is nothing to close
      const seen = state.tabs.find(x => keyOf(x.path) === t.key);
      if (!seen || seen.hostSeen !== true) continue;     // the removal would never follow this stop: wait for a poll that sees the host
      const held = gitBackoff.get(t.key);
      if (held && mergedPolls < held.next) continue;     // git said no a moment ago (PR #236 Dexter 12, Miguel Y2): not read again yet
      mergedBusy.add(t.key);
      gitRefused.delete(t.key);
      const run = closeTab(t.key, { auto: true }).then((r) => {
        if (gitRefused.has(t.key)) {
          const wait = Math.min(GIT_BACKOFF_MAX, held ? held.wait * 2 : 1);
          gitBackoff.set(t.key, { wait, next: mergedPolls + wait + 1 });
        } else gitBackoff.delete(t.key);
        if (r && (r.kept === true || r.stopped === true)) mergedTried.add(t);     // one try per record: a stop that failed, or one that worked
        if (r && typeof r.notSafe === 'string' && mergedWhy.get(t.key) !== r.notSafe) {
          mergedWhy.set(t.key, r.notSafe);
          log(`[shell] ${t.key}: merged, kept open: ${r.notSafe}`);
        }
        // Stopped: the next poll sees the host refuse and starts the removal; run it now rather than in up to 3 s.
        return r && r.stopped === true ? Promise.resolve(poll()).then(() => r) : r;
      }, (err) => { log(`[shell] ${t.key}: merged close threw: ${errorText(err)}`); return null; })
        .finally(() => { mergedBusy.delete(t.key); mergedRuns.delete(t.key); });
      mergedRuns.set(t.key, run);     // a hand close asked for meanwhile waits for it (closeTab)
      runs.push(run);
    }
    lastMergedPass = Promise.all(runs);
  }
  const mergedRuns = new Map();      // key -> the merged close in flight for it

  // PR #236 Dexter 12 / Miguel Y2: a merged lane git keeps (uncommitted, unpushed, HEAD past the merge, git can't say) changes only
  // with git activity, and each read is 4-5 git spawns. After a refusal from git its reads are skipped for 1, 2, 4, 8, then 16 polls
  // (the cap): git is read on polls 1, 3, 6, 11, 20, 37, 54... after the first, at most 17 polls (~51 s at the 3 s poll) apart. A
  // refusal that isn't git's (a turn, a draft, a reader edit) is looked at again on the next poll, as before: those checks are
  // cheap and a page ask only happens once git has passed. Anything that can change the answer looks again at once (mergedPoke).
  const GIT_BACKOFF_MAX = 16;
  let mergedPolls = 0;
  const gitBackoff = new Map();      // key -> { wait, next }: the poll number before which git isn't read again for it
  const gitRefused = new Map();      // key -> the git reason the last merged check stopped at (set by mergedCloseBlocker)
  /** Something that can change whether this lane is safe happened (a selection, a status change, a companion closed): look at once. */
  function mergedPoke(key) {
    const lane = companionParentOf(key) || key;
    gitBackoff.delete(lane);
  }
  /** The merged close's notes about a lane, dropped once its tab closes or is kept for good (PR #236 Miguel G4): no stale state by key. */
  function forgetMerged(key) {
    mergedWhy.delete(key);
    gitBackoff.delete(key);
    gitRefused.delete(key);
  }

  // #139: the page's own answer to "is your CLI box at rest?", by id, as Type /merged's `typed` answers are.
  const BOX_ANSWER_MS = 2000;
  const boxAsks = new Map();
  let boxSeq = 0;

  /**
   * The tab's page's answer, or null when it didn't answer in time: `{ clear }`, its CLI box at its prompt and empty, and nothing
   * else unsent in the page (the chat view's draft, a half-filled form).
   */
  function askPage(tab) {
    if (!tab.view || destroyed) return Promise.resolve(null);
    const id = ++boxSeq;
    // The wait is cancelled once the page answers (PR #236 Miguel G5): no 2 s timer kept alive per question, nor after destroy().
    // Made before the question goes: a page may answer inside send().
    const wait = answerWait(BOX_ANSWER_MS);
    const reply = new Promise(resolve => boxAsks.set(id, { key: tab.key, resolve, cancel: wait.cancel }));
    try { views.send(tab, 'box-state', { id }); } catch (err) { boxAsks.delete(id); wait.cancel(); log('[shell] box-state send threw:', err && err.message); return Promise.resolve(null); }
    return Promise.race([reply, wait.done.then(() => null)]).then((r) => { wait.cancel(); boxAsks.delete(id); return r; });
  }

  /**
   * A wait that can be called off: a real timer, cleared on cancel. A test that injects `sleep` gets that instead (it can't be
   * cancelled, but it's the test's own and ends at once).
   */
  function answerWait(ms) {
    if (typeof deps.sleep === 'function') return { done: sleep(ms), cancel: () => {} };
    let timer = null;
    let wake = () => {};
    const done = new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, ms); });
    return { done, cancel: () => { if (timer !== null) { clearTimeout(timer); timer = null; wake(); } } };
  }

  /** true when the tab's page says its box is at rest, false when it says not, null when it didn't answer in time. */
  const askBox = (tab) => askPage(tab).then(r => (r === null ? null : r.clear));

  /** main.js `tab:boxState`: only the page that was asked, for a question still waiting, counts. */
  function boxAnswered(sender, reply) {
    const tab = tabForSender(sender);
    if (!tab || !reply || typeof reply !== 'object') return false;
    const w = boxAsks.get(reply.id);
    if (!w || w.key !== tab.key) return false;
    boxAsks.delete(reply.id);
    w.resolve({ clear: reply.clear === true });
    return true;
  }

  /**
   * Why a merged tab must not be closed by itself right now, or '' when it may: #77's rule (closeReason: the marker and HEAD on
   * origin/develop, nothing uncommitted or unpushed, no agent here, no unsaved reader edit) plus an idle lane (laneRestBlocker: its
   * session and its side session at rest and in no night run, no shell tab) and every CLI box it holds at rest (each page's own
   * reading). Anything that can't be read keeps it.
   */
  async function mergedCloseBlocker(tab) {
    if (!tab.started || tab.starting || tab.ended === true) return 'its session is not running';
    let why = cheapBlocker(tab, null);
    if (why) return why;
    const g = await gitFactsOf(tab);
    why = cheapBlocker(tab, null);     // the read took a moment: the cheap facts first again
    if (why) return why;
    why = cheapBlocker(tab, g);        // so only git's part can say no here
    if (why) { gitRefused.set(tab.key, why); return why; }     // closeMergedPass backs off git's reads for it
    // The pages are asked LAST (PR #236 Dexter 6 A): a box read before git's slow reads could be typed into before the stop.
    const box = await askBox(tab);
    if (box !== true) return box === false ? 'its input box holds text, or a dialog is open' : "its page didn't say what its input box holds";
    const side = sideRecordOf(tab);
    if (side && side.started && side.ended !== true) {
      const sideBox = await askBox(side);
      if (sideBox !== true) return sideBox === false ? "its side session's input box holds text, or a dialog is open" : "its side session's page didn't say what its input box holds";
    }
    return cheapBlocker(tab, g);     // the asks took a moment: a turn may have started, a shell been opened, an edit made
  }

  /** Everything the merged close judges that needs no await: the lane at rest, the reader, the agents and, given git's facts, #77's rule. */
  function cheapBlocker(tab, g) {
    const why = laneRestBlocker(tab);
    if (why) return why;
    const unsaved = readerUnsavedOf(tab);
    if (unsaved) return `the file reader has unsaved edits to ${unsaved}`;
    const agents = agentsHereOf(tab);
    if (agents !== 0) return agents === null ? "couldn't check for agents" : 'an agent is working here';
    return g === null ? '' : closeReason(closeFactsOf(tab, g));
  }

  /**
   * The cheap half of "this lane is at rest" (#139; PR #236 Dexter 1), '' when it is: the merged close ends the lane's side session
   * and its shell with it, so they are judged too. Its session and a side session by the same rule (sessionBusyWhy: the lock, no turn,
   * nothing asking), neither in a night run (/bedtime, idle between ticks but not done); a shell tab keeps it whatever it says, since
   * nothing proves a shell idle (a dev server or a test run reports no turn).
   */
  function laneRestBlocker(tab) {
    const own = sessionRestWhy(tab.status);
    if (own) return `its session ${own}`;
    if (tabs.has(shellKeyOf(tab.key))) return "its shell tab is open (a shell can't be shown to be idle)";
    const side = sideRecordOf(tab);
    if (side && sideHolds(side)) {
      if (!side.started || side.starting) return "its side session hasn't come up yet";
      const s = sessionRestWhy(side.status);
      if (s) return `its side session ${s}`;
    }
    return '';
  }
  const sessionRestWhy = (st) => (!st ? "hasn't reported what it's doing" : st.night === true ? 'is in a night run (/bedtime)' : busyWhy(st) || '');
  /** A side record that may have a host running: a presented one not ended, a start under way, or a host a start left behind. */
  const sideHolds = (s) => (s.started === true && s.ended !== true) || s.starting === true || !!s.pending || !!s.unconfirmed;

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
    startDevelopAtOnce();
    await poll();
    return null;
  }

  /**
   * P10 (Ricardo's pick, BACKLOG #166): develop's session starts the moment the window opens, from its own folder, before the first
   * git poll has answered; the poll then reconciles (develop is always listed). It is a record the poll hasn't listed yet (`early`):
   * reconcileWith gives it its branch, or ends it when git doesn't list the folder. Not when develop was closed by hand (closed
   * stays closed), and not when the window was opened from a lane's worktree: that lane is the first start then (the poll's
   * first selection), and develop follows in the launch set.
   */
  /**
   * The same question firstSelection answers once git has: is the window opened from a LANE's worktree? Before git has answered the
   * lanes are unknown, so by shape: inside the project container, and neither the container itself (what main.js sends for a window
   * opened on the project) nor develop's folder nor inside it. Anything else (outside the project, no folder) resolves to develop.
   */
  function launchedFromALane(devPath) {
    if (typeof launchedFrom !== 'string' || launchedFrom === '') return false;
    if (keyOf(launchedFrom) === keyOf(container) || keyOf(launchedFrom) === devKey || isInside(launchedFrom, devPath)) return false;
    return isInside(launchedFrom, container);
  }

  function startDevelopAtOnce() {
    if (mode !== 'tabs' || devKey === null || tabs.has(devKey) || state.dismissed.includes(devKey)) return;
    const devPath = path.join(container, 'dev');
    if (launchedFromALane(devPath)) return;
    const rec = newRecord({ path: devPath, branch: null, isDev: true });
    rec.early = true;
    tabs.set(devKey, rec);
    start(rec);
  }

  let launchSetDone = false;

  /**
   * After the window's first reconcile with git's answer: the launch set (app/tab-lanes.js launchSet), each session through the
   * start chain, in order. A start that fails shows its error on its own tab and holds nobody else. Once per window: a pin made
   * later starts nothing by itself (it is on the strip, idle, until clicked or the next launch).
   */
  function startLaunchSet() {
    if (launchSetDone || mode !== 'tabs') return;
    launchSetDone = true;
    const lanes = state.tabs.map(t => keyOf(t.path));
    // the lane the window was opened from, by the same rule as the first selection (it is already starting, in the chain's first place)
    const named = typeof launchedFrom === 'string' && launchedFrom !== '' ? firstSelection() : null;
    const first = named === null ? undefined : named;
    for (const k of tabLanes.launchSet({ lanes, devKey, pinned, order, dismissed: state.dismissed, first })) {
      const tab = tabs.get(k);
      if (!tab || tab.started || tab.starting || ending.has(k)) continue;
      // #139: the window starts no claude in a lane on its way out (a merged lane shows as merged and waits for the person)
      if (wasMerged(k)) { log(`[shell] ${k}: merged; the launch doesn't start it`); continue; }
      start(tab);
    }
  }

  // --- #77: is this tab safe to close with no confirm? -------------------------------------------------------
  // Every fact that can't be read counts AGAINST it (host/close-safety.js); nothing here turns "couldn't tell"
  // into a number.

  /** The slow facts, read once: git's (branch, uncommitted, unpushed, HEAD on origin/develop), or null. */
  async function gitFactsOf(tab) {
    if (!safety || typeof safety.facts !== 'function') return null;
    try { return await safety.facts(tab.cwd); } catch (err) {
      log('[shell] safety.facts threw:', err && err.message);
      return null;
    }
  }

  /**
   * How many agents are working in the tab's folder (occupancy), or null when that can't be believed: no
   * reader, a reader that throws, or a service that couldn't look (an unreadable claim folder, a claim it
   * couldn't prove, no pass finished yet). Dexter D2, Miguel 1.
   */
  function agentsHereOf(tab) {
    if (!occupancy || typeof occupancy.claims !== 'function') return null;
    try {
      if (typeof occupancy.known === 'function' && occupancy.known(tab.cwd) !== true) return null;
      const claims = occupancy.claims();
      if (!Array.isArray(claims)) return null;
      const occ = occupancyDisplay.tabOccupancy(claims, tab.key, { keyOf, withAlso: true });
      return occ ? occ.count : 0;
    } catch (err) {
      log('[shell] occupancy for a close threw:', err && err.message);
      return null;
    }
  }

  /**
  /** The file with unsaved edits in the tab's code reader (#50), or null. A hook that throws says nothing. */
  function readerUnsavedOf(tab) {
    if (!safety || typeof safety.readerUnsaved !== 'function') return null;
    const one = (t) => {
      try { return safety.readerUnsaved(t); } catch (err) {
        log('[shell] safety.readerUnsaved threw:', err && err.message);
        return null;
      }
    };
    const own = one(tab);
    // A branch tab's close ends its side tab too (BACKLOG #132), so the side reader's unsaved file counts and is named with it.
    const side = sideRecordOf(tab);
    return joinNames(own, side ? one(side) : null);
  }

  /** The side tab's record of a BRANCH tab (a side or shell tab has none), or null. */
  function sideRecordOf(tab) {
    if (!tab || typeof tab.key !== 'string' || isSideKey(tab.key) || isShellKey(tab.key)) return null;
    return tabs.get(sideKeyOf(tab.key)) || null;
  }

  /**
   * The facts closeReason judges: git's (read earlier, passed in) with everything cheap read fresh. Merged is
   * the marker for the branch that is checked out NOW AND that commit being on origin/develop (Dexter D5): a
   * commit after the merge, or a switch to another branch, is not merged. The tab's own session is not a fact:
   * Ctrl+click closes it even mid-turn (Ricardo, 2026-10-09).
   */
  function closeFactsOf(tab, g) {
    const f = g && typeof g === 'object' ? g : {};
    let merged = null;
    if (typeof f.branch === 'string' && f.branch !== '') {
      let marker = null;
      try { marker = git.marker(tab.cwd, f.branch); } catch { marker = null; }
      if (marker === null) merged = false;
      else if (f.headInDevelop === true) merged = true;
      else if (f.headInDevelop === false) merged = false;
    }
    return {
      merged, dirtyCount: f.dirtyCount, unpushedCount: f.unpushedCount,
      agentsHere: agentsHereOf(tab),
      readerUnsaved: readerUnsavedOf(tab),
    };
  }

  const closing = new Set();   // keys with a close in flight: one gesture, one question (Dexter D7, Miguel 3)

  /**
   * Hand close, once per tab at a time. A second request for a tab already closing (a double click) is ignored.
   */
  async function closeTab(key, opts) {
    // A side or shell tab closes without a question (closeCompanionOnce); it also ends with its branch tab (#81).
    if (closing.has(key) && mergedRuns.has(key) && !(opts && opts.auto === true)) {
      // The person's x (or Ctrl+click, or Close tab) during a merged check (PR #236 Dexter 11): it isn't dropped. It waits for the
      // check, then is the normal hand close, unless the merged close stopped the session meanwhile: then the folder's removal
      // closes the tab, and that answers the x.
      let r = null;
      try { r = await mergedRuns.get(key); } catch { r = null; }
      if (!tabs.has(key) || (r && (r.stopped === true || r.removing === true))) return { ok: true };
      return closeTab(key, opts);
    }
    if (closing.has(key)) return { ok: false, error: 'already closing' };
    closing.add(key);
    try { return await (isShellKey(key) || isSideKey(key) ? closeCompanionOnce(key, opts) : closeTabOnce(key, opts)); } finally { closing.delete(key); }
  }
  /**
   * Which of the four closes a request is (PR #236 Miguel Y3), in the order they win:
   *   'merged'  the merged close (#139, `auto`): nothing asked; not safe now means kept, and a later poll looks again
   *   'stop'    the Stop button on a kept tab (#129, `stop` while its offer stands): asked once already, not again
   *   'ifSafe'  Ctrl+click (#77): no question when #77's rule passes, else the question with the reason
   *   'ask'     the x, the menu's Close tab, a `stop` whose offer has gone: the question
   */
  function closeModeOf(key, { ifSafe = false, stop = false, auto = false } = {}) {
    if (auto === true) return 'merged';
    if (stop === true && stuckFor(key) !== null) return 'stop';
    if (ifSafe === true) return 'ifSafe';
    return 'ask';
  }

  /** A branch tab's close, in the way closeModeOf names: then the reducer's `stop` + `close`. Nothing on disk. */
  async function closeTabOnce(key, opts) {
    const tab = tabByKey(key);
    if (!tab || mode !== 'tabs') return { ok: false, error: 'not closable' };
    const how = closeModeOf(key, opts);
    // Develop closes like a lane in every project window (#160), even as the last tab there (the menus bring it back), but never
    // by the merged close (#139): it is never merged. A single-folder window has no close at all (mode check above).
    if (tab.isDev && how === 'merged') return { ok: false, error: 'not closable' };
    const phaseNow = (state.tabs.find(t => keyOf(t.path) === key) || {}).phase;
    if (phaseNow === 'removing') return { ok: false, error: 'its folder is being removed' };   // Dexter F4
    let yes = false;
    let reason = '';
    let silent = false;
    if (how === 'merged') {
      if (!awaitsMergedClose(key)) return { ok: false, notSafe: 'not merged' };
      const why = await mergedCloseBlocker(tab);
      if (why !== '') return { ok: false, notSafe: why };
      yes = true;
      silent = true;
    } else if (how === 'stop') {
      yes = true;     // A plain x is a new close, and asks.
    } else if (how === 'ifSafe') {
      reason = closeReason(closeFactsOf(tab, await gitFactsOf(tab)));
      if (reason === '') { yes = true; silent = true; }
    }
    if (!yes && (how === 'ifSafe' || how === 'ask')) {
      try { yes = (await ui.confirmClose(tab, how === 'ifSafe' ? { reason } : undefined)) === true; } catch { yes = false; }
    }
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
    // The closing state starts BEFORE the targets are read (PR #231 Dexter L3): a click or the poll's look-again during the awaits below
    // (the targets' walk, the silent close's second git read) would otherwise present a host after the targets were read, and the close
    // would drop the tab without stopping it. Every way out of this block ends the state. It is published when the stop starts.
    ending.add(key);
    const targets = [];
    const dead = [];     // hosts taken as ended because their port refuses and their file proves nothing (PR #231 Miguel R3)
    let failure = null;
    try {
      // Every host this record may hold (#129; PR #231 Dexter 5): the presented one, else the pending AND the unconfirmed ones, else
      // whatever serves the folder when asked once more. `booting`: it may not have bound its port yet, so no file and a refusal prove nothing.
      if (tab.started && tab.ended === true) {
        // Its host ended after it ran, and its port may be another host's by now (PR #80 Dexter F2; PR #231 Dexter 1): nothing is sent
        // to it and nothing is killed. The close just closes, as stopCompanion does for an ended companion.
      } else if (tab.started && tab.port && tab.token) targets.push({ port: tab.port, token: tab.token, booting: false });
      else {
        for (const c of [tab.pending, tab.unconfirmed]) if (c && !targets.some(x => x.port === c.port)) targets.push({ port: c.port, token: c.token, booting: true, rec: c });
        if (targets.length === 0) {
          // Nothing presented and nothing pending: ask once more whether a host
          // serves this folder (an attach that couldn't read the token, a host that
          // bound after the shell gave up on it). Through the queue, like a start.
          let found = null;
          try { found = await queue.run(() => hosts.choosePort(tab)); } catch { found = null; }
          if (found && found.action === 'attach') {
            targets.push({ port: found.port, token: hosts.tokenFile(found.port) || hosts.tokenFor(found.port) || null, booting: false });
          }
        }
      }
      // Dexter D6: the silent close was licensed some awaits ago. Re-read what is cheap (the marker, the claims, the
      // session) right before the stop; if any of it changed, ask after all.
      if (how === 'merged') {
        // #139: the same re-read for the merged close, which never asks: anything changed (a turn began, a draft was typed) keeps it.
        const again = await mergedCloseBlocker(tab);
        if (!tabs.has(key)) return { ok: true };
        if (again !== '') return { ok: false, notSafe: again };
      } else if (silent) {
        // The git facts too (Dexter R4): a commit made while the first reads ran. A read that fails asks.
        const gitAgain = await gitFactsOf(tab);
        if (!tabs.has(key)) return { ok: true };     // gone during the read (its folder removed): nothing left to stop (Dexter F3)
        const again = closeReason(closeFactsOf(tab, gitAgain));
        if (again !== '') {
          let ok = false;
          try { ok = (await ui.confirmClose(tab, { reason: again })) === true; } catch { ok = false; }
          if (!ok) return { ok: false, cancelled: true };
          if (!tabs.has(key)) return { ok: true };
        }
      }
      // #129: the stop is sent FIRST, where its outcome can be seen, and the tab is dropped only once its host is known to be ended.
      // A refused or unanswered stop is retried once by pid; if that fails too the tab stays, with a Stop offer in the strip.
      const who = whoOf(tab);
      publish();
      for (const h of targets) {
        const f = await endHost(h, who, dead);
        if (failure === null) failure = f;
      }
    } finally { ending.delete(key); }
    if (tabs.get(key) !== tab) return { ok: true };     // gone during the stop (its folder was removed), or the key names a NEWER tab now (PR #231 Miguel R1)
    // A poll during the stop's wait saw the host refuse and moved the tab to `removing` (Contract C runs): the removal owns the tab
    // now, and its removeResult closes it. A closed row here would offer to reopen a folder being deleted (PR #236 Miguel R1, Dexter 7).
    if (phaseOf(key) === 'removing') return { ok: true, removing: true };
    if (failure !== null) return keepStuck(key, `Couldn't end the session in ${label}: ${failure}. It may still be running.`, failure, tab);
    clearStuck(key);     // the line about it goes with it
    forgetMerged(key);   // whichever way it closes (a dead port's line, a hand close, the merged close)
    if (how === 'merged') {
      // #139, as Ricardo chose (2026-11-06, "B: no Undo"): the merged close's only act is the stop. The existing flow does the rest:
      // the next poll sees the host refuse, the reducer moves the tab to `removing`, Contract C removes the folder and its
      // removeResult closes the tab with the notice (runRemove). No closeByHand, no closed row. If Contract C keeps the folder or
      // fails, the tab stays as that flow leaves it, and this path never stops it again (mergedTried, closeMergedPass).
      log(`[shell] ${key}: merged, its idle session stopped; the folder's removal closes the tab`);
      return { ok: true, stopped: true };
    }
    const before = model();
    const { state: next, actions } = lifecycle.closeByHand(state, tab.cwd);
    state = next;
    // The `+` menu offers it back (Ricardo, 2026-09-30), most recent first.
    closedByHand = [{ key, path: tab.cwd, branch: tab.branch }, ...closedByHand.filter(c => c.key !== key)];
    persistLayout();     // closed stays closed after a restart
    apply(actions.filter(a => a.type !== 'stop'), before);
    if (targets.length > 0) log(`[shell] stop ${key}: sent`);
    if (dead.length > 0) deadPortNotice(label);     // after apply: a selection it makes would clear it
    return { ok: true };
  }

  /** Who a host must be for this tab to end it by pid: its folder and its kind (host/stop-by-pid.js). */
  const whoOf = (t) => ({ cwd: t.cwd, side: t.side === true, shell: t.shell === true });

  // A stop the host took but didn't answer inside the control's 3 s is a host that is ending: given the host's own shutdown bound
  // (host/bounded-shutdown.js) to go before anything is done to it by pid (PR #231 Dexter 7).
  const TIMED_OUT = /^timed out after/;
  // A token refused at the handshake: whatever listens on that port is NOT this tab's host (PR #231 Dexter 1).
  const REFUSED_TOKEN = /handshake refused \(HTTP 403\)/;
  const WAIT_STEP_MS = 500;

  /** Does the port stop listening within the host's own shutdown bound? */
  async function goesQuiet(port) {
    for (let waited = 0; waited < SHUTDOWN_BOUND_MS; waited += WAIT_STEP_MS) {
      if (destroyed) return false;     // the window is gone: no timers kept alive for it (PR #231 Miguel R5)
      let answer = 'unknown';
      try { answer = await hosts.probe(port); } catch { answer = 'unknown'; }
      if (answer === 'refused') return true;
      await sleep(WAIT_STEP_MS);
    }
    return false;
  }

  /**
   * End ONE host of a tab (#129): send the stop and look at how it went. null: the host is ended, or was never this tab's. Otherwise
   * why it may still be running. Never rejects. `h` is { port, token, booting }; `who` says which host is this tab's.
   */
  async function endHost(h, who, dead) {
    if (h.rec && exitedHosts.has(h.rec)) return null;     // its spawned child exited: dead, and its port may be a stranger's now (PR #231 Dexter M2)
    const failure = h.token
      ? await stopOutcome(hosts.control({ port: h.port, token: h.token, msg: { type: 'stop' } }))
      : `a host is on port ${h.port} but its token can't be read`;
    if (failure === null) return null;     // it took the stop: never a kill after that (PR #231 Dexter 7)
    return afterFailedStop(h, failure, who, dead);
  }

  /** What a stop that failed leads to. The invariant: nothing is killed unless the file proves the process is THIS tab's host. */
  async function afterFailedStop(h, failure, who, dead) {     // dead: an array that collects the ports taken as ended on a refusal
    if (h.rec && exitedHosts.has(h.rec)) return null;     // it died while the stop was going out (PR #231 Dexter M2)
    if (REFUSED_TOKEN.test(failure)) {
      log(`[shell] port ${h.port} refused this tab's token: another tab's host holds it, nothing to stop`);
      return null;
    }
    if (TIMED_OUT.test(failure) && await goesQuiet(h.port)) return null;     // it took the stop and went
    if (destroyed) return failure;     // the wait was cut short: the host may be mid-shutdown, so no kill from a window that is gone
    let outcome;
    try { outcome = typeof hosts.stopByPid === 'function' ? await hosts.stopByPid(h.port, who) : 'unknown'; } catch (err) { outcome = 'unknown'; }
    if (outcome === 'killed' || outcome === 'gone' || outcome === 'mismatch') return null;     // a mismatch: the file is stale, the pid is another process now, so that host is dead (PR #231 Dexter 6)
    if (outcome === 'stranger') {
      log(`[shell] port ${h.port}: its host is not this tab's (another folder's), nothing to stop`);
      return null;
    }
    if (outcome === 'nofile' && !h.booting) {
      // A host that was listening and has no file now has gone. It could also be one that could not publish its identity (PR #231
      // Dexter L4), so the tab goes with a line in the log saying why, not silently.
      log(`[shell] port ${h.port}: the stop failed (${failure}) and the host has no identity file, so it is taken as gone`);
      return null;
    }
    if (outcome === 'nofile') {
      // Its start is not over: the host may not have bound its port yet, and has no file until it has. Wait for it, as long as the
      // start itself would (hosts.wait), then stop it; never drop the tab and leave a host that binds a moment later with no tab.
      let up = false;
      try { up = (await hosts.wait(h.port)) === true; } catch { up = false; }
      if (!up) return `its host on port ${h.port} hasn't come up yet, so it can't be stopped yet`;
      const again = h.token ? await stopOutcome(hosts.control({ port: h.port, token: h.token, msg: { type: 'stop' } })) : failure;
      if (again === null) return null;
      return afterFailedStop({ ...h, booting: false }, again, who, dead);
    }
    if (!h.booting && !destroyed) {
      // The file proves nothing ('unknown' or 'failed'), so nothing is killed. But a host that WAS listening and now refuses a fresh
      // probe is ended, whatever its file says (PR #231 Miguel R3; Ricardo, 2026-11-05: "Q2: A"); keeping the tab would retry the same
      // dead end for ever. Only a real refusal counts: 'unknown' (a timeout) proves nothing (host/port-probe.js).
      let answer = 'unknown';
      try { answer = await hosts.probe(h.port); } catch { answer = 'unknown'; }
      if (answer === 'refused' && !destroyed) {
        log(`[shell] port ${h.port}: the stop failed (${failure}), the pid retry said ${outcome}, and nothing listens on the port, so the host is taken as ended`);
        if (Array.isArray(dead)) dead.push(h.port);
        return null;
      }
    }
    return failure;
  }

  /** The strip's line for a tab closed on a dead port whose process its file couldn't confirm ended (PR #231 Miguel R3). */
  function deadPortNotice(name) {
    closeNotice = `Closed ${name}: its host no longer listens on its port, and its process couldn't be confirmed ended.`;
    publish();
  }

  function clearStuck(key) {
    const e = closeStuck.get(key);
    if (e && closeNotice === e.text) closeNotice = null;
    closeStuck.delete(key);
  }

  /** #129: a close whose host would not end keeps its tab, says so in the strip, and offers Stop (a second close, without the question). */
  function keepStuck(key, notice, failure, tab) {
    forgetMerged(key);     // the merged close won't try this record again (mergedTried): its notes about it go
    closeNotice = notice;
    closeStuck.delete(key);     // a Map keeps the place of a key set again: delete first, so the newest failure is the last (PR #231 Miguel R4)
    closeStuck.set(key, { text: notice, tab });
    log(`[shell] ${key}: ${notice}`);
    publish();
    return { ok: false, kept: true, stopError: failure };
  }

  // --- `+`: a new worktree (Contract A, then E), and reopening a closed tab ---

  /**
   * *New branch…*: Contract A makes the worktree, a poll gives it a tab (and
   * selects it), Contract E sets it up with its progress on the tab, and only
   * then does its session start (criterion 10). A setup failure still starts
   * it, with the error on the tab. One creation at a time.
   */
  async function createWorktree(branch, issueNumber) {
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

    countUse('tab:new-worktree');
    const key = keyOf(made.path);
    // #119 A6: a lane started from an issue gets its brief. It is asked for NOW and runs beside the setup (gh and the brief's
    // path take a second or two; the tab doesn't wait for them), but the session starts only once the brief is there,
    // because a session's first move may be to read it. The tab shows its issue number from this moment.
    let briefRun = null;
    if (Number.isInteger(issueNumber) && issueNumber >= 1 && issues && typeof issues.brief === 'function') {
      issueTabs.set(key, { branch: made.branch, number: issueNumber, title: null, url: null });
      briefHolds.add(key);
      briefRun = (async () => {
        try { return await issues.brief({ number: issueNumber, branch: made.branch, worktree: made.path }); } catch (err) {
          return { ok: false, error: errorText(err), issue: null };
        }
      })();
    }
    try {
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
      if (briefRun) {
        const b = await briefRun;
        briefHolds.delete(key);
        if (destroyed) return { ok: true, path: made.path };
        const known = issueShape(b && b.issue) || { number: issueNumber, title: null, url: null };
        issueTabs.set(key, { branch: made.branch, ...known });
        // Kept where a restart will find it, whether or not the brief got written (the number is the person's pick).
        if (issues && typeof issues.remember === 'function') {
          try { issues.remember({ branch: made.branch, path: made.path, issue: known }); } catch (err) { log('[shell] issues.remember threw:', err && err.message); }
        }
        // A tab closed by hand meanwhile keeps no warning for a later reopen (as with a setup error above).
        const note = b && b.ok !== true ? `the brief wasn't written (${b.error || 'unknown reason'})`
          : (b && typeof b.warning === 'string' && b.warning) || null;
        if (note && !state.dismissed.includes(key)) {
          createdWarnings.set(key, [createdWarnings.get(key), note].filter(Boolean).join('; '));
        }
        log(`[shell] brief for ${made.branch}: ${b && b.ok === true ? (b.existed ? 'already there' : 'written') : `not written: ${b && b.error}`}`);
        publish();
      }
    } finally {
      // Whatever threw in between (a publish, a poll, the setup), the hold comes off: a session that can never start is worse
      // than one that starts without its brief (PR #202 Miguel Y3).
      briefHolds.delete(key);
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

  /**
   * BACKLOG #119 A6: the form's *From an issue* list. Part of the form's state (`create.picker`), so main hides the
   * selected tab's page while it is open (the list is drawn by the strip page over that area) and Esc on the form
   * closes both. Only a form that is open for typing, or one a refusal left open, can take it.
   */
  function openPicker() {
    if (!create || (create.phase !== 'input' && create.phase !== 'failed')) return false;
    if (create.picker !== true) {
      create = { ...create, picker: true };
      publish();
    }
    return true;
  }

  function closePicker() {
    if (!create || create.picker !== true) return false;
    const { picker, ...rest } = create;     // eslint-disable-line no-unused-vars
    create = rest;
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

  /** Lanes closed by hand that git still lists, most recent first: the Lanes menu's "closed" rows. */
  function closedRows() {
    return closedByHand
      .filter(c => state.dismissed.includes(c.key))
      .map(c => ({ key: c.key, label: typeof c.branch === 'string' && c.branch ? c.branch : path.basename(c.path), isDev: c.key === devKey }));
  }

  /** The first few of them: what the `+` menu's probe answer and a plain Ctrl+Shift+T look at. */
  function reopenable() {
    return closedRows().slice(0, REOPEN_MAX).map(({ key: k, label }) => ({ key: k, label }));
  }

  /** *Reopen* / Ctrl+Shift+T: no key reopens the most recent one. */
  async function reopen(key) {
    const list = closedRows();
    const target = key === undefined ? list[0] : list.find(c => c.key === key);
    if (!target) return { ok: false, error: 'nothing to reopen' };
    const entry = closedByHand.find(c => c.key === target.key);
    // #139 (PR #236 Dexter 3): the person wants it open. If it comes back already merged (the poll that lists it marks it merged in
    // the same batch), the merged close leaves it alone from then on in this window: a lane closed by hand before or after its merge,
    // and reopened while its folder exists. Judged from that poll's marker.
    reopening.add(entry.key);
    state = lifecycle.reopen(state, entry.path).state;
    closedByHand = closedByHand.filter(c => c.key !== target.key);
    reopenedUnlisted.add(target.key);
    persistLayout({ prune: false });   // the reopened lane isn't in state.tabs until the poll below lists it
    selectWhenListed = target.key;
    await poll();
    return { ok: true };
  }

  /**
   * Reopen the lane closed by hand whose folder is `cwd` (or contains it), and select it: what Open on a background host of this project
   * does when its tab was closed here (PR #247 Dexter 2). { ok, key } or { ok: false, error }.
   */
  async function reopenFolder(cwd) {
    const k = typeof cwd === 'string' && cwd ? keyOf(cwd) : null;
    if (k === null) return { ok: false, error: 'no folder' };
    const rows = closedRows();
    const row = rows.find(c => c.key === k) || rows.find((c) => {
      const entry = closedByHand.find(x => x.key === c.key);
      return !!entry && isInside(cwd, entry.path);
    });
    if (!row) return { ok: false, error: 'no closed lane for that folder' };
    const r = await reopen(row.key);
    return { ...r, key: row.key };
  }

  /** What the `+` menu offers. */
  function plusMenu() {
    const busy = !!(create && create.phase === 'running');
    const scripts = scriptsAvailable();
    let why = null;
    if (mode !== 'tabs') why = 'not a project window';
    else if (busy) why = 'creating…';
    else if (!scripts.create) why = 'worktree scripts not installed';
    // #119 A5: a Shell tab for the SELECTED lane (or, with its side or shell tab showing, that tab's lane).
    const lane = companionParentOf(selectedKey) || selectedKey;
    const sm = shellMenu(lane);
    const shell = sm.label === 'Open shell here' ? { ...sm, label: 'Shell tab' } : sm;
    // #160: a closed develop is the + menu's first row too, one click from coming back.
    const dev = devClosed() ? closedRows().find(c => c.key === devKey) || null : null;
    const develop = dev ? { key: dev.key, label: dev.label, shortcut: reopenTarget() === dev.key ? 'Ctrl+Shift+T' : null } : null;
    return { create: { enabled: why === null, why }, reopen: mode === 'tabs' ? reopenable() : [], shell, develop };
  }

  /**
   * The window came back to the front: the selected tab is looked at now, so
   * whatever it was holding for you (a finished turn, an urgent need) is seen. A
   * look is selected AND focused, whichever arrives last (PR #90 Dexter F1).
   */
  function looked() {
    const tab = tabByKey(selectedKey);
    if (!tab || !tab.status || !(tab.status.needsInput || tab.status.finished || tab.status.messages > 0)) return false;
    tab.status = tabStatusLib.afterSelected(tab.status);
    if (tab.view) views.send(tab, 'tab-selected');
    publish();
    return true;
  }

  /** Is the tab of this view being looked at: selected, in a focused window (PR #224, Dexter 4: the page can't tell, so it asks). */
  function isLooked(sender) {
    const tab = tabForSender(sender);
    return !!tab && tab.key === selectedKey && ui.isFocused() === true;
  }

  /** A renderer's own status. Kept as-is except: you're looking at it. */
  function report(sender, status) {
    const tab = tabForSender(sender);
    if (!tab) return false;
    let next = sanitizeStatus(status);
    if ((next.needsInput || next.finished || next.messages > 0) && tab.key === selectedKey && ui.isFocused()) {
      next = tabStatusLib.afterSelected(next);
      views.send(tab, 'tab-selected');     // the page clears its own pending flag
    }
    if (tabStatusLib.sameStatus(tab.status, next)) return true;
    tab.status = next;
    mergedPoke(tab.key);     // a turn ended, a dialog went: a merged lane's safe check looks again at once (P7)
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

  /**
   * The tab whose view sent an attention message: a click selects it. The window comes forward either way: the toast
   * was this window's, so a click must never fall through to another one because its tab has since closed (#145).
   */
  function attentionClick(sender) {
    const tab = tabForSender(sender);
    if (tab) select(tab.key);
    ui.focusWindow();
    return !!tab;
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
      submitted: reply.submitted === true,       // only a literal true: the page's gate pressed Enter
    });
    return true;
  }

  /**
   * Asks `tab`'s own page to type `command` into its box, and with `submit` to press Enter too if its own submit
   * gate (app/submit-gate.js) allows it; its answer, or null if none came in time.
   */
  function askToType(tab, command, submit) {
    const id = ++typingSeq;
    const reply = new Promise(resolve => typing.set(id, { key: tab.key, resolve }));
    views.send(tab, 'type-command', { id, command, submit: submit === true });
    return Promise.race([reply, sleep(TYPE_ANSWER_MS).then(() => null)]).then((r) => { typing.delete(id); return r; });
  }

  /**
   * *Run /merged*, for the Git drawer (Enhancement #46, BACKLOG #61): select the branch's tab and have ITS OWN
   * PAGE type `/merged` into its box and press Enter once it reads back, if the page's submit gate allows it
   * (app/submit-gate.js). PR #93 R2-1 left the Enter to the person because no hook can say a turn is really
   * over; the answer then was that the CLI QUEUES a line submitted mid-turn (verify/probe-queued-skill.js), so
   * the worst case is a queued command, never a lost one (Ricardo's pick, DESIGN_WAND_SUBMIT.md).
   * The drawer only enables it for an open PR whose tab is at rest; this re-checks the tab
   * (it may have started a turn since the drawer drew) with the drawer's own rule, and explains instead
   * of typing into a busy session. The page types the top bar's way (PR #93 Dexter F3 / Miguel I2): it
   * judges its own screen (nothing into a dialog or a multi-line draft), clears a single-line draft
   * first, enters vim INSERT if needed, and answers ok only once the box reads back exactly `/merged`.
   * Always answers { kind: 'typed', branch, cleared, submitted } or { kind: 'explain', text }; `submitted` is
   * whether the Enter went in (false when the page's gate left it to the person).
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
      const r = await askToType(tab, '/merged', true);
      if (!r) return { kind: 'explain', text: `Couldn't confirm /merged reached ${name}'s session: its page didn't answer.` };
      if (!r.ok) return { kind: 'explain', text: `Didn't send /merged to ${name}'s session: ${r.reason || 'its page refused'}.` };
      return { kind: 'typed', branch, cleared: r.box !== '', submitted: r.submitted === true };
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

  /** The menu's side-session item for a branch tab or a side tab: its text, whether it works, and which branch tab it acts on. */
  function sideMenu(key) {
    const gone = { enabled: false, label: 'Open side session', target: null };
    if (mode !== 'tabs') return { ...gone, why: 'not a project window' };
    // From the shell's own records: a right-click must not rebuild the whole strip model (claims, marks...).
    const target = companionParentOf(key) !== null ? (tabs.has(key) ? companionParentOf(key) : null) : key;
    const parent = target === null ? null : tabByKey(target);
    if (!parent) return { ...gone, why: 'no such tab' };
    const rec = tabs.get(sideKeyOf(target));
    const label = !rec ? 'Open side session' : (rec.ended === true ? 'Reopen side session' : 'Go to side session');
    if (phaseOf(target) === 'removing') return { enabled: false, label, target, why: 'its folder is being removed' };
    if (setupHolds(parent)) return { enabled: false, label, target, why: 'its worktree is still being set up' };
    return { enabled: true, label, target };
  }

  // The reducer's phase of a branch tab ('removing' while its folder is being deleted), or null.
  const phaseOf = (key) => { const t = state.tabs.find(x => keyOf(x.path) === key); return t && typeof t.phase === 'string' ? t.phase : null; };
  // "Merged" means two things in this file, one helper each (PR #236 Miguel G1):
  //   wasMerged       the reducer moved it off `live` for a merge, whatever became of its folder since (kept, being removed, failed)
  //   awaitsMergedClose  merged, its folder untouched, its session the one the merged close may end: the merged close's own phase
  const wasMerged = (key) => ['finishing', 'kept', 'removing', 'remove-failed'].includes(phaseOf(key));
  const awaitsMergedClose = (key) => phaseOf(key) === 'finishing';

  function override(key) {
    const tab = tabByKey(key);
    if (!tab || !tab.view) return false;
    if (!menuState(key).override) return false;
    views.send(tab, 'lock-override');
    return true;
  }

  function step(n) {
    // Over the tabs you can see: Ctrl+Tab must not start every lane that is only a row in the Lanes menu (1B).
    const m = visibleOf(model());
    const sel = m.find(e => e.selected);
    const next = tabModel.neighbour(m, sel ? sel.key : null, n);
    return next === null ? Promise.resolve() : userSelect(next);
  }

  // A selection the PERSON made (a click, Ctrl+Tab) wins over a tab the shell
  // was waiting to select once git lists it (PR #80 Miguel G1): that tab still
  // opens, it just doesn't take the selection later.
  function userSelect(key) {
    selectWhenListed = null;
    // #139: starting a merged lane from its Lanes row is asking for it: the merged close leaves it alone in this window.
    const t = tabByKey(key);
    // (Only the merged close's own phase needs the spare: a `kept` lane is never closed by it, and leaves `kept` only for `live`.)
    if (t && !t.started && !t.starting && awaitsMergedClose(key)) spared.add(key);
    return select(key, true);
  }

  /** view query: which close button the blocked pane offers. */
  function tabmodeOf(tab) {
    if (mode === 'single') return 'single';
    return tab.isDev ? 'dev' : 'tab';
  }

  // --- #81: the standing read-only side session ---------------------------------------------------------------

  /**
   * Stop and forget a branch tab's side session. Its host is sent a stop (an ended one has nobody to hear it, which is
   * fine); the page goes; the selection is the caller's to move.
   */
  function dropSide(sk, { stop }) {
    const t = tabs.get(sk);
    if (!t) return;
    t.closed = true;
    if (stop === true) {
      for (const target of hostsToStop(t)) {
        hosts.control({ port: target.port, token: target.token, msg: { type: 'stop' } })
          .then(r => log(`[shell] stop ${sk}: ${r && r.ok ? 'sent' : (r && r.error)}`), () => {});
      }
    }
    if (t.view) { try { views.destroy(t); } catch (err) { log('[shell] destroy failed:', err && err.message); } }
    t.view = null;
    tabs.delete(sk);
  }

  /**
   * *Open side session* (a tab's menu): a second real claude in the tab's folder, in plan mode, as a small tab right after
   * its branch tab. Once open it stays; asking again goes to it. A stopped one is dropped and started afresh.
   */
  async function openSide(key) {
    return openCompanion(key, sideKeyOf, newSideRecord);
  }

  /** *Open shell here* (a tab's menu, or the + menu): the same lifecycle as the side session, with a host that runs the person's shell (#119 A5). */
  async function openShell(key) {
    return openCompanion(key, shellKeyOf, newShellRecord);
  }

  /** The side session and the shell share one lifecycle: one per lane, kept until the lane closes, restarted once ended. */
  async function openCompanion(key, keyFn, newRec) {
    if (mode !== 'tabs') return { ok: false, error: 'not a project window' };
    const sk = keyFn(key);
    const parent = sk === null ? null : tabByKey(key);
    if (!parent || parent.closed) return { ok: false, error: 'no such tab' };
    // A claude started in a folder `git worktree remove` is deleting leaves it half removed (Dexter 5): the same refusal a hand close has.
    if (phaseOf(key) === 'removing') return { ok: false, error: 'its folder is being removed' };
    if (setupHolds(parent)) return { ok: false, error: 'its worktree is still being set up' };
    const existing = tabs.get(sk);
    if (existing && existing.ended !== true) {
      await select(sk);          // an unstarted one (a failed start) is tried again by the selection
      return { ok: true, already: true };
    }
    // An ended record has no host to stop. (A timed-out spawn's `pending` can't be on a record that is also `ended`: pending is only
    // set while the start has not presented, and `ended` only after it has.)
    if (existing) dropSide(sk, { stop: false });
    tabs.set(sk, newRec(parent));
    await select(sk);
    return { ok: true };
  }

  /** At open: a side host still running from an earlier window comes back as the tab's side tab, with no spawn. */
  function adoptSide(parent, list) {
    adoptCompanion(parent, list, sideKeyOf, newSideRecord, 'side');
  }

  /** At open: a shell host still running from an earlier window comes back as the tab's shell tab, with no spawn (#119 A5). */
  function adoptShell(parent, list) {
    adoptCompanion(parent, list, shellKeyOf, newShellRecord, 'shell');
  }

  function adoptCompanion(parent, list, keyFn, newRec, what) {
    const sk = keyFn(parent.key);
    if (sk === null) return;
    // The identity files say which folders have a side host: a tab with none costs no port walk, and no place in the start queue.
    if (Array.isArray(list) && !list.some(h => h && typeof h.cwd === 'string' && keyOf(h.cwd) === parent.key)) return;
    queue.run(async () => {
      if (parent.closed || destroyed || tabs.has(sk)) return;
      const rec = newRec(parent);
      let chosen = null;
      try { chosen = await hosts.choosePort(rec); } catch (err) { log(`[shell] ${what} port probe failed:`, err && err.message); }
      if (!chosen || chosen.action !== 'attach' || tabs.has(sk)) return;
      const token = hosts.tokenFile(chosen.port) || hosts.tokenFor(chosen.port);
      if (!token) return;
      if (parent.closed || destroyed) {
        // Its branch tab closed while this was looking: the host it just proved is there has no tab to end with, so it ends now (Dexter 4).
        hosts.control({ port: chosen.port, token, msg: { type: 'stop' } }).catch(() => {});
        return;
      }
      tabs.set(sk, rec);
      present(rec, chosen.port, token);
    }).then(publish, publish);
  }

  /** The side hosts this build's identity files list ([{ port, cwd }]), or null when that can't be told (then each tab is looked for). */
  function listSideHosts() {
    return listHosts('sideHosts');
  }

  /** The shell hosts the identity files list, the same way (#119 A5). */
  function listShellHosts() {
    return listHosts('shellHosts');
  }

  function listHosts(name) {
    if (typeof hosts[name] !== 'function') return null;
    try { const l = hosts[name](); return Array.isArray(l) ? l : null; } catch (err) {
      log(`[shell] hosts.${name} threw:`, err && err.message);
      return null;
    }
  }

  /** The menu's shell item for a lane or its shell tab: its text, whether it works, and which branch tab it acts on (#119 A5). */
  function shellMenu(key) {
    const gone = { enabled: false, label: 'Open shell here', target: null };
    if (mode !== 'tabs') return { ...gone, why: 'not a project window' };
    const target = companionParentOf(key) !== null ? (tabs.has(key) ? companionParentOf(key) : null) : key;
    const parent = target === null || target === undefined ? null : tabByKey(target);
    if (!parent) return { ...gone, why: 'no such tab' };
    const rec = tabs.get(shellKeyOf(target));
    const label = !rec ? 'Open shell here' : (rec.ended === true ? 'Restart shell' : 'Go to shell');
    if (phaseOf(target) === 'removing') return { enabled: false, label, target, why: 'its folder is being removed' };
    if (setupHolds(parent)) return { enabled: false, label, target, why: 'its worktree is still being set up' };
    return { enabled: true, label, target };
  }

  /**
   * Stop a branch tab's side session and wait for its host to be gone, then forget it. The remover (Contract C) can't take a folder
   * a claude is working in, so this runs before it. A host that doesn't answer its stop is not waited on for ever: the caller goes on.
   */
  async function endSide(parentKey) {
    return endCompanion(sideKeyOf(parentKey));
  }

  /** The same for the lane's shell (#119 A5): the remover can't take a folder a shell is standing in either. */
  async function endShell(parentKey) {
    return endCompanion(shellKeyOf(parentKey));
  }

  async function endCompanion(sk) {
    const t = sk ? tabs.get(sk) : null;
    if (!t) return;
    await stopCompanion(t);     // a stop that fails: the remover reports a folder still in use
    dropSide(sk, { stop: false });
    publish();
  }

  /** A host's answer to a stop as the close reports it: why it may still be running, or null. Never rejects. */
  function stopOutcome(sent) {
    return Promise.resolve(sent).then(
      (r) => (r && r.ok === true ? null : ((r && r.error) || 'no answer')),
      (err) => (err && err.message) || String(err));
  }

  /** Every host a side or shell record may still have running: the presented one, else the pending and the unconfirmed ones (BACKLOG #133). */
  function hostsToStop(t) {
    if (t.started && t.port && t.token) return [{ port: t.port, token: t.token }];
    const out = [];
    for (const c of [t.pending, t.unconfirmed]) if (c && !out.some(o => o.port === c.port)) out.push({ port: c.port, token: c.token, rec: c });
    return out;
  }

  /** A start that gave up because its tab closed stops the host it made or found, and records which port that was. */
  function stopFromStart(tab, port, token) {
    tab.closeStopPort = port;
    tab.closeStopToken = token;
    tab.closeStop = stopOutcome(hosts.control({ port, token, msg: { type: 'stop' } }));
  }

  /**
   * End a side or shell tab's host and wait for its answer: why it may still be running, or null. Closed first, so a start still in
   * its port walk gives up before it spawns; then the start is let settle, so what it made or found is on the record when it is
   * stopped (R2-2). The remover must not start with a claude about to appear in the folder. The host's stop is its own teardown: the
   * pty tree killed by pid (host/pty-stop.js, host/kill-tree.js) and its identity file removed. An ended record is sent nothing: its
   * host is gone, and its port may be another host's by now.
   */
  async function stopCompanion(t) {
    const failed = await stopCompanionHosts(t);
    return failed.length > 0 ? failed[0].failure : null;
  }

  /** The hosts of a companion that did not take its stop: [{ port, token, booting, failure }]. See stopCompanion. */
  async function stopCompanionHosts(t) {
    t.closed = true;
    if (t.starting && t.startPromise) { try { await t.startPromise; } catch { /* start() reports its own errors */ } }
    // A start that gave up because this tab closed has already sent the stop to the host it made or found: wait for THAT one and
    // report how it went (Dexter F3, PR #214), rather than saying closed about a stop nobody looked at.
    // The host that start stopped is not the only one the record may hold: an earlier, unconfirmed one gets its stop too (Dexter F2, PR #216).
    const failed = [];
    const fromStart = t.closeStop ? await t.closeStop : null;
    const skip = t.closeStop ? t.closeStopPort : null;
    if (fromStart !== null) failed.push({ port: t.closeStopPort, token: t.closeStopToken || null, booting: true, failure: fromStart });
    const targets = (t.started && t.ended === true ? [] : hostsToStop(t)).filter(x => x.port !== skip);
    for (const target of targets) {
      if (target.rec && exitedHosts.has(target.rec)) continue;     // its spawned child exited: dead (PR #231 Dexter M2)
      const f = await stopOutcome(hosts.control({ port: target.port, token: target.token, msg: { type: 'stop' } }));
      if (f !== null) failed.push({ port: target.port, token: target.token, rec: target.rec, booting: !(t.started && t.port === target.port), failure: f });
    }
    return failed;
  }

  /**
   * A shell or side tab closed by hand (Ricardo's look, 2026-10-26): its x, a Ctrl+click, the menu's Close shell / Close side
   * session, or a shell page's own close. Nothing asks: a shell is a terminal, a side session is a reader that can write nothing
   * (the work is in the branch tab), and the folder stays. Only this tab's own host is stopped, never its branch tab's. Reopen
   * doesn't offer it back (Open shell here / Open side session starts a fresh one). If it was showing, its own branch tab shows next.
   */
  async function closeCompanionOnce(key, { stop = false } = {}) {
    const t = tabs.get(key);
    const noun = companionNounOf(key);
    if (!t || noun === null || mode !== 'tabs') return { ok: false, error: 'not closable' };
    // A side tab's code reader is a full editor (Dexter F1, PR #214): an unsaved edit in it asks, exactly as a branch tab's close
    // does (the question names the file). Nothing unsaved, nothing asked. A shell has no reader.
    if (isSideKey(key) && readerUnsavedOf(t) && !(stop === true && stuckFor(key) !== null)) {
      let yes = false;
      try { yes = (await ui.confirmClose(t)) === true; } catch { yes = false; }
      if (!yes) return { ok: false, cancelled: true };
      if (tabs.get(key) !== t) return { ok: true };     // gone while the dialog was up
    }
    ending.add(key);
    publish();
    let failed;
    try { failed = await stopCompanionHosts(t); } catch (err) { ending.delete(key); throw err; }
    if (tabs.get(key) !== t) { ending.delete(key); return { ok: true }; }     // gone meanwhile (its branch tab closed, or its folder was removed), or the key is a newer tab's now (Dexter F4)
    // #129: a stop that failed is looked at for every host that didn't take it (a refused token is a stranger's host, a timeout is given
    // the host's own shutdown bound, then the pid, proved to be THIS tab's); if one still may be running the tab stays (Stop offered).
    let failure = null;
    const who = whoOf(t);
    const dead = [];     // PR #231 Miguel R3, as in closeTabOnce
    try {
      for (const h of failed) {
        const f = await afterFailedStop(h, h.failure, who, dead);
        if (failure === null && f !== null) failure = f;
      }
    } finally { ending.delete(key); }
    if (tabs.get(key) !== t) return { ok: true };
    if (failure !== null) {
      t.closed = false;       // not closed after all: a start that gave up for it may begin again, and a second stop is sent afresh
      t.closeStop = null;
      t.closeStopPort = null;
      return keepStuck(key, `Couldn't end the ${noun} in ${t.branch}: ${failure}. It may still be running.`, failure, t);
    }
    clearStuck(key);     // the line about it goes with it
    const showing = selectedKey === key;
    dropSide(key, { stop: false });
    const parentKey = companionParentOf(key);
    mergedPoke(parentKey);     // its lane's merged check looks again at once (P7)
    if (showing && tabs.has(parentKey)) select(parentKey);     // a start it needs reports its own errors
    else publish();
    log(`[shell] closed ${key}`);
    if (dead.length > 0) deadPortNotice(`the ${noun} in ${t.branch}`);     // after the select, which clears notices
    return { ok: true };
  }

  function destroy() {
    destroyed = true;
    // A merged check still waiting for a page's answer gets "no answer" now, and its timer goes (PR #236 Miguel G5).
    for (const [id, w] of [...boxAsks]) {
      boxAsks.delete(id);
      if (typeof w.cancel === 'function') w.cancel();
      w.resolve(null);
    }
  }

  return {
    open, poll, select: userSelect, closeTab, report, raise, attentionClick, goTo, selectFolder, tabStates, typeMerged, typed, menuState, override,
    createWorktree, openCreate, cancelCreate, openPicker, closePicker, plusMenu, reopen, reopenFolder, reorder, pin, unpin, pinMenu, lanesMenu, looked, isLooked, openSide, sideMenu, openShell, shellMenu, issueOf,
    next: () => step(1), previous: () => step(-1),
    isTabView, tabForSender, tabByKey, tabmodeOf, snapshot, model, destroy, branchOf, occupancyFor, boxAnswered,
    // #139: the merged closes the last poll started (a test awaits them; main never needs to).
    _mergedPass: () => lastMergedPass,
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

/** A menu row's text: the label, then its state and its shortcut in brackets, each only when there is one. */
const rowText = (r) => `${menuText(r.label)}${r.state ? `  (${r.state})` : ''}${r.shortcut ? `  (${r.shortcut})` : ''}`;

/**
 * The Lanes ▾ menu's Electron template from the shell's rows (lanesMenu; BACKLOG #170 S8: pure, so it is tested without
 * Electron). A header is a disabled label, a separator a separator, a row a click that calls `act(row)`; no rows is one
 * disabled line. Main pops it.
 */
function lanesMenuTemplate(rows, act) {
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
  if (list.length === 0) return [{ label: 'No other lanes', enabled: false }];
  return list.map((r) => {
    if (r.type === 'header') return { label: r.label, enabled: false };
    if (r.type === 'separator') return { type: 'separator' };
    return { label: rowText(r), click: () => act(r) };
  });
}

/**
 * The + menu's template from plusMenu(): a closed develop first (#160), then New branch… and the shell tab. `acts` is
 * { reopen(key), openCreate(), openShell(target) }.
 */
function plusMenuTemplate(m, acts) {
  const dev = m && m.develop && typeof m.develop.key === 'string' ? m.develop : null;
  return [
    ...(dev ? [{ label: rowText({ label: dev.label, state: 'closed', shortcut: dev.shortcut }), click: () => acts.reopen(dev.key) }, { type: 'separator' }] : []),
    {
      label: m.create.enabled ? 'New branch…' : `New branch… (${m.create.why})`,
      enabled: m.create.enabled,
      click: () => acts.openCreate(),
    },
    // #119 A5: a plain shell for the selected lane
    {
      label: m.shell.enabled ? m.shell.label : `${m.shell.label} (${m.shell.why})`,
      enabled: m.shell.enabled,
      click: () => acts.openShell(m.shell.target),
    },
  ];
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
 *
 * PR #236 Miguel Y4: the view that had the keyboard went (its tab closed, the last one in the window or not) and no view replaces
 * it: `focusStrip: true`, so main gives the keyboard to the strip page, whose Lanes ▾ and + buttons and shortcuts (Ctrl+Shift+T)
 * bring a tab back. Otherwise a window with no tab open can't be reached from the keyboard at all.
 */
function focusStep(lastFocused, { windowFocused, selectedView, stripBusy = false } = {}) {
  // PR 3: the branch form is in the strip page. While it is open, every
  // publish (3 s poll, status reports) would otherwise hand the keyboard back
  // to the view mid-typing. Null, so the view is focused again once it closes.
  if (stripBusy === true) return { focus: false, lastFocused: null };
  if (!selectedView) {
    return windowFocused === true && lastFocused !== null && lastFocused !== undefined
      ? { focus: false, lastFocused: null, focusStrip: true } : { focus: false, lastFocused: null };
  }
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
  // #43: the shortcuts page. Bare F1 only, so Shift/Ctrl/Alt+F1 stay the terminal's. The CLI binds no F1 (it takes no
  // function keys), and with no menu bar Electron has no Help accelerator on it either.
  if (key === 'f1' && !input.control && !input.alt && !input.shift && !input.meta) return 'shortcuts';
  // #35: a new tab is a new worktree. Ctrl+Alt+T, not Ctrl+T: the CLI owns that
  // one (it toggles its task list), and every key not named here reaches it.
  if (key === 't' && input.control && input.alt && !input.shift) return 'new-branch';
  // #66: the indexing assistant's field, from anywhere in the window. The CLI binds no Ctrl+Alt+N.
  if (key === 'n' && input.control && input.alt && !input.shift) return 'index-note';
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
const VIEW_PROBE_ACTIONS = new Set(['previewState', 'previewDo', 'animState', 'state', 'move', 'select', 'toggleAll', 'dropOwn', 'measure', 'openMenu', 'closeMenu', 'secretRedraw', 'reconnect', 'focusState',
  // dockable panels D1: verify/probe-dock-tree.js
  'boxes', 'layout', 'dock', 'hide', 'show', 'foldAll', 'drag', 'tabClick', 'gutter', 'gutterRace', 'abortedDrag', 'menuTick', 'menuButton', 'squeeze',
  // dockable panels D3: verify/probe-dock-tree.js
  'presets', 'menuClick', 'menuType',
  // dockable panels D2: floating panels
  'floatDrag', 'floatPress', 'secretField', 'floatSecret',
  // dockable panels D4: collapse, a rail's popover, the keyboard, the settle motion
  'collapse', 'railClick', 'settleProbe', 'dblclick', 'focus', 'focusInto', 'key', 'outsidePress', 'reducedMotion', 'tabMenu',
  // BACKLOG #85: the Pin button; #138: whether a real pointer is over a rail icon
  'pinClick', 'isHovered', 'menuCheck', 'railScroll',
  // BACKLOG #109: verify/probe-rail-drag.js presses a rail icon (click, drag, hold) and releases a drag it left in flight
  'railPress', 'railRelease', 'railPressMove',
  // BACKLOG #85 follow-up: verify/probe-dock-autohide.js puts a wider Interface font on the page (not saved) to check the rail names refit
  'uiFont', 'leanClass', 'focusMode',
  // layout pass L3: verify/probe-git-tree.js
  'gitState', 'gitRefresh', 'gitHover', 'gitPin', 'gitJump', 'gitRerender', 'gitKey', 'gitFocus',
  // Enhancement #46: the drawer's actions, the swing, the tabs' states, and a session's screen
  'gitAct', 'gitMotion', 'gitTabs', 'gitScreen',
  // the Graph view: verify/probe-git-graph.js
  'ggState', 'ggView', 'ggClick', 'ggAct', 'ggKey', 'ggRerender',
  // backlog #39 job 2: verify/probe-docs-drift.js reads the docs-drift list and clicks a note's Dismiss
  'driftState', 'driftDismiss',
  // PR #93: type into the selected tab's own session (the probe's stand-in CLI box)
  'gitTermInput',
  // the repo browser and code reader: verify/probe-repo-browser.js
  'repoProbe',
  // backlog #51: verify/probe-wand.js reads the wand and operates its controls
  'wandState', 'wandClick', 'wandSetField', 'wandDrag', 'wandFocus', 'wandKey',
  // BACKLOG #119 A7: verify/probe-schedules.js reads the Schedules panel and clicks a row
  'schedulesState', 'schedulesClick',
  // backlog #63: verify/probe-resource-panel.js reads the Resources panel and chip, and clicks them
  'resourcesState', 'resourcesClick', 'resourcesChipMenu', 'resourcesHistoryDo',
  // backlog #41: verify/probe-games.js reads the Games panel and operates it
  'gamesState', 'gamesDo',
  // backlog #119 A3: verify/probe-changes-panel.js reads the Changes panel and operates it
  'changesProbe',
  // backlog #120: verify/probe-activity-map.js reads the Map panel and operates it
  'mapState', 'mapDo',
  // backlog #33: verify/probe-ask-panel.js reads the Ask panel and operates it
  'askState', 'askDo', 'explainerState', 'explainerDo',
  // backlog #71: verify/probe-canvas-panel.js reads Claude's panel frame and clicks its controls
  'canvasState', 'canvasClick', 'canvasOverlay', 'canvasMcpBox',
  // backlog #34: verify/probe-video-background.js; #88 + #92: the font and plain-colour actions of verify/probe-fonts-colour.js
  'bgState', 'bgStyle', 'bgMatch', 'fontsState', 'fontsSet', 'fontsSearch', 'fontsPick',
  // backlog #44 + #47: the occupancy banner, confirm and card line, and a probe keystroke / click / turn
  'occState', 'occKey', 'occClick', 'occTurn',
  // backlog #49 + #52: verify/probe-terminal-bar.js
  'barState', 'barScroll', 'barClick', 'barClear', 'barLook', 'barSelection',
  // backlog #42 + #43: verify/probe-shortcuts-page.js reads the shortcuts sheet and drives the bits a real key can't
  'shortcutsState', 'shortcutsDo',
  // backlog #62: verify/probe-lean.js reads lean mode as the page has it
  'leanState',
  // backlog #157: verify/probe-chat-view.js reads the chat view and operates it
  'chatState', 'chatDo']);

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && require('crypto').timingSafeEqual(x, y);
}

const STRIP_ISSUE_ACTIONS = new Set(['read', 'open', 'pick', 'filter', 'submit']);

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
      case 'ctrlClick':
        // #77: a real Ctrl+click on the strip's tab, so the page's own handler runs.
        if (typeof cmd.label !== 'string') return { ok: false, error: 'ctrlClick needs a label' };
        return await api.ctrlClick(cmd.label);
      case 'xClick':
        // Ricardo's look, 2026-10-26: a real plain click on the tab's own x.
        if (typeof cmd.label !== 'string' || cmd.label === '') return { ok: false, error: 'xClick needs a label' };
        return await api.xClick(cmd.label);
      case 'stopClick':
        // #129: a real click on the Stop button the strip's alert line offers on a tab kept because its host wouldn't end.
        return await api.stopClick();
      case 'tabMenu':
        // The tab's right-click menu as built, and one item's own click: a native popup nobody can click.
        if (typeof cmd.label !== 'string' || cmd.label === '') return { ok: false, error: 'tabMenu needs a label' };
        if (cmd.item !== undefined && typeof cmd.item !== 'string') return { ok: false, error: 'tabMenu item must be a label' };
        return await api.tabMenu(cmd.label, cmd.item);
      case 'mouseMove': {
        // BACKLOG #85: a real pointer move over the selected view, so hover is judged by hit-testing and not by a dispatched event.
        const whole = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
        if (!whole(cmd.x) || !whole(cmd.y)) return { ok: false, error: 'mouseMove needs whole-number x and y' };
        return await api.mouseMove(cmd.x, cmd.y);
      }
      case 'mouseClick': {
        const whole = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
        if (!whole(cmd.x) || !whole(cmd.y)) return { ok: false, error: 'mouseClick needs whole-number x and y' };
        return await api.mouseClick(cmd.x, cmd.y);
      }
      case 'mouseWheel': {
        // PR #233 F14: a real wheel event (Ctrl held if asked) over the selected view, so Chromium's own handling of it is what is measured
        const whole = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
        if (!whole(cmd.x) || !whole(cmd.y)) return { ok: false, error: 'mouseWheel needs whole-number x and y' };
        if (!Number.isInteger(cmd.deltaY) || Math.abs(cmd.deltaY) > 2000) return { ok: false, error: 'mouseWheel needs a whole-number deltaY' };
        return await api.mouseWheel(cmd.x, cmd.y, cmd.deltaY, cmd.ctrl === true);
      }
      case 'key': {
        // A synthetic key sent to the SELECTED view: proves before-input-event is wired.
        if (typeof cmd.key !== 'string' || !cmd.key) return { ok: false, error: 'key needs a key' };
        if (cmd.modifiers !== undefined && !Array.isArray(cmd.modifiers)) return { ok: false, error: 'key modifiers must be a list' };
        return await api.key(cmd.key, (cmd.modifiers || []).map(String));
      }
      case 'strip-key': {
        // PR #236 Miguel Y4: a key sent to the STRIP page (the window with no tab open): its shortcuts must bring a tab back.
        if (typeof cmd.key !== 'string' || !cmd.key) return { ok: false, error: 'strip-key needs a key' };
        if (cmd.modifiers !== undefined && !Array.isArray(cmd.modifiers)) return { ok: false, error: 'strip-key modifiers must be a list' };
        return await api.stripKey(cmd.key, (cmd.modifiers || []).map(String));
      }
      case 'screenshot':
        // Only ever a picture: never a path to some other file it could clobber.
        if (typeof cmd.file !== 'string' || !/\.png$/i.test(cmd.file)) return { ok: false, error: 'screenshot needs a .png file' };
        return await api.screenshot(cmd.file);
      // #139 / #160: the Lanes ▾ or + menu as built; `item` clicks that item, `shot` (a .png) is a picture of its items.
      case 'menu':
        if (cmd.which !== 'lanes' && cmd.which !== 'plus') return { ok: false, error: 'menu needs which: lanes or plus' };
        if (cmd.item !== undefined && typeof cmd.item !== 'string') return { ok: false, error: 'menu item must be a label' };
        if (cmd.shot !== undefined && !(typeof cmd.shot === 'string' && /\.png$/i.test(cmd.shot))) return { ok: false, error: 'menu shot needs a .png file' };
        return await api.menu(cmd.which, cmd.item, cmd.shot);
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
      case 'openCreate': return await api.openCreate();
      // BACKLOG #119 A6: the branch form's "From an issue" list, driven through the strip page's own elements (a real click,
      // a real input event, a real submit). A named action and its data, never a string of code.
      case 'stripIssues': {
        if (!STRIP_ISSUE_ACTIONS.has(cmd.action)) return { ok: false, error: 'stripIssues needs read, open, pick, filter or submit' };
        if (cmd.action === 'pick' && !(Number.isInteger(cmd.index) && cmd.index >= 0 && cmd.index < 1000)) return { ok: false, error: 'pick needs a row index' };
        if (cmd.action === 'filter' && !(typeof cmd.text === 'string' && cmd.text.length <= 200)) return { ok: false, error: 'filter needs text' };
        return await api.stripIssues(cmd.action, { index: cmd.index, text: cmd.text });
      }
      // #81: the tab menu's Open side session, without a native popup nobody can click.
      case 'side-open':
        if (typeof cmd.label !== 'string' || cmd.label === '') return { ok: false, error: 'side-open needs a label' };
        return await api.sideOpen(cmd.label);
      // #119 A5: the tab menu's Open shell here, the same way.
      case 'shell-open':
        if (typeof cmd.label !== 'string' || cmd.label === '') return { ok: false, error: 'shell-open needs a label' };
        return await api.shellOpen(cmd.label);
      // #141: a drag of one lane's tab onto another's through the strip page's own handlers; #139: the window's width.
      case 'drag-tab':
        if (typeof cmd.label !== 'string' || cmd.label === '' || typeof cmd.onLabel !== 'string' || cmd.onLabel === '') return { ok: false, error: 'drag-tab needs a label and an onLabel' };
        if (cmd.half !== 'left' && cmd.half !== 'right') return { ok: false, error: 'drag-tab needs half: left or right' };
        return await api.dragTab(cmd.label, cmd.onLabel, cmd.half);
      case 'window-size':
        if (!(Number.isInteger(cmd.width) && cmd.width >= 300 && cmd.width <= 8000)) return { ok: false, error: 'window-size needs a whole width from 300 to 8000' };
        return await api.windowSize(cmd.width);
      // #31: what the window's own `focus` event does, without an OS to hand over focus.
      case 'windowFocus': return await api.windowFocus();
      // #62: the window losing focus, as the OS would (Ricardo's lean video rule reads focus).
      case 'windowBlur': return await api.windowBlur();
      case 'view':
        // Layout pass L1: one of the selected view's NAMED probe actions
        // (renderer.js window.__dockProbe), never a string of code.
        if (typeof cmd.action !== 'string' || !VIEW_PROBE_ACTIONS.has(cmd.action)) {
          return { ok: false, error: 'view needs a known action' };
        }
        return await api.view(cmd.action, cmd.args && typeof cmd.args === 'object' ? cmd.args : {});
      // #71: where Claude's panel is and what its page titled itself, or a real press on it. Never a string of code.
      case 'canvas': {
        if (cmd.action === 'inspect') return await api.canvas('inspect', {});
        const whole = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
        if (cmd.action === 'click' && whole(cmd.x) && whole(cmd.y)) return await api.canvas('click', { x: cmd.x, y: cmd.y });
        return { ok: false, error: 'canvas needs inspect, or click with whole-number x and y' };
      }
      // #119 A4: where the Preview panel's native view is, whether it shows, its address and the title its page set. Inspect only.
      case 'preview':
        if (cmd.action === 'inspect') return await api.preview('inspect');
        // Only ever a picture of the panel's page, as for `screenshot`.
        if (cmd.action === 'shot' && typeof cmd.file === 'string' && /.png$/i.test(cmd.file)) return await api.preview('shot', cmd.file);
        return { ok: false, error: 'preview needs inspect, or shot with a .png file' };
      // #34: the window minimised or restored as the OS would, and the OS's reduced-motion setting
      // emulated -- the two inputs of the background video's play rule a probe can't reach by hand.
      case 'window-state':
        if (cmd.state !== 'minimize' && cmd.state !== 'restore') return { ok: false, error: 'window-state needs minimize or restore' };
        return await api.windowState(cmd.state);
      case 'reduced-motion':
        if (typeof cmd.on !== 'boolean') return { ok: false, error: 'reduced-motion needs true or false' };
        return await api.reducedMotion(cmd.on);
      // `graceful: true` quits the way closing the window does (app.quit(): will-quit runs); without it the probe's hard exit.
      case 'quit': return await api.quit(cmd.graceful === true);
      // The strip's ▾ menu, without a native popup nobody can click.
      case 'background': return await api.background();
      case 'background-stop':
        if (!(Number.isInteger(cmd.port) && cmd.port > 0 && cmd.port < 65536)) return { ok: false, error: 'background-stop needs a port' };
        return await api.backgroundStop(cmd.port);
      case 'background-open':
        if (!(Number.isInteger(cmd.port) && cmd.port > 0 && cmd.port < 65536)) return { ok: false, error: 'background-open needs a port' };
        return await api.backgroundOpen(cmd.port);
      case 'background-stop-all': return await api.backgroundStopAll();
      // BACKLOG #119 A8 (verify/probe-tray.js): the tray icon's state, its click and its menu, and its three switches.
      case 'tray': return await api.tray();
      case 'tray-click': return await api.trayClick();
      case 'tray-image':
        if (typeof cmd.file !== 'string' || !/\.png$/i.test(cmd.file)) return { ok: false, error: 'tray-image needs a .png file' };
        return await api.trayImage(cmd.file);
      case 'tray-menu':
        if (cmd.label !== undefined && typeof cmd.label !== 'string') return { ok: false, error: 'tray-menu label must be text' };
        return await api.trayMenu(cmd.label);
      case 'tray-setting':
        if (!['trayIcon', 'minimiseOnClose', 'startMinimised'].includes(cmd.key) || typeof cmd.value !== 'boolean') {
          return { ok: false, error: 'tray-setting needs a tray key and true or false' };
        }
        return await api.traySetting(cmd.key, cmd.value);
      // The window's own close, as the X does it: the 'close' handler decides whether it hides to the tray or really closes.
      case 'win-close': return await api.winClose();
      // #62: a click on one of the strip's lean controls, as a mouse would press it (only these two buttons).
      case 'strip-lean':
        if (cmd.button !== 'lean-btn' && cmd.button !== 'lean-back') return { ok: false, error: 'strip-lean needs lean-btn or lean-back' };
        return await api.stripLean(cmd.button);
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
  lanesMenuTemplate, plusMenuTemplate,
};
