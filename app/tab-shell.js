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
const programStatusDisplay = require('./program-status-display');
const tabStatusLib = require('./tab-status');
const occupancyDisplay = require('./occupancy-display');
const { closeReason } = require('../host/close-safety');
const summaryDisplay = require('./summary-display');
const { planGoTo } = require('./go-to-session');
const { sideKeyOf, parentKeyOf, isSideKey, sideLabel } = require('../host/side-session');
// #119 A5: a branch tab's plain shell, a tab of the same kind of its own (host/shell-tab.js).
const { shellKeyOf, parentKeyOfShell, isShellKey, shellLabel } = require('../host/shell-tab');

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
 *   hosts.spawn({ tab, port, token })      starts a detached host (may throw)
 *   hosts.wait(port)       -> Promise<boolean>  the host came up
 *   hosts.tokenFor(port)   -> string | null     a RUNNING host's token
 *   hosts.tokenFile(port)  -> string | null     ONLY `hosts/<port>.token`: written by
 *                                               the host that won the bind, and nobody else
 *   hosts.newToken()       -> string
 *   hosts.control({ port, token, msg })    -> Promise<{ ok, reply? , error? }>
 *   hosts.identity({ install, port }), hosts.readToken(install, port)  (planGoTo's)
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
  const briefHolds = new Set();        // keys whose lane brief (#119 A6) is still being written: no session starts before it
  const setups = new Map();            // key -> { running, line, error, log }  (Contract E)
  const createdWarnings = new Map();   // key -> Contract A's optional warning
  const issueTabs = new Map();         // key -> { number, title, url }: the issue a tab's lane was started from (#119 A6)
  let selectWhenListed = null;        // a tab to select as soon as a poll lists it
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
    const base = tabModel.stripModel(state, runtime(), sideSelected ? companionParentOf(sideSelected) : selectedKey, { keyOf });
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
      // A close of its own (Ricardo's look, 2026-10-26): it is a terminal, not a reader of its lane. A develop tab never closes, so
      // ending only with its branch tab left that lane's shell no way to end at all.
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
        badge: tabModel.badgeFor(e),
        phaseText: t && t.ended === true && e.side === true ? SIDE_ENDED_TEXT
          : t && t.ended === true && e.shell === true ? SHELL_ENDED_TEXT : tabModel.phaseText(e),
        mark: readMark(branchOf(e.key)),
        // #119 A6: the GitHub issue this lane was started from ({ number, title, url } or null).
        issue: isCompanionEntry(e) ? null : issueOf(e.key),
        // #119 A6: this tab's lane brief is being written, and its session waits for it.
        briefing: !isCompanionEntry(e) && briefHolds.has(e.key),
        // #63: the CPU warning chip ({ pct, level } or null).
        resourceWarn: readResourceWarn(e.key),
        // #44 + #47: the hatched edge. The warning is this tab's OWN reported turn, nothing guessed.
        occupancy: occupancyDisplay.tabOccupancy(claims, e.key, { keyOf, turn: t && t.status ? t.status.turn : null, now: at }),
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
            // a side tab closed meanwhile: dropSide ran before this host was recorded, so it is stopped here (Dexter 4)
            if (tab.closed && isCompanionEntry(tab)) tab.closeStop = stopOutcome(hosts.control({ port, token, msg: { type: 'stop' } }));
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
          if (spawned || isCompanionEntry(tab)) tab.closeStop = stopOutcome(hosts.control({ port, token, msg: { type: 'stop' } }));
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
    let sideList;           // the side hosts the identity files list, read at most once per batch of actions (Miguel Y2)
    let shellList;          // ... and the shell hosts (#119 A5), the same way
    for (const a of actions) {
      const key = keyOf(a.path);
      if (a.type === 'open') {
        if (tabs.has(key)) continue;
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
          selectedKey = tabModel.afterClose(before.filter(e => e.parentKey !== key), key, key);
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
    try { return safety.readerUnsaved(tab); } catch (err) {
      log('[shell] safety.readerUnsaved threw:', err && err.message);
      return null;
    }
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
    if (closing.has(key)) return { ok: false, error: 'already closing' };
    closing.add(key);
    try { return await (isShellKey(key) || isSideKey(key) ? closeCompanionOnce(key) : closeTabOnce(key, opts)); } finally { closing.delete(key); }
  }
  /**
   * Hand close: confirm, then the reducer's `stop` + `close`. Nothing on disk. `ifSafe` (Ctrl+click, #77)
   * skips the confirm when unsafeReason is empty; otherwise the confirm is told why.
   */
  async function closeTabOnce(key, { ifSafe = false } = {}) {
    const tab = tabByKey(key);
    if (!tab || tab.isDev || mode !== 'tabs') return { ok: false, error: 'not closable' };
    const phaseNow = (state.tabs.find(t => keyOf(t.path) === key) || {}).phase;
    if (phaseNow === 'removing') return { ok: false, error: 'its folder is being removed' };   // Dexter F4
    let yes = false;
    let reason = '';
    let silent = false;
    let gitFacts = null;
    if (ifSafe === true) {
      gitFacts = await gitFactsOf(tab);
      reason = closeReason(closeFactsOf(tab, gitFacts));
    }
    if (ifSafe === true && reason === '') { yes = true; silent = true; } else {
      try { yes = (await ui.confirmClose(tab, ifSafe === true ? { reason } : undefined)) === true; } catch { yes = false; }
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
    // Dexter D6: the silent close was licensed some awaits ago. Re-read what is cheap (the marker, the claims, the
    // session) right before the stop; if any of it changed, ask after all.
    if (silent) {
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
    // #119 A5: a Shell tab for the SELECTED lane (or, with its side or shell tab showing, that tab's lane).
    const lane = companionParentOf(selectedKey) || selectedKey;
    const sm = shellMenu(lane);
    const shell = sm.label === 'Open shell here' ? { ...sm, label: 'Shell tab' } : sm;
    return { create: { enabled: why === null, why }, reopen: mode === 'tabs' ? reopenable() : [], shell };
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
      const target = t.started && t.port && t.token ? { port: t.port, token: t.token } : (t.pending || null);
      if (target) {
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

  /**
   * End a side or shell tab's host and wait for its answer: why it may still be running, or null. Closed first, so a start still in
   * its port walk gives up before it spawns; then the start is let settle, so what it made or found is on the record when it is
   * stopped (R2-2). The remover must not start with a claude about to appear in the folder. The host's stop is its own teardown: the
   * pty tree killed by pid (host/pty-stop.js, host/kill-tree.js) and its identity file removed. An ended record is sent nothing: its
   * host is gone, and its port may be another host's by now.
   */
  async function stopCompanion(t) {
    t.closed = true;
    if (t.starting && t.startPromise) { try { await t.startPromise; } catch { /* start() reports its own errors */ } }
    // A start that gave up because this tab closed has already sent the stop to the host it made or found: wait for THAT one and
    // report how it went (Dexter F3, PR #214), rather than saying closed about a stop nobody looked at.
    if (t.closeStop) return await t.closeStop;
    const target = t.started && t.port && t.token ? (t.ended === true ? null : { port: t.port, token: t.token }) : (t.pending || null);
    if (!target) return null;
    return stopOutcome(hosts.control({ port: target.port, token: target.token, msg: { type: 'stop' } }));
  }

  /**
   * A shell or side tab closed by hand (Ricardo's look, 2026-10-26): its x, a Ctrl+click, the menu's Close shell / Close side
   * session, or a shell page's own close. Nothing asks: a shell is a terminal, a side session is a reader that can write nothing
   * (the work is in the branch tab), and the folder stays. Only this tab's own host is stopped, never its branch tab's. Reopen
   * doesn't offer it back (Open shell here / Open side session starts a fresh one). If it was showing, its own branch tab shows next.
   */
  async function closeCompanionOnce(key) {
    const t = tabs.get(key);
    const noun = companionNounOf(key);
    if (!t || noun === null || mode !== 'tabs') return { ok: false, error: 'not closable' };
    // A side tab's code reader is a full editor (Dexter F1, PR #214): an unsaved edit in it asks, exactly as a branch tab's close
    // does (the question names the file). Nothing unsaved, nothing asked. A shell has no reader.
    if (isSideKey(key) && readerUnsavedOf(t)) {
      let yes = false;
      try { yes = (await ui.confirmClose(t)) === true; } catch { yes = false; }
      if (!yes) return { ok: false, cancelled: true };
      if (tabs.get(key) !== t) return { ok: true };     // gone while the dialog was up
    }
    const failure = await stopCompanion(t);
    if (tabs.get(key) !== t) return { ok: true };     // gone meanwhile (its branch tab closed, or its folder was removed), or the key is a newer tab's now (Dexter F4)
    const showing = selectedKey === key;
    dropSide(key, { stop: false });
    const parentKey = companionParentOf(key);
    if (showing && tabs.has(parentKey)) select(parentKey);     // a start it needs reports its own errors
    else publish();
    if (failure !== null) {
      closeNotice = `Couldn't end the ${noun} in ${t.branch}: ${failure}. It may still be running.`;
      log(`[shell] ${key}: ${closeNotice}`);
      publish();
      return { ok: true, stopError: failure };
    }
    log(`[shell] closed ${key}`);
    return { ok: true };
  }

  function destroy() { destroyed = true; }

  return {
    open, poll, select: userSelect, closeTab, report, raise, attentionClick, goTo, selectFolder, tabStates, typeMerged, typed, menuState, override,
    createWorktree, openCreate, cancelCreate, openPicker, closePicker, plusMenu, reopen, looked, openSide, sideMenu, openShell, shellMenu, issueOf,
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
const VIEW_PROBE_ACTIONS = new Set(['animState', 'state', 'move', 'select', 'toggleAll', 'dropOwn', 'measure', 'openMenu', 'closeMenu', 'secretRedraw', 'reconnect', 'focusState',
  // dockable panels D1: verify/probe-dock-tree.js
  'boxes', 'layout', 'dock', 'hide', 'show', 'foldAll', 'drag', 'tabClick', 'gutter', 'gutterRace', 'abortedDrag', 'menuTick', 'menuButton', 'squeeze',
  // dockable panels D3: verify/probe-dock-tree.js
  'presets', 'menuClick', 'menuType',
  // dockable panels D2: floating panels
  'floatDrag', 'floatPress', 'secretField', 'floatSecret',
  // dockable panels D4: collapse, a rail's popover, the keyboard, the settle motion
  'collapse', 'railClick', 'settleProbe', 'dblclick', 'focus', 'key', 'outsidePress', 'reducedMotion', 'tabMenu',
  // BACKLOG #85: the dock rail's hover and the Pin button
  'hover', 'pinClick', 'menuCheck', 'railScroll',
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
  'leanState']);

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
};
