'use strict';
/**
 * The rail's state machine (BACKLOG #85, #138, #106), pure and timer-free. Side tabs open on click only: hovering a rail tab
 * never opens, swaps or closes a panel.
 * State: { module, held } -- the open panel, and whether a click or key holds it open (every panel a click opens is held).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const V = require('../app/dock-tree-display');

const { railAfter, RAIL_IDLE } = V;
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const open = (module, extra = {}) => ({ module, held: false, ...extra });
const run = (events, from = RAIL_IDLE) => events.reduce(railAfter, from);
const HOVER = [
  { type: 'enter', module: 'git' }, { type: 'enter', module: 'vault' }, { type: 'enter-panel' }, { type: 'leave' },
  { type: 'open-timer', module: 'git' }, { type: 'close-timer' },
];

test('the idle state is closed', () => {
  assert.deepEqual(RAIL_IDLE, { module: null, held: false });
  assert.deepEqual(railAfter(undefined, { type: 'nonsense' }), RAIL_IDLE);
  assert.deepEqual(railAfter('junk', null), RAIL_IDLE);
});

test('hover never opens a panel: nothing happens whatever the pointer does over the rail, from closed', () => {
  for (const ev of HOVER) assert.deepEqual(railAfter(RAIL_IDLE, ev), RAIL_IDLE, ev.type);
  assert.deepEqual(run(HOVER), RAIL_IDLE);
});

test('hover never swaps, drops or closes an open panel, held or not', () => {
  for (const s of [open('git', { held: true }), open('git')]) {
    for (const ev of HOVER) assert.deepEqual(railAfter(s, ev), s, ev.type);
    assert.deepEqual(run(HOVER, s), s);
  }
});

test('a click opens and holds; a click on the held tab closes; a click on another tab switches, held', () => {
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'click', module: 'git' }), open('git', { held: true }));
  assert.deepEqual(railAfter(open('git'), { type: 'click', module: 'git' }), open('git', { held: true }));
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'click', module: 'git' }), RAIL_IDLE);
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'click', module: 'vault' }), open('vault', { held: true }));
  assert.deepEqual(railAfter(open('git'), { type: 'click', module: 'vault' }), open('vault', { held: true }));
});

test('click git, hover over the others and the panel, leave: git stays open and held', () => {
  const s = run([{ type: 'click', module: 'git' }, ...HOVER]);
  assert.deepEqual(s, open('git', { held: true }));
});

test('a tab inside the open panel switches it and keeps whether it is held; with nothing open it does nothing', () => {
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'tab', module: 'vault' }), open('vault', { held: true }));
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'tab', module: 'vault' }), RAIL_IDLE);
});

test('Esc, a press outside, a tab drop and the rail going away close it, held or not', () => {
  for (const type of ['escape', 'outside', 'drop', 'gone']) {
    assert.deepEqual(railAfter(open('git', { held: true }), { type }), RAIL_IDLE);
    assert.deepEqual(railAfter(open('git'), { type }), RAIL_IDLE);
  }
});

test('a press or the keyboard inside the open panel holds it; with nothing open it does nothing', () => {
  assert.deepEqual(railAfter(open('git'), { type: 'hold' }), open('git', { held: true }));
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'hold' }), RAIL_IDLE);
});

test('junk events and junk modules change nothing; a junk state reads as idle', () => {
  const s = open('git', { held: true });
  for (const ev of [null, 7, {}, { type: 'enter' }, { type: 'click', module: null }, { type: 'click', module: '' }, { type: 'tab' }]) {
    assert.deepEqual(railAfter(s, ev), s);
  }
  assert.deepEqual(railAfter({ module: 7, held: 'yes' }, { type: 'leave' }), RAIL_IDLE);
  assert.deepEqual(railAfter({ module: '', held: true }, { type: 'hold' }), RAIL_IDLE);
  assert.deepEqual(railAfter({ module: 'a', held: 'yes' }, { type: 'leave' }), open('a'), 'only an exact true holds');
});

const evArb = fc.oneof(
  fc.record({ type: fc.constantFrom('enter', 'click', 'tab', 'open-timer'), module: fc.constantFrom('git', 'vault', 'fog') }),
  fc.record({ type: fc.constantFrom('leave', 'enter-panel', 'close-timer', 'hold', 'escape', 'outside', 'drop', 'gone') }),
);
const hoverArb = fc.oneof(
  fc.record({ type: fc.constantFrom('enter', 'open-timer'), module: fc.constantFrom('git', 'vault', 'fog') }),
  fc.record({ type: fc.constantFrom('leave', 'enter-panel', 'close-timer') }),
);

test('P: hover events are no-ops from any reachable state', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 30 }), fc.array(hoverArb, { maxLength: 10 }), (events, hovers) => {
    const s = run(events);
    assert.deepEqual(run(hovers, s), s);
  }), RUNS);
});

test('P: a closed state is never held, and a panel only opens by a click', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 40 }), (events) => {
    let s = RAIL_IDLE;
    for (const ev of events) {
      const next = railAfter(s, ev);
      if (s.module === null && next.module !== null) assert.equal(ev.type, 'click');
      if (next.module === null) assert.equal(next.held, false);
      s = next;
    }
  }), RUNS);
});

test('P: Esc always lands on the idle state, from anywhere', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 30 }), (events) => {
    assert.deepEqual(railAfter(run(events), { type: 'escape' }), RAIL_IDLE);
  }), RUNS);
});
