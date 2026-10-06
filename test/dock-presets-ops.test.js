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

test('save into an empty list starts a list; a stored value that is not a list is `unreadable`, never an empty list', () => {
  assert.deepStrictEqual(names(P.savePreset([], 'One', L())), ['One']);
  for (const start of [null, undefined, 'x', {}, 7]) {
    assert.deepStrictEqual(P.savePreset(start, 'One', L()), { ok: false, reason: 'unreadable' }, String(start));
    assert.deepStrictEqual(P.renamePreset(start, 'One', 'Two'), { ok: false, reason: 'unreadable' }, String(start));
    assert.deepStrictEqual(P.deletePreset(start, 'One'), { ok: false, reason: 'unreadable' }, String(start));
  }
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

// --- nothing this build can't understand is erased (PR #103 Dexter 6, Miguel I7) ----

// What another build (or a newer one) may have stored: an unknown field, a junk entry, a name over 40, a layout
// over the cap, a duplicate by case, and a shape nobody here knows.
const foreign = () => [
  { name: 'Kept', layout: L('k'), pinned: true },
  'junk',
  { name: 'x'.repeat(45), layout: L('long') },
  null,
  { name: 'kept', layout: L('dup') },
  { name: 'Big', layout: { pad: 'x'.repeat(P.MAX_PRESET_BYTES) } },
  { name: 'Mine', layout: L('m') },
  { shape: 'from the future' },
];

test('a save leaves every stored entry as it was and appends the new one', () => {
  const r = P.savePreset(foreign(), 'New', L('n'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.list.slice(0, 8), foreign());
  assert.deepStrictEqual(r.list[8], { name: 'New', layout: L('n') });
  assert.strictEqual(r.list.length, 9);
});

test('rename and replace change only the entry operated on: its unknown fields survive', () => {
  const renamed = P.renamePreset(foreign(), 'kept', 'Renamed');
  assert.strictEqual(renamed.ok, true);
  assert.deepStrictEqual(renamed.list[0], { name: 'Renamed', layout: L('k'), pinned: true });
  assert.deepStrictEqual(renamed.list.slice(1), foreign().slice(1));
  const replaced = P.savePreset(foreign(), 'KEPT', L('z'), { replace: true });
  assert.deepStrictEqual(replaced.list[0], { name: 'KEPT', layout: L('z'), pinned: true });
  assert.deepStrictEqual(replaced.list.slice(1), foreign().slice(1));
});

test('a delete removes that entry and nothing else, entries this build cannot use included', () => {
  const r = P.deletePreset(foreign(), 'Mine');
  assert.deepStrictEqual(r.list, foreign().filter((_, i) => i !== 6));
});

test('the display view shows what this build can use, and says how many it keeps without showing', () => {
  const d = P.describe(foreign());
  assert.deepStrictEqual(d.list.map(p => p.name), ['Kept', 'Mine']);
  assert.strictEqual(d.kept, 6);
  assert.deepStrictEqual(P.describe([]), { list: [], kept: 0 });
  assert.deepStrictEqual(P.describe(null), { list: [], kept: 0 });
});

test('the cap of 32 counts every stored entry, the ones this build cannot show included', () => {
  const stored = [...Array.from({ length: 31 }, () => 'junk'), { name: 'Only', layout: L() }];
  assert.deepStrictEqual(P.savePreset(stored, 'Extra', L()), { ok: false, reason: 'full' });
  assert.strictEqual(P.savePreset(stored, 'only', L('z'), { replace: true }).ok, true, 'replacing in place is not growing');
  assert.strictEqual(P.deletePreset(stored, 'Only').ok, true, 'a full list can always be thinned');
});

test('the display view is no longer capped: a stored 40 are all shown, not silently cut to 32', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, layout: L() }));
  assert.strictEqual(P.cleanPresets(many).length, 40);
});

// --- one cap, consistent (PR #103 Dexter 8, Miguel I6) ---------------------------------

const maxLayout = () => ({ pad: 'x'.repeat(P.MAX_PRESET_BYTES - '{"pad":""}'.length) });

test('the byte cap of the whole list is derived from the per-entry limits, and 32 maximal entries fit under it', () => {
  assert.strictEqual(P.MAX_LIST_BYTES, P.MAX_PRESETS * (P.MAX_PRESET_BYTES + 512));
  assert.strictEqual(Buffer.byteLength(JSON.stringify(maxLayout())), P.MAX_PRESET_BYTES);
  const widest = '\u{1F600}'.repeat(P.NAME_MAX);
  const list = Array.from({ length: 32 }, (_, i) => ({ name: [...widest].slice(0, 38).join('') + String(10 + i), layout: maxLayout() }));
  assert.strictEqual(list.every(p => P.checkName(p.name) === p.name), true);
  assert.ok(Buffer.byteLength(JSON.stringify(list)) <= P.MAX_LIST_BYTES, 'the page\'s own rules never produce a list over the cap');
  // ...so a replace in a list of 32 maximal entries, which the page's rules allow, is stored
  const r = P.savePreset(list, list[3].name, maxLayout(), { replace: true });
  assert.strictEqual(r.ok, true);
});

test('a stored list already over the cap refuses growth but still lets a delete through', () => {
  const stuffed = [{ name: 'Huge', layout: L(), blob: 'x'.repeat(P.MAX_LIST_BYTES) }];
  assert.deepStrictEqual(P.savePreset(stuffed, 'More', L()), { ok: false, reason: 'full' });
  assert.strictEqual(P.deletePreset(stuffed, 'Huge').ok, true);
});

// --- applyOp: the one entry main uses ----------------------------------------------------

test('applyOp runs save, rename and delete over the stored list', () => {
  const saved = P.applyOp(two(), { op: 'save', name: 'Plan', layout: L('p') });
  assert.deepStrictEqual(names(saved), ['Review', 'Write', 'Plan']);
  const idd = () => [{ name: 'Review', layout: L('r'), id: 'r1' }, { name: 'Write', layout: L('w'), id: 'w1' }];   // applyOp asks for the id
  assert.deepStrictEqual(names(P.applyOp(idd(), { op: 'save', name: 'review', layout: L('z'), replace: true, id: 'r1' })), ['review', 'Write']);
  assert.deepStrictEqual(names(P.applyOp(idd(), { op: 'rename', name: 'Review', to: 'Docs', id: 'r1' })), ['Docs', 'Write']);
  assert.deepStrictEqual(names(P.applyOp(idd(), { op: 'delete', name: 'Write', id: 'w1' })), ['Review']);
});

test('applyOp refuses what it does not understand with a named reason and never throws', () => {
  for (const bad of [null, undefined, 'save', 7, [], {}, { op: 'drop' }, { op: 'constructor' }, { op: '__proto__' }]) {
    assert.deepStrictEqual(P.applyOp(two(), bad), { ok: false, reason: 'op' }, JSON.stringify(bad));
  }
  assert.deepStrictEqual(P.applyOp(null, { op: 'delete', name: 'x' }), { ok: false, reason: 'unreadable' });
  assert.deepStrictEqual(P.applyOp(two(), { op: 'rename', name: {}, to: [] }), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(P.applyOp(two(), { op: 'save', name: 'x', layout: 'no' }), { ok: false, reason: 'layout' });
});
