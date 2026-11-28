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
 *                       never a pid it cannot prove). -> { ok, asked, stopped, kept, texts }: `stopped` counts the named rows that ended
 *                       (and those already gone), `kept` the rest, `ok` only when none was kept. One stop per card at a time (Dexter 6,
 *                       Miguel Y3): ask and stop answer "a stop is already running" meanwhile.
 *     newLane(root, branch)  a flat project, or a folder placed nowhere, is refused before anything opens (Miguel G5, Dexter 4); then
 *                       the project opens (openProject) and the strip's + runs in its window (app/tab-shell.js createWorktree). A lane
 *                       made whose setup failed is { ok: false, made: true, error } (Miguel G6).
 *
 * deps: windowless() -> Promise<host rows> (main: app/tray-model.js windowlessItems' rows), stopHost(row) -> Promise<{ outcome, text }>,
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

function createHomeActions(deps) {
  const { projectOf, keyOf, openProject, registry } = deps;
  let windowless = deps.windowless;
  let stopHost = deps.stopHost;
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
    try {
      let rows;
      try { rows = await windowless(); } catch (err) { return { ok: false, error: `the sessions could not be listed: ${errText(err)}` }; }
      const list = Array.isArray(rows) ? rows : [];
      const mine = new Map(selectRows(key, list, { projectOf, keyOf }).map((r) => [rowId(r), r]));
      const listed = new Set(list.filter(hasId).map(rowId));
      const targets = [];
      let gone = 0;
      let moved = 0;
      for (const id of a.ids) {
        if (mine.has(id)) targets.push(mine.get(id));
        else if (!listed.has(id)) gone += 1;              // it ended on its own since the question
        else moved += 1;                                   // it got a window (or is no longer this card's): not asked to stop that
      }
      const results = await stopRows(targets, (r) => stopHost(r));
      for (const x of results) log(`[main] home: Stop its sessions: ${x.outcome} (pid ${x.row.pid}, port ${x.row.port})`);
      const ended = results.filter((x) => ENDED.has(x.outcome)).length;
      const texts = [
        ...results.filter((x) => !ENDED.has(x.outcome)).map((x) => x.text).filter((s) => typeof s === 'string' && s),
        ...(moved > 0 ? [`${moved === 1 ? 'A session' : `${moved} sessions`} got a window since the question, so ${moved === 1 ? 'it was' : 'they were'} not stopped.`] : []),
      ];
      const stopped = ended + gone;
      const kept = a.ids.length - stopped;
      return { ok: kept === 0, asked: a.ids.length, stopped, kept, texts };
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
    _setWindowless: (fn) => { windowless = fn; },
  };
}

module.exports = { createHomeActions, selectRows, rowId, ASK_TTL_MS };
