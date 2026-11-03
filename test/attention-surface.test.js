'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { surfacesFor } = require('../app/attention-surface');

const finished = { kind: 'finished', title: 'p finished', body: 'done', urgent: false };
const needsYou = { kind: 'input-needed', title: 'p needs you', body: 'permission?', urgent: true };

test('a focused window gets NO toast at all', () => {
  // A toast for the thing you are already looking at is noise, and noise is
  // how a notification system stops being read.
  //
  // This was briefly the other way round, on the theory that focus suppression
  // was why notifications never arrived. It was not: no hook was reaching the
  // host at all (tool_name "Agent" vs "Task"). Suppressing while focused was
  // right, and removing it fixed nothing while adding noise.
  assert.strictEqual(surfacesFor(finished, { focused: true }).toast, null);
});

test('an urgent request is also silent while focused', () => {
  // Even a blocked session: if the window is in front of you, the in-window
  // cue is already telling you, and a toast on top of it is duplication.
  assert.strictEqual(surfacesFor(needsYou, { focused: true }).toast, null);
});

test('an unfocused window gets a toast for what needs you', () => {
  const s = surfacesFor(needsYou, { focused: false });
  assert.ok(s.toast, 'no toast raised for an unfocused window');
});

test('a finished turn raises NO toast, focused or not: only what needs you does (BACKLOG #78, Ricardo 2026-10-29)', () => {
  // "I should only get notifications when an action from me is needed." The in-window cue and the tab's "done" dot still say it.
  for (const focused of [true, false]) {
    const s = surfacesFor(finished, { focused });
    assert.strictEqual(s.toast, null, `focused=${focused}`);
    assert.strictEqual(s.cue, true);
    assert.strictEqual(s.badge, 'done');
    assert.strictEqual(s.flashTaskbar, false);
  }
});

test('a held cross-session message is a toast like a permission prompt', () => {
  const held = { kind: 'peer-message', title: 'p: message from dexter', body: 'run /merged', urgent: true };
  const s = surfacesFor(held, { focused: false });
  assert.strictEqual(s.toast.title, held.title);
  assert.strictEqual(s.toast.requireInteraction, true);
  assert.strictEqual(s.flashTaskbar, true);
});

test('PR #224 Dexter 5: a held message\'s toast is silent (the knock is its one sound); other urgent toasts are not', () => {
  assert.strictEqual(surfacesFor({ kind: 'peer-message', title: 't', body: 'b', urgent: true }, { focused: false }).toast.silent, true);
  assert.strictEqual(surfacesFor(needsYou, { focused: false }).toast.silent, false);
});

test('an urgent toast in an unfocused window sticks until acknowledged', () => {
  const s = surfacesFor(needsYou, { focused: false });
  assert.strictEqual(s.toast.requireInteraction, true);
  assert.strictEqual(s.toast.silent, false);
});

test('every toast waits to be clicked (it is always one that needs you)', () => {
  const s = surfacesFor(needsYou, { focused: false });
  assert.strictEqual(s.toast.silent, false);
  assert.strictEqual(s.toast.requireInteraction, true);
});

test('the taskbar flashes only when the window is not focused', () => {
  // flashFrame on a focused window does nothing on Windows and is noise
  // everywhere else.
  assert.strictEqual(surfacesFor(needsYou, { focused: false }).flashTaskbar, true);
  assert.strictEqual(surfacesFor(needsYou, { focused: true }).flashTaskbar, false);
});

test('only an urgent event flashes the taskbar', () => {
  // A finished turn is worth a toast, not worth an icon flashing at you until
  // you look. That distinction is what keeps the flash meaningful.
  assert.strictEqual(surfacesFor(finished, { focused: false }).flashTaskbar, false);
});

test('the in-window cue always shows, in every case', () => {
  // The toast disappears on its own; the cue is what is still there when you
  // come back, so it must not depend on focus or urgency.
  for (const msg of [finished, needsYou]) {
    for (const focused of [true, false]) {
      assert.strictEqual(surfacesFor(msg, { focused }).cue, true, `${msg.kind}/${focused}`);
    }
  }
});

test('the overlay badge marks urgency and clears on a plain finish', () => {
  assert.strictEqual(surfacesFor(needsYou, { focused: false }).badge, 'urgent');
  assert.strictEqual(surfacesFor(finished, { focused: false }).badge, 'done');
});

test('the toast carries the title and body verbatim', () => {
  const s = surfacesFor(needsYou, { focused: false });
  assert.strictEqual(s.toast.title, needsYou.title);
  assert.strictEqual(s.toast.body, needsYou.body);
});

test('an unknown kind still gets through rather than vanishing: its cue, and its toast when it says it needs you', () => {
  // A new kind added to the host must not be silently dropped by an older renderer. Without `urgent` it needs nobody, so it is a cue only.
  const calm = surfacesFor({ kind: 'whatever', title: 't', body: 'b' }, { focused: false });
  assert.strictEqual(calm.toast, null);
  assert.strictEqual(calm.cue, true);
  assert.ok(surfacesFor({ kind: 'whatever', title: 't', body: 'b', urgent: true }, { focused: false }).toast);
});

test('a missing options object is treated as unfocused', () => {
  const s = surfacesFor(needsYou);
  assert.strictEqual(s.flashTaskbar, true);
});

test('cueFlash: the taskbar flashes when the cue rises on an unfocused window, stops when it clears (BACKLOG #117)', () => {
  const { cueFlash } = require('../app/cue-flash');
  assert.strictEqual(cueFlash(false, true, false), true, 'rise, unfocused: start');
  assert.strictEqual(cueFlash(false, true, true), null, 'never flash the focused window');
  assert.strictEqual(cueFlash(true, true, false), null, 'already up: do not restart the flash');
  assert.strictEqual(cueFlash(true, false, true), false, 'cleared: stop');
  assert.strictEqual(cueFlash(true, false, false), false, 'cleared while unfocused: stop');
  assert.strictEqual(cueFlash(false, false, true), null, 'nothing to stop');
});
