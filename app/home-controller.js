'use strict';
/**
 * Jiandu Home's main-side logic (documentation/DESIGN_PROJECT_HUB.md §2-3; plan documentation/PLAN_PROJECT_HUB.md H-PR2). No Electron:
 * main hands in every fact and effect, so each path is behaviour under plain node (app/app-lifecycle.js is the model).
 *
 *   createHomeController(deps) -> { sync(), refresh({ force }), act(msg), model() }
 *     sync()      build the cards (app/home-model.js homeCards) from the record, the cached recents, the windows and the cached windowless
 *                 sessions, and push the page its payload. Main calls it at every shell change (windowsChanged, the tray's sync moment).
 *     refresh()   read Claude Code's recents again when the cache is older than RECENTS_MAX_AGE_MS (or `force`), and the windowless
 *                 sessions each time; then sync(). One refresh in flight is shared. A failed read keeps the last list.
 *     act(msg)    one ask from the page, validated here (the page decides nothing): { action, key, lane?, text? }
 *                   filter        { text } at most 200 characters: filterCards on the LAST built list, no rebuild (Miguel G3)
 *                   choose-folder no key: the folder dialog, then the open path
 *                   lane          { key, lane }: the lane must be one of that card's lanes; opens the lane's folder
 *                   any other     the key must be a card's (ALL the cards, not only the shown ones) and the card must offer it
 *                 -> { ok: true } | { ok: false, error }
 *     model()     the last payload (built now if none was).
 *
 *   pagePayload(model, filter, now) -> { cards, summary, filter, empty, now }: the shown cards with only the actions this PR wires
 *   (H_PR2_ACTIONS: Stop its sessions and New lane come with H-PR3), `empty` the empty-state line or null.
 *
 * The record is read with readFresh(): a read that failed just now (EBUSY / EPERM) keeps the last good record, so one bad read never
 * flips the pins and the order (PR #262 Dexter 5).
 *
 * deps: record { readFresh, pin, remove } (app/home-record.js), readRecents() -> Promise<list | null>, windows() -> the model's windows,
 * windowless() -> Promise<[{ cwd }]>, projectOf, exists, keyOf, labelOf, push(payload), effects { open(cwd), goTo(root),
 * closeWindow(root), showInExplorer(root), chooseFolder() }, now(), log.
 */

const { homeCards, filterCards } = require('./home-model');

const RECENTS_MAX_AGE_MS = 60_000;
const MAX_FILTER = 200;
const EMPTY_TEXT = 'No projects yet. Choose a folder to open one.';
const H_PR2_ACTIONS = Object.freeze(['open', 'go-to', 'close-window', 'pin', 'unpin', 'remove', 'show-in-explorer']);
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
    lastUsed: c.lastUsed, lanes: c.lanes, actions: c.actions.filter((a) => H_PR2_ACTIONS.includes(a)),
  }));
  return { cards, summary, filter: text, empty, now };
}

function createHomeController(deps) {
  const { record, readRecents, windows, windowless, projectOf, exists, keyOf, labelOf, push, effects } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  let lastGood = null;
  let recents = null;
  let recentsAt = null;
  let sessions = [];
  let built = null;            // { cards, summary } with no filter: what every key is checked against
  let filter = '';
  let payload = null;
  let inFlight = null;

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

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const stale = recentsAt === null || now() - recentsAt >= RECENTS_MAX_AGE_MS;
      const reads = [];
      if (force || stale) {
        reads.push(Promise.resolve().then(readRecents).then((r) => {
          if (Array.isArray(r)) { recents = r; recentsAt = now(); }
        }, (err) => log(`[main] home: the recents read failed: ${err && err.message}`)));
      }
      reads.push(Promise.resolve().then(windowless).then((w) => { if (Array.isArray(w)) sessions = w; },
        (err) => log(`[main] home: the windowless sessions read failed: ${err && err.message}`)));
      await Promise.all(reads);
      sync();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  const run = (fn) => {
    try { fn(); return { ok: true }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  };

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
    if (action === 'choose-folder') return run(() => effects.chooseFolder());
    if (typeof msg.key !== 'string') return { ok: false, error: 'no card key' };
    if (!built) build();
    const card = built.cards.find((c) => c.key === msg.key);
    if (!card) return { ok: false, error: 'no such card' };
    if (action === 'lane') {
      const want = typeof msg.lane === 'string' ? keyOf(msg.lane) : null;
      const lane = want === null ? null : card.lanes.find((l) => keyOf(l.path) === want);
      if (!lane) return { ok: false, error: 'no such lane' };
      return run(() => effects.open(lane.path));
    }
    if (!H_PR2_ACTIONS.includes(action) || !card.actions.includes(action)) return { ok: false, error: `that card does not offer ${action}` };
    switch (action) {
      case 'open': return run(() => effects.open(card.root));
      case 'go-to': return run(() => effects.goTo(card.root));
      case 'close-window': return run(() => effects.closeWindow(card.root));
      case 'show-in-explorer': return run(() => effects.showInExplorer(card.root));
      case 'pin': case 'unpin': return run(() => { record.pin(card.root, action === 'pin'); sync(); });
      case 'remove': return run(() => { record.remove(card.root); sync(); });
      default: return { ok: false, error: `that card does not offer ${action}` };
    }
  }

  function model() {
    if (payload) return payload;
    build();
    return pagePayload(built, filter, now());
  }

  return { sync, refresh, act, model };
}

module.exports = { createHomeController, pagePayload, EMPTY_TEXT, H_PR2_ACTIONS, RECENTS_MAX_AGE_MS, MAX_FILTER };
