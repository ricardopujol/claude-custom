'use strict';
/**
 * Send ONE control frame to a running host from outside a window, and report
 * what came of it. The shell uses it for *Go to that session* (`raise`) and for
 * closing a tab by hand (`stop`).
 *
 * The connection is made the way the renderer's `connect()` and
 * verify/probe-session-lock-host.js's `attach()` make it: a plain WebSocket to
 * `ws://127.0.0.1:<port>/?token=<encoded>`. The host refuses a bad token at the
 * HANDSHAKE (403), so a wrong token never gets as far as a socket.
 *
 * Contract: it NEVER throws and NEVER leaves a socket open. Every outcome is a
 * value, and the failures are told apart by their `error` string so a caller
 * can say something true ("that host is gone" is not "that host is stuck"):
 *   'connection refused'            nothing is listening on the port
 *   'handshake refused (HTTP 403)'  something is, and it rejected the token
 *   'timed out after <n>ms'         it accepted but never did what was expected
 *   'closed before reply'           it hung up on us before answering
 *   'socket error: <message>'       anything else the socket reported
 *   'invalid ...' / 'unsupported control type: <t>'   bad arguments
 */

// What each frame waits for. `reply` is the control type that answers it;
// `null` means "the host ends, and its socket closes". A third frame is a
// third line here.
const EXPECTED = Object.freeze({
  raise: { reply: 'raised' },
  stop: { reply: null },
});

const DEFAULT_TIMEOUT_MS = 3000;

const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

function sendControl({ port, token, msg, timeoutMs = DEFAULT_TIMEOUT_MS, WebSocket = require('ws') } = {}) {
  return new Promise((resolve) => {
    if (!isPort(port)) return resolve({ ok: false, error: `invalid port: ${String(port)}` });
    if (typeof token !== 'string' || !token) return resolve({ ok: false, error: 'invalid token' });
    const expected = msg && typeof msg.type === 'string' && Object.hasOwn(EXPECTED, msg.type)
      ? EXPECTED[msg.type] : null;
    if (!expected) return resolve({ ok: false, error: `unsupported control type: ${msg && msg.type}` });
    const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    let ws = null;
    let timer = null;
    let sent = false;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws) {
        ws.on('error', () => {});                  // a late error must not be unhandled
        try { ws.terminate(); } catch { /* already closed */ }
      }
      resolve(result);
    };

    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    } catch (err) {
      return finish({ ok: false, error: `socket error: ${err && err.message}` });
    }

    timer = setTimeout(() => finish({ ok: false, error: `timed out after ${wait}ms` }), wait);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify(msg));
        sent = true;
      } catch (err) {
        finish({ ok: false, error: `socket error: ${err && err.message}` });
      }
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary || expected.reply === null) return;    // pty bytes, or nothing to wait for
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (parsed && parsed.type === expected.reply) finish({ ok: true, reply: parsed });
    });

    ws.on('error', (err) => {
      const text = (err && err.message) || String(err);
      const status = /Unexpected server response: (\d+)/.exec(text);
      if (status) return finish({ ok: false, error: `handshake refused (HTTP ${status[1]})` });
      if (err && err.code === 'ECONNREFUSED') return finish({ ok: false, error: 'connection refused' });
      // A host that ends on `stop` can drop the connection hard rather than
      // close it; once the frame is out, that IS the answer.
      if (expected.reply === null && sent && err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
        return finish({ ok: true, reply: null });
      }
      finish({ ok: false, error: `socket error: ${text}` });
    });

    ws.on('close', () => {
      if (expected.reply === null && sent) return finish({ ok: true, reply: null });
      finish({ ok: false, error: 'closed before reply' });
    });
  });
}

module.exports = { sendControl, EXPECTED, DEFAULT_TIMEOUT_MS };
