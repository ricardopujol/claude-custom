'use strict';
/** The Files tab's overlay (#45): fog's read / edited data, rolled up into folders. */
const test = require('node:test');
const assert = require('node:assert');
const { rollUp, ancestorsOf } = require('../host/repo-overlay');

const f = (path, tier, edits = 0) => ({ path, tier, edits, touches: edits + 1, lastTouched: 0, brightness: 1 });
const dir = (o, p) => o.dirs.find(d => d.path === p);

test('ancestorsOf lists every folder above a file, outermost first, root included', () => {
  assert.deepStrictEqual(ancestorsOf('a/b/c.js'), ['', 'a', 'a/b']);
  assert.deepStrictEqual(ancestorsOf('c.js'), ['']);
});

test('a folder counts the edits of every file under it, at any depth', () => {
  const o = rollUp([f('a/x.js', 'edited', 2), f('a/b/y.js', 'edited', 3), f('c/z.js', 'edited', 1)]);
  assert.strictEqual(dir(o, 'a').edits, 5);
  assert.strictEqual(dir(o, 'a/b').edits, 3);
  assert.strictEqual(dir(o, 'c').edits, 1);
  assert.strictEqual(dir(o, '').edits, 6);
});

test('a folder says how many of its files were edited and how many only read', () => {
  const o = rollUp([f('a/x.js', 'edited', 2), f('a/y.js', 'read'), f('a/z.js', 'read')]);
  assert.deepStrictEqual({ e: dir(o, 'a').edited, r: dir(o, 'a').read }, { e: 1, r: 2 });
});

test('a read-only folder has zero edits and a read count (so it reads as "only read", not as absent)', () => {
  const o = rollUp([f('docs/a.md', 'read')]);
  assert.strictEqual(dir(o, 'docs').edits, 0);
  assert.strictEqual(dir(o, 'docs').read, 1);
});

test('files carry their tier and edits; dark and unknown tiers are not part of the overlay', () => {
  const o = rollUp([f('a.js', 'edited', 2), f('b.js', 'read'), f('c.js', 'dark'), f('d.js', 'weird')]);
  assert.deepStrictEqual(o.files.map(x => [x.path, x.tier, x.edits]), [['a.js', 'edited', 2], ['b.js', 'read', 0]]);
});

test('an edited file whose count is missing or nonsense still counts as one edit, never zero', () => {
  const o = rollUp([{ path: 'a.js', tier: 'edited' }, { path: 'b.js', tier: 'edited', edits: NaN }, { path: 'c.js', tier: 'edited', edits: -4 }]);
  assert.deepStrictEqual(o.files.map(x => x.edits), [1, 1, 1]);
});

test('a fractional count is floored, an Infinity is one edit', () => {
  const o = rollUp([{ path: 'a.js', tier: 'edited', edits: 2.9 }, { path: 'b.js', tier: 'edited', edits: Infinity }]);
  assert.deepStrictEqual(o.files.map(x => x.edits), [2, 1]);
});

test('nothing touched is an empty overlay, and non-lists are too', () => {
  assert.deepStrictEqual(rollUp([]), { files: [], dirs: [] });
  assert.deepStrictEqual(rollUp(null), { files: [], dirs: [] });
  assert.deepStrictEqual(rollUp([null, {}, { path: '' }, { path: 5, tier: 'read' }]), { files: [], dirs: [] });
});

test('a file named like an Object.prototype member is just a file', () => {
  const o = rollUp([f('__proto__/constructor.js', 'edited', 1), f('toString', 'read')]);
  assert.strictEqual(dir(o, '__proto__').edits, 1);
  assert.strictEqual(dir(o, '').edits, 1);
  assert.strictEqual(o.files.length, 2);
});

test('a duplicate path (two sessions merged badly) is one row, the stronger tier winning', () => {
  const o = rollUp([f('a.js', 'read'), f('a.js', 'edited', 2)]);
  assert.strictEqual(o.files.length, 1);
  assert.strictEqual(o.files[0].tier, 'edited');
  assert.strictEqual(dir(o, '').edits, 2);
});

// ---- PR #95 Dexter D3: the overlay's keys are spelled the way the listing spells them ----

test('D3: App/renderer.js and app/renderer.js are one file: counts add, one row, folder and root agree', () => {
  const o = rollUp([f('app/renderer.js', 'edited', 2), f('App/renderer.js', 'edited', 1), f('APP/RENDERER.JS', 'read')]);
  assert.strictEqual(o.files.length, 1);
  assert.strictEqual(o.files[0].edits, 3);
  assert.strictEqual(o.files[0].tier, 'edited');
  assert.deepStrictEqual(o.dirs.map(d => [d.path, d.edits]), [['', 3], ['app', 3]]);
});

test('D3: the row takes the LISTING\'s spelling when the listing knows the file (every variant spelled otherwise)', () => {
  const resolve = (p) => (p.toLowerCase() === 'app/renderer.js' ? 'app/renderer.js' : null);
  const o = rollUp([f('App\\Renderer.js', 'edited', 2), f('app/renderer.js', 'edited', 1)], { resolve });
  assert.deepStrictEqual(o.files.map(x => [x.path, x.edits]), [['app/renderer.js', 3]]);
  assert.deepStrictEqual(o.dirs.map(d => d.path), ['', 'app']);
});

test('D3: with no listing to ask, the first spelling seen names the file', () => {
  const o = rollUp([f('App/x.js', 'edited', 1), f('app/x.js', 'edited', 1)]);
  assert.deepStrictEqual(o.files.map(x => x.path), ['App/x.js']);
});

test('D3: ./x.js, sub/../x.js and backslashes are the same file as x.js; a path that climbs out or is absolute is no file here', () => {
  const o = rollUp([f('./x.js', 'edited', 1), f('sub/../x.js', 'edited', 1), f('x.js', 'edited', 1), f('..\\up.js', 'edited', 1),
    f('../up.js', 'edited', 1), f('/abs.js', 'edited', 1), f('C:/abs.js', 'edited', 1), f('.', 'edited', 1)]);
  assert.deepStrictEqual(o.files.map(x => [x.path, x.edits]), [['x.js', 3]]);
});
