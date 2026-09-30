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
 *   - `listening` is `true` for a started tab whose host answers and is LEFT
 *     OUT otherwise. Never `false`: a starting host, an unstarted one and a
 *     probe that timed out are all "not known", and the reducer reads `false`
 *     as "confirmed gone". (`merged` is `{}` in this PR, so nothing removes a
 *     folder; PR 3 must tell "refused" from "timed out" before it emits false.)
 *   - A poll that can't list worktrees produces NO observation; one that lists
 *     no dev is ignored by the reducer. Either way every tab stays.
 *   - Absence is never a number: a tab's port and token are null until known.
 */

const lifecycle = require('../host/tab-lifecycle');
const { parsePorcelain, tabWorktrees } = require('../host/worktree-list');
const { normPath, isInside } = require('../host/project-layout');
const tabModel = require('./tab-model');
const tabStatusLib = require('./tab-status');
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
 * The reducer's `listening` map: `true`, keyed by normPath, for every started
 * tab whose host answers. Everything else is left out.
 */
async function captureListening(tabs, isListening) {
  const out = {};
  const started = [...tabs].filter(t => t.started === true && t.starting !== true && Number.isInteger(t.port));
  const answers = await Promise.all(started.map(async (t) => {
    try { return (await isListening(t.port)) === true; } catch { return false; }
  }));
  started.forEach((t, i) => { if (answers[i]) out[t.key] = true; });
  return out;
}

/**
 * The reducer's observation from `git worktree list --porcelain` text, or null
 * when there is no text (git failed): no observation at all.
 */
function buildObservation(porcelain, container, listening) {
  if (typeof porcelain !== 'string') return null;
  return {
    worktrees: tabWorktrees(parsePorcelain(porcelain), container),
    merged: {},
    listening: listening || {},
  };
}

// What a tab says when no port could be found or refused for its folder.
const NO_PORT_ERROR = 'no usable port for this folder';

const noWindowText = (h) => `That session is in another claude-custom (pid ${h.pid}, port ${h.port}) ` +
  'with no window open. Open its project to see it.';

const cleanLock = (s) => (typeof s === 'string' && s ? s : null);

/** What a renderer may say about itself, cut down to the four known fields. */
function sanitizeStatus(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    working: o.working === true,
    needsInput: o.needsInput === true,
    lock: cleanLock(o.lock),
    health: typeof o.health === 'string' && o.health !== '' ? o.health : null,
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
 *   hosts.choosePort(tab)  -> Promise<{ port, action: 'spawn'|'attach' } | null>
 *   hosts.isListening(port)-> Promise<boolean>
 *   hosts.spawn({ tab, port, token })      starts a detached host (may throw)
 *   hosts.wait(port)       -> Promise<boolean>  the host came up
 *   hosts.tokenFor(port)   -> string | null     a RUNNING host's token
 *   hosts.newToken()       -> string
 *   hosts.control({ port, token, msg })    -> Promise<{ ok, reply? , error? }>
 *   hosts.identity({ install, port }), hosts.readToken(install, port)  (planGoTo's)
 *   views.create(tab)      -> view          shows the tab's renderer
 *   views.destroy(tab)
 *   views.send(tab, channel, payload)
 *   views.owns(tab, sender)-> boolean       the view's webContents is `sender`
 *   ui.confirmClose(tab)   -> Promise<boolean>
 *   ui.changed(snapshot)
 *   ui.focusWindow()       restore + show + focus + flash
 *   ui.isFocused()
 *   log(...)
 */
function createShell(deps) {
  const {
    mode = 'tabs', container = null, cwd = null, launchedFrom = null,
    git, hosts, views, ui, log = () => {},
  } = deps;

  const queue = createQueue();
  const tabs = new Map();        // key -> record
  let state = lifecycle.initial();
  let selectedKey = null;
  let polling = false;
  let lastError = null;
  let closeNotice = null;        // a hand close whose stop failed; cleared by the next selection
  let destroyed = false;

  const keyOf = normPath;

  function runtime() {
    const rt = new Map();
    for (const t of tabs.values()) {
      rt.set(t.key, { started: t.started, port: t.port, token: t.token, status: t.status });
    }
    return rt;
  }

  function model() {
    return tabModel.stripModel(state, runtime(), selectedKey, { keyOf }).map((e) => {
      const t = tabs.get(e.key);
      return { ...e, starting: !!(t && t.starting), startError: t ? t.error : null };
    });
  }

  function snapshot() {
    const m = model();
    const sel = m.find(e => e.selected);
    return { model: m, selectedKey: sel ? sel.key : null, tabs: [...tabs.values()], notice: lastError, closeNotice, mode };
  }

  function publish() {
    if (destroyed) return;
    try { ui.changed(snapshot()); } catch (err) { log('[shell] ui.changed threw:', err && err.message); }
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
    };
  }

  // Create the tab's view. The session is running by now (attached or spawned).
  function present(tab, port, token) {
    tab.port = port;
    tab.token = token;
    tab.view = views.create(tab);
    tab.started = true;
  }

  // At open: a tab whose session is ALREADY running gets its view now (its
  // markers should show). One that isn't records nothing and starts nothing.
  function attachIfRunning(tab) {
    return queue.run(async () => {
      if (tab.closed || tab.started || tab.starting || destroyed) return;
      let chosen = null;
      try { chosen = await hosts.choosePort(tab); } catch (err) { log('[shell] port probe failed:', err && err.message); }
      if (!chosen || chosen.action !== 'attach' || tab.closed || tab.started || tab.starting) return;
      const token = hosts.tokenFor(chosen.port);
      if (!token) { log(`[shell] ${tab.key}: a host is on ${chosen.port} but its token can't be read`); return; }
      present(tab, chosen.port, token);
    }).then(publish, publish);
  }

  // First selection: choose the port NOW, spawn if nobody serves this folder,
  // wait for it, then draw. One chain, so two tabs can't take one port.
  function start(tab) {
    if (tab.started) return Promise.resolve();
    if (tab.starting) return tab.startPromise;
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
          // (a loser of the bind no longer touches the token files).
          if (!(await hosts.wait(port))) throw new Error(`the host did not come up on port ${port} in time`);
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
        if (key === selectedKey) {
          selectedKey = tabModel.afterClose(before, key, selectedKey);
          reselect = true;
        }
      } else if (a.type === 'error') {
        const t = tabByKey(key);
        if (t) t.error = a.error;
      }
      // 'mark-merged' and 'remove' need `merged`, which is always {} in this PR.
    }
    if (reselect && selectedKey !== null) select(selectedKey);
    publish();
  }

  function reconcileWith(observation) {
    const before = model();
    const { state: next, actions } = lifecycle.reconcile(state, observation);
    state = next;
    apply(actions, before);
    if (selectedKey === null || !tabs.has(selectedKey)) {
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
      // Captured now, reconciled now, in this order, before the next poll starts.
      const listening = await captureListening(tabs.values(), hosts.isListening);
      const obs = buildObservation(text, container, listening);
      if (obs) reconcileWith(obs);
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
    const label = (model().find(e => e.key === key) || {}).label || tab.branch || tab.cwd;
    let target = null;
    if (tab.started && tab.port && tab.token) target = { port: tab.port, token: tab.token };
    else if (tab.pending) target = { port: tab.pending.port, token: tab.pending.token };
    const before = model();
    const { state: next, actions } = lifecycle.closeByHand(state, tab.cwd);
    state = next;
    // The stop is sent here, where its outcome can be seen, not fire-and-forget.
    apply(actions.filter(a => a.type !== 'stop'), before);
    if (!target) return { ok: true };
    let failure = null;
    try {
      const r = await hosts.control({ ...target, msg: { type: 'stop' } });
      if (!r || r.ok !== true) failure = (r && r.error) || 'no answer';
    } catch (err) {
      failure = (err && err.message) || String(err);
    }
    if (failure !== null) {
      closeNotice = `Couldn't end the session in ${label}: ${failure}. It may still be running.`;
      log(`[shell] ${key}: ${closeNotice}`);
      publish();
      return { ok: true, stopError: failure };
    }
    log(`[shell] stop ${key}: sent`);
    return { ok: true };
  }

  /** A renderer's own status. Kept as-is except: you're looking at it. */
  function report(sender, status) {
    const tab = tabForSender(sender);
    if (!tab) return false;
    let next = sanitizeStatus(status);
    if (next.needsInput && tab.key === selectedKey && ui.isFocused()) {
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
    return next === null ? Promise.resolve() : select(next);
  }

  /** view query: which close button the blocked pane offers. */
  function tabmodeOf(tab) {
    if (mode === 'single') return 'single';
    return tab.isDev ? 'dev' : 'tab';
  }

  function destroy() { destroyed = true; }

  return {
    open, poll, select, closeTab, report, raise, attentionClick, goTo, menuState, override,
    next: () => step(1), previous: () => step(-1),
    isTabView, tabForSender, tabByKey, tabmodeOf, snapshot, model, destroy,
    // Exposed for tests and the probe driver.
    _tabs: tabs, _state: () => state,
  };
}

// --- keyboard focus ----------------------------------------------------------------

/**
 * Should main give the keyboard to the selected tab's view now? Dexter F4 /
 * Miguel M1, PR #75: keyed on a CHANGED SELECTION, a view created for a tab
 * that was already selected (first launch, Ctrl+Tab onto an unstarted tab)
 * never got focus, and keystrokes went to the strip. Keyed on the VIEW
 * instead: focus it when the window is focused and it is not the view that
 * last received focus. A non-selected tab presenting changes nothing here,
 * because only the selected tab's view is ever passed in.
 */
function viewToFocus({ windowFocused, selectedView, lastFocused } = {}) {
  return windowFocused === true && !!selectedView && selectedView !== lastFocused;
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
  if (!input.control || input.alt) return null;
  if (key === 'tab') return input.shift ? 'prev-tab' : 'next-tab';
  if (key === 'i' && input.shift) return 'devtools';
  return null;
}

// --- the probe driver's command handling ----------------------------------------

/**
 * One line of newline-JSON from the probe -> a reply object. NEVER throws.
 * `api` is main's: { state, select(label), close(label), screenshot(file),
 * quit() }. Anything else is refused by name, so a typo in the probe is a
 * failure it can see rather than a command that silently did nothing.
 */
async function handleProbeCommand(line, api) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return { ok: false, error: 'not JSON' }; }
  if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') return { ok: false, error: 'no cmd' };
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
        if (typeof cmd.file !== 'string' || !cmd.file) return { ok: false, error: 'screenshot needs a file' };
        return await api.screenshot(cmd.file);
      case 'quit': return await api.quit();
      default: return { ok: false, error: `unknown command: ${cmd.cmd}` };
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  createShell, createQueue, captureListening, buildObservation, sanitizeStatus,
  handleProbeCommand, noWindowText, shortcutFor, viewToFocus, NO_PORT_ERROR,
};
