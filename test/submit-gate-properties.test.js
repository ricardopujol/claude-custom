'use strict';
/**
 * The submit gate's invariants (BACKLOG #61), stated as properties:
 *
 *   1. SAFETY: `enter` is true ONLY for an idle or running turn AND a favourite that is not type-only.
 *      Never for a dialog ('prompt'), an unseen session (null), a type-only favourite, or any other value.
 *   2. TOTAL: whatever it is given, it answers with the three keys and does not throw.
 *   3. A flash is always paired with a no-error answer: a reason (a refusal) never has a flash, and an
 *      answer with no reason always has one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { planSubmit } = require('../app/submit-gate');

const anything = fc.anything();
const turnArb = fc.oneof(fc.constantFrom('idle', 'turn', 'prompt', null, undefined), anything);
const typeOnlyArb = fc.oneof(fc.constantFrom(true, false, undefined, null), anything);

test('property 1: Enter only for idle/turn and a favourite that is not type-only', () => {
  fc.assert(fc.property(turnArb, typeOnlyArb, (turn, typeOnly) => {
    const r = planSubmit({ turn, typeOnly });
    const mayEnter = (turn === 'idle' || turn === 'turn') && (typeOnly === false || typeOnly === undefined);
    assert.strictEqual(r.enter, mayEnter);
  }), { numRuns: 500 });
});

test('property 1b: a dialog or an unseen session or a type-only favourite NEVER submits', () => {
  fc.assert(fc.property(typeOnlyArb, (typeOnly) => {
    assert.strictEqual(planSubmit({ turn: 'prompt', typeOnly }).enter, false);
    assert.strictEqual(planSubmit({ turn: null, typeOnly }).enter, false);
  }));
  fc.assert(fc.property(turnArb, (turn) => {
    assert.strictEqual(planSubmit({ turn, typeOnly: true }).enter, false);
  }));
});

test('property 2: total, and always the same three keys', () => {
  fc.assert(fc.property(anything, (input) => {
    const r = planSubmit(input);
    assert.deepStrictEqual(Object.keys(r).sort(), ['enter', 'flash', 'reason']);
    assert.strictEqual(typeof r.enter, 'boolean');
  }));
});

test('property 3: a refusal has a reason and no flash; everything else has a flash and no reason', () => {
  fc.assert(fc.property(turnArb, typeOnlyArb, (turn, typeOnly) => {
    const r = planSubmit({ turn, typeOnly });
    if (r.reason !== null) assert.strictEqual(r.flash, null);
    else assert.strictEqual(typeof r.flash, 'string');
  }));
});
