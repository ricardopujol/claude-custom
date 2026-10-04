'use strict';
/**
 * app/submit-gate.js (BACKLOG #61, DESIGN_WAND_SUBMIT.md "The submit gate"): every row of the table, and the
 * refusals. Properties are in test/submit-gate-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { planSubmit, FLASH } = require('../app/submit-gate');

test('idle, not type-only: Enter, and the flash says "sent"', () => {
  const p = planSubmit({ turn: 'idle', typeOnly: false });
  assert.deepStrictEqual(p, { enter: true, flash: 'sent', reason: null });
});

test('mid-turn, not type-only: Enter anyway (the CLI queues it), and the flash says it is queued', () => {
  const p = planSubmit({ turn: 'turn', typeOnly: false });
  assert.strictEqual(p.enter, true);
  assert.strictEqual(p.flash, "queued: Claude runs it when it's free");
  assert.strictEqual(p.reason, null);
});

test('a dialog is open: no Enter, no flash, a reason (the typing was refused before this)', () => {
  for (const typeOnly of [false, true]) {
    const p = planSubmit({ turn: 'prompt', typeOnly });
    assert.strictEqual(p.enter, false);
    assert.strictEqual(p.flash, null);
    assert.match(p.reason, /dialog/);
  }
});

test('session start not seen (null): type only, because a dialog cannot be told apart', () => {
  const p = planSubmit({ turn: null, typeOnly: false });
  assert.deepStrictEqual(p, { enter: false, flash: 'typed, press Enter', reason: null });
});

test('a type-only favourite types only, whatever the state', () => {
  for (const turn of ['idle', 'turn', null]) {
    const p = planSubmit({ turn, typeOnly: true });
    assert.deepStrictEqual(p, { enter: false, flash: 'typed, press Enter', reason: null }, String(turn));
  }
});

test('an absent typeOnly means "submit" (an old favourite from a v1 file), but an odd value never submits', () => {
  assert.strictEqual(planSubmit({ turn: 'idle' }).enter, true);
  assert.strictEqual(planSubmit({ turn: 'idle', typeOnly: undefined }).enter, true);
  for (const odd of [null, 0, 1, 'false', '', {}, []]) {
    assert.strictEqual(planSubmit({ turn: 'idle', typeOnly: odd }).enter, false, JSON.stringify(odd));
  }
});

test('an unknown or garbage state never submits; nothing throws', () => {
  for (const turn of [undefined, 'working', '', 0, {}, 'IDLE']) {
    assert.strictEqual(planSubmit({ turn, typeOnly: false }).enter, false, String(turn));
  }
  assert.strictEqual(planSubmit().enter, false);
  assert.strictEqual(planSubmit(null).enter, false);
});

test('the flash texts are exported for the display', () => {
  assert.deepStrictEqual(Object.keys(FLASH).sort(), ['queued', 'sent', 'typed']);
});
