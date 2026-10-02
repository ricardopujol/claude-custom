'use strict';
/**
 * The host's LISTEN path, checked against the source.
 *
 * Dexter, correctness review of PR #31, Finding 1 (Critical). Two windows
 * launching the same project at once -- a double-click on a picker row is
 * enough -- both find the port free and both spawn. The loser then:
 *
 *   1. writes .harness/hosts/<port>.token AND .harness/session-token,
 *      clobbering the winner's,
 *   2. spawns a real `claude --dangerously-skip-permissions`,
 *   3. constructs the WebSocketServer, which binds ASYNCHRONOUSLY and does
 *      not throw,
 *   4. publishes its identity over the winner's, naming its own pid,
 *   5. and only then takes EADDRINUSE as an unhandled 'error' event and dies.
 *
 * `shutdown()` runs on SIGINT/SIGTERM only, so nothing repairs the file. Port
 * P is then held by the live winner while <port>.json names a dead pid, and
 * every later launch reads that, decides 'unidentified', and STEPS PAST the
 * live host to spawn an empty session. A Remote Control session in that host
 * becomes unreachable from the GUI permanently.
 *
 * These are SOURCE assertions, in the style of test/control.test.js's
 * allow-list check, because host.js is 1300 lines of module-level wiring that
 * cannot be required in a unit test without spawning a pty. They are coarse,
 * and they are the only thing that fails when someone removes the guard.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the websocket server has an error listener, so a failed bind is not fatal', () => {
  // Without this, EADDRINUSE is an 'error' event with no listener, which in
  // Node THROWS -- an uncaught exception that kills the host mid-startup,
  // after it has already overwritten the winner's files.
  // assert.ok, not assert.match: a failing match dumps all 51KB of host.js.
  assert.ok(/wss\.on\(\s*['"]error['"]/.test(HOST),
    'host.js must register wss.on("error") -- an unhandled listen error is an uncaught throw');
});

test('the identity file is published from the LISTENING event, not the same tick as the bind', () => {
  // `new WebSocketServer({port})` binds asynchronously. Publishing in the same
  // synchronous tick advertises a host that is not yet accepting -- and, worse,
  // advertises one whose bind is about to FAIL.
  const idx = HOST.indexOf('writeIdentity({');
  assert.ok(idx !== -1, 'writeIdentity must be called for this check to mean anything');

  // Walk back to the nearest enclosing listener registration.
  const before = HOST.slice(0, idx);
  const lastListening = before.lastIndexOf("wss.on('listening'");
  assert.ok(lastListening !== -1,
    'writeIdentity must sit inside a wss.on("listening") handler');

  // And nothing may close that handler between its start and the call.
  const between = before.slice(lastListening);
  assert.ok(!between.includes('\n});'),
    'writeIdentity must still be INSIDE the listening handler, not after it');
});

test('a failed bind kills the pty instead of orphaning it', () => {
  // The loser has already spawned a real claude by the time the bind fails.
  // Leaving it is a permission-bypassed session with no host and no window.
  const idx = HOST.indexOf("wss.on('error'");
  assert.ok(idx !== -1);
  const handler = HOST.slice(idx, idx + 1200);
  // `shutdown\(` not `shutdown\(\)`: the handler passes {removeIdentity}, and a
  // regex that demands an empty argument list fails on the correct code.
  assert.ok(/shutdown\(/.test(handler),
    'the listen-error handler must run shutdown() so the pty is not orphaned');
});

test('the identity file is NOT removed by a host that never owned it', () => {
  // shutdown() unlinks the identity file. A host that failed to bind must not
  // unlink the file belonging to the host that DID bind -- that would turn one
  // crash into the winner becoming unidentifiable, which is the same defect
  // from the other side.
  const idx = HOST.indexOf("wss.on('error'");
  const handler = HOST.slice(idx, idx + 1200);
  assert.ok(/listening|owned|bound/i.test(handler),
    'the error handler must distinguish "we never bound" from a normal shutdown');
});

// Dexter, PR 2 F1 (High): the ▾ list may stop a pid only on an EXACT proof,
// the OS start time in the identity file. The host learns it asynchronously at
// boot, so it publishes it both ways round: in the listening handler when boot
// got there first, and from boot once it knows -- but only as the port's owner.
test('the identity carries the OS start time, from whichever of bind and boot finishes last', () => {
  const idx = HOST.indexOf('writeIdentity({');
  const call = HOST.slice(idx, idx + 200);
  assert.match(call, /processStartedAt: lockOwner \? lockOwner\.processStartedAt : undefined/);
  const boot = HOST.indexOf('lockOwner = { pid: process.pid, processStartedAt');
  assert.ok(boot !== -1);
  const after = HOST.slice(boot, boot + 900);
  assert.match(after, /if \(boundPort === PORT && typeof processStartedAt === 'string'\)/);
  assert.match(after, /writeIdentity\(\{ dir: HARNESS_DIR, port: PORT, cwd: CWD, processStartedAt \}\)/);
});
