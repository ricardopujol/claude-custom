'use strict';
/**
 * app/submit-gate.js (BACKLOG #61, DESIGN_WAND_SUBMIT.md "The submit gate" and "Review round picks"): every row of
 * the table, the screen matcher for the CLI's queued-messages line, and the shared words. Properties are in
 * test/submit-gate-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { planSubmit, queuedShown, FLASH, DRAFT_CLEARED } = require('../app/submit-gate');

test('idle, not type-only: Enter, no re-check, provisional flash "sent"', () => {
  assert.deepStrictEqual(planSubmit({ turn: 'idle', typeOnly: false }), { enter: true, recheck: false, flash: 'sent', reason: null });
});

test('mid-turn, not type-only: Enter anyway (the CLI queues it), but only after the F1 re-check', () => {
  const p = planSubmit({ turn: 'turn', typeOnly: false });
  assert.strictEqual(p.enter, true);
  assert.strictEqual(p.recheck, true, 'a dialog can open between the read-back and the CR in a running turn');
  assert.strictEqual(p.reason, null);
});

test('F3: the host says a dialog is open (prompt): type only with the hint, never Enter, never a refusal here', () => {
  for (const typeOnly of [false, true]) {
    const p = planSubmit({ turn: 'prompt', typeOnly });
    assert.deepStrictEqual(p, { enter: false, recheck: false, flash: "Claude may be waiting on you: press Enter if it's free", reason: null }, String(typeOnly));
  }
});

test('session start not seen (null): type only, because a dialog cannot be told apart', () => {
  assert.deepStrictEqual(planSubmit({ turn: null, typeOnly: false }), { enter: false, recheck: false, flash: 'typed, press Enter', reason: null });
});

test('a type-only favourite types only, whatever the state but a dialog', () => {
  for (const turn of ['idle', 'turn', null]) {
    assert.deepStrictEqual(planSubmit({ turn, typeOnly: true }), { enter: false, recheck: false, flash: 'typed, press Enter', reason: null }, String(turn));
  }
});

test('an absent typeOnly means "submit" (an old favourite), but an odd value never submits', () => {
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

test('the words are exported once for every module that shows them', () => {
  assert.deepStrictEqual(Object.keys(FLASH).sort(), ['queued', 'sent', 'typed', 'waiting']);
  assert.strictEqual(FLASH.typed, 'typed, press Enter');
  assert.strictEqual(FLASH.queued, "queued: Claude runs it when it's free");
  assert.strictEqual(DRAFT_CLEARED, " Its input box wasn't empty: if that was a draft, Ctrl+Y in that tab brings it back.");
});

// --- F7: the CLI's own queued-messages line, measured by verify/probe-queued-skill.js -------------------------

test('F7 queuedShown: true on the CLI\'s "Press up to edit queued messages" line, wherever it sits', () => {
  assert.strictEqual(queuedShown(['❯ /probeq', '  ctrl+x ctrl+s to send now', '', '❯ Press up to edit queued messages', '  esc to interrupt']), true);
  assert.strictEqual(queuedShown(['Press up to edit queued messages']), true);
  assert.strictEqual(queuedShown(['❯   Press   up to edit\tqueued messages   ']), true, 'whitespace runs compare as one space');
});

test('F7 queuedShown: false for an ordinary screen, a partial line, the wrong case, and anything that is not lines', () => {
  assert.strictEqual(queuedShown(['❯ /checkpoint', '  ctrl+x ctrl+s to send now']), false, 'the "send now" hint alone proves nothing');
  assert.strictEqual(queuedShown(['Press up to edit']), false);
  assert.strictEqual(queuedShown(['press up to edit queued messages']), false);
  assert.strictEqual(queuedShown([]), false);
  for (const junk of [null, undefined, 'Press up to edit queued messages', 5, {}, [null, 3]]) assert.strictEqual(queuedShown(junk), false, String(junk));
});
