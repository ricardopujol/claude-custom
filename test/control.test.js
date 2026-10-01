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

test('a lock-override frame is control, never typed into the pty', () => {
  // Extension X1's *Open anyway*. Off CONTROL_TYPES it would fall through to
  // term.write -- which, in a BLOCKED host, is a null pty.
  const written = [];
  let dispatchedWith = null;
  const result = handleFrame('{"type":"lock-override"}', (msg) => { dispatchedWith = msg; }, (t) => written.push(t));
  assert.strictEqual(result.handled, true);
  assert.deepStrictEqual(written, []);
  assert.deepStrictEqual(dispatchedWith, { type: 'lock-override' });
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

test('a drop frame is CONTROL, and is never typed into the session', () => {
  // The #18/#24 merge, 2026-09-18. This branch predates #18 and dispatched
  // `drop` from the raw ws handler; #18 moved every control frame behind
  // CONTROL_TYPES. A type missing from that list does not get ignored -- it
  // falls through to `term.write`, so the whole frame is TYPED, verbatim JSON
  // and the user's own file paths with it, into a session running
  // --dangerously-skip-permissions. Dropping a file would have typed its path
  // at the prompt.
  const written = [];
  let dispatchedWith = null;
  const text = '{"type":"drop","entries":[{"path":"C:\\\\w\\\\notes.txt"}]}';
  const result = handleFrame(text, (msg) => { dispatchedWith = msg; }, (t) => written.push(t));

  assert.strictEqual(result.handled, true, 'a drop frame must be handled as control');
  assert.deepStrictEqual(written, [], 'a drop frame must NEVER reach the terminal');
  assert.strictEqual(dispatchedWith.type, 'drop');
  const BS = String.fromCharCode(92);          // one backslash, unambiguously
  assert.strictEqual(dispatchedWith.entries[0].path, 'C:' + BS + 'w' + BS + 'notes.txt');
});

test('a portrait frame is CONTROL, and is never typed into the session', () => {
  // FF7: dropping a file onto an agent's face sends {type:'portrait', ...,
  // path: 'C:\\Users\\ricar\\Desktop\\photo.png'} -- a real filesystem path,
  // exactly the shape #18/#24 already fixed for `drop`. Missing from
  // CONTROL_TYPES, that path would be typed verbatim into a session running
  // --dangerously-skip-permissions instead of reaching the upload handler.
  const written = [];
  let dispatchedWith = null;
  const text = '{"type":"portrait","action":"set","agent":"code-reviewer","state":"working","path":"C:\\\\Users\\\\ricar\\\\Desktop\\\\photo.png"}';
  const result = handleFrame(text, (msg) => { dispatchedWith = msg; }, (t) => written.push(t));

  assert.strictEqual(result.handled, true, 'a portrait frame must be handled as control');
  assert.deepStrictEqual(written, [], 'a portrait frame must NEVER reach the terminal');
  assert.strictEqual(dispatchedWith.type, 'portrait');
  assert.strictEqual(dispatchedWith.agent, 'code-reviewer');
});

test('a style frame is CONTROL, and is never typed into the session', () => {
  // The same shape as the drop-frame test above, for the FF6 style tab: a
  // set-background or reset-background action must be dispatched, not typed
  // as literal JSON into a session that may be running with permissions
  // bypassed.
  const written = [];
  let dispatchedWith = null;
  const text = '{"type":"style","action":"set-background","path":"C:\\\\pic.png"}';
  const result = handleFrame(text, (msg) => { dispatchedWith = msg; }, (t) => written.push(t));

  assert.strictEqual(result.handled, true, 'a style frame must be handled as control');
  assert.deepStrictEqual(written, [], 'a style frame must NEVER reach the terminal');
  assert.strictEqual(dispatchedWith.type, 'style');
  assert.strictEqual(dispatchedWith.action, 'set-background');
});

test('every type host.js dispatches is on the control allow-list', () => {
  // The general form of the bug above, so the next feature to add a control
  // frame cannot reproduce it. Any `msg.type === 'x'` branch in
  // dispatchControl whose 'x' is not in CONTROL_TYPES is a frame that gets
  // typed into the session instead of handled.
  const fs = require('fs');
  const path = require('path');
  const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  const start = host.indexOf('function dispatchControl');
  assert.ok(start !== -1, 'dispatchControl must exist for this check to mean anything');
  const body = host.slice(start, host.indexOf('\n  }', start));

  const dispatched = new Set();
  const re = /msg\.type === '([^']+)'/g;
  let m;
  while ((m = re.exec(body))) dispatched.add(m[1]);
  assert.ok(dispatched.size > 0, 'found no dispatched types -- the scan is broken, not the code');

  const missing = [...dispatched].filter(t => !CONTROL_TYPES.has(t));
  assert.deepStrictEqual(missing, [],
    'host.js dispatches these types, but parseControlFrame does not recognise them, ' +
    'so the frames are written to the pty as literal keystrokes instead');
});

test('stop and raise frames are control, never typed into the pty', () => {
  // Worktree tabs. Off CONTROL_TYPES either would be typed as literal JSON
  // into a session that may run --dangerously-skip-permissions.
  for (const type of ['stop', 'raise']) {
    const written = [];
    let dispatchedWith = null;
    const result = handleFrame(JSON.stringify({ type }), (msg) => { dispatchedWith = msg; }, (t) => written.push(t));
    assert.strictEqual(result.handled, true, type);
    assert.deepStrictEqual(written, [], type);
    assert.deepStrictEqual(dispatchedWith, { type }, type);
  }
});

test('a lock-stop-holder frame is control, never typed into the pty', () => {
  // *Stop that session*. Off CONTROL_TYPES it would be typed as literal JSON
  // into the pty -- and the host's hello would not list it, so the pane's
  // request would never be honoured.
  const written = [];
  let dispatchedWith = null;
  const result = handleFrame('{"type":"lock-stop-holder"}', (msg) => { dispatchedWith = msg; }, (t) => written.push(t));
  assert.strictEqual(result.handled, true);
  assert.deepStrictEqual(written, []);
  assert.deepStrictEqual(dispatchedWith, { type: 'lock-stop-holder' });
});

// --- raiseTargets: who a `raise` frame comes forward for ---------------------

test('raiseTargets leaves out the sender: a one-shot client is not a window', () => {
  const { raiseTargets } = require('../host/control');
  const sender = { id: 'sender' };
  const w1 = { id: 'w1' };
  const w2 = { id: 'w2' };
  assert.deepStrictEqual(raiseTargets(new Set([w1, sender, w2]), sender), [w1, w2]);
  // The sender alone means "no window open": 0, never 1.
  assert.deepStrictEqual(raiseTargets(new Set([sender]), sender), []);
  assert.deepStrictEqual(raiseTargets(new Set(), sender), []);
});

test('raiseTargets copes with a missing set and keeps every non-sender', () => {
  const { raiseTargets } = require('../host/control');
  assert.deepStrictEqual(raiseTargets(null, {}), []);
  const a = {}; const b = {};
  assert.deepStrictEqual(raiseTargets([a, b], null), [a, b]);
});

// --- stop-if-idle: the holder decides, in one step (Dexter, PR #76 F2) --------

test('a stop-if-idle frame is control, never typed into the pty', () => {
  const written = [];
  const result = handleFrame('{"type":"stop-if-idle"}', () => {}, (t) => written.push(t));
  assert.strictEqual(result.handled, true);
  assert.deepStrictEqual(written, []);
});

test('idleStopVerdict stops only with no window attached and none that just left', () => {
  const { idleStopVerdict, WINDOW_GONE_GRACE_MS } = require('../host/control');
  const now = 100000;
  assert.deepStrictEqual(idleStopVerdict({ windows: 0, lastWindowLeftAt: null, now }), { stop: true, windows: 0 });
  assert.deepStrictEqual(idleStopVerdict({ windows: 0, lastWindowLeftAt: now - WINDOW_GONE_GRACE_MS, now }), { stop: true, windows: 0 });
  assert.deepStrictEqual(idleStopVerdict({ windows: 2, lastWindowLeftAt: null, now }), { stop: false, windows: 2 });
  // A window that left a moment ago is reloading or reconnecting (renderer.js
  // reconnects within ~1 s): that session is in use.
  assert.deepStrictEqual(idleStopVerdict({ windows: 0, lastWindowLeftAt: now - 1000, now }),
    { stop: false, windows: 0, recent: true });
  for (const windows of [undefined, null, -1, 1.5, '0', NaN]) {
    assert.strictEqual(idleStopVerdict({ windows, lastWindowLeftAt: null, now }).stop, false, String(windows));
  }
  assert.ok(WINDOW_GONE_GRACE_MS >= 3000, 'longer than a reload and a reconnect');
});

test('leftAsWindow: a connection that lasted is a window leaving; a one-shot control client is not', () => {
  const { leftAsWindow, ONE_SHOT_MAX_MS } = require('../host/control');
  assert.strictEqual(leftAsWindow(1000, 1000 + ONE_SHOT_MAX_MS), true);
  assert.strictEqual(leftAsWindow(1000, 1000 + 120), false, 'host/host-client.js lives for one frame');
  assert.strictEqual(leftAsWindow(null, 5000), true, 'unknown opening time errs toward "a window left"');
});
