'use strict';
/**
 * Jiandu Home's two effects with side effects on sessions and worktrees (plan documentation/PLAN_PROJECT_HUB.md H-PR3), out of
 * app/main.js so each branch is behaviour under plain node (PR #265 Miguel Y1). No Electron: main hands in every dep.
 *
 *   selectRows(key, rows, { projectOf, keyOf }) -> the rows of card `key`: windowless (`windows === 0`, a real zero) and whose CWD's
 *       project root is that card's (app/home-model.js sessionKeyOf, the SAME rule the card counts by). Never the row's install: a
 *       claude-custom root holds every build, and a build's sessions work in other projects (PR #265 Dexter 1 / Miguel B1, the trap
 *       app/background-menu.js stopAllOf names). Never by folder containment: a card whose folder holds other projects owns none of
 *       their sessions (Dexter 2).
 *   createHomeActions(deps) -> { ask(key), stop(key, token), busy(key), newLane(root, branch) }
 *     ask(key)          a fresh read; the card's rows now -> { ok: true, token, count } | { ok: false, error }. The token is bound to
 *                       the card and to those rows' ids (pid + start), is good once, for ASK_TTL_MS; a new ask on the card replaces it
 *                       (Dexter 3, 5).
 *     stop(key, token)  only with that token: the named rows that are still the card's and windowless on a fresh read are stopped,
 *                       one at a time (host/stop-folder.js stopRows, host/stop-holder.js stopHost: never a session with a window open,
 *                       never a pid it cannot prove). -> { ok, asked, stopped, kept, texts }: `stopped` counts the named rows that ended,
 *                       and those PROVEN gone (absent from a verified fresh read); `kept` the rest, each with its reason in `texts` ("1
 *                       now has a window", "1 is open as a tab now", "1 could not be checked ..."); `ok` only when none was kept. An
 *                       unverified or failed fresh read stops nothing and says so (PR #265 Dexter R2-1: a session still running is never
 *                       reported as stopped). One stop per card at a time (Dexter 6, Miguel Y3): ask and stop answer "a stop is already
 *                       running" meanwhile.
 *     newLane(root, branch)  a flat project, or a folder placed nowhere, is refused before anything opens (Miguel G5, Dexter 4); then
 *                       the project opens (openProject) and the strip's + runs in its window (app/tab-shell.js createWorktree). A lane
 *                       made whose setup failed is { ok: false, made: true, error } (Miguel G6).
 *
 * deps: readList() -> Promise<{ rows, verified }> (host/background-hosts.js), itemsOf(list) -> menu items (app/background-menu.js
 * menuModel), windowlessOf(items) -> the windowless items (app/tray-model.js windowlessItems), stopHost(row) -> Promise<{ outcome, text }>,
 * projectOf, keyOf, openProject(o), registry { get(root) }, now(), newToken(), log.
 */

const { stopRows, ENDED } = require('../host/stop-folder');
const { sessionKeyOf } = require('./home-model');

const ASK_TTL_MS = 2 * 60_000;
const BUSY = 'a stop is already running for this project';
const NO_ASK = 'that question is no longer open; ask again';
const NOT_TABS = 'a new lane needs a project with worktrees (a dev folder)';

const rowId = (r) => `${r.pid}:${r.processStartedAt}`;
const hasId = (r) => !!r && Number.isInteger(r.pid) && r.pid > 0 && typeof r.processStartedAt === 'string' && r.processStartedAt !== '';
const errText = (err) => String((err && err.message) || err);

function selectRows(key, rows, { projectOf, keyOf }) {
  if (typeof key !== 'string' || !key) return [];
  return (Array.isArray(rows) ? rows : []).filter((r) => hasId(r) && r.windows === 0 && typeof r.cwd === 'string' && r.cwd
    && sessionKeyOf(r.cwd, { projectOf, keyOf }) === key);
}

// Why a named session that is still listed is not stopped (PR #265 Dexter R2-1): it left "windowless" some way since the question.
function keptReason(item) {
  const r = item.row;
  if (item.open && item.open.kind === 'select-tab') return 'is open as a tab now';
  if (Number.isInteger(r.windows) && r.windows > 0) return 'now has a window';
  if (r.windows !== 0) return 'could not be checked (its window count could not be read)';
  return 'is no longer this project\'s';
}

function createHomeActions(deps) {
  const { projectOf, keyOf, openProject, registry, itemsOf, windowlessOf } = deps;
  let readList = deps.readList;
  let stopHost = deps.stopHost;
  // The host list as it is read ({ rows, verified }: host/background-hosts.js), its menu items (app/background-menu.js menuModel) and
  // the windowless ones among them (app/tray-model.js windowlessItems): the same path as the cards' count.
  const windowless = async () => windowlessOf(itemsOf(await readList())).map((it) => it.row);
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const newToken = deps.newToken || (() => require('crypto').randomBytes(16).toString('hex'));
  const asks = new Map();         // token -> { key, ids, expires }
  const running = new Set();      // keys with a stop in flight

  const dropAsksOf = (key) => { for (const [t, a] of asks) if (a.key === key) asks.delete(t); };

  async function ask(key) {
    if (running.has(key)) return { ok: false, error: BUSY };
    let rows;
    try { rows = await windowless(); } catch (err) { return { ok: false, error: `the sessions could not be listed: ${errText(err)}` }; }
    const chosen = selectRows(key, rows, { projectOf, keyOf });
    if (chosen.length === 0) return { ok: false, error: 'no session of this project runs with no window now' };
    dropAsksOf(key);
    const token = newToken();
    asks.set(token, { key, ids: chosen.map(rowId), expires: now() + ASK_TTL_MS });
    return { ok: true, token, count: chosen.length };
  }

  async function stop(key, token) {
    if (running.has(key)) return { ok: false, error: BUSY };
    const a = typeof token === 'string' && token ? asks.get(token) : undefined;
    if (!a || a.key !== key) return { ok: false, error: NO_ASK };
    asks.delete(token);                                     // good once
    if (now() > a.expires) return { ok: false, error: 'the question expired; ask again' };
    running.add(key);
    const asked = a.ids.length;
    const none = (text) => ({ ok: false, asked, stopped: 0, kept: asked, texts: [text] });
    try {
      // the fresh read. Only a VERIFIED one may say a session is gone (PR #265 Dexter R2-1): an unverified or failed read stops nothing
      let list;
      try { list = await readList(); } catch (err) { return none(`the sessions could not be read, so none was stopped: ${errText(err)}`); }
      if (!list || list.verified !== true || !Array.isArray(list.rows)) return none('the sessions could not be checked, so none was stopped');
      const items = itemsOf(list).filter((it) => it && hasId(it.row));
      const mine = new Map(selectRows(key, windowlessOf(items).map((it) => it.row), { projectOf, keyOf }).map((r) => [rowId(r), r]));
      const anyState = new Map(items.map((it) => [rowId(it.row), it]));
      const targets = [];
      let gone = 0;
      const reasons = new Map();                           // why a named session that still runs was not stopped -> how many
      for (const id of a.ids) {
        if (mine.has(id)) targets.push(mine.get(id));
        else if (anyState.has(id)) { const why = keptReason(anyState.get(id)); reasons.set(why, (reasons.get(why) || 0) + 1); }
        else gone += 1;                                    // absent from a verified read: its host is proven not running
      }
      const results = await stopRows(targets, (r) => stopHost(r));
      for (const x of results) log(`[main] home: Stop its sessions: ${x.outcome} (pid ${x.row.pid}, port ${x.row.port})`);
      const ended = results.filter((x) => ENDED.has(x.outcome)).length;
      const texts = [
        ...results.filter((x) => !ENDED.has(x.outcome)).map((x) => x.text).filter((s) => typeof s === 'string' && s),
        ...[...reasons].map(([why, n]) => `${n} ${why}`),
      ];
      const stopped = ended + gone;
      const kept = asked - stopped;
      return { ok: kept === 0, asked, stopped, kept, texts };
    } finally {
      running.delete(key);
    }
  }

  async function newLane(root, branch) {
    let place = null;
    try { place = projectOf(root); } catch { place = null; }
    if (!place || place.kind !== 'container') return { ok: false, error: NOT_TABS };
    let o;
    try { o = await openProject({ cwd: root, show: 'shown' }); } catch (err) { return { ok: false, error: errText(err) }; }
    if (!o || o.ok !== true) return { ok: false, error: (o && o.error) || 'the project did not open' };
    if (o.elsewhere) return { ok: false, error: 'that project\'s window is in another Jiandu; make the lane there' };
    const w = registry.get(o.root || root);
    const shell = w && w.tabShell ? w.tabShell : (w && typeof w.createWorktree === 'function' ? w : null);
    if (!shell) return { ok: false, error: 'the project\'s window did not start' };
    if (shell.snapshot().mode !== 'tabs') return { ok: false, error: NOT_TABS };
    let r;
    try { r = await shell.createWorktree(branch); } catch (err) { return { ok: false, error: errText(err) }; }
    if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'the lane was not made' };
    if (typeof r.setupError === 'string' && r.setupError) return { ok: false, made: true, branch, error: `its setup failed: ${r.setupError}` };
    return { ok: true, branch };
  }

  return {
    ask, stop, newLane,
    busy: (key) => running.has(key),
    // test seams: swap a dep after construction
    _setStopHost: (fn) => { stopHost = fn; },
    _setReadList: (fn) => { readList = fn; },
  };
}

module.exports = { createHomeActions, selectRows, rowId, ASK_TTL_MS };
