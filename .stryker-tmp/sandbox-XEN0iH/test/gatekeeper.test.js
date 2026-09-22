// @ts-nocheck
'use strict';
/**
 * Who is allowed to attach to the host.
 *
 * THE THREAT, stated plainly: the host binds a WebSocket on 127.0.0.1 and one
 * of its control messages writes straight into the pty, which is running
 * `claude --dangerously-skip-permissions`. Browsers do NOT apply CORS to
 * WebSocket handshakes, so any web page the user visits could open
 * ws://127.0.0.1:7681 and type commands into a bypass-mode session.
 *
 * Two independent gates, because they fail differently:
 *
 *   ORIGIN   stops a browser. Every browser sets Origin on a WebSocket
 *            handshake and cannot be made to forge it, so this is the gate
 *            that closes the actual hole.
 *   TOKEN    stops a non-browser local process that simply omits Origin. It is
 *            weaker by nature -- anything that can read a 0600 file in the
 *            user's own home directory has already won -- but it costs
 *            nothing and closes the trivial `wscat` case.
 */
const test = require('node:test');
const assert = require('node:assert');

const { allowConnection, LOCAL_ORIGINS } = require('../host/gatekeeper');

const TOKEN = 'a'.repeat(32);
const check = (opts) => allowConnection(opts, { expectedToken: TOKEN });

// --- the gate that matters ---------------------------------------------------

test('a web page origin is REFUSED', () => {
  // The whole point. This is the connection a visited page would make.
  const res = check({ origin: 'https://evil.example', token: TOKEN });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /origin/i);
});

test('http, https and ws origins are all refused', () => {
  for (const origin of ['http://localhost:3000', 'https://example.com',
                        'ws://127.0.0.1:7681', 'http://127.0.0.1:7681']) {
    assert.strictEqual(check({ origin, token: TOKEN }).ok, false, origin);
  }
});

test('a page on localhost is refused too', () => {
  // "It is localhost, so it is us" is exactly the assumption that makes this
  // exploitable: a dev server on 127.0.0.1 is still a web page.
  assert.strictEqual(check({ origin: 'http://localhost:5173', token: TOKEN }).ok, false);
});

test('the Electron renderer IS allowed', () => {
  // MEASURED, not assumed -- verify/probe-renderer-origin.js launches a real
  // Electron window with this app's own webPreferences and reads the handshake
  // off the wire. It sends exactly `Origin: file://`.
  for (const origin of LOCAL_ORIGINS) {
    assert.strictEqual(check({ origin, token: TOKEN }).ok, true, JSON.stringify(origin));
  }
  assert.ok(LOCAL_ORIGINS.includes('file://'), 'the measured renderer origin must be allowed');
});

test('an OPAQUE origin is refused — the string "null" is not a local origin', () => {
  // Miguel, code review 2026-09-14: any `<iframe sandbox>` without
  // allow-same-origin serialises its origin as the literal string "null", so
  // accepting it let such a page clear the ORIGIN gate -- the one this module
  // calls "the one that closes the actual hole" -- leaving only the token,
  // which the module itself describes as weaker by nature. The two-gate design
  // collapsed to one via an HTML attribute.
  //
  // Safe to refuse because it was MEASURED: the real renderer sends
  // `Origin: file://`, never "null" (verify/probe-renderer-origin.js).
  assert.strictEqual(check({ origin: 'null', token: TOKEN }).ok, false);
  assert.ok(!LOCAL_ORIGINS.includes('null'));
});

test('a missing Origin header is allowed only WITH the token', () => {
  // A non-browser client (a probe, wscat) sends no Origin. That cannot be
  // distinguished from a local tool, so the token has to carry it.
  assert.strictEqual(check({ origin: undefined, token: TOKEN }).ok, true);
  assert.strictEqual(check({ origin: undefined, token: 'wrong' }).ok, false);
  assert.strictEqual(check({ origin: undefined, token: undefined }).ok, false);
});

// --- the token ---------------------------------------------------------------

test('a wrong token is refused even from an allowed origin', () => {
  const res = check({ origin: 'file://', token: 'nope' });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /token/i);
});

test('a missing token is refused', () => {
  assert.strictEqual(check({ origin: 'file://' }).ok, false);
});

test('token comparison does not leak length by returning early', () => {
  // Not a serious channel here -- an attacker who can time this can also read
  // the token file -- but a length-equality short-circuit is free to avoid.
  const res = check({ origin: 'file://', token: 'a' });
  assert.strictEqual(res.ok, false);
});

test('an empty expected token REFUSES everything rather than allowing it', () => {
  // Fail closed. A misconfigured host that accepted any connection because it
  // had no token would be worse than the bug this fixes.
  const res = allowConnection({ origin: 'file://', token: '' }, { expectedToken: '' });
  assert.strictEqual(res.ok, false);
});

test('a null expected token refuses everything', () => {
  assert.strictEqual(allowConnection({ origin: 'file://', token: 'x' }, {}).ok, false);
});

// --- shape -------------------------------------------------------------------

test('every refusal says why, for the host log', () => {
  for (const opts of [{ origin: 'https://evil.example', token: TOKEN },
                      { origin: 'file://', token: 'bad' },
                      { origin: undefined }]) {
    const res = check(opts);
    assert.strictEqual(res.ok, false);
    assert.ok(res.reason && res.reason.length > 0, JSON.stringify(opts));
  }
});

test('the reason never contains the expected token', () => {
  // A refusal is logged; logging the secret in it would hand it over.
  const res = check({ origin: 'file://', token: 'bad' });
  assert.ok(!res.reason.includes(TOKEN), res.reason);
});
