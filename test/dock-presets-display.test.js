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
