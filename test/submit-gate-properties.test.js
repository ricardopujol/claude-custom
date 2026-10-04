'use strict';
/**
 * The submit gate's invariants (BACKLOG #61), stated as properties:
 *
 *   1. SAFETY: `enter` is true ONLY for an idle or running turn AND a favourite that is not type-only.
 *      Never for a dialog ('prompt'), an unseen session (null), a type-only favourite, or any other value.
 *   2. TOTAL: whatever it is given, it answers with the four keys and does not throw.
 *   3. `recheck` (the F1 wait) is true only where `enter` is true and the turn is running; it never accompanies
 *      a type-only answer, and `reason` is null or a string with no flash.
 *   4. The queued-line matcher is total, and true only when the CLI's phrase is on some line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { planSubmit, queuedShown } = require('../app/submit-gate');

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

test('property 2: total, and always the same four keys', () => {
  fc.assert(fc.property(anything, (input) => {
    const r = planSubmit(input);
    assert.deepStrictEqual(Object.keys(r).sort(), ['enter', 'flash', 'reason', 'recheck']);
    assert.strictEqual(typeof r.enter, 'boolean');
    assert.strictEqual(typeof r.recheck, 'boolean');
  }));
});

test('property 3: recheck only with a running turn that may submit; a reason never carries a flash', () => {
  fc.assert(fc.property(turnArb, typeOnlyArb, (turn, typeOnly) => {
    const r = planSubmit({ turn, typeOnly });
    assert.strictEqual(r.recheck, r.enter && turn === 'turn');
    if (r.reason !== null) assert.strictEqual(r.flash, null);
    else assert.strictEqual(typeof r.flash, 'string');
  }));
});

test('property 4: queuedShown is total and true exactly when the phrase is on a line', () => {
  const PHRASE = 'Press up to edit queued messages';
  const line = fc.string({ maxLength: 40 }).filter(s => !/Press\s+up\s+to\s+edit\s+queued\s+messages/.test(s));
  fc.assert(fc.property(anything, (v) => { assert.strictEqual(typeof queuedShown(v), 'boolean'); }));
  fc.assert(fc.property(fc.array(line, { maxLength: 8 }), (lines) => {
    assert.strictEqual(queuedShown(lines), false);
  }));
  fc.assert(fc.property(fc.array(line, { maxLength: 8 }), fc.nat(8), fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), (lines, at, pre, post) => {
    const copy = lines.slice();
    copy.splice(at % (copy.length + 1), 0, `${pre}${PHRASE}${post}`);
    assert.strictEqual(queuedShown(copy), true);
  }));
});
