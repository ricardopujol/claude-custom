'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { validResizeDims, parseControlFrame, handleFrame, MAX_TERMINAL_DIM, CONTROL_TYPES } =
  require('../host/control');

// --- validResizeDims ---------------------------------------------------------

test('validResizeDims rejects the exact inputs that throw in node-pty', () => {
  assert.strictEqual(validResizeDims(0, 30), false);
  assert.strictEqual(validResizeDims(-5, 30), false);
  assert.strictEqual(validResizeDims(null, 30), false);
  assert.strictEqual(validResizeDims(80, undefined), false);
  assert.strictEqual(validResizeDims(1.5, 30), false);
  assert.strictEqual(validResizeDims(80, 30), true);
});

test('validResizeDims rejects cols=1, which xterm silently clamps to 2 while node-pty accepts it', () => {
  // Dexter, logic review 2026-09-15: @xterm/headless's MINIMUM_COLS is 2, not
  // 1 -- a bound of `>= 1` admits the exact value that desyncs node-pty (which
  // applies 1) against the replay emulator (which silently becomes 2).
  assert.strictEqual(validResizeDims(1, 30), false);
  assert.strictEqual(validResizeDims(2, 30), true);
  // xterm's MINIMUM_ROWS is actually 1, so `rows` alone could be looser --
  // but a single shared minimum of 2 is simpler and still correct (no real
  // terminal needs a single row), so rows=1 is rejected too.
  assert.strictEqual(validResizeDims(30, 1), false);
  assert.strictEqual(validResizeDims(2, 2), true);
});

test('validResizeDims boundary is pinned at MAX_TERMINAL_DIM, not a hardcoded literal', () => {
  // Miguel, code review 2026-09-15: measured 10000 accepting a resize that
  // allocates +1154MB and blocks the event loop 602ms -- 7.5x the hook
  // helper's 80ms connect budget. Lowered to 2000, still generous for any
  // real terminal. A module-scope constant produces zero mutants under this
  // project's mutmut setup, so this boundary must be pinned explicitly.
  assert.strictEqual(MAX_TERMINAL_DIM, 2000);
  assert.strictEqual(validResizeDims(MAX_TERMINAL_DIM, MAX_TERMINAL_DIM), true);
  assert.strictEqual(validResizeDims(MAX_TERMINAL_DIM + 1, 30), false);
});

// --- parseControlFrame --------------------------------------------------------

test('parseControlFrame treats literal text starting with "{" as input when it is not valid JSON', () => {
  assert.strictEqual(parseControlFrame('{not json'), null);
});

test('parseControlFrame treats plain typed text as input', () => {
  assert.strictEqual(parseControlFrame('ls -la\r'), null);
});

test('parseControlFrame treats valid JSON with no type field as input, not a control message', () => {
  assert.strictEqual(parseControlFrame('{"foo":"bar"}'), null);
});

test('parseControlFrame treats a JSON object with an UNRECOGNIZED type as input, not a swallowed frame', () => {
  // Dexter + Miguel, 2026-09-15: the first version of this classifier accepted
  // ANY string `type`, so pasting a JSON Schema fragment or a Google
  // service-account key (both start with `{"type":"..."}`) got silently
  // consumed instead of typed -- no handler matched, nothing logged, the
  // text simply vanished. Only the host's own known message types are ours.
  const serviceAccountShaped = '{"type":"service_account","project_id":"acme-prod"}';
  assert.strictEqual(parseControlFrame(serviceAccountShaped), null);
  const jsonSchemaShaped = '{"type":"object","properties":{}}';
  assert.strictEqual(parseControlFrame(jsonSchemaShaped), null);
});

test('parseControlFrame requires the frame to start with "{" literally -- leading whitespace is literal input', () => {
  // Dexter, 2026-09-15: JSON.parse tolerates leading whitespace but the
  // `startsWith('{')` pre-filter does not, so a control message with a
  // leading space would be typed rather than dispatched. No real sender
  // produces this (JSON.stringify never emits leading whitespace), so this
  // pins the deliberate, currently-harmless choice rather than fixing a bug.
  assert.strictEqual(parseControlFrame(' {"type":"health"}'), null);
});

test('parseControlFrame returns the parsed message for every known control type', () => {
  for (const type of CONTROL_TYPES) {
    assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type, x: 1 })), { type, x: 1 });
  }
});

// --- handleFrame: the actual defect Miguel and Dexter both flagged as untested ----

test('a dispatch that throws never falls through to literal input', () => {
  // This is the property B1 was about. The old code wrapped JSON.parse and
  // dispatch in ONE try, so a throwing handler (an unvalidated resize,
  // reliably) was caught by the catch that means "not control JSON" and the
  // raw text got typed into the pty. Deleting the final `return` in the real
  // dispatcher reintroduces this in full while every OTHER test stays green
  // -- this is the one that pins it.
  const written = [];
  const result = handleFrame(
    '{"type":"resize","cols":0,"rows":30}',
    () => { throw new Error('boom'); },
    (text) => written.push(text),
  );
  assert.deepStrictEqual(written, [], 'the control text must never become literal input');
  assert.strictEqual(result.handled, true);
  assert.ok(result.error instanceof Error);
});

test('literal text is written when the frame is not a recognized control message', () => {
  const written = [];
  const result = handleFrame(
    'ls -la\r',
    () => { throw new Error('dispatch must not be called for literal input'); },
    (text) => written.push(text),
  );
  assert.deepStrictEqual(written, ['ls -la\r']);
  assert.strictEqual(result.handled, false);
});

test('an unrecognized but JSON-shaped type reaches the terminal, not a silent drop', () => {
  const written = [];
  let dispatchCalled = false;
  const text = '{"type":"service_account","project_id":"x"}';
  const result = handleFrame(text, () => { dispatchCalled = true; }, (t) => written.push(t));
  assert.strictEqual(dispatchCalled, false);
  assert.deepStrictEqual(written, [text]);
  assert.strictEqual(result.handled, false);
});

test('a dispatch that succeeds never writes the frame as literal input', () => {
  const written = [];
  let dispatchedWith = null;
  const result = handleFrame(
    '{"type":"health"}',
    (msg) => { dispatchedWith = msg; },
    (text) => written.push(text),
  );
  assert.deepStrictEqual(dispatchedWith, { type: 'health' });
  assert.deepStrictEqual(written, []);
  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.error, undefined);
});
