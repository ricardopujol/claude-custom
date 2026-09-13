'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { surfacesFor } = require('../app/attention-surface');

const finished = { kind: 'finished', title: 'p finished', body: 'done', urgent: false };
const needsYou = { kind: 'input-needed', title: 'p needs you', body: 'permission?', urgent: true };

test('a finished task notifies even while the window is focused', () => {
  // THE reported bug. The old rule suppressed every toast when the window had
  // focus, so watching the terminal while a task ran meant never being told it
  // ended -- which is the exact case the feature was asked for.
  const s = surfacesFor(finished, { focused: true });
  assert.ok(s.toast, 'no toast for a finished task in a focused window');
});

test('a focused window gets a quiet, non-sticky toast', () => {
  // Still looking at it: say so once, do not make noise and do not demand a
  // click to dismiss.
  const s = surfacesFor(finished, { focused: true });
  assert.strictEqual(s.toast.silent, true);
  assert.strictEqual(s.toast.requireInteraction, false);
});

test('an urgent toast in an unfocused window sticks until acknowledged', () => {
  const s = surfacesFor(needsYou, { focused: false });
  assert.strictEqual(s.toast.requireInteraction, true);
  assert.strictEqual(s.toast.silent, false);
});

test('an urgent event is never silent, even with focus', () => {
  // A blocked session is blocked whether or not you are looking at the window.
  const s = surfacesFor(needsYou, { focused: true });
  assert.strictEqual(s.toast.silent, false);
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

test('an unknown kind still gets through rather than vanishing', () => {
  // Failing open matters here: a new kind added to the host must not be
  // silently dropped by an older renderer.
  const s = surfacesFor({ kind: 'whatever', title: 't', body: 'b' }, { focused: false });
  assert.ok(s.toast);
  assert.strictEqual(s.cue, true);
});

test('a missing options object is treated as unfocused', () => {
  const s = surfacesFor(needsYou);
  assert.strictEqual(s.flashTaskbar, true);
});
