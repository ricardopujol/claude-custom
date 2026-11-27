'use strict';
/**
 * The routing pipe (single-instance PR 3, step 2): ONE listener per process on `\\.\pipe\claude-custom-window-<pid>` (host/window-focus.js),
 * one entry per project window of the process.
 *
 * Why one listener: the name is the one every `window.json` of this process leads to (host/window-owner.js), and the only name an older
 * build or another install knows. Two windows of one process cannot each listen on it, so each window's claim (host/window-claim.js)
 * registers an entry here instead of listening; its `close()` removes only that entry, so stop() / resume() of one window never touch
 * another's.
 *
 * Routing a focus message, in this order:
 *   root   the sender's project root (PR 3 senders): that window, or NOTHING (never another window: P-R1)
 *   cwd    its project root (projectOf), else the registered root that contains it
 *   port   the window with a tab on that port
 *   only   the one registered window (a pre-PR-3 sender from `dev\` sends `{}`)
 *   none   refused: 'no such window'. That launch opens its own window (the pre-#247 behaviour, never a swallowed launch); in the
 *          migration window only, when an old sender meets an owner with two or more windows.
 *
 *   createWindowRouter({ listen, pid, projectOf, samePath, isInside, log }) -> { register(entry), resolve(msg), size(), stop() }
 *     entry   { root, hasPort(port), accepting(msg), whenReady(msg), onFocus(msg) }
 *     register resolves { close() } once the pipe is up (so before any owner file names this pid); a listen failure rejects it.
 * No Electron.
 */

const NO_SUCH_WINDOW = 'no such window';

function createWindowRouter({ listen, pid, projectOf, samePath, isInside, log = () => {} } = {}) {
  const entries = [];               // in register order
  let server = null;                // Promise<{ close }> while listening (or starting to)

  const byRoot = (root) => entries.find((e) => samePath(e.root, root)) || null;

  function resolve(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    if (typeof m.root === 'string' && m.root) return byRoot(m.root);
    if (typeof m.cwd === 'string' && m.cwd) {
      let p = null;
      try { p = projectOf(m.cwd); } catch { p = null; }
      const own = p && typeof p.root === 'string' ? byRoot(p.root) : null;
      if (own) return own;
      const containing = entries.filter((e) => samePath(e.root, m.cwd) || isInside(m.cwd, e.root));
      if (containing.length) return containing.reduce((best, e) => (isInside(e.root, best.root) ? e : best));   // the deepest root
    }
    if (Number.isInteger(m.port)) {
      const withPort = entries.find((e) => { try { return e.hasPort(m.port) === true; } catch { return false; } });
      if (withPort) return withPort;
    }
    return entries.length === 1 ? entries[0] : null;
  }

  const gates = {
    pid,
    accepting: (msg) => { const e = resolve(msg); return e ? e.accepting(msg) : NO_SUCH_WINDOW; },
    whenReady: (msg) => { const e = resolve(msg); return e ? e.whenReady(msg) : false; },
    onFocus: (msg) => { const e = resolve(msg); return e ? e.onFocus(msg) : undefined; },
    log,
  };

  function ensureServer() {
    if (!server) {
      server = Promise.resolve().then(() => listen(gates));
      server.catch(() => { server = null; });          // a failed listen is tried again by the next register
    }
    return server;
  }

  async function register(entry) {
    await ensureServer();
    entries.push(entry);
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      },
    };
  }

  async function stop() {
    entries.length = 0;
    const s = server;
    server = null;
    if (s) { try { await (await s).close(); } catch { /* never listened, or gone */ } }
  }

  return { register, resolve, size: () => entries.length, stop };
}

module.exports = { createWindowRouter, NO_SUCH_WINDOW };
