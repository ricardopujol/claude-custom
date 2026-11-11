'use strict';
/**
 * The registry of project windows (single-instance PR 2, step 1): which window a sender belongs to, and what closing one does.
 * Properties P1 (sender resolution) and P3 (close). Seeded generator loops, like the repo's other property tests.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

let nextSender = 1;
function fakeWindow(root) {
  const strip = { id: nextSender++ };
  const views = [{ id: nextSender++ }, { id: nextSender++ }];
  const panels = [{ id: nextSender++ }];
  const w = {
    root, disposed: 0,
    isStrip: (s) => s === strip,
    isTabView: (s) => views.includes(s),
    canvasViews: { isPanel: (s) => panels.includes(s) },
    dispose() { w.disposed++; },
    strip, views, panels,
  };
  return w;
}

test('add / get / remove / size / first / forEach', () => {
  const r = createProjectRegistry();
  const a = fakeWindow('A'); const b = fakeWindow('B');
  r.add(a); r.add(b);
  assert.strictEqual(r.size(), 2);
  assert.strictEqual(r.get('A'), a);
  assert.strictEqual(r.first(), a, 'insertion order: the first added is the first');
  const seen = []; r.forEach((p) => seen.push(p.root));
  assert.deepStrictEqual(seen, ['A', 'B']);
  r.remove(a);
  assert.strictEqual(r.get('A'), null);
  assert.strictEqual(r.first(), b);
  assert.strictEqual(r.size(), 1);
});

test('an empty registry resolves nothing and has no first', () => {
  const r = createProjectRegistry();
  assert.strictEqual(r.first(), null);
  assert.strictEqual(r.stripOwner({ sender: {} }), null);
  assert.strictEqual(r.stripOwner(null), null);
  assert.strictEqual(r.viewOwner(undefined), null);
  assert.strictEqual(r.panelOwner({}), null);
});

test('adding a second window for the same root is refused (one window per project in a process)', () => {
  const r = createProjectRegistry();
  r.add(fakeWindow('A'));
  assert.throws(() => r.add(fakeWindow('A')), /already/);
});

test('P1: every sender resolves to exactly its own window, in any add/remove order; strips are never view owners', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 5);
    const wins = Array.from({ length: n }, (_, i) => fakeWindow(`P${seed}-${i}`));
    const order = [...wins].sort(() => rand() - 0.5);
    const r = createProjectRegistry();
    for (const w of order) r.add(w);
    const gone = new Set(wins.filter(() => rand() < 0.4));
    for (const w of gone) r.remove(w);
    const stranger = { id: -1 };
    for (const w of wins) {
      const live = !gone.has(w);
      assert.strictEqual(r.stripOwner({ sender: w.strip }), live ? w : null);
      for (const v of w.views) assert.strictEqual(r.viewOwner(v), live ? w : null);
      for (const p of w.panels) assert.strictEqual(r.panelOwner(p), live ? w : null);
      assert.strictEqual(r.viewOwner(w.strip), null, 'a strip is not a tab view');
      assert.strictEqual(r.stripOwner({ sender: w.views[0] }), null, 'a view is not a strip');
      assert.strictEqual(r.viewOwner(w.panels[0]), null, 'a panel is not a tab view');
    }
    assert.strictEqual(r.stripOwner({ sender: stranger }), null);
    assert.strictEqual(r.viewOwner(stranger), null);
    assert.strictEqual(r.panelOwner(stranger), null);
  }
});

test('P3: any close order of N windows disposes exactly N-1, each once; the last is left and the registry is never empty', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed * 7);
    const n = 1 + Math.floor(rand() * 5);
    const wins = Array.from({ length: n }, (_, i) => fakeWindow(`Q${seed}-${i}`));
    const r = createProjectRegistry();
    for (const w of wins) r.add(w);
    const order = [...wins].sort(() => rand() - 0.5);
    const results = order.map((w) => r.closed(w));
    assert.strictEqual(r.size(), 1, 'the last window stays registered for window-all-closed to tear down');
    assert.strictEqual(results.filter((x) => x === true).length, n - 1);
    assert.strictEqual(results[results.length - 1], false, 'the last close is not removed');
    assert.deepStrictEqual(wins.map((w) => w.disposed).reduce((x, y) => x + y, 0), n - 1);
    for (const w of wins) assert.ok(w.disposed <= 1, 'each is disposed at most once');
    const survivor = order[order.length - 1];
    assert.strictEqual(r.first(), survivor);
    assert.strictEqual(survivor.disposed, 0);
  }
});

test('closing a window that is no longer registered does nothing', () => {
  const r = createProjectRegistry();
  const a = fakeWindow('A'); const b = fakeWindow('B');
  r.add(a); r.add(b);
  assert.strictEqual(r.closed(a), true);
  assert.strictEqual(r.closed(a), false, 'a second close of the same window does not dispose it again');
  assert.strictEqual(a.disposed, 1);
});

test('the registry module requires no Electron (it loads under plain node)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'project-registry.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/);
});
