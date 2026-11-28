'use strict';
/**
 * Jiandu Home's main-side logic (documentation/DESIGN_PROJECT_HUB.md §2-3; plan documentation/PLAN_PROJECT_HUB.md H-PR2). No Electron:
 * main hands in every fact and effect, so each path is behaviour under plain node (app/app-lifecycle.js is the model).
 *
 *   createHomeController(deps) -> { sync(), syncSoon(), refresh({ force }), act(msg), model(), closed() }
 *     sync()      build the cards (app/home-model.js homeCards) from the record, the cached recents, the windows and the cached windowless
 *                 sessions, and push the page its payload. Main calls it at every shell change (windowsChanged).
 *     syncSoon()  sync() once in the next turn, however many times it is asked in this one (`defer`, setImmediate). Main calls it at the
 *                 tray's other sync moment, every strip push, so "needs you" and the tab counts are live (PR #263 Miguel Y1).
 *     refresh()   read Claude Code's recents and the windowless sessions again when they are older than RECENTS_MAX_AGE_MS (or `force`);
 *                 then sync(). The windowless read starts a powershell, so it is never on a 30 s beat (Miguel G2). One refresh in flight
 *                 is shared; a forced one asked during an unforced one runs after it (Miguel G3). A failed read keeps the last list.
 *                 A read whose lists differ from the last, or a forced one, calls onSourcesChanged() (main clears its cached disk facts:
 *                 app/home-paths.js, Miguel Y2).
 *     act(msg)    one ask from the page, validated here (the page decides nothing): { action, key, lane?, text? }
 *                   filter        { text } at most 200 characters: filterCards on the LAST built list, no rebuild (Miguel G3)
 *                   choose-folder no key: the folder dialog, then the open path
 *                   lane          { key, lane }: the lane must be one of that card's lanes, by the exact path main sent (no disk call
 *                                 on page input: Miguel G8); opens the lane's folder
 *                   any other     the key must be a card's (ALL the cards, not only the shown ones) and the card must offer it
 *                   stop-sessions { key, confirmed: true } (H-PR3, H8): a windowless card only, and only the card's second click;
 *                                 host/stop-folder.js on the card's root -> a Promise of { ok, stopped, kept, error? }
 *                   new-lane      { key, branch } (H-PR3): checkBranch first (no git call for a bad name), then the strip's + in
 *                                 the project's window -> a Promise of { ok: true, branch } | { ok: false, error }
 *                 -> { ok: true } | { ok: false, error }. A pin or remove the record refused (it answers null) is
 *                 { ok: false, error: 'the record was not written' } (PR #263 Miguel Y3).
 *     model()     the last payload (built now if none was).
 *     closed()    the Home window closed: its filter goes, so a new Home shows every card under an empty box (PR #263 Dexter 1).
 *
 *   pagePayload(model, filter, now) -> { cards, summary, filter, empty, now }: the shown cards with only the wired actions
 *   (WIRED_ACTIONS), `empty` the empty-state line or null.
 *   windowFacts(projectWindows, needsYouKeys) -> the model's windows: each LIVE project window's tabs, needs and lanes. A registered
 *   window whose BrowserWindow is gone is left out, so its card is closed and offers Open (PR #263 Dexter 8).
 *
 * The record is read with readFresh(): a read that failed just now (EBUSY / EPERM) keeps the last good record, so one bad read never
 * flips the pins and the order (PR #262 Dexter 5).
 *
 * deps: record { readFresh, pin, remove } (app/home-record.js), readRecents() -> Promise<list | null>, windows() -> the model's windows,
 * windowless() -> Promise<[{ cwd }]>, projectOf, exists, keyOf, labelOf, push(payload), effects { open(cwd), goTo(root),
 * closeWindow(root), showInExplorer(root), chooseFolder(), stopSessions(root) -> Promise<{ stopped, kept, late, verified, texts }>,
 * newLane(root, branch) -> Promise<{ ok, branch } | { ok: false, error }> }, now(), log; optional defer(fn), onSourcesChanged().
 */

const path = require('path');
const { homeCards, filterCards } = require('./home-model');
const { checkBranch } = require('../host/worktree-ops');

const RECENTS_MAX_AGE_MS = 60_000;
const MAX_FILTER = 200;
const EMPTY_TEXT = 'No projects yet. Choose a folder to open one.';
const WIRED_ACTIONS = Object.freeze(['open', 'go-to', 'close-window', 'pin', 'unpin', 'remove', 'show-in-explorer', 'stop-sessions', 'new-lane']);
const NOT_WRITTEN = 'the record was not written';
const MAX_BRANCH = 120;
const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const errText = (err) => String((err && err.message) || err);
const EMPTY_RECORD = () => ({ projects: [], pins: [], removed: [] });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function pagePayload(model, filter, now) {
  const all = model && Array.isArray(model.cards) ? model.cards : [];
  const shown = filterCards(all, filter);
  const summary = { ...(model && model.summary), shown: shown.length };
  const text = typeof filter === 'string' ? filter : '';
  let empty = null;
  if (all.length === 0) empty = EMPTY_TEXT;
  else if (shown.length === 0) empty = `No project matches "${text.trim()}".`;
  const cards = shown.map((c) => ({
    key: c.key, root: c.root, label: c.label, pinned: c.pinned, state: c.state, tabs: c.tabs, needs: c.needs, sessions: c.sessions,
    lastUsed: c.lastUsed, lanes: c.lanes, actions: c.actions.filter((a) => WIRED_ACTIONS.includes(a)),
  }));
  return { cards, summary, filter: text, empty, now };
}

/** What a project window tells Home: its tabs, how many need you, and its lanes (the tabs of its worktrees, not side or shell tabs). */
function windowFacts(projectWindows, needsYouKeys) {
  const out = [];
  for (const p of Array.isArray(projectWindows) ? projectWindows : []) {
    if (!p || !p.win || typeof p.win.isDestroyed !== 'function' || p.win.isDestroyed()) continue;
    const tabs = p.tabShell ? p.tabShell.snapshot().tabs : [];
    const needing = new Set(needsYouKeys(tabs));
    const lanes = tabs.filter((t) => t && typeof t.cwd === 'string' && t.cwd && t.side !== true && t.shell !== true)
      .map((t) => ({ key: t.key, label: typeof t.branch === 'string' && t.branch ? t.branch : path.basename(t.cwd), path: t.cwd, needs: needing.has(t.key) }));
    out.push({ root: p.root, label: p.label, tabs: tabs.length, needs: needing.size, lanes });
  }
  return out;
}

const pathsOf = (list, field) => JSON.stringify((Array.isArray(list) ? list : []).map((x) => (isObj(x) ? x[field] : null)));

function createHomeController(deps) {
  const { record, readRecents, windows, windowless, projectOf, exists, keyOf, labelOf, push, effects } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const defer = deps.defer || ((fn) => setImmediate(fn));
  const sourcesChanged = () => { try { if (typeof deps.onSourcesChanged === 'function') deps.onSourcesChanged(); } catch (err) { log(`[main] home: onSourcesChanged threw: ${err && err.message}`); } };
  let lastGood = null;
  let recents = null;
  let recentsAt = null;
  let sessions = [];
  let sessionsAt = null;
  let built = null;            // { cards, summary } with no filter: what every key is checked against
  let filter = '';
  let payload = null;
  let inFlight = null;
  let inFlightForced = false;
  let again = null;            // a forced refresh waiting for an unforced one in flight (Miguel G3)
  let soon = false;

  function readRecord() {
    let r = null;
    try { r = record.readFresh(); } catch { r = null; }
    if (r !== null && isObj(r)) lastGood = r;
    return lastGood || EMPTY_RECORD();
  }

  function build() {
    let wins = [];
    try { wins = windows(); } catch (err) { log(`[main] home: could not list the windows: ${err && err.message}`); }
    built = homeCards({ record: readRecord(), recents, windows: wins, windowless: sessions, filter: '', projectOf, exists, keyOf, labelOf });
    return built;
  }

  function publish() {
    payload = pagePayload(built, filter, now());
    try { push(payload); } catch (err) { log(`[main] home: the push failed: ${err && err.message}`); }
    return payload;
  }

  function sync() {
    build();
    return publish();
  }

  function syncSoon() {
    if (soon) return;
    soon = true;
    defer(() => {
      soon = false;
      try { sync(); } catch (err) { log(`[main] home: a sync failed: ${err && err.message}`); }
    });
  }

  const stale = (at) => at === null || now() - at >= RECENTS_MAX_AGE_MS;

  function refresh({ force = false } = {}) {
    if (inFlight) {
      if (!force || inFlightForced) return inFlight;
      if (!again) again = inFlight.then(() => { again = null; return refresh({ force: true }); });
      return again;
    }
    inFlightForced = force === true;
    inFlight = (async () => {
      const before = pathsOf(recents, 'path') + pathsOf(sessions, 'cwd');
      const reads = [];
      if (force || stale(recentsAt)) {
        reads.push(Promise.resolve().then(readRecents).then((r) => {
          if (Array.isArray(r)) { recents = r; recentsAt = now(); }
        }, (err) => log(`[main] home: the recents read failed: ${err && err.message}`)));
      }
      if (force || stale(sessionsAt)) {
        reads.push(Promise.resolve().then(windowless).then((w) => { if (Array.isArray(w)) { sessions = w; sessionsAt = now(); } },
          (err) => log(`[main] home: the windowless sessions read failed: ${err && err.message}`)));
      }
      await Promise.all(reads);
      if (force || pathsOf(recents, 'path') + pathsOf(sessions, 'cwd') !== before) sourcesChanged();
      sync();
    })().finally(() => { inFlight = null; inFlightForced = false; });
    return inFlight;
  }

  const run = (fn) => {
    try { return fn() === false ? { ok: false, error: NOT_WRITTEN } : { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  };
  // a record edit answers null when the store refused it (busy lock, damaged or newer file): that is no success (Miguel Y3)
  const edited = (r) => { sync(); return r !== null && r !== undefined; };

  function act(msg) {
    if (!isObj(msg) || typeof msg.action !== 'string') return { ok: false, error: 'not an act' };
    const { action } = msg;
    if (action === 'filter') {
      if (typeof msg.text !== 'string' || msg.text.length > MAX_FILTER) return { ok: false, error: 'a filter is text' };
      filter = msg.text;
      if (!built) build();
      publish();
      return { ok: true };
    }
    if (action === 'choose-folder') return run(() => { effects.chooseFolder(); });
    if (typeof msg.key !== 'string') return { ok: false, error: 'no card key' };
    if (!built) build();
    const card = built.cards.find((c) => c.key === msg.key);
    if (!card) return { ok: false, error: 'no such card' };
    if (action === 'lane') {
      const lane = typeof msg.lane === 'string' ? card.lanes.find((l) => l.path === msg.lane) : null;
      if (!lane) return { ok: false, error: 'no such lane' };
      return run(() => { effects.open(lane.path); });
    }
    if (!WIRED_ACTIONS.includes(action) || !card.actions.includes(action)) return { ok: false, error: `that card does not offer ${action}` };
    switch (action) {
      case 'open': return run(() => { effects.open(card.root); });
      case 'go-to': return run(() => { effects.goTo(card.root); });
      case 'close-window': return run(() => { effects.closeWindow(card.root); });
      case 'show-in-explorer': return run(() => { effects.showInExplorer(card.root); });
      case 'pin': case 'unpin': return run(() => edited(record.pin(card.root, action === 'pin')));
      case 'remove': return run(() => edited(record.remove(card.root)));
      case 'stop-sessions': return stopSessions(card, msg);
      case 'new-lane': return newLane(card, msg);
      default: return { ok: false, error: `that card does not offer ${action}` };
    }
  }

  // H8: the card asks first ("Stop 2 sessions in viral? Stop / Cancel"); main refuses an ask that is not the second click, so no
  // page bug can stop a session on one click. The stop is host/stop-folder.js's, as `claude-custom <folder> --stop` runs it. Only
  // a stop that ended every session, with every session checked, is ok; anything else says why, with the count that did stop.
  async function stopSessions(card, msg) {
    if (msg.confirmed !== true) return { ok: false, error: 'a stop needs its second click' };
    let rep;
    try { rep = await effects.stopSessions(card.root); } catch (err) { return { ok: false, stopped: 0, kept: 0, error: errText(err) }; }
    refresh({ force: true }).catch(() => {});
    if (!isObj(rep) || !isCount(rep.stopped) || !isCount(rep.kept) || !isCount(rep.late)) {
      return { ok: false, stopped: 0, kept: 0, error: 'the stop gave no answer' };
    }
    const kept = rep.kept + rep.late;
    const texts = Array.isArray(rep.texts) ? rep.texts.filter((s) => typeof s === 'string' && s) : [];
    let error = null;
    if (rep.kept > 0) error = texts[0] || 'a session could not be stopped';
    else if (rep.late > 0) error = 'sessions kept starting while others were stopped; stop again';
    else if (rep.verified !== true) error = 'not every session could be checked, so one may still run';
    await inFlightDone();
    return error === null ? { ok: true, stopped: rep.stopped, kept } : { ok: false, stopped: rep.stopped, kept, error };
  }

  // New lane: the strip's + (app/tab-shell.js createWorktree: Contract A, then setup, then the lane's tab) in the project's window,
  // which opens if it was not. The name is checked here first (host/worktree-ops.js checkBranch), so a bad one makes no git call.
  async function newLane(card, msg) {
    if (typeof msg.branch !== 'string') return { ok: false, error: checkBranch('') };
    const branch = msg.branch.trim();
    if (branch.length > MAX_BRANCH) return { ok: false, error: `a branch name is at most ${MAX_BRANCH} characters` };
    const bad = checkBranch(branch);
    if (bad) return { ok: false, error: bad };
    let r;
    try { r = await effects.newLane(card.root, branch); } catch (err) { return { ok: false, error: errText(err) }; }
    if (!isObj(r) || r.ok !== true) return { ok: false, error: isObj(r) && typeof r.error === 'string' && r.error ? r.error : 'the lane was not made' };
    return { ok: true, branch: typeof r.branch === 'string' && r.branch ? r.branch : branch };
  }

  // the refresh a stop started has pushed its cards before the stop answers, so the page's note lands on the fresh card
  const inFlightDone = () => (inFlight ? inFlight.catch(() => {}) : Promise.resolve());

  function model() {
    if (payload) return payload;
    build();
    return pagePayload(built, filter, now());
  }

  function closed() {
    filter = '';
    payload = null;
  }

  return { sync, syncSoon, refresh, act, model, closed };
}

module.exports = { createHomeController, pagePayload, windowFacts, EMPTY_TEXT, WIRED_ACTIONS, RECENTS_MAX_AGE_MS, MAX_FILTER, NOT_WRITTEN };
