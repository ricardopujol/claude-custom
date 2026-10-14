'use strict';
/**
 * The rail's hover state machine (BACKLOG #85), pure and timer-free: the page owns the two timers (100 ms before a hover opens a
 * panel, 100 ms of grace before leaving closes it) and feeds `open-timer` / `close-timer` events back in.
 * State: { module, held, pending, leaving } -- the open panel, whether a click or key holds it open, the tab hovered and
 * waiting for its timer, and whether the pointer left and the close timer is running.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const V = require('../app/dock-tree-display');

const { railAfter, RAIL_IDLE } = V;
const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };
const open = (module, extra = {}) => ({ module, held: false, pending: null, leaving: false, ...extra });
const run = (events, from = RAIL_IDLE) => events.reduce(railAfter, from);

test('the idle state is closed, nothing waiting', () => {
  assert.deepEqual(RAIL_IDLE, { module: null, held: false, pending: null, leaving: false });
  assert.deepEqual(railAfter(undefined, { type: 'nonsense' }), RAIL_IDLE);
  assert.deepEqual(railAfter('junk', null), RAIL_IDLE);
});

test('hovering a tab waits for the open timer; the timer opens it, unheld', () => {
  const s = railAfter(RAIL_IDLE, { type: 'enter', module: 'git' });
  assert.deepEqual(s, { ...RAIL_IDLE, pending: 'git' });
  assert.deepEqual(railAfter(s, { type: 'open-timer', module: 'git' }), open('git'));
});

test('a pass across the rail opens nothing: leaving before the timer clears the wait, and a late timer is ignored', () => {
  const s = run([{ type: 'enter', module: 'git' }, { type: 'leave' }]);
  assert.deepEqual(s, RAIL_IDLE);
  assert.deepEqual(railAfter(s, { type: 'open-timer', module: 'git' }), RAIL_IDLE);
});

test('a timer for a tab that is no longer the hovered one is ignored', () => {
  const s = run([{ type: 'enter', module: 'git' }, { type: 'enter', module: 'vault' }]);
  assert.equal(s.pending, 'vault');
  assert.deepEqual(railAfter(s, { type: 'open-timer', module: 'git' }), s);
});

test('leaving an open, unheld panel starts the grace; coming back into the panel or the tab cancels it', () => {
  const s = railAfter(open('git'), { type: 'leave' });
  assert.deepEqual(s, open('git', { leaving: true }));
  assert.deepEqual(railAfter(s, { type: 'enter-panel' }), open('git'));
  assert.deepEqual(railAfter(s, { type: 'enter', module: 'git' }), open('git'));
  assert.deepEqual(railAfter(s, { type: 'close-timer' }), RAIL_IDLE);
});

test('a close timer after the pointer came back changes nothing', () => {
  assert.deepEqual(railAfter(open('git'), { type: 'close-timer' }), open('git'));
});

test('hovering another tab while one is open swaps to it at once, no second delay', () => {
  assert.deepEqual(railAfter(open('git', { leaving: true }), { type: 'enter', module: 'vault' }), open('vault'));
});

test('a held panel does not close by leaving or by the close timer', () => {
  const held = open('git', { held: true });
  assert.deepEqual(railAfter(held, { type: 'leave' }), held);
  assert.deepEqual(railAfter(held, { type: 'close-timer' }), held);
});

test('a click opens and holds; a click on the open unheld tab holds it; a click on a held one closes it', () => {
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'click', module: 'git' }), open('git', { held: true }));
  assert.deepEqual(railAfter(open('git', { leaving: true }), { type: 'click', module: 'git' }), open('git', { held: true }));
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'click', module: 'git' }), RAIL_IDLE);
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'click', module: 'vault' }), open('vault', { held: true }));
  assert.deepEqual(railAfter(open('git'), { type: 'click', module: 'vault' }), open('vault', { held: true }));
});

test('a click on a tab with a hover wait pending opens it held and clears the wait', () => {
  assert.deepEqual(railAfter({ ...RAIL_IDLE, pending: 'git' }, { type: 'click', module: 'git' }), open('git', { held: true }));
});

test('a tab inside the open panel switches it and keeps whether it is held; with nothing open it does nothing', () => {
  assert.deepEqual(railAfter(open('git', { held: true }), { type: 'tab', module: 'vault' }), open('vault', { held: true }));
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'tab', module: 'vault' }), RAIL_IDLE);
});

test('Esc, a press outside, a tab drop and the rail going away close it, held or not', () => {
  for (const type of ['escape', 'outside', 'drop', 'gone']) {
    assert.deepEqual(railAfter(open('git', { held: true }), { type }), RAIL_IDLE);
    assert.deepEqual(railAfter({ ...RAIL_IDLE, pending: 'git' }, { type }), RAIL_IDLE);
  }
});

test('junk events and junk modules change nothing', () => {
  const s = open('git', { held: true });
  for (const ev of [null, 7, {}, { type: 'enter' }, { type: 'enter', module: '' }, { type: 'enter', module: 7 }, { type: 'click', module: null }, { type: 'tab' }]) {
    assert.deepEqual(railAfter(s, ev), s);
  }
  assert.deepEqual(railAfter({ module: 7, held: 'yes', pending: {}, leaving: 1 }, { type: 'leave' }), RAIL_IDLE);
});

const evArb = fc.oneof(
  fc.record({ type: fc.constantFrom('enter', 'click', 'tab', 'open-timer'), module: fc.constantFrom('git', 'vault', 'fog') }),
  fc.record({ type: fc.constantFrom('leave', 'enter-panel', 'close-timer', 'escape', 'outside', 'drop', 'gone') }),
);

test('P: whatever happens, a closed state waits on nothing but a hover, and an open one waits on no hover', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 40 }), (events) => {
    let s = RAIL_IDLE;
    for (const ev of events) {
      s = railAfter(s, ev);
      if (s.module === null) assert.ok(!s.held && !s.leaving);
      else assert.equal(s.pending, null);
      if (s.held) assert.ok(!s.leaving);
      assert.equal(typeof s.held, 'boolean');
      assert.equal(typeof s.leaving, 'boolean');
    }
  }), RUNS);
});

test('P: Esc always lands on the idle state, from anywhere', () => {
  fc.assert(fc.property(fc.array(evArb, { maxLength: 30 }), (events) => {
    assert.deepEqual(railAfter(run(events), { type: 'escape' }), RAIL_IDLE);
  }), RUNS);
});

// --- review fixes (PR #168: Dexter 1 and 3, Miguel Y2) -------------------------------------------

test('Dexter 1: a hover swap drops the hold: click git, hover vault, leave, grace -> nothing stays open', () => {
  const s = run([{ type: 'click', module: 'git' }, { type: 'enter', module: 'vault' }]);
  assert.deepEqual(s, open('vault'), 'vault opens unheld');
  assert.deepEqual(run([{ type: 'leave' }, { type: 'close-timer' }], s), RAIL_IDLE);
  assert.deepEqual(run([{ type: 'click', module: 'git' }, { type: 'enter', module: 'vault' }, { type: 'leave' }, { type: 'close-timer' }]), RAIL_IDLE);
});

test('Dexter 3: the panel\'s own pointer-over clears a hover wait (a rest on the rail\'s strip opens nothing)', () => {
  const s = railAfter({ ...RAIL_IDLE, pending: 'git' }, { type: 'enter-panel' });
  assert.deepEqual(s, RAIL_IDLE);
  assert.deepEqual(railAfter(s, { type: 'open-timer', module: 'git' }), RAIL_IDLE);
});

test('Miguel Y2: a press or the keyboard inside the open panel holds it, like a click on its tab; with nothing open it does nothing', () => {
  assert.deepEqual(railAfter(open('git', { leaving: true }), { type: 'hold' }), open('git', { held: true }));
  assert.deepEqual(railAfter(open('git'), { type: 'hold' }), open('git', { held: true }));
  assert.deepEqual(railAfter(RAIL_IDLE, { type: 'hold' }), RAIL_IDLE);
  assert.deepEqual(railAfter({ ...RAIL_IDLE, pending: 'git' }, { type: 'hold' }), { ...RAIL_IDLE, pending: 'git' });
  const s = run([{ type: 'enter', module: 'git' }, { type: 'open-timer', module: 'git' }, { type: 'hold' }, { type: 'leave' }, { type: 'close-timer' }]);
  assert.deepEqual(s, open('git', { held: true }), 'typing in a hover-opened panel survives the pointer leaving');
});
