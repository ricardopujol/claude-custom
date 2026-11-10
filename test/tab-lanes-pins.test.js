'use strict';
/**
 * Pins in the strip's placement and overflow (BACKLOG #167; documentation/DESIGN_TABS_SESSIONS.md 3.2): a pinned lane is on the strip
 * even when idle, and is must-keep under overflow (never +N), clipping like the must-keep set when the pins alone exceed the room.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const tabLanes = require('../app/tab-lanes');

const lane = (key, o = {}) => ({ key, label: key, isDev: false, selected: false, started: false, ...o });
const keys = (list) => list.map(e => e.key);

test('a pinned lane with no session is on the strip, not a Lanes row', () => {
  const p = tabLanes.placeLanes([lane('dev', { isDev: true, selected: true, started: true }), lane('a', { pinned: true }), lane('b')], []);
  assert.deepStrictEqual(keys(p.strip), ['dev', 'a']);
  assert.deepStrictEqual(keys(p.menu.notStarted), ['b']);
});

test('only a real true pins: a truthy stand-in is not a pin', () => {
  for (const pinned of ['yes', 1, {}, [], 'true']) {
    const p = tabLanes.placeLanes([lane('dev', { isDev: true }), lane('a', { pinned })], []);
    assert.deepStrictEqual(keys(p.strip), ['dev'], String(pinned));
  }
});

test('a pinned lane whose session ended stays on the strip', () => {
  const p = tabLanes.placeLanes([lane('dev', { isDev: true }), lane('a', { pinned: true, started: true, ended: true })], []);
  assert.deepStrictEqual(keys(p.strip), ['dev', 'a']);
});

test('a pin on a side or shell tab changes nothing: companions follow their lane', () => {
  // a companion whose lane has no tab is not drawn by its own pin; and with its lane on the strip it is just a companion
  const orphan = tabLanes.placeLanes([lane('dev', { isDev: true }), lane('x|side', { side: true, parentKey: 'x', pinned: true })], []);
  assert.deepStrictEqual(keys(orphan.strip), ['dev']);
  const r = tabLanes.splitOverflow([lane('dev', { isDev: true }), lane('u', { started: true }), lane('u|side', { side: true, parentKey: 'u', pinned: true })], 1);
  assert.deepStrictEqual(keys(r.hidden), ['u'], 'a companion\'s pin keeps nothing');
});

test('overflow: a pinned lane is never hidden, and the unpinned ones after it go first', () => {
  const strip = [lane('dev', { isDev: true, selected: true }), lane('u1', { started: true }), lane('p1', { pinned: true }), lane('u2', { started: true }), lane('p2', { pinned: true })];
  const r = tabLanes.splitOverflow(strip, 3);
  assert.deepStrictEqual(keys(r.shown), ['dev', 'p1', 'p2']);
  assert.deepStrictEqual(keys(r.hidden), ['u1', 'u2']);
});

test('overflow: pins alone past the capacity are all shown (they clip, as the must-keep set does), and nothing else is', () => {
  const strip = [lane('dev', { isDev: true }), lane('p1', { pinned: true }), lane('p2', { pinned: true }), lane('p3', { pinned: true }), lane('u', { started: true })];
  const r = tabLanes.splitOverflow(strip, 2);
  assert.deepStrictEqual(keys(r.shown), ['dev', 'p1', 'p2', 'p3']);
  assert.deepStrictEqual(keys(r.hidden), ['u']);
});

test('a pinned lane with its companions is one unit and all of it is kept', () => {
  const strip = [lane('dev', { isDev: true }), lane('p', { pinned: true }), lane('p|side', { side: true, parentKey: 'p' }), lane('u', { started: true })];
  const r = tabLanes.splitOverflow(strip, 2);
  assert.deepStrictEqual(keys(r.shown), ['dev', 'p', 'p|side']);
  assert.deepStrictEqual(keys(r.hidden), ['u']);
});

test('PROPERTY: every pinned lane is on the strip and shown, every entry is in the strip or the menu exactly once, and the shown/hidden split is exact', () => {
  const entry = fc.record({
    started: fc.boolean(), ended: fc.boolean(), selected: fc.boolean(), pinned: fc.boolean(), needsInput: fc.boolean(),
    phase: fc.constantFrom('live', 'finishing', 'kept', null),
  });
  fc.assert(fc.property(fc.array(entry, { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 8 }), (rows, cap) => {
    const entries = rows.map((r, i) => lane(`k${i}`, { ...r, isDev: i === 0, pinned: i === 0 ? false : r.pinned }));
    const placed = tabLanes.placeLanes(entries, []);
    const inMenu = [...placed.menu.notStarted, ...placed.menu.merged].map(r => r.key);
    for (const e of entries) {
      const onStrip = placed.strip.some(s => s.key === e.key);
      assert.strictEqual(onStrip !== inMenu.includes(e.key), true, `${e.key} is in exactly one place`);
      if (e.pinned === true) assert.ok(onStrip, `${e.key} is pinned`);
    }
    const { shown, hidden } = tabLanes.splitOverflow(placed.strip, cap);
    for (const e of entries) if (e.pinned === true) assert.ok(shown.some(s => s.key === e.key), `${e.key} is shown`);
    assert.strictEqual(shown.length + hidden.length, placed.strip.length);
  }));
});

// --- the launch set (documentation/DESIGN_TABS_SESSIONS.md 3.1) ---------------------------------------

test('launchSet: develop first, then the pinned lanes in strip order; unpinned lanes are not in it', () => {
  const lanes = ['dev', 'a', 'b', 'c'];
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: ['a', 'c'], order: [] }), ['dev', 'a', 'c']);
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: ['a', 'c'], order: ['c', 'a'] }), ['dev', 'c', 'a'], 'strip order, not the order they were pinned in');
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: [], order: [] }), ['dev']);
});

test('launchSet: a pin git no longer lists, a hand-closed lane and a closed develop are left out', () => {
  const lanes = ['dev', 'a', 'b'];
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: ['gone', 'a', 'b'], order: [], dismissed: ['b'] }), ['dev', 'a']);
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: ['a'], order: [], dismissed: ['dev'] }), ['a']);
});

test('launchSet: a lane the window was opened from goes first, develop follows, no repeats', () => {
  const lanes = ['dev', 'a', 'b'];
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: ['a', 'b'], order: [], first: 'b' }), ['b', 'dev', 'a']);
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: [], order: [], first: 'dev' }), ['dev']);
  assert.deepStrictEqual(tabLanes.launchSet({ lanes, devKey: 'dev', pinned: [], order: [], first: 'nowhere' }), ['dev'], 'a first that is not listed starts nothing');
});

test('launchSet: junk in, nothing out', () => {
  assert.deepStrictEqual(tabLanes.launchSet({}), []);
  assert.deepStrictEqual(tabLanes.launchSet(null), []);
  assert.deepStrictEqual(tabLanes.launchSet({ lanes: ['a', 7, null, ''], devKey: null, pinned: ['a', 7], order: 'x' }), ['a']);
});

test('PROPERTY: the launch set is a subset of the listed lanes, has no duplicates, holds every pinned listed lane that is not closed, and develop leads unless a first lane was named', () => {
  const k = fc.constantFrom('dev', 'a', 'b', 'c', 'd', 'e', 'gone');
  fc.assert(fc.property(
    fc.uniqueArray(fc.constantFrom('dev', 'a', 'b', 'c', 'd', 'e'), { minLength: 0, maxLength: 6 }),
    fc.array(k, { maxLength: 8 }), fc.array(k, { maxLength: 8 }), fc.array(k, { maxLength: 4 }), fc.option(k, { nil: undefined }),
    (lanes, pinned, order, dismissed, first) => {
      const out = tabLanes.launchSet({ lanes, devKey: 'dev', pinned, order, dismissed, first });
      assert.strictEqual(new Set(out).size, out.length, 'no duplicates');
      for (const x of out) assert.ok(lanes.includes(x), `${x} is listed`);
      for (const p of pinned) if (lanes.includes(p) && !dismissed.includes(p) && p !== 'dev') assert.ok(out.includes(p), `pinned ${p} is in it`);
      if (lanes.includes('dev') && !dismissed.includes('dev')) assert.ok(out.includes('dev'), 'develop is in it');
      const named = first !== undefined && lanes.includes(first) && !dismissed.includes(first);
      if (named) assert.strictEqual(out[0], first);
      else if (out.length > 0 && out.includes('dev')) assert.strictEqual(out[0], 'dev');
    }));
});
