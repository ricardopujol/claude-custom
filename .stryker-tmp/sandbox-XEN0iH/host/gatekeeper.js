// @ts-nocheck
'use strict';
/**
 * Who is allowed to attach to the host.
 *
 * THE HOLE THIS CLOSES, stated plainly: the host binds a WebSocket on
 * 127.0.0.1, and one of its control messages (`{type:'input'}`) writes straight
 * into the pty -- which is running `claude --dangerously-skip-permissions`.
 *
 * Browsers do NOT apply CORS to WebSocket handshakes. So before this, any web
 * page the user happened to visit could open ws://127.0.0.1:7681 and type
 * commands into a bypass-mode Claude session. "It only listens on localhost" is
 * not a defence against a browser, because the browser IS on localhost.
 *
 * TWO GATES, because they fail differently:
 *
 *   ORIGIN -- the one that closes the actual hole. Every browser sets `Origin`
 *             on a WebSocket handshake and page script cannot forge it, so
 *             refusing any http/https/ws origin refuses every web page.
 *
 *   TOKEN  -- for the client that simply omits Origin, which a browser cannot
 *             do but `wscat` can. Weaker by nature: anything able to read a
 *             0600 file in the user's own home has already won. It costs
 *             nothing and closes the trivial case.
 *
 * FAILS CLOSED. With no expected token configured, nothing is allowed -- a
 * misconfigured host that accepted everything would be worse than the bug.
 */

const crypto = require('crypto');

// What the Electron renderer reports. MEASURED rather than assumed --
// verify/probe-renderer-origin.js launches a real Electron window with this
// app's own webPreferences (contextIsolation: true, nodeIntegration: false)
// and reads the handshake off the wire: it sends exactly `Origin: file://`.
//
// THE STRING "null" IS DELIBERATELY NOT HERE. Miguel, code review 2026-09-14:
// a document with an OPAQUE origin -- any `<iframe sandbox>` without
// allow-same-origin -- serialises its origin as the literal string "null", so
// accepting it let such a page clear the ORIGIN gate, the one this module
// calls the one that closes the actual hole. The whole defence then fell back
// to the token, which is weaker by nature. Two gates collapsed to one via an
// HTML attribute. The renderer was measured not to need it, so refusing it
// costs nothing.
const LOCAL_ORIGINS = Object.freeze(['file://', '']);

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  // Hash first so the comparison is over equal-length buffers:
  // crypto.timingSafeEqual throws on a length mismatch, which would itself
  // leak the length through an exception.
  const ha = crypto.createHash('sha256').update(left).digest();
  const hb = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function allowConnection({ origin, token } = {}, { expectedToken } = {}) {
  if (!expectedToken) {
    return { ok: false, reason: 'no session token configured; refusing all connections' };
  }

  // An Origin header means a BROWSER made this connection. The only browser we
  // want is our own renderer, which loads from file:// and so reports a local
  // origin. Anything with a scheme is a web page, including one on localhost --
  // a dev server on 127.0.0.1 is still a web page.
  if (origin !== undefined && origin !== null && !LOCAL_ORIGINS.includes(origin)) {
    return { ok: false, reason: `refused origin ${JSON.stringify(String(origin).slice(0, 80))}` };
  }

  if (!timingSafeEqual(token, expectedToken)) {
    // Never echo the expected token: a refusal is logged, and logging the
    // secret in it would hand the secret over.
    return { ok: false, reason: 'bad or missing session token' };
  }

  return { ok: true, reason: null };
}

const newToken = () => crypto.randomBytes(24).toString('hex');

module.exports = { allowConnection, newToken, LOCAL_ORIGINS };
