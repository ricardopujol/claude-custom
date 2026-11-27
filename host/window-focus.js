'use strict';
/**
 * The focus channel of "one window per project" (DESIGN_TABS_SESSIONS.md 3.3): how a second launch of a project tells the
 * project's window "focus yourself and select this lane".
 *
 * A named pipe the window's own main process listens on, `\\.\pipe\claude-custom-window-<pid>` -- the same transport the
 * hook helper already uses for a host (`claude-custom-<pid>`). The pid is the one in the owner file (host/window-owner.js), so the
 * launcher needs nothing else to find it. One JSON line in ({ root?, cwd?, port? }), one JSON line out ({ ok }), then it closes.
 * SINGLE-INSTANCE PR 3: one process holds several windows, so it listens ONCE on that name and routes by `root` (host/window-router.js);
 * the same listener serves the app pipe `claude-custom-app-<pid>` (appPipeNameFor, another message filter: host/app-claim.js). A sender
 * may ask for an ack (`ack: true`): it is answered `{"ack":true}` at once, so a hung owner (no ack) is told from one that holds the
 * launch while it starts. A sender that does not ask gets exactly one line, as before.
 * A window that is READY answers ok the moment the message is understood and focuses and selects right after. A window still starting
 * HOLDS the launch (no idle drop) until it is ready (ok) or stops / passes its start bound (not ok), so ok is never said by a window that
 * may end before it acts (PR #247 round 2 M2). The launch's own wait is longer than the bound (host/window-claim.js).
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

const nameFor = (kind, pid, platform) => (platform === 'win32'
  ? `\\\\.\\pipe\\claude-custom-${kind}-${pid}`
  : path.join(os.tmpdir(), `claude-custom-${kind}-${pid}.sock`));

/** The window pipe of process `pid`: every `window.json` of that process leads here (one listener per process, host/window-router.js). */
function pipeNameFor(pid, platform = process.platform) { return nameFor('window', pid, platform); }

/** The app pipe of process `pid` (single-instance PR 3): `open` messages from a launch that read this install's `app.json`. */
function appPipeNameFor(pid, platform = process.platform) { return nameFor('app', pid, platform); }

// What a launch may say: nothing, the sender's project root, a folder, a port. Anything else is refused whole. `ack` is the sender's
// request for an acknowledgement (read off the raw line by the listener), never part of the message.
function cleanMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.type !== 'focus') return null;
  const out = {};
  if (raw.root !== undefined) {
    if (typeof raw.root !== 'string' || raw.root.length > MAX_CWD) return null;
    out.root = raw.root;
  }
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
 * Say ok, and act only once that ok has gone out (PR #258 Dexter 3). A sender that gave up before its line was read (an owner whose loop
 * was blocked while the line AND the close were pending) has no pipe to write to: the write fails, and nothing is opened for a launch that
 * already opened its own window. A socket already gone is not written to at all.
 */
function okThenAct(sock, act, log = () => {}) {
  if (sock.destroyed) return;
  try {
    sock.write('{"ok":true}\n', (err) => {
      if (err) { log(`[window-focus] the launch left before its ok: ${err.code || err.message}`); return; }
      act();
    });
    sock.end();
  } catch { /* the launch went away */ }
}

/**
 * Listen for launches. Resolves { close() } once the pipe is up; rejects when it can't be (the name is taken): the caller then
 * publishes no owner file. `onFocus(msg)` runs AFTER the launch was answered ok, which only a ready window does.
 * `accepting(msg)` -> bool: false answers not-ok at once. `whenReady(msg)` -> bool | Promise<bool>: held on until it settles; anything but
 * true (false, a rejection, a throw) answers not-ok. Default: ready. Each gate gets the CLEANED message (the router picks a window by it).
 * `name` serves another pipe than this pid's window pipe (the app pipe); `clean(raw)` -> msg | null is its message filter.
 * THE ACK (PR 3 step 1): a line carrying `ack: true` is answered `{"ack":true}` at once, before the gates, so the sender can tell a hung
 * owner (no ack) from one that holds the launch while it starts. A line without it gets exactly one line back, as before.
 */
function listen({ pid, name, clean = cleanMessage, onFocus, accepting = () => true, whenReady = () => true, idleMs = DEFAULT_IDLE_MS, log = () => {} } = {}) {
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
        let raw = null;
        try { raw = JSON.parse(buf.slice(0, i)); } catch { raw = null; }
        let msg = null;
        try { msg = clean(raw); } catch { msg = null; }
        if (!msg) return reply({ ok: false, error: 'not a focus request' });
        // Asked for: the line was understood, by a process whose event loop runs. Sent once, before any gate.
        if (raw && raw.ack === true) { try { sock.write('{"ack":true}\n'); } catch { /* the launch went away */ } }
        // An owner that is quitting, or whose start never finished, says no: the launch then opens its own window (host/window-claim.js).
        // `accepting` may name its refusal (the router: 'no such window'); anything else that is not true is 'closing'.
        let open = false;
        let why = 'closing';
        try { const a = accepting(msg); open = a === true; if (typeof a === 'string' && a) why = a; } catch { open = false; }
        if (!open) return reply({ ok: false, error: why });
        // A launch is held (no idle drop) while this window finishes starting: ok is only ever said by a window that is ready, so an
        // owner that then ends before it is ready (attach-only refusal, failed start) cannot have swallowed a launch (PR #247 Dexter M2).
        sock.setTimeout(0);
        // ACCEPT, THEN ACT. Once the window is ready the launch is answered at once and acted on right after.
        let ready;
        try { ready = Promise.resolve(whenReady(msg)); } catch { ready = Promise.resolve(false); }
        ready.catch(() => false).then((isReady) => {
          if (sock.destroyed) return;        // the launch gave up while held: nobody to answer, and nothing to act for (PR #248 Miguel S2)
          let open = false;
          let why2 = 'closing';
          try { const a = isReady === true ? accepting(msg) : false; open = a === true; if (typeof a === 'string' && a) why2 = a; } catch { open = false; }
          if (!open) return reply({ ok: false, error: why2 });          // the real reason, as the first refusal says it (PR #258 Miguel S1)
          if (answered) return;
          answered = true;
          okThenAct(sock, () => { Promise.resolve().then(() => onFocus(msg)).catch((err) => log(`[window-focus] onFocus failed: ${err && err.message}`)); }, log);
        });
      });
    });
    server.once('error', reject);
    server.listen(typeof name === 'string' && name ? name : pipeNameFor(pid), () => {
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

/**
 * Ask the window of `pid` (or the pipe `name`) to focus, or send another `type`. NEVER throws: { ok: true } (accepted) or { ok: false, error }.
 * `ackMs`: ask for the ack and answer { ok: false, error: 'no ack' } when no line at all came back within it (a hung owner). An owner of
 * older code answers its one final line and no ack: that line is the answer, as before.
 */
function send({ pid, name, type = 'focus', msg = {}, timeoutMs = DEFAULT_SEND_TIMEOUT_MS, ackMs } = {}) {
  return new Promise((resolve) => {
    const target = typeof name === 'string' && name ? name : null;
    if (!target && !isPid(pid)) return resolve({ ok: false, error: `invalid pid: ${String(pid)}` });
    const wantsAck = Number.isFinite(ackMs) && ackMs > 0;
    let done = false;
    let buf = '';
    let ackTimer = null;
    const sock = net.connect(target || pipeNameFor(pid));
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(ackTimer);
      sock.on('error', () => {});
      try { sock.destroy(); } catch { /* closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    if (wantsAck) ackTimer = setTimeout(() => finish({ ok: false, error: 'no ack' }), ackMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ ...msg, type, ...(wantsAck ? { ack: true } : {}) }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0 && !done; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let v;
        try { v = JSON.parse(line); } catch { return finish({ ok: false, error: 'unparseable answer' }); }
        const isObj = v && typeof v === 'object' && !Array.isArray(v);
        // The ack only stops the ack clock: the launch is held for the final line (the owner may still be starting).
        if (isObj && v.ack === true && v.ok === undefined) { clearTimeout(ackTimer); continue; }
        // Only the exact { ok: true } is an acceptance; null, arrays and a truthy non-true ok are not (PR #247 Miguel I3).
        if (isObj && v.ok === true) return finish({ ok: true });
        return finish({ ok: false, error: (isObj && typeof v.error === 'string' && v.error) || 'refused' });
      }
    });
    sock.on('error', (err) => finish({ ok: false, error: `socket error: ${err && err.code || err && err.message}` }));
    sock.on('close', () => finish({ ok: false, error: 'closed before answer' }));
  });
}

module.exports = { pipeNameFor, appPipeNameFor, listen, send, cleanMessage, okThenAct, MAX_CWD };
