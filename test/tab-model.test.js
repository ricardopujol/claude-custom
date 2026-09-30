'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const m = require('../app/tab-model');

const DEV = { path: 'C:\\p\\dev', branch: 'develop', isDev: true, phase: 'live', hostSeen: true };
const A = { path: 'C:\\p\\feat-a', branch: 'feat/a', isDev: false, phase: 'live', hostSeen: true };
const B = { path: 'C:\\p\\feat-b', branch: 'feat/b', isDev: false, phase: 'live', hostSeen: false };
const keyOf = p => p.toLowerCase();
const strip = (tabs, runtime = {}, sel = keyOf(DEV.path)) => m.stripModel({ tabs }, runtime, sel, { keyOf });

test('label is the branch', () => {
  assert.deepStrictEqual(strip([DEV, A]).map(e => e.label), ['develop', 'feat/a']);
});

test('a null or non-string branch labels with the folder name', () => {
  const rebasing = { ...A, branch: null };
  assert.strictEqual(strip([DEV, rebasing])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, branch: 42 }])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, path: 'C:\\p\\feat-a\\', branch: null }])[1].label, 'feat-a');
  assert.strictEqual(strip([DEV, { ...A, path: '/p/feat-a', branch: null }])[1].label, 'feat-a');
});

test('closable: never dev, never a lone tab', () => {
  assert.deepStrictEqual(strip([DEV, A, B]).map(e => e.closable), [false, true, true]);
  assert.deepStrictEqual(strip([DEV]).map(e => e.closable), [false]);
  assert.deepStrictEqual(strip([A]).map(e => e.closable), [false]);
});

test('lock glyphs', () => {
  const g = lock => strip([DEV], { [keyOf(DEV.path)]: { status: { lock } } })[0].lockGlyph;
  assert.strictEqual(g('override'), 'open');
  assert.strictEqual(g('unlocked'), 'warn');
  assert.strictEqual(g('blocked'), 'blocked');
  assert.strictEqual(g('held'), null);
  assert.strictEqual(g('pending'), null);
  assert.strictEqual(g(null), null);
  assert.strictEqual(g('whatever'), null);
});

test('health passes through as text; null stays null', () => {
  const h = health => strip([DEV], new Map([[keyOf(DEV.path), { status: { health } }]]))[0].health;
  assert.strictEqual(h('↓3'), '↓3');
  assert.strictEqual(h('+12'), '+12');
  assert.strictEqual(h(null), null);
  assert.strictEqual(h(undefined), null);
  assert.strictEqual(h(''), null);
});

test('working / needsInput follow the status; a null status is false / null everywhere', () => {
  const k = keyOf(DEV.path);
  const on = strip([DEV], { [k]: { started: true, status: { working: true, needsInput: true } } })[0];
  assert.strictEqual(on.working, true);
  assert.strictEqual(on.needsInput, true);
  assert.strictEqual(on.started, true);
  for (const rt of [{}, { [k]: { started: false, status: null } }, { [k]: {} }]) {
    const e = strip([DEV], rt)[0];
    assert.strictEqual(e.working, false);
    assert.strictEqual(e.needsInput, false);
    assert.strictEqual(e.lockGlyph, null);
    assert.strictEqual(e.health, null);
    assert.strictEqual(e.started, false);
  }
});

test('phase and error come from the reducer', () => {
  const e = strip([DEV, { ...A, phase: 'remove-failed', error: 'busy' }])[1];
  assert.strictEqual(e.phase, 'remove-failed');
  assert.strictEqual(e.error, 'busy');
  assert.strictEqual(strip([DEV])[0].error, null);
});

test('selection: matching key, else dev', () => {
  const sel = model => model.filter(e => e.selected).map(e => e.key);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, keyOf(B.path))), [keyOf(B.path)]);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, 'nope')), [keyOf(DEV.path)]);
  assert.deepStrictEqual(sel(strip([DEV, A, B], {}, undefined)), [keyOf(DEV.path)]);
});

test('dev is moved first', () => {
  assert.strictEqual(strip([A, DEV, B])[0].isDev, true);
});

test('select: existing key or the selection unchanged', () => {
  const model = strip([DEV, A], {}, keyOf(A.path));
  assert.strictEqual(m.select(model, keyOf(DEV.path)), keyOf(DEV.path));
  assert.strictEqual(m.select(model, 'nope'), keyOf(A.path));
});

test('neighbour wraps both ways', () => {
  const model = strip([DEV, A, B]);
  const [d, a, b] = model.map(e => e.key);
  assert.strictEqual(m.neighbour(model, d, 1), a);
  assert.strictEqual(m.neighbour(model, b, 1), d);
  assert.strictEqual(m.neighbour(model, d, -1), b);
  assert.strictEqual(m.neighbour(model, a, -1), d);
});

test('afterClose: unselected close keeps selection; selected goes right, else left', () => {
  const model = strip([DEV, A, B]);
  const [d, a, b] = model.map(e => e.key);
  assert.strictEqual(m.afterClose(model, b, a), a);
  assert.strictEqual(m.afterClose(model, a, a), b);
  assert.strictEqual(m.afterClose(model, b, b), a);
  assert.strictEqual(m.afterClose(strip([DEV, A]), keyOf(A.path), keyOf(A.path)), d);
});

test('initialSelection: equal, containing (deepest), else dev', () => {
  const isInside = (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase() + '\\');
  const opts = { keyOf, isInside };
  const tabs = [DEV, A, B];
  assert.strictEqual(m.initialSelection(tabs, 'C:\\P\\FEAT-A', opts), keyOf(A.path));
  assert.strictEqual(m.initialSelection(tabs, 'C:\\p\\feat-b\\src\\x', opts), keyOf(B.path));
  assert.strictEqual(m.initialSelection(tabs, 'C:\\elsewhere', opts), keyOf(DEV.path));
  assert.strictEqual(m.initialSelection(tabs, null, opts), keyOf(DEV.path));
  assert.strictEqual(m.initialSelection([], 'C:\\x', opts), null);
  const nested = [DEV, { ...A, path: 'C:\\p\\feat-a' }, { ...B, path: 'C:\\p\\feat-a\\inner' }];
  assert.strictEqual(m.initialSelection(nested, 'C:\\p\\feat-a\\inner\\z', opts), keyOf('C:\\p\\feat-a\\inner'));
});

// --- properties ------------------------------------------------------------

const stateArb = fc.tuple(
  fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 0, maxLength: 6 }),
  fc.boolean(),
).map(([names, devFirst]) => {
  const tabs = names.map(n => ({ path: `C:\\p\\${n}`, branch: n, isDev: false, phase: 'live', hostSeen: true }));
  return devFirst ? [{ ...DEV }, ...tabs] : [...tabs, { ...DEV }];
});

test('PROPERTY: dev is first and unique; exactly one selected; dev never closable', () => {
  fc.assert(fc.property(stateArb, fc.string(), (tabs, sel) => {
    const model = strip(tabs, {}, sel);
    assert.strictEqual(model[0].isDev, true);
    assert.strictEqual(model.filter(e => e.isDev).length, 1);
    assert.strictEqual(model.filter(e => e.selected).length, 1);
    assert.ok(model.every(e => !(e.isDev && e.closable)));
    assert.ok(model.some(e => e.key === m.select(model, sel)));
  }));
});

test('PROPERTY: neighbour stepping +1 n times visits every tab once and returns to the start', () => {
  fc.assert(fc.property(stateArb, fc.nat(), (tabs, pick) => {
    const model = strip(tabs);
    const start = model[pick % model.length].key;
    const seen = [];
    let cur = start;
    for (let i = 0; i < model.length; i++) { cur = m.neighbour(model, cur, 1); seen.push(cur); }
    assert.strictEqual(cur, start);
    assert.deepStrictEqual([...seen].sort(), model.map(e => e.key).sort());
    assert.strictEqual(m.neighbour(model, m.neighbour(model, start, 1), -1), start);
  }));
});

test('PROPERTY: afterClose never selects the closed key and always names an existing tab', () => {
  fc.assert(fc.property(stateArb, fc.nat(), fc.nat(), (tabs, ci, si) => {
    const model = strip(tabs);
    fc.pre(model.length > 1);
    const closed = model[ci % model.length].key;
    const selected = model[si % model.length].key;
    const next = m.afterClose(model, closed, selected);
    assert.notStrictEqual(next, closed);
    assert.ok(model.some(e => e.key === next));
    if (closed !== selected) assert.strictEqual(next, selected);
  }));
});
