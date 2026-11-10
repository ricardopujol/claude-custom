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
