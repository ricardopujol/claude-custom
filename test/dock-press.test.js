'use strict';
/**
 * BACKLOG #109: a rail tab's icon is a drag handle, exactly like a tab's name. One press on a button is either a click (it
 * opens the rail's panel, or selects the tab) or a drag (the dock drag: ghost, zones, drop), never both. The decision is
 * app/dock-drag.js pressStep, a pure step over pointer events; the page only feeds it and acts on the effect it answers.
 *
 *   rail button: 6 px of movement, or 250 ms held down, starts the drag; a release before either is a click.
 *   tab name:    5 px of movement starts the drag (as before #109); holding still never does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const D = require('../app/dock-drag');

const RUNS = { numRuns: Number(process.env.LAYOUT_RUNS) || 300 };

// Feed a list of events from no press at all; collect the effects.
function run(events, opts) {
  let st = null;
  const effects = [];
  for (const ev of events) {
    const out = D.pressStep(st, ev, opts);
    st = out.state;
    effects.push(out.effect);
  }
  return { st, effects };
}
const down = (x = 100, y = 100, t = 0) => ({ type: 'down', x, y, t });
const move = (x, y, t = 10) => ({ type: 'move', x, y, t });
const up = (t = 20) => ({ type: 'up', t });

test('the thresholds: a rail button 6 px or 250 ms, a tab name 5 px and no hold', () => {
  assert.deepEqual(D.PRESS.rail, { distance: 6, holdMs: 250 });
  assert.deepEqual(D.PRESS.tab, { distance: 5, holdMs: null });
});

test('a press and a release without moving is a click', () => {
  assert.deepEqual(run([down(), up()], D.PRESS.rail).effects, ['none', 'click']);
  assert.deepEqual(run([down(), up()], D.PRESS.tab).effects, ['none', 'click']);
});

test('a wobble under the distance is still a click', () => {
  // 3,4 is 5 px away: under the rail's 6, so no drag; the release clicks.
  assert.deepEqual(run([down(100, 100), move(103, 104), move(101, 99), up()], D.PRESS.rail).effects, ['none', 'none', 'none', 'click']);
});

test('moving the distance starts the drag; the next moves are the drag\'s; the release drops, and is no click', () => {
  const r = run([down(100, 100), move(106, 100), move(150, 120), up()], D.PRESS.rail);
  assert.deepEqual(r.effects, ['none', 'start', 'move', 'drop']);
  assert.equal(r.st, null, 'nothing is pressed after the release');
});

test('the distance is the straight line: 6 px on a diagonal starts it, 5.9 does not', () => {
  assert.equal(run([down(0, 0), move(3.6, 4.8)], D.PRESS.rail).effects[1], 'start');        // exactly 6
  assert.equal(run([down(0, 0), move(3.5, 4.8)], D.PRESS.rail).effects[1], 'none');         // 5.94
});

test('a tab name keeps its 5 px', () => {
  assert.equal(run([down(0, 0), move(5, 0)], D.PRESS.tab).effects[1], 'start');
  assert.equal(run([down(0, 0), move(4.9, 0)], D.PRESS.tab).effects[1], 'none');
});

test('a rail button held still for 250 ms starts the drag; 249 ms does not', () => {
  assert.deepEqual(run([down(100, 100, 1000), { type: 'hold', t: 1249 }], D.PRESS.rail).effects, ['none', 'none']);
  const r = run([down(100, 100, 1000), { type: 'hold', t: 1250 }, move(110, 100, 1260), up(1300)], D.PRESS.rail);
  assert.deepEqual(r.effects, ['none', 'start', 'move', 'drop'], 'a long press is a drag, and its release no click');
});

// PR #241 Dexter 1 (High): a hold-started drag released where it was pressed was judged at the press point; pressed in the
// window's right rim (the rail's outer 14 px), that docked the panel along the right edge and saved it. A drop needs movement.
test('a hold released without moving past the distance is a cancel, never a drop and never a click', () => {
  assert.deepEqual(run([down(100, 100, 0), { type: 'hold', t: 300 }, up(320)], D.PRESS.rail).effects, ['none', 'start', 'cancel']);
  assert.deepEqual(run([down(100, 100, 0), { type: 'hold', t: 300 }, move(103, 104, 310), move(100, 99, 315), up(320)], D.PRESS.rail).effects,
    ['none', 'start', 'move', 'move', 'cancel'], 'a wobble under the distance after the hold is still no drop');
});

test('a hold, then a move past the distance, then a release is a drop: the drag moved', () => {
  assert.deepEqual(run([down(100, 100, 0), { type: 'hold', t: 300 }, move(106, 100, 310), move(100, 100, 320), up(330)], D.PRESS.rail).effects,
    ['none', 'start', 'move', 'move', 'drop'], 'once it has moved the distance, coming back to the press point still drops');
});

// PR #241 Miguel L1: the page's hold timer fires once, and a timer can fire early (by the clock pressStep reads), which turned the
// hold into a click. holdRemaining says how long is still to wait, so the page re-arms for the rest.
test('holdRemaining: the ms still to wait for the hold, 0 when it is due, null when there is no hold to wait for', () => {
  const st = D.pressStep(null, down(100, 100, 1000), D.PRESS.rail).state;
  assert.equal(D.holdRemaining(st, 1000, D.PRESS.rail), 250);
  assert.equal(D.holdRemaining(st, 1249, D.PRESS.rail), 1, 'an early fire at 249 ms: one more to wait');
  assert.equal(D.holdRemaining(st, 1250, D.PRESS.rail), 0, 'due at 250 ms');
  assert.equal(D.holdRemaining(st, 1400, D.PRESS.rail), 0);
  assert.equal(D.holdRemaining(st, 1000, D.PRESS.tab), null, 'a tab name has no hold');
  const dragging = D.pressStep(st, move(150, 100, 1010), D.PRESS.rail).state;
  assert.equal(D.holdRemaining(dragging, 1100, D.PRESS.rail), null, 'already dragging');
  for (const [s, t] of [[null, 5], [st, NaN], [st, 'x'], [{}, 5]]) assert.equal(D.holdRemaining(s, t, D.PRESS.rail), null);
  // The re-armed fire at 1250 starts it: an early fire never makes a click.
  assert.deepEqual(run([down(100, 100, 1000), { type: 'hold', t: 1249 }, { type: 'hold', t: 1250 }, up(1300)], D.PRESS.rail).effects, ['none', 'none', 'start', 'cancel']);
});

test('a small move after the hold time starts the drag too (the timer may come late)', () => {
  assert.deepEqual(run([down(100, 100, 0), move(101, 100, 260)], D.PRESS.rail).effects, ['none', 'start']);
});

test('a tab name never starts on a hold', () => {
  assert.deepEqual(run([down(100, 100, 0), { type: 'hold', t: 5000 }, move(101, 100, 6000), up(6100)], D.PRESS.tab).effects, ['none', 'none', 'none', 'click']);
});

test('a cancel ends a press with nothing, and a drag with a cancel (never a click, never a drop)', () => {
  assert.deepEqual(run([down(), { type: 'cancel' }], D.PRESS.rail).effects, ['none', 'none']);
  const r = run([down(0, 0), move(50, 0), { type: 'cancel' }, up()], D.PRESS.rail);
  assert.deepEqual(r.effects, ['none', 'start', 'cancel', 'none']);
  assert.equal(r.st, null);
});

test('events with no press are nothing: a move, a hold, a release, a cancel', () => {
  for (const ev of [move(5, 5), { type: 'hold', t: 999 }, up(), { type: 'cancel' }]) assert.deepEqual(D.pressStep(null, ev, D.PRESS.rail), { state: null, effect: 'none' });
});

// PR #241 Dexter 3: down, a move past the distance, down, up answered 'click' (a click after a drag had started); on the page a
// second touch or pen pointer overwrote the press and leaked the first ghost. A second down during a press or a drag is ignored:
// the press goes on from its own point. (A lost release of the SAME pointer is the page's to end: it cancels, then presses anew.)
test('a second down while pressed is ignored: the press goes on from its own point', () => {
  assert.deepEqual(run([down(0, 0, 0), down(500, 500, 10), move(503, 500, 20), up(30)], D.PRESS.rail).effects, ['none', 'none', 'start', 'drop'],
    '503 px from the first press point is a drag, not a 3 px wobble from the second');
  assert.deepEqual(run([down(0, 0, 0), down(500, 500, 10), up(30)], D.PRESS.rail).effects, ['none', 'none', 'click']);
});

test('a second down while dragging is ignored: no click after a start', () => {
  assert.deepEqual(run([down(0, 0, 0), move(50, 0, 5), down(0, 0, 10), up(20)], D.PRESS.rail).effects, ['none', 'start', 'none', 'drop']);
});

test('junk never throws and changes nothing: unknown events, junk numbers, junk options read as the rail\'s', () => {
  const st = D.pressStep(null, down(10, 10, 0), D.PRESS.rail).state;
  for (const ev of [null, undefined, 5, 'up', {}, { type: 'zap' }, { type: 'move', x: NaN, y: 3, t: 1 }, { type: 'move', x: null, y: null, t: null }]) {
    assert.deepEqual(D.pressStep(st, ev, D.PRESS.rail), { state: st, effect: 'none' }, JSON.stringify(ev));
  }
  // A down with junk coordinates is no press.
  assert.deepEqual(D.pressStep(null, { type: 'down', x: 'a', y: 1, t: 0 }, D.PRESS.rail), { state: null, effect: 'none' });
  // Junk options: the rail's thresholds.
  assert.equal(run([down(0, 0, 0), move(6, 0, 1)], null).effects[1], 'start');
  assert.equal(run([down(0, 0, 0), { type: 'hold', t: 250 }], {}).effects[1], 'start');
});

test('pressStep never changes the state it was given', () => {
  const st = Object.freeze(D.pressStep(null, down(0, 0, 0), D.PRESS.rail).state);
  D.pressStep(st, move(50, 50, 5), D.PRESS.rail);
  D.pressStep(st, up(), D.PRESS.rail);
  assert.equal(st.phase, 'pressed');
});

// The property: whatever one press does between its down and its release, it is a click or a drag, never both; a drag starts
// once and ends once; and a press that never got the distance or (on the rail) the hold time is a click.
test('property: one press is a click or a drag, never both, and only a press that crossed a threshold drags', () => {
  const ev = fc.oneof(
    fc.record({ type: fc.constant('move'), x: fc.integer({ min: -40, max: 40 }), y: fc.integer({ min: -40, max: 40 }), t: fc.integer({ min: 0, max: 600 }) }),
    fc.record({ type: fc.constant('hold'), t: fc.integer({ min: 0, max: 600 }) }),
    // Dexter 3: a second pointer's down can come at any point of the press; it changes nothing.
    fc.record({ type: fc.constant('down'), x: fc.integer({ min: -40, max: 40 }), y: fc.integer({ min: -40, max: 40 }), t: fc.integer({ min: 0, max: 600 }) }),
  );
  fc.assert(fc.property(fc.array(ev, { maxLength: 12 }), fc.boolean(), fc.constantFrom('rail', 'tab'), (mid, cancelled, kind) => {
    const opts = D.PRESS[kind];
    const evs = [down(0, 0, 0), ...mid, cancelled ? { type: 'cancel' } : up(700)];
    const { st, effects } = run(evs, opts);
    const starts = effects.filter(e => e === 'start').length;
    const clicks = effects.filter(e => e === 'click').length;
    const ends = effects.filter(e => e === 'drop' || e === 'cancel').length;
    assert.ok(starts <= 1, 'a drag starts at most once');
    assert.ok(!(starts && clicks), 'never a click after a drag');
    assert.equal(ends, starts, 'every drag ends once: a drop or a cancel');
    assert.equal(st, null);
    const crossed = mid.some(e => (e.type === 'move' && (Math.hypot(e.x, e.y) >= opts.distance || (opts.holdMs !== null && e.t >= opts.holdMs)))
      || (e.type === 'hold' && opts.holdMs !== null && e.t >= opts.holdMs));
    assert.equal(starts === 1, crossed, 'a drag exactly when a threshold was crossed');
    assert.equal(clicks, !cancelled && !crossed ? 1 : 0, 'a click exactly when released without crossing one');
    // Dexter 1: a drop needs movement. A drag only a hold started, released before any move went the distance, is a cancel.
    const movedFar = mid.some(e => e.type === 'move' && Math.hypot(e.x, e.y) >= opts.distance);
    const drops = effects.filter(e => e === 'drop').length;
    assert.equal(drops, !cancelled && starts === 1 && movedFar ? 1 : 0, 'a drop exactly when the drag moved the distance and was released');
  }), RUNS);
});
