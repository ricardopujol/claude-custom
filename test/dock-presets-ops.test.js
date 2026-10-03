'use strict';
/**
 * Layout presets (BACKLOG #53, D3): save, rename and delete in app/dock-presets.js. Each returns
 * { ok: true, list } or { ok: false, reason }, never throws and never changes the list it was given.
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../app/dock-presets');

const L = (tag = 'a') => ({ version: 2, root: { type: 'term' }, floats: [], hidden: [tag], seat: {} });
const names = r => r.list.map(p => p.name);
const two = () => [{ name: 'Review', layout: L('r') }, { name: 'Write', layout: L('w') }];

// --- savePreset ----------------------------------------------------------------

test('save appends a new preset, trimmed, with a copy of the layout', () => {
  const layout = L('n');
  const r = P.savePreset(two(), '  Plan ', layout);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['Review', 'Write', 'Plan']);
  assert.deepStrictEqual(r.list[2].layout, L('n'));
  layout.hidden.push('later');
  assert.deepStrictEqual(r.list[2].layout, L('n'), 'the saved layout is not the live object');
});

test('save into an empty or junk list starts a list', () => {
  for (const start of [[], null, undefined, 'x', {}]) assert.deepStrictEqual(names(P.savePreset(start, 'One', L())), ['One']);
});

test('save refuses a bad name with `name`', () => {
  for (const bad of ['', '  ', 'x'.repeat(41), 'a\nb', null, 7]) {
    assert.deepStrictEqual(P.savePreset(two(), bad, L()), { ok: false, reason: 'name' }, JSON.stringify(bad));
  }
});

test('save refuses a layout that is not an object, or is over the size cap, with `layout`', () => {
  for (const bad of [null, [], 'x', 7, undefined, { pad: 'x'.repeat(P.MAX_PRESET_BYTES) }]) {
    assert.deepStrictEqual(P.savePreset(two(), 'Ok', bad), { ok: false, reason: 'layout' });
  }
});

test('save under a name that exists (ignoring case) is `taken` and changes nothing', () => {
  const list = two();
  assert.deepStrictEqual(P.savePreset(list, 'review', L('z')), { ok: false, reason: 'taken' });
  assert.deepStrictEqual(P.savePreset(list, ' REVIEW ', L('z')), { ok: false, reason: 'taken' });
  assert.deepStrictEqual(list, two());
});

test('save with `replace` replaces in place, takes the typed name, and keeps the order', () => {
  const r = P.savePreset(two(), 'review', L('z'), { replace: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['review', 'Write']);
  assert.deepStrictEqual(r.list[0].layout, L('z'));
});

test('`replace` on a name that is not there is a plain save', () => {
  assert.deepStrictEqual(names(P.savePreset(two(), 'New', L(), { replace: true })), ['Review', 'Write', 'New']);
});

test('the 33rd save is `full`; replacing one of 32 is still allowed', () => {
  const full = Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`, layout: L() }));
  assert.deepStrictEqual(P.savePreset(full, 'extra', L()), { ok: false, reason: 'full' });
  assert.strictEqual(P.savePreset(full, 'P5', L('z'), { replace: true }).list.length, 32);
  const almost = full.slice(0, 31);
  assert.strictEqual(P.savePreset(almost, 'extra', L()).list.length, 32);
});

test('a bad name wins over a full list, so the reason shown is the one the user can fix first', () => {
  const full = Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`, layout: L() }));
  assert.strictEqual(P.savePreset(full, '', L()).reason, 'name');
});

test('save never changes the list it was given', () => {
  const list = two();
  P.savePreset(list, 'Plan', L());
  P.savePreset(list, 'Review', L('z'), { replace: true });
  assert.deepStrictEqual(list, two());
});

// --- renamePreset --------------------------------------------------------------

test('rename changes the name in place and keeps the layout and the order', () => {
  const r = P.renamePreset(two(), 'Review', ' Reviewing ');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['Reviewing', 'Write']);
  assert.deepStrictEqual(r.list[0].layout, L('r'));
});

test('rename finds the preset ignoring case', () => {
  assert.deepStrictEqual(names(P.renamePreset(two(), 'wRiTe', 'Docs')), ['Review', 'Docs']);
});

test('rename to another case of its own name is allowed', () => {
  assert.deepStrictEqual(names(P.renamePreset(two(), 'Review', 'REVIEW')), ['REVIEW', 'Write']);
});

test('rename to a name another preset has is `taken`', () => {
  assert.deepStrictEqual(P.renamePreset(two(), 'Review', 'write'), { ok: false, reason: 'taken' });
});

test('rename of a preset that is not there is `missing`; to a bad name is `name`', () => {
  assert.deepStrictEqual(P.renamePreset(two(), 'Nope', 'X'), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(P.renamePreset(two(), 'Review', ''), { ok: false, reason: 'name' });
  assert.deepStrictEqual(P.renamePreset(two(), 'Review', 'x'.repeat(41)), { ok: false, reason: 'name' });
});

test('rename checks the preset exists before it judges the new name', () => {
  assert.strictEqual(P.renamePreset(two(), 'Nope', '').reason, 'missing');
});

test('rename never changes the list it was given', () => {
  const list = two();
  P.renamePreset(list, 'Review', 'Other');
  assert.deepStrictEqual(list, two());
});

// --- deletePreset --------------------------------------------------------------

test('delete removes the preset, ignoring case, and keeps the others in order', () => {
  const r = P.deletePreset(two(), 'REVIEW');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['Write']);
});

test('delete of a preset that is not there is `missing`', () => {
  assert.deepStrictEqual(P.deletePreset(two(), 'Nope'), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(P.deletePreset([], 'x'), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(P.deletePreset(two(), 7), { ok: false, reason: 'missing' });
});

test('delete never changes the list it was given', () => {
  const list = two();
  P.deletePreset(list, 'Review');
  assert.deepStrictEqual(list, two());
});

test('find returns the preset by name, ignoring case and padding', () => {
  assert.strictEqual(P.find(two(), ' wRITE ').layout.hidden[0], 'w');
  assert.strictEqual(P.find(two(), 'nope'), null);
  assert.strictEqual(P.find(null, 'x'), null);
});
