'use strict';
/**
 * Which preset a confirm is about (BACKLOG #59, PR #103 Dexter r2 A). A question asked about 'Focus' must act on
 * the preset the user was shown, not on whatever holds that name when the answer reaches main: every preset
 * carries an id, the page sends it with every rename, delete and replace, and main refuses with `changed` when the
 * preset under that name has another one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const P = require('../app/dock-presets');
const { registerLayoutHandlers, PRESET_NAMES } = require('../app/layout-bridge');

const L = (tag = 'a') => ({ version: 2, root: { type: 'term' }, floats: [], hidden: [tag], seat: {} });
const counter = (prefix = 'id') => { let n = 0; return () => `${prefix}${++n}`; };

// --- the regression: Dexter's sequence, two windows over one store ------------------------------------------

function fakeStore(seed) {
  const data = { [PRESET_NAMES.key]: seed };
  const store = {
    data, writes: 0, locked: 0, wroteUnlocked: 0,
    read: (name, fallback) => (name in data ? data[name] : fallback),
    write: (name, value) => { store.writes += 1; if (!store.locked) store.wroteUnlocked += 1; data[name] = JSON.parse(JSON.stringify(value)); return value; },
    withLock: (name, fn) => { store.locked += 1; try { return fn(); } finally { store.locked -= 1; } },
    readState: name => (name in data ? { status: 'ok', value: data[name] } : { status: 'missing', value: null }),
  };
  return store;
}

// One main (one window) on the shared store: its get, its op and what it pushed to its views.
function windowOn(store, newId) {
  const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); } };
  const view = {};
  const sent = [];
  registerLayoutHandlers({ ipcMain: ipc, store, sync: {}, names: PRESET_NAMES, isSender: s => s === view, send: (ch, v) => sent.push([ch, v]), newId });
  return {
    sent,
    get: () => ipc.handlers.get(PRESET_NAMES.get)({ sender: view }),
    op: req => ipc.handlers.get(PRESET_NAMES.op)({ sender: view }, req),
  };
}

// A has a question open about 'Focus' (what it was shown); B deletes Focus, then renames Debug to Focus.
async function staleFocus() {
  const store = fakeStore([{ name: 'Focus', layout: L('focus') }, { name: 'Debug', layout: L('debug') }]);
  const newId = counter();
  const A = windowOn(store, newId);
  const B = windowOn(store, newId);
  const shown = P.describe((await A.get()).layout).list;
  const focus = shown.find(p => p.name === 'Focus');
  assert.ok(typeof focus.id === 'string', 'the page is shown an id for every preset');
  assert.strictEqual((await B.op({ op: 'delete', name: 'Focus', id: focus.id })).ok, true);
  const debug = P.find(store.data[PRESET_NAMES.key], 'Debug');
  assert.strictEqual((await B.op({ op: 'rename', name: 'Debug', to: 'Focus', id: debug.id })).ok, true);
  return { store, A, focus };
}

test('#59 Dexter r2 A: a stale "Delete \'Focus\'?" confirmed after another window put Debug under that name deletes nothing', async () => {
  const { store, A, focus } = await staleFocus();
  const before = JSON.stringify(store.data[PRESET_NAMES.key]);
  assert.deepStrictEqual(await A.op({ op: 'delete', name: 'Focus', id: focus.id }), { ok: false, reason: 'changed' });
  assert.strictEqual(JSON.stringify(store.data[PRESET_NAMES.key]), before, 'B\'s layout, now called Focus, is still there');
  assert.deepStrictEqual(P.find(store.data[PRESET_NAMES.key], 'Focus').layout, L('debug'));
});

test('#59: the same stale question as a rename renames nothing', async () => {
  const { store, A, focus } = await staleFocus();
  assert.deepStrictEqual(await A.op({ op: 'rename', name: 'Focus', to: 'Old focus', id: focus.id }), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(P.cleanPresets(store.data[PRESET_NAMES.key]).map(p => p.name), ['Focus']);
});

test('#59: the same stale question as a replace overwrites nothing', async () => {
  const { store, A, focus } = await staleFocus();
  assert.deepStrictEqual(await A.op({ op: 'save', name: 'Focus', layout: L('mine'), replace: true, id: focus.id }), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(P.find(store.data[PRESET_NAMES.key], 'Focus').layout, L('debug'));
});

test('#59: a confirm about the preset that is still there goes through, renamed in another case included', async () => {
  const store = fakeStore([{ name: 'Focus', layout: L('focus') }]);
  const A = windowOn(store, counter());
  const focus = P.describe((await A.get()).layout).list[0];
  assert.strictEqual((await A.op({ op: 'rename', name: 'Focus', to: 'FOCUS', id: focus.id })).ok, true);
  assert.strictEqual((await A.op({ op: 'save', name: 'focus', layout: L('z'), replace: true, id: focus.id })).ok, true);
  assert.strictEqual((await A.op({ op: 'delete', name: 'focus', id: focus.id })).ok, true);
  assert.deepStrictEqual(store.data[PRESET_NAMES.key], []);
});

// --- the rule, in the pure module -----------------------------------------------------------------------------

const two = () => [{ name: 'Review', layout: L('r'), id: 'r1' }, { name: 'Write', layout: L('w'), id: 'w1' }];

test('a rename, delete or replace carrying the id of the preset under that name goes through; another id is `changed`', () => {
  assert.strictEqual(P.applyOp(two(), { op: 'delete', name: 'review', id: 'r1' }).ok, true);
  assert.strictEqual(P.applyOp(two(), { op: 'rename', name: 'Review', to: 'X', id: 'r1' }).ok, true);
  assert.strictEqual(P.applyOp(two(), { op: 'save', name: 'Review', layout: L(), replace: true, id: 'r1' }).ok, true);
  for (const req of [
    { op: 'delete', name: 'Review', id: 'w1' }, { op: 'rename', name: 'Review', to: 'X', id: 'gone' },
    { op: 'save', name: 'Review', layout: L(), replace: true, id: 'w1' }, { op: 'delete', name: 'Review', id: null },
    { op: 'delete', name: 'Review', id: 7 },
  ]) assert.deepStrictEqual(P.applyOp(two(), req), { ok: false, reason: 'changed' }, JSON.stringify(req));
});

test('a name that is not there at all is still `missing`, whatever id came with it', () => {
  assert.deepStrictEqual(P.applyOp(two(), { op: 'delete', name: 'Nope', id: 'r1' }), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(P.applyOp(two(), { op: 'rename', name: 'Nope', to: 'X', id: 'r1' }), { ok: false, reason: 'missing' });
});

test('PR #127 Dexter F1 / Miguel I1: no id is no proof of identity: a question with none (null or missing) is refused, even over a preset that has none', () => {
  const bare = [{ name: 'Old', layout: L() }];
  const ops = id => [
    { op: 'delete', name: 'Old', ...id }, { op: 'rename', name: 'Old', to: 'New', ...id },
    { op: 'save', name: 'Old', layout: L('z'), replace: true, ...id },
  ];
  for (const id of [{ id: null }, {}, { id: undefined }, { id: '' }, { id: 7 }]) {
    for (const req of ops(id)) {
      assert.deepStrictEqual(P.applyOp(bare, req), { ok: false, reason: 'changed' }, `id-less preset: ${JSON.stringify(req)}`);
      assert.deepStrictEqual(P.applyOp(two(), req.name === 'Old' ? { ...req, name: 'Review' } : req), { ok: false, reason: 'changed' }, `preset with an id: ${JSON.stringify(req)}`);
    }
  }
  assert.deepStrictEqual(P.applyOp(bare, { op: 'delete', name: 'Old', id: 'x' }), { ok: false, reason: 'changed' });
});

test('PR #127 Dexter F1: an old build\'s delete-then-rename-into-the-name, which writes no ids, still costs the other window nothing', async () => {
  const store = fakeStore([{ name: 'Focus', layout: L('focus') }, { name: 'Debug', layout: L('debug') }]);
  const A = windowOn(store, counter());
  // A was shown the list by a watcher push (a push never gives ids), so its question about Focus carries null.
  const shown = P.describe(store.data[PRESET_NAMES.key]).list.find(p => p.name === 'Focus');
  assert.strictEqual(shown.id, undefined);
  const askedWith = { id: typeof shown.id === 'string' ? shown.id : null };
  // The old window (no ids anywhere): deletes Focus, then renames Debug to Focus.
  store.data[PRESET_NAMES.key] = P.deletePreset(store.data[PRESET_NAMES.key], 'Focus').list;
  store.data[PRESET_NAMES.key] = P.renamePreset(store.data[PRESET_NAMES.key], 'Debug', 'Focus').list;
  assert.deepStrictEqual(await A.op({ op: 'delete', name: 'Focus', ...askedWith }), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(P.find(store.data[PRESET_NAMES.key], 'Focus').layout, L('debug'), 'ex-Debug is still there');
});

test('PROPERTY (PR #127): no confirm ever acts on a different preset than the one it asked about, whoever wrote in between (ids or not)', () => {
  const nameArb = fc.constantFrom('Focus', 'focus', 'Debug', 'Review', 'A');
  const entryArb = fc.record({ name: nameArb, id: fc.option(fc.constantFrom('i1', 'i2', 'i3'), { nil: undefined }) }, { requiredKeys: ['name'] });
  const writerArb = fc.record({
    build: fc.constantFrom('old', 'new'), op: fc.constantFrom('save', 'rename', 'delete', 'replace'), name: nameArb, to: nameArb,
  });
  const key = n => P.nameKey(n.trim());
  const underName = (raw, name) => raw.find(e => e && typeof e.name === 'string' && key(e.name) === key(name));
  fc.assert(fc.property(
    fc.uniqueArray(entryArb, { minLength: 1, maxLength: 5, selector: e => e.name.toLowerCase() }), fc.boolean(), fc.nat(), fc.array(writerArb, { maxLength: 5 }),
    fc.constantFrom('delete', 'rename', 'replace'), nameArb,
    (seed, migrated, pick, writers, confirm, to) => {
      let uid = 0;
      const tag = raw => raw.map(e => (e.uid === undefined ? { ...e, uid: ++uid } : e));
      let raw = tag(seed.map(({ name, id }, n) => (id === undefined ? { name, layout: L(name) } : { name, layout: L(name), id: `i${n}` })));   // ids that exist are one each
      if (migrated) raw = P.withIds(raw, counter('m'));          // this window's get gave the stored presets their ids
      const shown = P.cleanPresets(raw);
      const asked = shown[pick % shown.length];
      const askedUid = underName(raw, asked.name).uid;
      const sent = typeof asked.id === 'string' ? asked.id : null;   // what the page sends: the id it was shown, else null
      for (const w of writers) {
        let r;
        if (w.build === 'new') {
          const here = underName(raw, w.name);
          r = P.applyOp(raw, { op: w.op === 'replace' ? 'save' : w.op, name: w.name, to: w.to, layout: L('w'), replace: w.op === 'replace', id: here && typeof here.id === 'string' ? here.id : null }, { newId: counter('w') });
        } else if (w.op === 'rename') r = P.renamePreset(raw, w.name, w.to);
        else if (w.op === 'delete') r = P.deletePreset(raw, w.name);
        else r = P.savePreset(raw, w.name, L('w'), { replace: w.op === 'replace' });
        if (r.ok) raw = tag(r.list);
      }
      const req = { op: confirm === 'rename' ? 'rename' : confirm === 'delete' ? 'delete' : 'save', name: asked.name, to, layout: L('mine'), replace: confirm === 'replace', id: sent };
      const target = underName(raw, asked.name);
      const r = P.applyOp(raw, req, { newId: counter('z') });
      if (r.ok && target) assert.strictEqual(target.uid, askedUid, `${confirm} of ${asked.name} acted on another preset: ${JSON.stringify(raw)}`);
    },
  ), { numRuns: Number(process.env.LAYOUT_RUNS) || 600 });
});

test('`changed` is checked after `missing` and before the new name is judged, so the user hears the reason that matters', () => {
  assert.deepStrictEqual(P.applyOp(two(), { op: 'rename', name: 'Review', to: '', id: 'w1' }), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(P.applyOp(two(), { op: 'rename', name: 'Review', to: 'write', id: 'w1' }), { ok: false, reason: 'changed' });
});

test('a replace whose name has gone meanwhile is a plain save, as before: there is nothing of anyone\'s to overwrite', () => {
  const r = P.applyOp(two(), { op: 'save', name: 'New', layout: L(), replace: true, id: 'gone' }, { newId: counter('n') });
  assert.deepStrictEqual(r.list.map(p => p.name), ['Review', 'Write', 'New']);
});

// --- ids: given on save, kept by rename and replace, and given to presets stored before ids ---------------------

test('a new preset gets an id; rename and replace keep the one it has', () => {
  const saved = P.applyOp(two(), { op: 'save', name: 'Plan', layout: L() }, { newId: counter('n') });
  assert.deepStrictEqual(saved.list.map(p => p.id), ['r1', 'w1', 'n1']);
  assert.strictEqual(P.applyOp(two(), { op: 'rename', name: 'Review', to: 'Docs', id: 'r1' }, { newId: counter('n') }).list[0].id, 'r1');
  assert.strictEqual(P.applyOp(two(), { op: 'save', name: 'review', layout: L('z'), replace: true, id: 'r1' }, { newId: counter('n') }).list[0].id, 'r1');
});

test('an op gives an id to every preset that has none (or a bad or repeated one), and leaves entries this build cannot use alone', () => {
  const stored = [{ name: 'A', layout: L() }, 'junk', { name: 'B', layout: L(), id: 7 }, { name: 'C', layout: L(), id: 'x' },
    { name: 'D', layout: L(), id: 'x' }, { shape: 'later' }, { name: 'E', layout: L(), id: 'y'.repeat(P.ID_MAX + 1) }];
  const r = P.applyOp(stored, { op: 'save', name: 'F', layout: L() }, { newId: counter('n') });
  assert.deepStrictEqual(r.list.map(e => (e && typeof e === 'object' ? e.id : e)), ['n1', 'junk', 'n2', 'x', 'n3', undefined, 'n4', 'n5']);
  assert.deepStrictEqual(r.list[5], { shape: 'later' });
});

test('withIds hands back the very same list when every preset already has its own id, and never throws', () => {
  const list = two();
  assert.strictEqual(P.withIds(list, counter()), list);
  const bare = [{ name: 'A', layout: L() }];
  assert.deepStrictEqual(P.withIds(bare, () => { throw new Error('no crypto'); }), bare, 'an id that cannot be made is left for next time');
  assert.deepStrictEqual(P.withIds(bare, () => 7), bare, 'nor is a bad one stored');
  assert.deepStrictEqual(bare, [{ name: 'A', layout: L() }], 'the list it was given is not changed');
  for (const raw of [null, 'x', 7, {}]) assert.strictEqual(P.withIds(raw, counter()), raw);
});

test('needsIds says whether withIds has anything to give, without making an id', () => {
  assert.strictEqual(P.needsIds(two()), false);
  assert.strictEqual(P.needsIds([...two(), 'junk', { shape: 'later' }]), false, 'entries this build cannot use need nothing');
  assert.strictEqual(P.needsIds([{ name: 'A', layout: L() }]), true);
  assert.strictEqual(P.needsIds([{ name: 'A', layout: L(), id: 'x' }, { name: 'B', layout: L(), id: 'x' }]), true);
  assert.strictEqual(P.needsIds([{ name: 'A', layout: L(), id: '' }]), true);
  for (const raw of [null, 'x', [], {}]) assert.strictEqual(P.needsIds(raw), false);
});

test('with no id maker passed, applyOp makes a random one', () => {
  const a = P.applyOp([], { op: 'save', name: 'A', layout: L() }).list[0].id;
  const b = P.applyOp([], { op: 'save', name: 'A', layout: L() }).list[0].id;
  assert.ok(typeof a === 'string' && a.length > 8 && a.length <= P.ID_MAX);
  assert.notStrictEqual(a, b);
});

test('the menu\'s list carries each preset\'s id (none when it has none)', () => {
  assert.deepStrictEqual(P.cleanPresets(two()).map(p => p.id), ['r1', 'w1']);
  assert.deepStrictEqual(P.cleanPresets([{ name: 'A', layout: L() }]), [{ name: 'A', layout: L() }]);
});

test('PROPERTY: after any op, every preset this build can use has an id no other has, and no good id is lost but a deleted one', () => {
  const nameArb = fc.constantFrom('A', 'a', 'B', 'Focus', 'Debug', '');
  const entryArb = fc.oneof(
    { weight: 4, arbitrary: fc.record({ name: nameArb, layout: fc.constant(L()), id: fc.option(fc.constantFrom('i1', 'i2', 'i3', 7), { nil: undefined }) }, { requiredKeys: ['name', 'layout'] }) },
    { weight: 1, arbitrary: fc.anything() },
  );
  const reqArb = fc.record({
    op: fc.constantFrom('save', 'rename', 'delete'), name: nameArb, to: nameArb, layout: fc.constant(L()),
    replace: fc.boolean(), id: fc.option(fc.constantFrom('i1', 'i2', 'n1', null), { nil: undefined }),
  });
  fc.assert(fc.property(fc.array(entryArb, { maxLength: 12 }), reqArb, (raw, req) => {
    const r = P.applyOp(raw, req, { newId: counter('n') });
    if (!r.ok) return;
    const ids = P.cleanPresets(r.list).map(p => p.id);
    assert.ok(ids.every(id => typeof id === 'string'), JSON.stringify(ids));
    assert.strictEqual(new Set(ids).size, ids.length);
    // An id one preset had to itself is still in the list afterwards, unless that preset was the one deleted.
    const before = P.cleanPresets(raw).map(p => p.id).filter(id => typeof id === 'string');
    const own = before.filter(id => before.indexOf(id) === before.lastIndexOf(id));
    const lost = own.filter(id => !ids.includes(id));
    assert.ok(lost.length <= (req.op === 'delete' ? 1 : 0), `lost ${JSON.stringify(lost)} on ${req.op}`);
  }), { numRuns: Number(process.env.LAYOUT_RUNS) || 300 });
});

// --- presets stored before ids get theirs the first time a window reads the list ---------------------------------

test('a get of a list with id-less presets gives them ids, writes that back once under the lock, and tells this window\'s views', async () => {
  const store = fakeStore([{ name: 'A', layout: L() }, 'junk']);
  const W = windowOn(store, counter());
  const answer = await W.get();
  assert.deepStrictEqual(answer, { status: 'ok', layout: [{ name: 'A', layout: L(), id: 'id1' }, 'junk'] });
  assert.deepStrictEqual(store.data[PRESET_NAMES.key], answer.layout);
  assert.strictEqual(store.writes, 1);
  assert.strictEqual(store.wroteUnlocked, 0);
  assert.deepStrictEqual(W.sent, [[PRESET_NAMES.push, answer.layout]]);
  await W.get();
  assert.strictEqual(store.writes, 1, 'a list that has its ids is not written again');
});

test('a get whose write-back fails answers the list as it was read: reading is never refused over it', async () => {
  const store = fakeStore([{ name: 'A', layout: L() }]);
  store.write = () => { throw new Error('EPERM'); };
  const W = windowOn(store, counter());
  assert.deepStrictEqual(await W.get(), { status: 'ok', layout: [{ name: 'A', layout: L() }] });
  assert.deepStrictEqual(W.sent, []);
});

// --- what the page does with it -----------------------------------------------------------------------------------

const step = (state, event) => P.reduceMenu(state, event);
const list = (...pairs) => pairs.map(([name, id]) => ({ name, layout: L(name), id }));

test('opening rename or delete remembers the id of the preset it is about', () => {
  assert.strictEqual(step({ mode: 'idle' }, { type: 'open', mode: 'delete', name: 'Focus', id: 'f1' }).id, 'f1');
  assert.strictEqual(step({ mode: 'idle' }, { type: 'open', mode: 'rename', name: 'Focus', id: 'f1' }).id, 'f1');
  assert.strictEqual(step({ mode: 'save', text: 'focus' }, { type: 'taken', name: 'Focus', text: 'focus', id: 'f1' }).id, 'f1');
});

test('a taken save asks to replace the preset it saw, with that preset\'s id; one it never saw is asked about as id-less', () => {
  const answer = (before) => step({ mode: 'save', text: 'focus' }, { type: 'answer', req: { op: 'save', name: 'focus' }, result: { ok: false, reason: 'taken' }, before, after: before });
  assert.strictEqual(answer(list(['Focus', 'f1'])).id, 'f1');
  assert.strictEqual(answer([]).id, null);
});

test('#59: a push that puts another preset under the name an open question is about closes it and says the preset changed', () => {
  for (const mode of ['rename', 'delete', 'replace']) {
    const s = step({ mode, name: 'Focus', id: 'f1', text: 'x' }, { type: 'list', list: list(['Focus', 'd1']) });
    assert.deepStrictEqual(s, { mode: 'idle', error: P.changedText(mode), focus: { kind: 'save-open' }, select: false }, mode);
  }
  const same = { mode: 'delete', name: 'Focus', id: 'f1' };
  assert.strictEqual(step(same, { type: 'list', list: list(['FOCUS', 'f1']) }), same, 'the same preset, in another case, keeps the question');
});

test('#59: main answering `changed` closes the question and says nothing was done', () => {
  for (const [mode, req] of [
    ['rename', { op: 'rename', name: 'Focus', to: 'B', id: 'f1' }], ['delete', { op: 'delete', name: 'Focus', id: 'f1' }],
    ['replace', { op: 'save', name: 'Focus', replace: true, id: 'f1' }],
  ]) {
    const s = step({ mode, name: 'Focus', id: 'f1', text: 'x' }, { type: 'answer', req, result: { ok: false, reason: 'changed' }, before: [], after: [] });
    assert.deepStrictEqual(s, { mode: 'idle', error: P.changedText(mode), focus: { kind: 'save-open' }, select: false }, mode);
  }
});

test('the words for a preset that changed say nothing was done, naming what was not', () => {
  assert.strictEqual(P.changedText('delete'), 'That preset changed since you asked. Nothing was deleted.');
  assert.strictEqual(P.changedText('rename'), 'That preset changed since you asked. Nothing was renamed.');
  assert.strictEqual(P.changedText('replace'), 'That preset changed since you asked. Nothing was replaced.');
  assert.strictEqual(P.refusalText('changed'), 'That preset changed since you asked. Nothing was changed.');
});
