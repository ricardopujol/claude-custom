// @ts-nocheck
'use strict';
/**
 * Whether the secret INPUT is showing its text.
 *
 * A masked field is unusable for checking what you pasted; an unmasked one that
 * stays unmasked is a secret sitting on screen for as long as the window is
 * open. The rules for when it goes back to masked are the whole feature, so
 * they are here rather than scattered through event handlers.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createMask } = require('../app/secret-mask');

test('starts masked', () => {
  assert.strictEqual(createMask().visible(), false);
});

test('toggles to visible and back', () => {
  const m = createMask();
  m.toggle();
  assert.strictEqual(m.visible(), true);
  m.toggle();
  assert.strictEqual(m.visible(), false);
});

test('storing a secret re-masks the field', () => {
  // The next secret typed must not inherit the last one's visibility. Whoever
  // revealed it did so for the value they were checking, not for every value
  // after it.
  const m = createMask();
  m.toggle();
  m.stored();
  assert.strictEqual(m.visible(), false);
});

test('leaving the panel re-masks the field', () => {
  // A revealed value left behind outlives the moment someone needed it, and
  // the next person to open the tab did not ask to see it.
  const m = createMask();
  m.toggle();
  m.left();
  assert.strictEqual(m.visible(), false);
});

test('the label reads as an action, not a state', () => {
  // "Show" when hidden, "Hide" when shown. A button labelled with the CURRENT
  // state reads backwards to half the people who look at it.
  const m = createMask();
  assert.strictEqual(m.label(), 'Show');
  m.toggle();
  assert.strictEqual(m.label(), 'Hide');
});

test('reports the input type the field should carry', () => {
  const m = createMask();
  assert.strictEqual(m.inputType(), 'password');
  m.toggle();
  assert.strictEqual(m.inputType(), 'text');
});

test('re-masking something already masked is not a toggle', () => {
  // stored() and left() must be idempotent: two of them in a row should not
  // flip the field back to visible.
  const m = createMask();
  m.stored();
  m.left();
  assert.strictEqual(m.visible(), false);
});
