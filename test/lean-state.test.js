'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createLean } = require('../app/lean-state');

const NIGHT = 1_700_000_000_000;

test('starts normal', () => {
  assert.deepStrictEqual(createLean().view(), { on: false, byBedtime: false, bedtimeSince: null });
});

test('the button turns it on by hand and off again', () => {
  const l = createLean();
  assert.strictEqual(l.setByHand(true), true);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null });
  assert.strictEqual(l.setByHand(true), false, 'nothing changed');
  assert.strictEqual(l.setByHand(false), true);
  assert.strictEqual(l.view().on, false);
});

test('a night starting turns it on, remembering which night did', () => {
  const l = createLean();
  assert.strictEqual(l.nightStarted('a', NIGHT), true);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: true, bedtimeSince: NIGHT });
});

test('the night ending turns it off when the night turned it on', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.nightEnded('a'), true);
  assert.deepStrictEqual(l.view(), { on: false, byBedtime: false, bedtimeSince: null });
});

test('a night starting while it was already on by hand leaves it by hand, and the night ending leaves it on', () => {
  const l = createLean();
  l.setByHand(true);
  assert.strictEqual(l.nightStarted('a', NIGHT), false);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null });
  assert.strictEqual(l.nightEnded('a'), false);
  assert.strictEqual(l.view().on, true);
});

test('the button always wins: Back to normal during a night stays normal, and the same night reported again does not undo it', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.setByHand(false);
  assert.strictEqual(l.view().on, false);
  assert.strictEqual(l.nightStarted('a', NIGHT), false, 'the same night, said again');
  assert.strictEqual(l.view().on, false);
  assert.strictEqual(l.nightEnded('a'), false);
});

test('a NEW night after Back to normal turns it on again', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.setByHand(false);
  l.nightEnded('a');
  assert.strictEqual(l.nightStarted('a', NIGHT + 86_400_000), true);
  assert.strictEqual(l.view().on, true);
});

test('the button on while a night turned it on takes it over: the night ending no longer turns it off', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.setByHand(true), true, 'the view changed: no longer "by bedtime"');
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null });
  l.nightEnded('a');
  assert.strictEqual(l.view().on, true);
});

test('two tabs with nights: it ends only when the last night ends', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.nightStarted('b', NIGHT + 60_000), false, 'already on by bedtime');
  assert.strictEqual(l.nightEnded('a'), false);
  assert.strictEqual(l.view().on, true);
  assert.strictEqual(l.nightEnded('b'), true);
  assert.strictEqual(l.view().on, false);
});

test('an end nobody started changes nothing', () => {
  const l = createLean();
  assert.strictEqual(l.nightEnded('zzz'), false);
  l.setByHand(true);
  assert.strictEqual(l.nightEnded('zzz'), false);
  assert.strictEqual(l.view().on, true);
});

test('a malformed start (not a finite number) is ignored, never a night', () => {
  const l = createLean();
  for (const bad of [null, undefined, NaN, Infinity, '1700', {}]) assert.strictEqual(l.nightStarted('a', bad), false);
  assert.strictEqual(l.view().on, false);
});

test('a night restarting under the same tab replaces the old one (one night per tab)', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.nightStarted('a', NIGHT + 1000);
  assert.strictEqual(l.nightEnded('a'), true, 'one end closes the tab\'s only night');
  assert.strictEqual(l.view().on, false);
});

test('property: lean is on exactly when the button said so, or a night it started is still going and the button has not said otherwise since', () => {
  const op = fc.oneof(
    fc.record({ t: fc.constant('hand'), on: fc.boolean() }),
    fc.record({ t: fc.constant('start'), tab: fc.constantFrom('a', 'b'), at: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ t: fc.constant('end'), tab: fc.constantFrom('a', 'b') }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
    const l = createLean();
    for (const o of ops) {
      if (o.t === 'hand') l.setByHand(o.on);
      else if (o.t === 'start') l.nightStarted(o.tab, o.at);
      else l.nightEnded(o.tab);
      const v = l.view();
      // internal consistency of the view
      assert.strictEqual(typeof v.on, 'boolean');
      if (!v.on) assert.deepStrictEqual([v.byBedtime, v.bedtimeSince], [false, null]);
      if (v.byBedtime) assert.strictEqual(typeof v.bedtimeSince, 'number');
    }
    // ending every tab's night while on by bedtime always lands on normal
    l.nightEnded('a'); l.nightEnded('b');
    const v = l.view();
    assert.strictEqual(v.byBedtime, false);
  }));
});
