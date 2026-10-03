'use strict';
/**
 * Layout presets (BACKLOG #53, D3): what the page does with the list -- the thumbnail boxes, how the store's
 * answer is read, and the words for a refusal. Pure; the menu that shows them is measured by
 * verify/probe-dock-tree.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../app/dock-presets');
const T = require('../app/dock-tree');

const IDS = ['agents', 'vault', 'git'];
const fitReal = (layout, ids, vp) => T.fit(T.normalize(layout, ids), null, vp);

// --- thumbBoxes ------------------------------------------------------------------

test('thumbnail constants: a 1200 x 750 window drawn into 44 x 28', () => {
  assert.deepStrictEqual(P.THUMB, { width: 44, height: 28, window: { width: 1200, height: 750 } });
});

test('the default layout is a terminal and one group on the right, scaled into the thumbnail', () => {
  const boxes = P.thumbBoxes(T.defaultLayout(IDS), IDS, fitReal);
  assert.deepStrictEqual(boxes.map(b => b.kind), ['term', 'group']);
  const [term, group] = boxes;
  // fitted: term 1015 wide (the gutter is 5), group 180 wide; both 750 tall. Scale 44/1200.
  assert.strictEqual(term.x, 0);
  assert.strictEqual(term.y, 0);
  assert.ok(Math.abs(term.w - 1015 * 44 / 1200) < 0.06, String(term.w));
  assert.strictEqual(term.h, 28);
  assert.ok(Math.abs(group.x - 1020 * 44 / 1200) < 0.06, String(group.x));
  assert.ok(Math.abs(group.w - 180 * 44 / 1200) < 0.06, String(group.w));
});

test('only terminals and groups are drawn: no gutters, no rails', () => {
  const calls = [];
  const fake = (layout, ids, vp) => {
    calls.push(vp);
    return { boxes: [
      { kind: 'term', rect: { x: 0, y: 0, width: 600, height: 750 } },
      { kind: 'gutter', rect: { x: 600, y: 0, width: 5, height: 750 } },
      { kind: 'rail', rect: { x: 605, y: 0, width: 28, height: 750 } },
      { kind: 'group', id: 'g', tabs: [], rect: { x: 633, y: 0, width: 567, height: 750 } },
    ] };
  };
  const boxes = P.thumbBoxes({}, IDS, fake);
  assert.deepStrictEqual(boxes.map(b => b.kind), ['term', 'group']);
  assert.deepStrictEqual(calls, [{ width: 1200, height: 750 }]);
});

test('a box is never thinner than one pixel and never leaves the thumbnail', () => {
  const fake = () => ({ boxes: [
    { kind: 'group', rect: { x: 0, y: 0, width: 3, height: 3 } },
    { kind: 'term', rect: { x: 1190, y: 740, width: 500, height: 500 } },
  ] });
  const [a, b] = P.thumbBoxes({}, IDS, fake);
  assert.ok(a.w >= 1 && a.h >= 1, JSON.stringify(a));
  assert.ok(b.x + b.w <= 44 + 1e-9 && b.y + b.h <= 28 + 1e-9, JSON.stringify(b));
});

test('a fit that throws or answers junk draws nothing', () => {
  assert.deepStrictEqual(P.thumbBoxes({}, IDS, () => { throw new Error('x'); }), []);
  for (const junk of [null, undefined, 7, {}, { boxes: 'x' }, { boxes: [null, 7, { kind: 'term' }, { kind: 'term', rect: { x: 'a' } }] }]) {
    assert.deepStrictEqual(P.thumbBoxes({}, IDS, () => junk), [], JSON.stringify(junk));
  }
  assert.deepStrictEqual(P.thumbBoxes({}, IDS, null), []);
});

test('a stored layout that names a module this build lacks still draws, through the page\'s normalize', () => {
  const l = { version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'term' }, { type: 'group', id: 'g', tabs: ['ghost', 'vault'] }], sizes: [0, 200] }, floats: [], hidden: [], seat: {} };
  assert.strictEqual(P.thumbBoxes(l, IDS, fitReal).length, 2);
});

// --- afterGet ----------------------------------------------------------------------

test('afterGet: an ok answer is a usable list of what this build can show, with how many it keeps unseen', () => {
  const r = P.afterGet({ status: 'ok', layout: [{ name: ' A ', layout: { version: 2 } }, { name: '' }] });
  assert.deepStrictEqual(r, { usable: true, list: [{ name: 'A', layout: { version: 2 } }], kept: 1 });
});

test('afterGet: MISSING is a usable empty list (the first save creates the file)', () => {
  assert.deepStrictEqual(P.afterGet({ status: 'missing', layout: null }), { usable: true, list: [], kept: 0 });
});

test('afterGet: unreadable, corrupt, an unknown status or no answer is NOT "no presets"', () => {
  for (const a of [{ status: 'unreadable', layout: null }, { status: 'corrupt', layout: null }, { status: 'weird' }, null, undefined, 'x', {}]) {
    assert.deepStrictEqual(P.afterGet(a), { usable: false, list: [], kept: 0 }, JSON.stringify(a));
  }
});

test('afterGet: an ok answer whose value is not an array is corrupt, not an empty list', () => {
  for (const v of [{}, 'x', 7, null]) assert.deepStrictEqual(P.afterGet({ status: 'ok', layout: v }), { usable: false, list: [], kept: 0 }, JSON.stringify(v));
});

// --- afterOp -------------------------------------------------------------------------

test('afterOp: main answers { ok, list } with the stored list; the page shows what it can and counts the rest', () => {
  const stored = [{ name: 'A', layout: { version: 2 } }, 'junk', { name: 'B', layout: { version: 2 }, pinned: 1 }];
  assert.deepStrictEqual(P.afterOp({ ok: true, list: stored }), {
    ok: true, list: [{ name: 'A', layout: { version: 2 } }, { name: 'B', layout: { version: 2 } }], kept: 1,
  });
});

test('afterOp: a refusal keeps its reason; anything else (no answer, junk, a list that is not a list) is `failed`', () => {
  assert.deepStrictEqual(P.afterOp({ ok: false, reason: 'taken' }), { ok: false, reason: 'taken' });
  assert.deepStrictEqual(P.afterOp({ ok: false, reason: 'unreadable' }), { ok: false, reason: 'unreadable' });
  for (const bad of [null, undefined, 'x', 7, [], {}, { ok: true }, { ok: true, list: {} }, { ok: false }, { ok: false, reason: 7 }]) {
    assert.deepStrictEqual(P.afterOp(bad), { ok: false, reason: 'failed' }, JSON.stringify(bad));
  }
});

// --- keptText ------------------------------------------------------------------------

test('keptText says how many presets from another version are kept, and nothing when none', () => {
  assert.strictEqual(P.keptText(0), '');
  assert.strictEqual(P.keptText(1), '1 preset from another version is kept');
  assert.strictEqual(P.keptText(2), '2 presets from another version are kept');
});

// --- refusalText ---------------------------------------------------------------------

test('every refusal has its own words, and an unknown one still says something', () => {
  const reasons = ['name', 'taken', 'full', 'missing', 'layout', 'unreadable', 'failed'];
  const texts = reasons.map(P.refusalText);
  for (const t of texts) assert.ok(typeof t === 'string' && t.length > 10, t);
  assert.strictEqual(new Set(texts).size, reasons.length);
  assert.match(P.refusalText('nonsense'), /couldn't/i);
  assert.notStrictEqual(P.refusalText('failed'), P.refusalText('nonsense'), '`failed` has words of its own');
  assert.notStrictEqual(P.refusalText('op'), P.refusalText('failed'));
  assert.match(P.refusalText('full'), /32/);
  assert.match(P.refusalText('name'), /40/);
});

// =====================================================================================
// The Presets section's state as a pure reducer `(state, event) -> state` (BACKLOG #53, D3): what the open Window
// menu is doing, where focus goes after every change, what a refusal says, and what an open field does when
// another window changes the list under it. PR #103 Dexter 3 and 4, Miguel I1, I2, I3, I5, S4.

const MENU_L = (tag = 'a') => ({ version: 2, root: { type: 'term' }, floats: [], hidden: [tag], seat: {} });
const list = (...names) => names.map(name => ({ name, layout: MENU_L(name) }));
const IDLE = { mode: 'idle' };
const step = (state, event) => P.reduceMenu(state, event);

// --- opening, typing, backing out --------------------------------------------------------

test('opening the save field: empty text, focus and select the field once', () => {
  const s = step(IDLE, { type: 'open', mode: 'save' });
  assert.deepStrictEqual(s, { mode: 'save', text: '', error: null, focus: { kind: 'field' }, select: true });
});

test('opening rename: the field holds the current name, selected; opening delete: focus lands on the confirm button', () => {
  assert.deepStrictEqual(step(IDLE, { type: 'open', mode: 'rename', name: 'Review' }),
    { mode: 'rename', name: 'Review', text: 'Review', error: null, focus: { kind: 'field' }, select: true });
  assert.deepStrictEqual(step(IDLE, { type: 'open', mode: 'delete', name: 'Review' }),
    { mode: 'delete', name: 'Review', error: null, focus: { kind: 'confirm' }, select: false });
});

test('typing keeps the text and does not touch focus or the error line', () => {
  const s = step({ mode: 'save', text: '', error: 'x', focus: null, select: false }, { type: 'typed', text: 'Rev' });
  assert.deepStrictEqual(s, { mode: 'save', text: 'Rev', error: 'x', focus: null, select: false });
});

test('the field is selected only when it opens: once focus is applied, a redraw does not select again', () => {
  const opened = step(IDLE, { type: 'open', mode: 'save' });
  assert.strictEqual(opened.select, true);
  const settled = step(opened, { type: 'focused' });
  assert.strictEqual(settled.select, false);
  assert.strictEqual(settled.focus, null);
  assert.strictEqual(settled.text, '');
});

test('cancel goes back to idle and sends focus to the control that opened the field or question', () => {
  assert.deepStrictEqual(step({ mode: 'save', text: 'x' }, { type: 'cancel' }), { mode: 'idle', focus: { kind: 'save-open' }, select: false });
  assert.deepStrictEqual(step({ mode: 'replace', name: 'A', text: 'a' }, { type: 'cancel' }), { mode: 'idle', focus: { kind: 'save-open' }, select: false });
  assert.deepStrictEqual(step({ mode: 'rename', name: 'A', text: 'b' }, { type: 'cancel' }), { mode: 'idle', focus: { kind: 'act', name: 'A', act: 'rename' }, select: false });
  assert.deepStrictEqual(step({ mode: 'delete', name: 'A' }, { type: 'cancel' }), { mode: 'idle', focus: { kind: 'act', name: 'A', act: 'delete' }, select: false });
  assert.deepStrictEqual(step(IDLE, { type: 'cancel' }), IDLE, 'nothing open: nothing changes');
});

test('a name that is taken asks to replace it, naming it, with the text kept and focus on the confirm button', () => {
  const s = step({ mode: 'save', text: 'review' }, { type: 'taken', name: 'Review', text: 'review' });
  assert.deepStrictEqual(s, { mode: 'replace', name: 'Review', text: 'review', error: null, focus: { kind: 'confirm' }, select: false });
});

// --- answers from main ---------------------------------------------------------------------

const answer = (state, req, result, before, after) => step(state, { type: 'answer', req, result, before, after });

test('a save that worked: idle, focus on that preset\'s row (found by the name main stored)', () => {
  const s = answer({ mode: 'save', text: 'plan' }, { op: 'save', name: 'plan' }, { ok: true }, list('A'), list('A', 'Plan'));
  assert.deepStrictEqual(s, { mode: 'idle', focus: { kind: 'row', name: 'Plan' }, select: false });
  const r = answer({ mode: 'replace', name: 'A', text: 'a' }, { op: 'save', name: 'A', replace: true }, { ok: true }, list('A'), list('a'));
  assert.deepStrictEqual(r.focus, { kind: 'row', name: 'a' });
});

test('a rename that worked: focus on the renamed row', () => {
  const s = answer({ mode: 'rename', name: 'A', text: 'Z' }, { op: 'rename', name: 'A', to: 'Z' }, { ok: true }, list('A', 'B'), list('Z', 'B'));
  assert.deepStrictEqual(s, { mode: 'idle', focus: { kind: 'row', name: 'Z' }, select: false });
});

test('a delete that worked: focus on the next row, else the previous, else Save this layout', () => {
  const del = (name, before, after) => answer({ mode: 'delete', name }, { op: 'delete', name }, { ok: true }, before, after).focus;
  assert.deepStrictEqual(del('B', list('A', 'B', 'C'), list('A', 'C')), { kind: 'row', name: 'C' });
  assert.deepStrictEqual(del('C', list('A', 'B', 'C'), list('A', 'B')), { kind: 'row', name: 'B' });
  assert.deepStrictEqual(del('A', list('A'), []), { kind: 'save-open' });
  assert.deepStrictEqual(del('b', list('A', 'B', 'C'), list('A', 'C')), { kind: 'row', name: 'C' }, 'ignoring case');
});

test('a refusal keeps the field or question open, says why, and sends focus back where the user was typing', () => {
  const taken = answer({ mode: 'rename', name: 'A', text: 'B' }, { op: 'rename', name: 'A', to: 'B' }, { ok: false, reason: 'taken' }, list('A', 'B'), list('A', 'B'));
  assert.deepStrictEqual(taken, { mode: 'rename', name: 'A', text: 'B', error: P.refusalText('taken'), focus: { kind: 'field' }, select: false });
  const full = answer({ mode: 'replace', name: 'A', text: 'a' }, { op: 'save', name: 'A', replace: true }, { ok: false, reason: 'full' }, list('A'), list('A'));
  assert.deepStrictEqual(full, { mode: 'replace', name: 'A', text: 'a', error: P.refusalText('full'), focus: { kind: 'confirm' }, select: false });
  const bad = answer({ mode: 'save', text: ' ' }, { op: 'save', name: ' ' }, { ok: false, reason: 'name' }, [], []);
  assert.deepStrictEqual(bad, { mode: 'save', text: ' ', error: P.refusalText('name'), focus: { kind: 'field' }, select: false });
});

test('PR #103 Dexter 4: a rename, delete or replace of a preset another window removed resets to the plain list and says "no longer exists"', () => {
  for (const [mode, req] of [
    ['rename', { op: 'rename', name: 'A', to: 'B' }], ['delete', { op: 'delete', name: 'A' }], ['replace', { op: 'save', name: 'A', replace: true }],
  ]) {
    const s = answer({ mode, name: 'A', text: 'x' }, req, { ok: false, reason: 'missing' }, list('B'), list('B'));
    assert.deepStrictEqual(s, { mode: 'idle', error: '\'A\' no longer exists', focus: { kind: 'save-open' }, select: false }, mode);
  }
});

test('an unreadable answer closes the field with no line of its own: the section says the file can\'t be read', () => {
  const s = answer({ mode: 'save', text: 'x' }, { op: 'save', name: 'x' }, { ok: false, reason: 'unreadable' }, [], []);
  assert.deepStrictEqual(s, { mode: 'idle', focus: null, select: false });
});

// --- another window changes the list under an open menu --------------------------------------

test('PR #103 Dexter 4 / Miguel S4: a push that removes the preset an open rename, delete or replace is about resets and says so', () => {
  for (const mode of ['rename', 'delete', 'replace']) {
    const s = step({ mode, name: 'A', text: 'typed' }, { type: 'list', list: list('B') });
    assert.deepStrictEqual(s, { mode: 'idle', error: '\'A\' no longer exists', focus: { kind: 'save-open' }, select: false }, mode);
  }
});

test('a push that leaves the target there changes nothing: typing is not thrown away', () => {
  for (const state of [
    { mode: 'rename', name: 'a', text: 'typed' }, { mode: 'delete', name: 'A' }, { mode: 'replace', name: 'A', text: 'x' }, { mode: 'save', text: 'half' }, IDLE,
  ]) assert.deepStrictEqual(step(state, { type: 'list', list: list('A', 'B') }), state);
});

test('closing the menu forgets the field', () => {
  assert.deepStrictEqual(step({ mode: 'rename', name: 'A', text: 'x' }, { type: 'close' }), IDLE);
});

test('a notice (a preset this version can\'t apply) is said in idle and sends focus to that preset\'s row', () => {
  const s = step(IDLE, { type: 'notice', error: 'x', focus: { kind: 'row', name: 'Old' } });
  assert.deepStrictEqual(s, { mode: 'idle', error: 'x', focus: { kind: 'row', name: 'Old' }, select: false });
});

test('an event this reducer doesn\'t know changes nothing and never throws', () => {
  for (const ev of [null, undefined, 7, {}, { type: 'nope' }, { type: 'answer' }]) assert.deepStrictEqual(step(IDLE, ev), IDLE);
});

// --- retry (PR #103 Dexter 3) ------------------------------------------------------------------

test('an unreadable list is asked for again every time the Window menu opens; a usable or still-loading one is not', () => {
  assert.strictEqual(P.needsRetry({ loaded: true, usable: false, list: [] }), true);
  assert.strictEqual(P.needsRetry({ loaded: true, usable: true, list: [] }), false);
  assert.strictEqual(P.needsRetry({ loaded: false, usable: false, list: [] }), false);
  assert.strictEqual(P.needsRetry(null), false);
});

// --- names for assistive tech (Miguel I2) ------------------------------------------------------

test('every preset control names the preset it acts on', () => {
  for (const kind of ['apply', 'rename-open', 'delete-open', 'rename-field', 'rename-commit', 'rename-cancel', 'delete-confirm', 'delete-cancel', 'replace-confirm', 'replace-cancel']) {
    assert.ok(P.labelFor(kind, 'Reviewing').includes('\'Reviewing\''), kind);
  }
  assert.strictEqual(P.labelFor('delete-open', 'Reviewing'), 'Delete preset \'Reviewing\'');
  assert.strictEqual(P.labelFor('replace-confirm', 'Reviewing'), 'Replace \'Reviewing\'');
  assert.strictEqual(P.labelFor('delete-cancel', 'Reviewing'), 'Cancel deleting \'Reviewing\'');
  const all = ['apply', 'rename-open', 'delete-open', 'rename-field', 'rename-commit', 'rename-cancel', 'delete-confirm', 'delete-cancel', 'replace-confirm', 'replace-cancel'].map(k => P.labelFor(k, 'X'));
  assert.strictEqual(new Set(all).size, all.length, 'no two controls share a name');
});


test('a save main refuses as taken becomes the replace question, naming the preset as it is stored', () => {
  const s = answer({ mode: 'save', text: 'review' }, { op: 'save', name: 'review' }, { ok: false, reason: 'taken' }, list('Review'), list('Review'));
  assert.deepStrictEqual(s, { mode: 'replace', name: 'Review', text: 'review', error: null, focus: { kind: 'confirm' }, select: false });
  // a rename refused as taken stays a refusal on the rename field
  assert.strictEqual(answer({ mode: 'rename', name: 'A', text: 'b' }, { op: 'rename', name: 'A', to: 'b' }, { ok: false, reason: 'taken' }, list('A', 'B'), list('A', 'B')).mode, 'rename');
});

// --- applying a preset this version can read (PR #103 Dexter 7) -----------------------------------

const readAny = (raw) => ({ read: 'any', from: raw });

test('only a version-2 tree or an L1 zones layout is applied; anything else is refused, never turned into the default layout', () => {
  assert.deepStrictEqual(P.presetLayout({ version: 2, root: {} }, ['a'], readAny), { ok: true, layout: { read: 'any', from: { version: 2, root: {} } } });
  assert.strictEqual(P.presetLayout({ version: 1, zones: { right: ['a'] } }, ['a'], readAny).ok, true, 'the L1 shape is migrated by readAny');
  for (const bad of [{ version: 3, root: {} }, { version: 1 }, {}, { hidden: [] }, null, 'x', [], { version: '2' }]) {
    assert.deepStrictEqual(P.presetLayout(bad, ['a'], readAny), { ok: false, reason: 'version' }, JSON.stringify(bad));
  }
});

test('a readAny that throws is a refusal, not a crash', () => {
  assert.deepStrictEqual(P.presetLayout({ version: 2 }, [], () => { throw new Error('x'); }), { ok: false, reason: 'version' });
});

test('the words for a layout this version can\'t read say so', () => {
  assert.match(P.refusalText('version'), /can't be read by this version/);
});

test('the thumbnail of a layout in the L1 shape draws the migrated tree, as applying it will place it', () => {
  const l1 = { version: 1, zones: { left: [], right: ['vault'], bottom: [] }, size: { left: 200, right: 300 } };
  const viaReadAny = (layout, ids, vp) => T.fit(T.readAny(layout, ids), null, vp);
  const boxes = P.thumbBoxes(l1, IDS, viaReadAny);
  assert.ok(boxes.length >= 2, 'a terminal and the group the L1 zone became');
  assert.strictEqual(P.presetLayout(l1, IDS, T.readAny).ok, true);
});
