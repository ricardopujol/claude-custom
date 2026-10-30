'use strict';
/**
 * The rail's state machine (BACKLOG #85, #138, #106), pure and timer-free. Side tabs open on click only: hovering a rail tab
 * never opens, swaps or closes a panel, and a panel a click opened stays until the person closes it.
 * State: { module } -- the open panel, or null.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const V = require('../app/dock-tree-display');

const { railAfter, RAIL_IDLE } = V;
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const open = (module) => ({ module });
const run = (events, from = RAIL_IDLE) => events.reduce(railAfter, from);
const HOVER = [
  { type: 'enter', module: 'git' }, { type: 'enter', module: 'vault' }, { type: 'enter-panel' }, { type: 'leave' },
  { type: 'open-timer', module: 'git' }, { type: 'close-timer' }, { type: 'hold' },
];

test('the idle state is closed', () => {
  assert.deepEqual(RAIL_IDLE, { module: null });
  assert.deepEqual(railAfter(undefined, { type: 'nonsense' }), RAIL_IDLE);
  assert.deepEqual(railAfter('junk', null), RAIL_IDLE);
});

test('hover never opens a panel: nothing happens whatever the pointer does over the rail, from closed', () => {
  for (const ev of HOVER) assert.deepEqual(railAfter(RAIL_IDLE, ev), RAIL_IDLE, ev.type);
  assert.deepEqual(run(HOVER), RAIL_IDLE);
});

test('hover never swaps or closes an open panel', () => {
  const s = open('git');
  for (const ev of HOVER) assert.deepEqual(railAfter(s, ev), s, ev.type);
  assert.deepEqual(run(HOVER, s), s);
});

test('a click opens; a click on the open tab closes; a click on another tab switches', () => {
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'click', module: 'git' }), open('git'));
  assert.deepEqual(railAfter(open('git'), { type: 'click', module: 'git' }), RAIL_IDLE);
  assert.deepEqual(railAfter(open('git'), { type: 'click', module: 'vault' }), open('vault'));
});

test('click git, hover over the others and the panel, leave: git stays open', () => {
  assert.deepEqual(run([{ type: 'click', module: 'git' }, ...HOVER]), open('git'));
});

test('a tab inside the open panel switches it; with nothing open it does nothing', () => {
  assert.deepEqual(railAfter(open('git'), { type: 'tab', module: 'vault' }), open('vault'));
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'tab', module: 'vault' }), RAIL_IDLE);
});

test('Esc, a press outside, a tab drop and the rail going away close it', () => {
  for (const type of ['escape', 'outside', 'drop', 'gone']) assert.deepEqual(railAfter(open('git'), { type }), RAIL_IDLE);
});

test('junk events and junk modules change nothing; a junk state reads as idle', () => {
  const s = open('git');
  for (const ev of [null, 7, {}, { type: 'enter' }, { type: 'click', module: null }, { type: 'click', module: '' }, { type: 'tab' }]) {
    assert.deepEqual(railAfter(s, ev), s);
  }
  assert.deepEqual(railAfter({ module: 7, held: 'yes' }, { type: 'leave' }), RAIL_IDLE);
  assert.deepEqual(railAfter({ module: '' }, { type: 'tab', module: 'a' }), RAIL_IDLE);
  assert.deepEqual(railAfter({ module: 'a', held: false, pending: 'x' }, { type: 'leave' }), open('a'), 'old fields are dropped');
});

const evArb = fc.oneof(
  fc.record({ type: fc.constantFrom('enter', 'click', 'tab', 'open-timer'), module: fc.constantFrom('git', 'vault', 'fog') }),
  fc.record({ type: fc.constantFrom('leave', 'enter-panel', 'close-timer', 'hold', 'escape', 'outside', 'drop', 'gone') }),
);
const hoverArb = fc.oneof(
  fc.record({ type: fc.constantFrom('enter', 'open-timer'), module: fc.constantFrom('git', 'vault', 'fog') }),
  fc.record({ type: fc.constantFrom('leave', 'enter-panel', 'close-timer', 'hold') }),
);

test('P: hover events are no-ops from any reachable state', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 30 }), fc.array(hoverArb, { maxLength: 10 }), (events, hovers) => {
    const s = run(events);
    assert.deepEqual(run(hovers, s), s);
  }), RUNS);
});

test('P: a panel only opens by a click, and the state is only ever a module name or null', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 40 }), (events) => {
    let s = RAIL_IDLE;
    for (const ev of events) {
      const next = railAfter(s, ev);
      if (s.module === null && next.module !== null) assert.equal(ev.type, 'click');
      assert.deepEqual(Object.keys(next), ['module']);
      s = next;
    }
  }), RUNS);
});

test('P: Esc always lands on the idle state, from anywhere', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 30 }), (events) => {
    assert.deepEqual(railAfter(run(events), { type: 'escape' }), RAIL_IDLE);
  }), RUNS);
});
