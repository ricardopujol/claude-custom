'use strict';
/**
 * The focus channel of "one window per project" (DESIGN_TABS_SESSIONS.md 3.3): how a second launch of a project tells the
 * project's window "focus yourself and select this lane".
 *
 * A named pipe the window's own main process listens on, `\\.\pipe\claude-custom-window-<pid>` -- the same transport the
 * hook helper already uses for a host (`claude-custom-<pid>`). The pid is the one in the owner file (host/window-owner.js), so the
 * launcher needs nothing else to find it. One JSON line in ({ cwd?, port? }), one JSON line out ({ ok }) the moment the message is understood, then it closes.
 * The owner focuses and selects AFTER answering, once its window is ready: a launch never waits for a window to start.
 *
 * WHY NOT THE OTHER TWO (measured, verify/measure-single-instance-lock.js; reasons in the PR):
 *   - Electron's requestSingleInstanceLock is per user-data dir, not per project: a window of another project is refused too.
 *   - A control to the project's host needs a host attached, and has no "focus" frame (a host of older code would TYPE an unknown
 *     frame into the session's prompt, host/host-client.js header).
 *
 * The channel is local to the user's session (a named pipe's default ACL), carries a folder and a port, and can only ask a
 * window to come to the front and select a lane it already has: nothing it sends is executed or opened.
 */

const net = require('net');
const os = require('os');
const path = require('path');

const MAX_LINE = 4096;
const MAX_CWD = 1024;
const DEFAULT_IDLE_MS = 5000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

const isPid = (n) => Number.isInteger(n) && n > 0;

function pipeNameFor(pid, platform = process.platform) {
  return platform === 'win32'
    ? `\\\\.\\pipe\\claude-custom-window-${pid}`
    : path.join(os.tmpdir(), `claude-custom-window-${pid}.sock`);
}

// What a launch may say: nothing, a folder, a port. Anything else is refused whole.
function cleanMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.type !== 'focus') return null;
  const out = {};
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.length > MAX_CWD) return null;
    out.cwd = raw.cwd;
  }
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
    out.port = raw.port;
  }
  return out;
}

/**
 * Listen for launches. Resolves { close() } once the pipe is up; rejects when it can't be (the name is taken): the caller then
 * publishes no owner file. `onFocus(msg)` runs AFTER the launch was answered ok, and may wait for the window to be ready.
 */
function listen({ pid, onFocus, accepting = () => true, idleMs = DEFAULT_IDLE_MS, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      // A connection that goes quiet (never finishes a line) is dropped: it holds a socket for nothing.
      sock.setTimeout(idleMs, () => { try { sock.destroy(); } catch { /* gone */ } });
      let buf = '';
      let answered = false;
      const reply = (obj) => {
        if (answered) return;
        answered = true;
        try { sock.end(JSON.stringify(obj) + '\n'); } catch { /* the launch went away */ }
      };
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        if (answered) return;
        buf += d;
        if (buf.length > MAX_LINE) return reply({ ok: false, error: 'too long' });
        const i = buf.indexOf('\n');
        if (i < 0) return;
        let msg = null;
        try { msg = cleanMessage(JSON.parse(buf.slice(0, i))); } catch { msg = null; }
        if (!msg) return reply({ ok: false, error: 'not a focus request' });
        // An owner that is quitting, or whose start never finished, says no: the launch then opens its own window (host/window-claim.js).
        let open = false;
        try { open = accepting() === true; } catch { open = false; }
        if (!open) return reply({ ok: false, error: 'closing' });
        // ACCEPT, THEN ACT. The launch is answered the moment the message is understood; it never waits for this window to finish starting
        // (a window that takes longer than the launch's wait would make the launch open a second one).
        reply({ ok: true });
        Promise.resolve().then(() => onFocus(msg)).catch((err) => log(`[window-focus] onFocus failed: ${err && err.message}`));
      });
    });
    server.once('error', reject);
    server.listen(pipeNameFor(pid), () => {
      server.removeListener('error', reject);
      server.on('error', (err) => log(`[window-focus] ${err && err.message}`));
      resolve({
        close: () => new Promise((done) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

/** Ask the window of `pid` to focus. NEVER throws: { ok: true } (accepted) or { ok: false, error }. */
function send({ pid, msg = {}, timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!isPid(pid)) return resolve({ ok: false, error: `invalid pid: ${String(pid)}` });
    let done = false;
    let buf = '';
    const sock = net.connect(pipeNameFor(pid));
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.on('error', () => {});
      try { sock.destroy(); } catch { /* closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'focus', ...msg }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let v;
      try { v = JSON.parse(buf.slice(0, i)); } catch { return finish({ ok: false, error: 'unparseable answer' }); }
      // Only the exact { ok: true } is an acceptance; null, arrays and a truthy non-true ok are not (PR #247 Miguel I3).
      if (v && typeof v === 'object' && !Array.isArray(v) && v.ok === true) finish({ ok: true });
      else finish({ ok: false, error: (v && typeof v === 'object' && typeof v.error === 'string' && v.error) || 'refused' });
    });
    sock.on('error', (err) => finish({ ok: false, error: `socket error: ${err && err.code || err && err.message}` }));
    sock.on('close', () => finish({ ok: false, error: 'closed before answer' }));
  });
}

module.exports = { pipeNameFor, listen, send, cleanMessage };
