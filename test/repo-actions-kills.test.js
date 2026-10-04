'use strict';
/**
 * The repo browser's reveal and drag-out at their edges (backlog #60, Mortimer's release-#101 part 2): the
 * prepared-drag key (case and separators fold), its expiry at the exact tick, the cache bound and its refresh
 * order, and which reason each failure gets.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRepoActions } = require('../app/repo-actions');

const fileStat = async () => ({ isFile: () => true });
const okGuard = async (root, rel) => ({ ok: true, abs: `${root}\\${rel}`, real: `${root}\\REAL\\${rel}` });

function make(over = {}) {
  const shown = [];
  const started = [];
  const state = { t: 1000 };
  const api = createRepoActions({
    shell: { showItemInFolder: (p) => shown.push(p) },
    startDrag: (o) => started.push(o),
    icon: () => 'ICON',
    guard: okGuard,
    fsApi: { stat: fileStat },
    now: () => state.t,
    ...over,
  });
  return { api, shown, started, state };
}

// ---- resolve ----

test('a rel that is not a string is "not a path" and never reaches the guard, for every action', async () => {
  let asked = 0;
  const { api } = make({ guard: async () => { asked += 1; return { ok: true, abs: 'x' }; } });
  for (const rel of [undefined, null, 5, {}, ['a']]) {
    assert.deepStrictEqual(await api.reveal('C:\\w', rel), { ok: false, why: 'not a path' });
    assert.deepStrictEqual(await api.drag('C:\\w', rel), { ok: false, why: 'not a path' });
    assert.deepStrictEqual(await api.prepare('C:\\w', rel), { ok: false, why: 'not a path' });
  }
  assert.strictEqual(asked, 0);
});

test('a refusal by the guard comes back with its reason, and nothing is shown, stat-ed or started', async () => {
  let statted = 0;
  const { api, shown, started } = make({
    guard: async () => ({ ok: false, why: 'outside the worktree', real: 'C:\\x', abs: 'C:\\x' }),
    fsApi: { stat: async () => { statted += 1; return { isFile: () => true }; } },
  });
  assert.deepStrictEqual(await api.reveal('C:\\w', 'a'), { ok: false, why: 'outside the worktree' });
  assert.deepStrictEqual(await api.drag('C:\\w', 'a'), { ok: false, why: 'outside the worktree' });
  assert.deepStrictEqual(await api.prepare('C:\\w', 'a'), { ok: false, why: 'outside the worktree' });
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a'), { ok: false, why: 'not ready' });
  assert.deepStrictEqual([shown, started, statted], [[], [], 0]);
});

test('the real path the guard resolved is what is shown and dragged; the spelled path when there is no real one', async () => {
  const a = make();
  await a.api.reveal('C:\\w', 'a.txt');
  await a.api.drag('C:\\w', 'a.txt');
  assert.deepStrictEqual(a.shown, ['C:\\w\\REAL\\a.txt']);
  assert.deepStrictEqual(a.started, [{ file: 'C:\\w\\REAL\\a.txt', icon: 'ICON' }]);
  const b = make({ guard: async (root, rel) => ({ ok: true, abs: `${root}\\${rel}` }) });
  await b.api.reveal('C:\\w', 'a.txt');
  await b.api.drag('C:\\w', 'a.txt');
  assert.deepStrictEqual(b.shown, ['C:\\w\\a.txt']);
  assert.deepStrictEqual(b.started, [{ file: 'C:\\w\\a.txt', icon: 'ICON' }]);
});

// ---- reveal ----

test('a shell that throws is reported with its message, or with a reason that names Explorer when it has none', async () => {
  const boom = (e) => make({ shell: { showItemInFolder: () => { throw e; } } }).api.reveal('C:\\w', 'a');
  assert.deepStrictEqual(await boom(new Error('shell is down')), { ok: false, why: 'shell is down' });
  for (const e of [{}, undefined, new Error('')]) {
    const r = await boom(e);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /explorer/i);
  }
});

test('reveal answers ok with nothing else', async () => {
  assert.deepStrictEqual(await make().api.reveal('C:\\w', 'a'), { ok: true });
});

// ---- drag ----

test('drag: a folder is "not-a-file" and nothing starts; a file starts once, with the icon', async () => {
  const dir = make({ fsApi: { stat: async () => ({ isFile: () => false }) } });
  assert.deepStrictEqual(await dir.api.drag('C:\\w', 'd'), { ok: false, why: 'not-a-file' });
  assert.deepStrictEqual(dir.started, []);
  const file = make();
  assert.deepStrictEqual(await file.api.drag('C:\\w', 'a'), { ok: true });
  assert.strictEqual(file.started.length, 1);
});

test('drag uses the start handed in for this call over the default one', async () => {
  const mine = [];
  const { api, started } = make();
  await api.drag('C:\\w', 'a', (o) => mine.push(o));
  assert.strictEqual(mine.length, 1);
  assert.deepStrictEqual(started, []);
});

test('drag: a stat that fails is "gone" for ENOENT, else its own message, else a reason that names the drag', async () => {
  const failing = (e) => make({ fsApi: { stat: async () => { throw e; } } }).api.drag('C:\\w', 'a');
  assert.deepStrictEqual(await failing(Object.assign(new Error('missing'), { code: 'ENOENT' })), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await failing(Object.assign(new Error('denied'), { code: 'EACCES' })), { ok: false, why: 'denied' });
  for (const e of [{}, undefined, new Error('')]) {
    const r = await failing(e);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /drag/i);
  }
});

test('drag: a start that throws is reported the same way', async () => {
  const { api } = make({ startDrag: () => { throw new Error('no window'); } });
  assert.deepStrictEqual(await api.drag('C:\\w', 'a'), { ok: false, why: 'no window' });
});

// ---- prepare ----

test('prepare: a folder is "not-a-file"; a missing file is "gone"; other failures give their message, or "unreadable"', async () => {
  const prep = (stat) => make({ fsApi: { stat } }).api.prepare('C:\\w', 'a');
  assert.deepStrictEqual(await prep(async () => ({ isFile: () => false })), { ok: false, why: 'not-a-file' });
  assert.deepStrictEqual(await prep(async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await prep(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { ok: false, why: 'denied' });
  assert.deepStrictEqual(await prep(async () => { throw {}; }), { ok: false, why: 'unreadable' });
  assert.deepStrictEqual(await prep(async () => { throw undefined; }), { ok: false, why: 'unreadable' });
  assert.deepStrictEqual(await prep(async () => { throw new Error(''); }), { ok: false, why: 'unreadable' });
});

test('a file that failed to prepare is never ready to drag', async () => {
  const { api, started } = make({ fsApi: { stat: async () => ({ isFile: () => false }) } });
  await api.prepare('C:\\w', 'a');
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a'), { ok: false, why: 'not ready' });
  assert.deepStrictEqual(started, []);
});

// ---- dragNow: the key ----

test('a prepared drag is found by the worktree and path in any case and with either slash', async () => {
  const { api, started } = make();
  assert.deepStrictEqual(await api.prepare('C:\\W', 'A\\B.txt'), { ok: true });
  assert.deepStrictEqual(api.dragNow('c:\\w', 'a/b.txt'), { ok: true });
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a\\B.TXT'), { ok: true });
  assert.strictEqual(started.length, 2);
  assert.deepStrictEqual(started[0], { file: 'C:\\W\\REAL\\A\\B.txt', icon: 'ICON' });
});

test('the key keeps the worktree and the path apart: another tab, another file or another nesting is not ready', async () => {
  const { api } = make();
  await api.prepare('C:\\w', 'a\\b.txt');
  for (const [root, rel] of [['C:\\x', 'a/b.txt'], ['C:\\w', 'a/c.txt'], ['C:\\w', 'ab.txt'], ['C:\\w', 'a/b.txt/'], ['C:\\', 'w\\a/b.txt'], ['C:\\wa', '/b.txt']]) {
    assert.deepStrictEqual(api.dragNow(root, rel), { ok: false, why: 'not ready' }, `${root} ${rel}`);
  }
});

test('a prepared file is dragged with the file prepared (not the one the guard would say now), by the start handed in', async () => {
  const mine = [];
  const { api, started } = make();
  await api.prepare('C:\\w', 'a');
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a', (o) => mine.push(o)), { ok: true });
  assert.deepStrictEqual(mine, [{ file: 'C:\\w\\REAL\\a', icon: 'ICON' }]);
  assert.deepStrictEqual(started, []);
});

test('dragNow: a start that throws is reported with its message, or a reason that names the drag', () => {
  const run = async (e) => {
    const { api } = make({ startDrag: () => { throw e; } });
    await api.prepare('C:\\w', 'a');
    return api.dragNow('C:\\w', 'a');
  };
  return Promise.all([run(new Error('no window')), run({}), run(undefined)]).then(([a, b, c]) => {
    assert.deepStrictEqual(a, { ok: false, why: 'no window' });
    for (const r of [b, c]) { assert.strictEqual(r.ok, false); assert.match(r.why, /drag/i); }
  });
});

// ---- dragNow: expiry ----

test('a prepared drag is good for exactly 60 seconds and not a millisecond longer', async () => {
  const { api, state } = make();
  await api.prepare('C:\\w', 'a');
  state.t += 60 * 1000 - 1;
  assert.strictEqual(api.dragNow('C:\\w', 'a').ok, true);
  state.t = 1000 + 60 * 1000;
  assert.strictEqual(api.dragNow('C:\\w', 'a').ok, true, 'at exactly the limit it still works');
  state.t = 1000 + 60 * 1000 + 1;
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a'), { ok: false, why: 'not ready' });
});

test('preparing again refreshes the time', async () => {
  const { api, state } = make();
  await api.prepare('C:\\w', 'a');
  state.t += 50 * 1000;
  await api.prepare('C:\\w', 'a');
  state.t += 50 * 1000;
  assert.strictEqual(api.dragNow('C:\\w', 'a').ok, true);
});

// ---- the bound ----

test('the cache holds exactly maxPrepared entries and drops the oldest past that', async () => {
  const { api } = make({ maxPrepared: 2 });
  await api.prepare('C:\\w', 'a');
  await api.prepare('C:\\w', 'b');
  assert.strictEqual(api.dragNow('C:\\w', 'a').ok, true, 'exactly the bound evicts nothing');
  assert.strictEqual(api.dragNow('C:\\w', 'b').ok, true);
  await api.prepare('C:\\w', 'c');
  assert.deepStrictEqual(api.dragNow('C:\\w', 'a'), { ok: false, why: 'not ready' });
  assert.strictEqual(api.dragNow('C:\\w', 'b').ok, true);
  assert.strictEqual(api.dragNow('C:\\w', 'c').ok, true);
});

test('preparing a path again makes it the newest, so it is the one that survives the next eviction', async () => {
  const { api } = make({ maxPrepared: 2 });
  await api.prepare('C:\\w', 'a');
  await api.prepare('C:\\w', 'b');
  await api.prepare('C:\\w', 'A');           // the same key as `a`, now the newest
  await api.prepare('C:\\w', 'c');           // evicts the oldest: b
  assert.strictEqual(api.dragNow('C:\\w', 'a').ok, true);
  assert.deepStrictEqual(api.dragNow('C:\\w', 'b'), { ok: false, why: 'not ready' });
  assert.strictEqual(api.dragNow('C:\\w', 'c').ok, true);
});

test('the default bound is 200 entries', async () => {
  const { api } = make();
  for (let i = 0; i < 201; i++) await api.prepare('C:\\w', `f${i}`);
  assert.deepStrictEqual(api.dragNow('C:\\w', 'f0'), { ok: false, why: 'not ready' });
  assert.strictEqual(api.dragNow('C:\\w', 'f1').ok, true);
  assert.strictEqual(api.dragNow('C:\\w', 'f200').ok, true);
});
