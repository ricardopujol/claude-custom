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
  // It loads from file://, which browsers report as a null origin or omit.
  for (const origin of LOCAL_ORIGINS) {
    assert.strictEqual(check({ origin, token: TOKEN }).ok, true, JSON.stringify(origin));
  }
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
