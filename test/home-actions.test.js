'use strict';
/**
 * app/home-actions.js (PR #265 Dexter 1-6, Miguel B1, Y1, Y3, G5): Home's Stop its sessions and New lane effects, out of main.js, with
 * every dep faked. The rule that costs the most: a card's Stop ends EXACTLY the sessions that card counted (the project root of each
 * row's cwd, never its install), and only the ones its question named.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createHomeActions, selectRows, rowId, ASK_TTL_MS } = require('../app/home-actions');
const { homeCards } = require('../app/home-model');

const keyOf = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').toLowerCase() : null);
const labelOf = (root) => String(root).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
// A container is `<root>\dev` or `<root>\feat-*`; C:\flat is a flat repo; anything else is placed nowhere (its own root).
const projectOf = (p) => {
  if (typeof p !== 'string' || !p) return null;
  if (/^c:\\flat(\\|$)/i.test(p)) return { kind: 'flat', root: 'C:\\flat', dev: 'C:\\flat' };
  if (/^c:\\(a|cc)$/i.test(p)) return { kind: 'container', root: p, dev: `${p}\\dev` };     // a container root itself (real projectOf does this)
  const m = /^(.*?)\\(dev|feat-[^\\]+)(\\.*)?$/i.exec(p);
  return m ? { kind: 'container', root: m[1], dev: `${m[1]}\\dev` } : null;
};

let nextPid = 100;
const row = (cwd, over = {}) => ({ pid: nextPid++, processStartedAt: '1340', cwd, install: 'C:\\cc\\dev', windows: 0, port: 7700, ...over });

function rig({ rows = [], stopAnswer = () => ({ outcome: 'stopped', text: 'Stopped.' }), time = 1000 } = {}) {
  const s = { rows, time, stopped: [], opened: [], reads: 0 };
  const shells = new Map();
  const a = createHomeActions({
    windowless: async () => { s.reads++; return s.rows; },
    stopHost: async (r) => { s.stopped.push(r.pid); const ans = stopAnswer(r); if (ans instanceof Error) throw ans; return ans; },
    projectOf, keyOf,
    openProject: async (o) => { s.opened.push(o.cwd); return s.openAnswer || { ok: true, root: o.cwd }; },
    registry: { get: (root) => shells.get(root) || null },
    now: () => s.time,
    newToken: (() => { let n = 0; return () => `t${++n}`; })(),
    log: () => {},
  });
  return { a, s, shells };
}

test('Dexter 1 / Miguel B1 (Critical): a row is chosen by its cwd ONLY, never by its install: the claude-custom card stops only its own', async () => {
  const t = rig({ rows: [row('C:\\viral\\dev', { install: 'C:\\cc\\dev' }), row('C:\\komodo\\dev', { install: 'C:\\cc\\feat-x' }), row('C:\\cc\\feat-x')] });
  const ask = await t.a.ask('c:\\cc');
  assert.strictEqual(ask.ok, true);
  assert.strictEqual(ask.count, 1);
  const r = await t.a.stop('c:\\cc', ask.token);
  assert.deepStrictEqual(t.s.stopped, [t.s.rows[2].pid], 'only the session that works in claude-custom');
  assert.deepStrictEqual(r, { ok: true, asked: 1, stopped: 1, kept: 0, texts: [] });
});

test('Dexter 2 (High): a card whose folder holds other projects stops only its own sessions, by the project root of each cwd', async () => {
  const t = rig({ rows: [row('C:\\Users\\ricar\\VibeCode'), row('C:\\Users\\ricar\\VibeCode\\viral\\dev'), row('C:\\Users\\ricar\\VibeCode\\music\\dev')] });
  const ask = await t.a.ask('c:\\users\\ricar\\vibecode');
  assert.strictEqual(ask.count, 1);
  await t.a.stop('c:\\users\\ricar\\vibecode', ask.token);
  assert.deepStrictEqual(t.s.stopped, [t.s.rows[0].pid]);
});

test('property (Dexter 2): for any rows, a card\'s Stop selects exactly the sessions that card counted, and no two cards share one', () => {
  const folders = ['C:\\p', 'C:\\p\\dev', 'C:\\p\\feat-a', 'C:\\p\\dev\\sub', 'C:\\p\\a\\dev', 'C:\\q\\dev', 'C:\\flat', 'C:\\flat\\src', 'C:\\Users\\ricar', 'C:\\Users\\ricar\\VibeCode'];
  fc.assert(fc.property(fc.array(fc.record({
    cwd: fc.constantFrom(...folders), install: fc.constantFrom(...folders), windows: fc.constantFrom(0, 0, 0, 1, null),
  }), { maxLength: 14 }), (specs) => {
    const rows = specs.map((x, i) => ({ pid: 1000 + i, processStartedAt: '1', ...x }));
    const windowless = rows.filter((r) => r.windows === 0).map((r) => ({ cwd: r.cwd }));
    const { cards } = homeCards({ record: { projects: [], pins: [], removed: [] }, recents: [], windows: [], windowless, projectOf, exists: () => true, keyOf, labelOf });
    const seen = new Set();
    let total = 0;
    for (const c of cards) {
      const chosen = selectRows(c.key, rows, { projectOf, keyOf });
      assert.strictEqual(chosen.length, c.sessions === null ? 0 : c.sessions, `${c.key}: counted ${c.sessions}, chosen ${chosen.length}`);
      for (const r of chosen) { assert.ok(!seen.has(rowId(r)), `${rowId(r)} on two cards`); seen.add(rowId(r)); }
      total += chosen.length;
    }
    assert.strictEqual(total, windowless.length, 'every windowless session is on exactly one card');
  }), { numRuns: 300 });
});

test('Dexter 3: the stop ends only the sessions its question named, still windowless on a fresh read; the report counts against them', async () => {
  const t = rig({ rows: [row('C:\\a\\dev')] });
  const ask = await t.a.ask('c:\\a');
  assert.strictEqual(ask.count, 1);
  const named = t.s.rows[0];
  t.s.rows = [named, row('C:\\a\\feat-x'), row('C:\\a\\feat-y')];   // two more started after the question
  const r = await t.a.stop('c:\\a', ask.token);
  assert.deepStrictEqual(t.s.stopped, [named.pid], 'the two new ones were not asked about');
  assert.deepStrictEqual(r, { ok: true, asked: 1, stopped: 1, kept: 0, texts: [] });
});

test('Dexter 3: a named session that got a window is kept and said; one that already ended counts as stopped', async () => {
  const t = rig({ rows: [row('C:\\a\\dev'), row('C:\\a\\feat-x'), row('C:\\a\\feat-y')] });
  const ask = await t.a.ask('c:\\a');
  assert.strictEqual(ask.count, 3);
  const [d, x] = t.s.rows;
  t.s.rows = [d, { ...x, windows: 1 }];                 // feat-x got a window; feat-y ended by itself
  const r = await t.a.stop('c:\\a', ask.token);
  assert.deepStrictEqual(t.s.stopped, [d.pid]);
  assert.deepStrictEqual(r, { ok: false, asked: 3, stopped: 2, kept: 1, texts: ['A session got a window since the question, so it was not stopped.'] });
});

test('Dexter 3: rows with a window, or `windows: null` (not known), are never asked about', async () => {
  const t = rig({ rows: [row('C:\\a\\dev', { windows: 1 }), row('C:\\a\\feat-x', { windows: null }), row('C:\\a\\feat-y', { windows: '0' })] });
  assert.deepStrictEqual(await t.a.ask('c:\\a'), { ok: false, error: 'no session of this project runs with no window now' });
});

test('Dexter 5: a stop with no ask, a token of another card, a replay or an expired token is refused and stops nothing', async () => {
  const t = rig({ rows: [row('C:\\a\\dev'), row('C:\\b\\dev')] });
  assert.deepStrictEqual(await t.a.stop('c:\\a', 'made-up'), { ok: false, error: 'that question is no longer open; ask again' });
  const askB = await t.a.ask('c:\\b');
  assert.deepStrictEqual(await t.a.stop('c:\\a', askB.token), { ok: false, error: 'that question is no longer open; ask again' });
  const askA = await t.a.ask('c:\\a');
  assert.strictEqual((await t.a.stop('c:\\a', askA.token)).ok, true);
  assert.deepStrictEqual(await t.a.stop('c:\\a', askA.token), { ok: false, error: 'that question is no longer open; ask again' }, 'a replay');
  const late = await t.a.ask('c:\\b');
  t.s.time += ASK_TTL_MS + 1;
  assert.deepStrictEqual(await t.a.stop('c:\\b', late.token), { ok: false, error: 'the question expired; ask again' });
  assert.deepStrictEqual(t.s.stopped, [t.s.rows[0].pid]);
  for (const bad of [undefined, null, 5, '']) assert.strictEqual((await t.a.stop('c:\\a', bad)).ok, false);
});

test('Dexter 5: a second ask on a card replaces the first: only the newest question can be answered', async () => {
  const t = rig({ rows: [row('C:\\a\\dev')] });
  const first = await t.a.ask('c:\\a');
  const second = await t.a.ask('c:\\a');
  assert.strictEqual((await t.a.stop('c:\\a', first.token)).ok, false);
  assert.strictEqual((await t.a.stop('c:\\a', second.token)).ok, true);
});

test('Dexter 6 / Miguel Y3: no second stop on a root while one runs; busy(key) says so until it ends', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = rig({ rows: [row('C:\\a\\dev')] });
  t.a._setStopHost(async () => { await gate; return { outcome: 'stopped', text: 'Stopped.' }; });
  const ask = await t.a.ask('c:\\a');
  const running = t.a.stop('c:\\a', ask.token);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.a.busy('c:\\a'), true);
  const ask2 = await t.a.ask('c:\\a');
  assert.deepStrictEqual(ask2, { ok: false, error: 'a stop is already running for this project' });
  assert.deepStrictEqual(await t.a.stop('c:\\a', ask.token), { ok: false, error: 'a stop is already running for this project' });
  release();
  assert.strictEqual((await running).ok, true);
  assert.strictEqual(t.a.busy('c:\\a'), false);
});

test('a failed or throwing stop of a named session is kept with its text; a list that cannot be read is an error', async () => {
  const t = rig({ rows: [row('C:\\a\\dev'), row('C:\\a\\feat-x')], stopAnswer: (r) => (r.cwd.endsWith('dev') ? { outcome: 'refused', text: 'It has a window open.' } : new Error('powershell failed')) });
  const ask = await t.a.ask('c:\\a');
  const r = await t.a.stop('c:\\a', ask.token);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopped, 0);
  assert.strictEqual(r.kept, 2);
  assert.strictEqual(r.texts[0], 'It has a window open.');
  assert.match(r.texts[1], /powershell failed/);
  const broken = rig({ rows: [row('C:\\a\\dev')] });
  const ask2 = await broken.a.ask('c:\\a');
  broken.a._setWindowless(async () => { throw new Error('no list'); });
  assert.deepStrictEqual(await broken.a.stop('c:\\a', ask2.token), { ok: false, error: 'the sessions could not be listed: no list' });
  assert.strictEqual(broken.a.busy('c:\\a'), false, 'the busy mark goes on the throw path too');
});

// ---- New lane (Miguel Y1, G5, G6; Dexter 4) -------------------------------------------------------------------------------------

const shell = (over = {}) => ({ snapshot: () => ({ mode: 'tabs' }), createWorktree: async (b) => ({ ok: true, path: `C:\\a\\${b.replace('/', '-')}` }), ...over });

test('New lane: a flat project or a folder placed nowhere is refused BEFORE anything opens (Miguel G5, Dexter 4)', async () => {
  const t = rig();
  assert.deepStrictEqual(await t.a.newLane('C:\\flat', 'feat/x'), { ok: false, error: 'a new lane needs a project with worktrees (a dev folder)' });
  assert.deepStrictEqual(await t.a.newLane('C:\\nowhere', 'feat/x'), { ok: false, error: 'a new lane needs a project with worktrees (a dev folder)' });
  assert.deepStrictEqual(t.s.opened, []);
});

test('New lane: the project opens, then the strip\'s + runs in its window; every way it can fail says why', async () => {
  const t = rig();
  t.shells.set('C:\\a', shell());
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: true, branch: 'feat/x' });
  assert.deepStrictEqual(t.s.opened, ['C:\\a']);
  t.s.openAnswer = { ok: false, error: 'the folder is gone' };
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'the folder is gone' });
  t.s.openAnswer = { ok: true, elsewhere: true };
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'that project\'s window is in another Jiandu; make the lane there' });
  t.s.openAnswer = null;
  t.shells.delete('C:\\a');
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'the project\'s window did not start' });
  t.shells.set('C:\\a', shell({ snapshot: () => ({ mode: 'single' }) }));
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'a new lane needs a project with worktrees (a dev folder)' });
  t.shells.set('C:\\a', shell({ createWorktree: async () => ({ ok: false, error: 'feat/x already exists' }) }));
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'feat/x already exists' });
  t.shells.set('C:\\a', shell({ createWorktree: async () => { throw new Error('boom'); } }));
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, error: 'boom' });
});

test('Miguel G6: a lane made whose setup failed is not an ok: it says the lane is there and why the setup failed', async () => {
  const t = rig();
  t.shells.set('C:\\a', shell({ createWorktree: async () => ({ ok: true, path: 'C:\\a\\feat-x', setupError: 'npm ci failed' }) }));
  assert.deepStrictEqual(await t.a.newLane('C:\\a', 'feat/x'), { ok: false, made: true, branch: 'feat/x', error: 'its setup failed: npm ci failed' });
});
