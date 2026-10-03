'use strict';
/**
 * Layout presets (BACKLOG #53, dockable panels D3): the pure list rules of app/dock-presets.js.
 * A preset is { name, layout }; the list is what main stores under `layout-presets`.
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../app/dock-presets');

const L = (tag = 'a') => ({ version: 2, root: { type: 'term' }, floats: [], hidden: [tag], seat: {} });

// --- names ---------------------------------------------------------------------

test('the limits are the ones the design states', () => {
  assert.strictEqual(P.NAME_MAX, 40);
  assert.strictEqual(P.MAX_PRESETS, 32);
  assert.strictEqual(P.MAX_PRESET_BYTES, 8192);
});

test('checkName trims, and accepts 1 to 40 characters', () => {
  assert.strictEqual(P.checkName('  Reviewing  '), 'Reviewing');
  assert.strictEqual(P.checkName('a'), 'a');
  assert.strictEqual(P.checkName('x'.repeat(40)), 'x'.repeat(40));
});

test('checkName refuses empty, over 40, control characters and non-strings', () => {
  for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0000b', 'tab\there', 'del\u007f', 'c1\u0085', 7, null, undefined, {}, []]) {
    assert.strictEqual(P.checkName(bad), null, JSON.stringify(bad));
  }
});

test('checkName counts characters, not UTF-16 units', () => {
  assert.strictEqual(P.checkName('\u{1F600}'.repeat(40)), '\u{1F600}'.repeat(40));
  assert.strictEqual(P.checkName('\u{1F600}'.repeat(41)), null);
});

test('trimming happens before the length check', () => {
  assert.strictEqual(P.checkName(` ${'x'.repeat(40)} `), 'x'.repeat(40));
});

// --- cleanPresets --------------------------------------------------------------

test('anything that is not an array is an empty list', () => {
  for (const bad of [null, undefined, 'x', 7, {}, true]) assert.deepStrictEqual(P.cleanPresets(bad), [], String(bad));
});

test('cleanPresets keeps good entries in order, trimmed, with only name and layout', () => {
  const out = P.cleanPresets([{ name: ' One ', layout: L(), extra: 1 }, { name: 'Two', layout: L('b') }]);
  assert.deepStrictEqual(out, [{ name: 'One', layout: L() }, { name: 'Two', layout: L('b') }]);
});

test('cleanPresets drops entries with a bad name or a layout that is not an object', () => {
  const out = P.cleanPresets([
    null, 'x', [], { name: '', layout: L() }, { name: 'ok' }, { name: 'ok', layout: [] }, { name: 'ok', layout: 'x' },
    { name: 7, layout: L() }, { name: 'Good', layout: L() },
  ]);
  assert.deepStrictEqual(out.map(p => p.name), ['Good']);
});

test('cleanPresets drops a preset over 8192 bytes, and keeps one just under', () => {
  const big = { name: 'Big', layout: { pad: 'x'.repeat(P.MAX_PRESET_BYTES) } };
  assert.deepStrictEqual(P.cleanPresets([big]), []);
  const fits = { name: 'Fits', layout: { pad: 'x'.repeat(P.MAX_PRESET_BYTES - 40) } };
  assert.strictEqual(P.cleanPresets([fits]).length, 1);
});

test('cleanPresets keeps the first of two names that differ only by case', () => {
  const out = P.cleanPresets([{ name: 'Review', layout: L('a') }, { name: 'review', layout: L('b') }, { name: 'Other', layout: L() }]);
  assert.deepStrictEqual(out.map(p => p.name), ['Review', 'Other']);
  assert.deepStrictEqual(out[0].layout, L('a'));
});

test('cleanPresets keeps at most 32', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, layout: L() }));
  const out = P.cleanPresets(many);
  assert.strictEqual(out.length, 32);
  assert.strictEqual(out[31].name, 'p31');
});

test('cleanPresets does not throw on a layout that cannot be serialized', () => {
  const loop = {};
  loop.self = loop;
  assert.deepStrictEqual(P.cleanPresets([{ name: 'Loop', layout: loop }, { name: 'Fine', layout: L() }]).map(p => p.name), ['Fine']);
  assert.deepStrictEqual(P.cleanPresets([{ name: 'Big', layout: { n: 10n } }]), []);
});

test('cleanPresets returns copies: changing the result never changes the input', () => {
  const input = [{ name: 'A', layout: L() }];
  const out = P.cleanPresets(input);
  out[0].layout.hidden.push('zzz');
  out[0].name = 'changed';
  assert.deepStrictEqual(input, [{ name: 'A', layout: L() }]);
});
