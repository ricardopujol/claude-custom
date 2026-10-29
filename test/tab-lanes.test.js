'use strict';
/**
 * app/tab-lanes.js (BACKLOG #139, #141, #151; documentation/DESIGN_TAB_STRIP.md): the pure decisions behind the
 * strip's Lanes menu (1B: only running lanes get a tab) and its overflow (2A: shrink, then "+N").
 */
const test = require('node:test');
const assert = require('node:assert');

const L = require('../app/tab-lanes');

const lane = (key, over = {}) => ({
  key, label: key, isDev: false, selected: false, started: false, starting: false, ended: false,
  phase: 'live', badge: null, setup: null, briefing: false, ...over,
});
const dev = (over = {}) => lane('dev', { isDev: true, started: true, ...over });
const side = (parent, over = {}) => lane(`${parent}#side`, { side: true, parentKey: parent, started: true, ...over });
const shellTab = (parent, over = {}) => lane(`${parent}#shell`, { shell: true, parentKey: parent, started: true, ...over });
const keys = (list) => list.map(e => e.key);

// --- placeLanes: strip vs menu ------------------------------------------------------------

test('1B: a lane with no running session and not selected is in the menu, not on the strip', () => {
  const r = L.placeLanes([dev({ selected: true }), lane('a'), lane('b', { started: true })], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'b']);
  assert.deepStrictEqual(r.menu.notStarted.map(x => x.key), ['a']);
  assert.deepStrictEqual(r.menu.merged, []);
});

test('the selected lane stays on the strip even with no session (a failed start, an ended one, "not started yet")', () => {
  const r = L.placeLanes([dev(), lane('a', { selected: true })], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'a']);
});

test('a session that ended without a merge stays while selected and moves to the menu once you switch away', () => {
  const ended = (selected) => [dev({ selected: !selected }), lane('a', { started: true, ended: true, selected })];
  assert.deepStrictEqual(keys(L.placeLanes(ended(true), []).strip), ['dev', 'a']);
  const away = L.placeLanes(ended(false), []);
  assert.deepStrictEqual(keys(away.strip), ['dev']);
  assert.deepStrictEqual(away.menu.notStarted.map(x => [x.key, x.state]), [['a', 'ended']]);
});

test('develop always has its tab, whatever its session does', () => {
  const r = L.placeLanes([dev({ started: false, ended: true }), lane('a', { selected: true })], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'a']);
});

test('a lane still starting, setting up, or waiting for its brief keeps its tab', () => {
  const r = L.placeLanes([
    dev({ selected: true }),
    lane('s', { starting: true }), lane('u', { setup: { running: true } }), lane('b', { briefing: true }),
    lane('idle', { setup: { running: false, error: null } }),
  ], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 's', 'u', 'b']);
});

test('a merged lane with no session goes to the Merged group; a merged lane still running keeps its tab', () => {
  const r = L.placeLanes([
    dev({ selected: true }),
    lane('m1', { phase: 'finishing' }), lane('m2', { phase: 'kept' }), lane('m3', { phase: 'finishing', started: true }),
    lane('n'),
  ], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'm3']);
  assert.deepStrictEqual(r.menu.merged.map(x => [x.key, x.state]), [['m1', 'merged'], ['m2', 'merged']]);
  assert.deepStrictEqual(r.menu.notStarted.map(x => [x.key, x.state]), [['n', 'not started']]);
});

test('a lane whose folder is being removed, or that failed to go, stays visible so its message is seen', () => {
  const r = L.placeLanes([dev({ selected: true }), lane('r', { phase: 'removing' }), lane('f', { phase: 'remove-failed', badge: 'warn' })], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'r', 'f']);
});

test('a lane keeps its tab while it has a side or shell tab, and the companions follow it', () => {
  const r = L.placeLanes([
    dev({ selected: true }),
    lane('a', { started: true }), side('a'), shellTab('a'),
    lane('b'), side('b'),
  ], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'a', 'a#side', 'a#shell', 'b', 'b#side']);
  assert.deepStrictEqual(r.menu.notStarted, []);
});

test('a selected side tab keeps its (unselected) branch tab on the strip', () => {
  const r = L.placeLanes([dev(), lane('a'), side('a', { selected: true })], []);
  assert.deepStrictEqual(keys(r.strip), ['dev', 'a', 'a#side']);
});

test('closed-by-hand lanes are menu rows after the others, marked closed, and never duplicated', () => {
  const r = L.placeLanes([dev({ selected: true }), lane('a')], [{ key: 'z', label: 'feat/z' }, { key: 'a', label: 'a again' }]);
  assert.deepStrictEqual(r.menu.notStarted.map(x => [x.key, x.state, x.closed]), [['a', 'not started', false], ['z', 'closed', true]]);
});

test('junk in, no throw: non-array entries, null entries, closed rows without keys', () => {
  assert.deepStrictEqual(L.placeLanes(null, null), { strip: [], menu: { notStarted: [], merged: [] } });
  const r = L.placeLanes([null, 3, dev({ selected: true })], [null, { label: 'x' }, { key: 5 }]);
  assert.deepStrictEqual(keys(r.strip), ['dev']);
  assert.deepStrictEqual(r.menu.notStarted, []);
});

// --- splitOverflow: 2A ---------------------------------------------------------------------

test('2A: everything fits when the capacity covers it', () => {
  const list = [dev({ selected: true }), lane('a'), lane('b')];
  const r = L.splitOverflow(list, 3);
  assert.deepStrictEqual([keys(r.shown), keys(r.hidden)], [['dev', 'a', 'b'], []]);
});

test('2A: the tabs that do not fit go to the menu, from the right', () => {
  const list = [dev({ selected: true }), lane('a'), lane('b'), lane('c')];
  const r = L.splitOverflow(list, 2);
  assert.deepStrictEqual([keys(r.shown), keys(r.hidden)], [['dev', 'a'], ['b', 'c']]);
});

test('2A: the selected tab stays on the strip even when it is past the capacity; the strip stays in order', () => {
  const list = [dev(), lane('a'), lane('b'), lane('c', { selected: true })];
  const r = L.splitOverflow(list, 3);
  assert.deepStrictEqual([keys(r.shown), keys(r.hidden)], [['dev', 'a', 'c'], ['b']]);
});

test('2A: develop stays on the strip too, even when the capacity is one', () => {
  const list = [dev(), lane('a', { selected: true }), lane('b')];
  const r = L.splitOverflow(list, 1);
  assert.deepStrictEqual([keys(r.shown), keys(r.hidden)], [['dev', 'a'], ['b']]);
});

test('2A: a lane and its side and shell tabs move together', () => {
  const list = [dev({ selected: true }), lane('a'), side('a'), lane('b'), side('b'), shellTab('b')];
  const r = L.splitOverflow(list, 3);
  assert.deepStrictEqual([keys(r.shown), keys(r.hidden)], [['dev', 'a', 'a#side'], ['b']]);
});

test('2A: hidden lists the LANES (not their companions), so "+N" counts lanes', () => {
  const list = [dev({ selected: true }), lane('a'), side('a'), shellTab('a')];
  const r = L.splitOverflow(list, 1);
  assert.deepStrictEqual(keys(r.hidden), ['a']);
});

test('2A: junk capacity is "no limit", never "nothing fits"', () => {
  const list = [dev({ selected: true }), lane('a')];
  for (const c of [undefined, null, NaN, 'x', Infinity]) assert.deepStrictEqual(keys(L.splitOverflow(list, c).shown), ['dev', 'a'], String(c));
  assert.deepStrictEqual(keys(L.splitOverflow(list, 0).shown), ['dev'], 'zero still keeps develop and the selected tab');
});

test('capacityFor: whole minimum-width tabs, at least one, junk is no limit', () => {
  assert.strictEqual(L.MIN_TAB, 112);
  assert.strictEqual(L.capacityFor(1120), 10);
  assert.strictEqual(L.capacityFor(1119), 9);
  assert.strictEqual(L.capacityFor(50), 1);
  assert.strictEqual(L.capacityFor(-5), 1);
  for (const w of [undefined, null, NaN, 'wide']) assert.strictEqual(L.capacityFor(w), Infinity, String(w));
  assert.strictEqual(L.capacityFor(500, 100), 5);
});

// --- order: drag to reorder --------------------------------------------------------------------

test('applyOrder: saved lanes first, in the saved order; new lanes after them in their own order', () => {
  const items = ['a', 'b', 'c', 'd'].map(k => ({ key: k }));
  assert.deepStrictEqual(keys(L.applyOrder(items, ['c', 'a'], e => e.key)), ['c', 'a', 'b', 'd']);
  assert.deepStrictEqual(keys(L.applyOrder(items, [], e => e.key)), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(keys(L.applyOrder(items, ['x', 'd', 'x', 'b'], e => e.key)), ['d', 'b', 'a', 'c'], 'unknown and repeated keys are ignored');
});

test('applyOrder: junk order is no order', () => {
  const items = [{ key: 'a' }, { key: 'b' }];
  for (const o of [null, undefined, 'a', 5, {}, [1, null, {}]]) assert.deepStrictEqual(keys(L.applyOrder(items, o, e => e.key)), ['a', 'b'], String(o));
});

test('moveKey: before another lane, or to the end', () => {
  assert.deepStrictEqual(L.moveKey(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepStrictEqual(L.moveKey(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
  assert.deepStrictEqual(L.moveKey(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
  assert.deepStrictEqual(L.moveKey(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'], 'dropped on itself: nothing moves');
});

test('moveKey: a key the order does not know yet is added; a "before" it does not know means the end', () => {
  assert.deepStrictEqual(L.moveKey(['a', 'b'], 'n', 'a'), ['n', 'a', 'b']);
  assert.deepStrictEqual(L.moveKey(['a', 'b'], 'a', 'nope'), ['b', 'a']);
});

test('moveKey: junk refuses to move and returns the order unchanged', () => {
  assert.deepStrictEqual(L.moveKey(['a', 'b'], 7, 'a'), ['a', 'b']);
  assert.deepStrictEqual(L.moveKey(['a', 'b'], '', 'a'), ['a', 'b']);
  assert.deepStrictEqual(L.moveKey('nope', 'a', null), ['a']);
});

// --- leaving: the fade -----------------------------------------------------------------------------

test('leaving: a tab that was on the strip and is now neither shown nor merely hidden by overflow', () => {
  assert.deepStrictEqual(L.leaving(['dev', 'a', 'b'], ['dev', 'b'], []), ['a']);
  assert.deepStrictEqual(L.leaving(['dev', 'a', 'b'], ['dev'], ['b']), ['a'], 'b only moved into the overflow menu');
  assert.deepStrictEqual(L.leaving([], ['a'], []), []);
  assert.deepStrictEqual(L.leaving(null, null, null), []);
});

// --- the menu's rows -------------------------------------------------------------------------------

test('lanesMenuRows: hidden tabs, then not started, then merged, each a header and rows; empty groups are left out', () => {
  const rows = L.lanesMenuRows(
    { notStarted: [{ key: 'n', label: 'feat/n', state: 'not started', closed: false }, { key: 'z', label: 'feat/z', state: 'closed', closed: true }],
      merged: [{ key: 'm', label: 'feat/m', state: 'merged', closed: false }] },
    [{ key: 'h', label: 'feat/h', started: true }],
  );
  assert.deepStrictEqual(rows.map(r => [r.type, r.label, r.key, r.action]), [
    ['header', 'Hidden tabs', undefined, undefined],
    ['row', 'feat/h', 'h', 'select'],
    ['header', 'Not started', undefined, undefined],
    ['row', 'feat/n', 'n', 'select'],
    ['row', 'feat/z', 'z', 'reopen'],
    ['header', 'Merged', undefined, undefined],
    ['row', 'feat/m', 'm', 'select'],
  ]);
  assert.strictEqual(rows.find(r => r.key === 'n').state, 'not started');
  assert.strictEqual(rows.find(r => r.key === 'z').state, 'closed');
});

test('lanesMenuRows: nothing to list is an empty menu', () => {
  assert.deepStrictEqual(L.lanesMenuRows({ notStarted: [], merged: [] }, []), []);
  assert.deepStrictEqual(L.lanesMenuRows(null, null), []);
});

// --- dropBefore: where a dragged tab lands ---------------------------------------------------------

test('dropBefore: the left half of a tab drops before it; the right half before the next lane, or the end', () => {
  const strip = [dev(), lane('a'), side('a'), lane('b'), lane('c')];
  assert.deepStrictEqual(L.dropBefore(strip, 'c', 'a', true), { ok: true, before: 'a' });
  assert.deepStrictEqual(L.dropBefore(strip, 'c', 'a', false), { ok: true, before: 'b' }, 'a lane\'s side tab is not a place to drop between');
  assert.deepStrictEqual(L.dropBefore(strip, 'a', 'c', false), { ok: true, before: null });
  assert.deepStrictEqual(L.dropBefore(strip, 'a', 'c', true), { ok: true, before: 'c' });
});

test('dropBefore: over a companion counts as over its lane; over develop is "first of the others"', () => {
  const strip = [dev(), lane('a'), side('a'), lane('b')];
  assert.deepStrictEqual(L.dropBefore(strip, 'b', 'a#side', true), { ok: true, before: 'a' });
  assert.deepStrictEqual(L.dropBefore(strip, 'b', 'a#side', false), { ok: true, before: 'b' });
  assert.deepStrictEqual(L.dropBefore(strip, 'b', 'dev', true), { ok: true, before: 'dev' });
  assert.deepStrictEqual(L.dropBefore(strip, 'b', 'dev', false), { ok: true, before: 'dev' });
});

test('dropBefore: develop, a companion, a stranger, or the tab itself cannot be dragged or dropped on', () => {
  const strip = [dev(), lane('a'), side('a'), lane('b')];
  assert.strictEqual(L.dropBefore(strip, 'dev', 'a', true).ok, false);
  assert.strictEqual(L.dropBefore(strip, 'a#side', 'b', true).ok, false);
  assert.strictEqual(L.dropBefore(strip, 'nope', 'b', true).ok, false);
  assert.strictEqual(L.dropBefore(strip, 'a', 'nope', true).ok, false);
  assert.strictEqual(L.dropBefore(strip, 'a', 'a', true).ok, false);
  assert.strictEqual(L.dropBefore(null, 'a', 'b', true).ok, false);
});
