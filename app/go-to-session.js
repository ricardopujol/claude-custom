'use strict';
/**
 * "Go to that session" (PR 2, worktree tabs): the lock overlay names a holder;
 * this plans what clicking it does.
 *
 *   planGoTo(holder, { tabsByPort, readIdentity, readToken })
 *     -> { kind: 'select-tab', key }         a tab in THIS window serves the port
 *      | { kind: 'raise', port, token }      another claude-custom's window
 *      | { kind: 'explain', text }
 *
 * `holder` is host/session-lock.js's `holderOf`: `{ pid, startedAt, port,
 * claudePid, install }`. Every field may be missing or null.
 *
 * DEPENDENCIES (this file does no I/O and never touches `path`, so it loads
 * in a browser page too):
 *   tabsByPort            a `Map<number, key>` OR a function `(port) => key|undefined`
 *   readIdentity({ install, port })
 *                         host/host-identity.js's reader with the directory
 *                         left to the caller: main passes
 *                         `readIdentity({ dir: path.join(install, '.harness'), port })`.
 *                         Returns `{ port, cwd, pid, startedAt } | null`.
 *   readToken(install, port)
 *                         the contents of `<install>\.harness\hosts\<port>.token`
 *                         or null.
 *
 * THE IDENTITY CHECK COMES BEFORE THE TOKEN IS EVER READ OR RETURNED. A stale
 * lock names a port; something else may now listen there. Handing install A's
 * token to whatever answers on that port is a credential leak, so `readToken`
 * is not called unless the live identity's pid EQUALS the holder's pid.
 *
 * A port that is not a positive integer is NEVER looked up: `null` must not
 * become port 0 (`Number(null)` is 0), and a pid that isn't a positive integer
 * can't be matched (else `undefined === undefined` would "match").
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `goToSession`.
 */
(function (root) {

const isPosInt = n => typeof n === 'number' && Number.isInteger(n) && n > 0;
const nonEmpty = s => typeof s === 'string' && s.length > 0;

function tabFor(tabsByPort, port) {
  try {
    if (typeof tabsByPort === 'function') return tabsByPort(port);
    if (tabsByPort instanceof Map) return tabsByPort.get(port);
  } catch { /* an unreadable lookup is "no tab" */ }
  return undefined;
}

const notFound = () => ({ kind: 'explain', text: "That session's window can't be found." });

function planGoTo(holder, deps = {}) {
  const { tabsByPort, readIdentity, readToken } = deps;
  const h = holder && typeof holder === 'object' ? holder : {};
  if (!isPosInt(h.port)) return notFound();

  // This window first.
  const key = tabFor(tabsByPort, h.port);
  if (nonEmpty(key)) return { kind: 'select-tab', key };

  if (!nonEmpty(h.install) || !isPosInt(h.pid) || typeof readIdentity !== 'function') return notFound();

  let identity = null;
  try { identity = readIdentity({ install: h.install, port: h.port }); } catch { identity = null; }
  if (!identity || identity.pid !== h.pid) return notFound();

  // Only now, with the live host proven to be the holder, may the token be read.
  let token = null;
  if (typeof readToken === 'function') {
    try { token = readToken(h.install, h.port); } catch { token = null; }
  }
  if (!nonEmpty(token)) {
    return {
      kind: 'explain',
      text: `That session is in another claude-custom (pid ${h.pid}, port ${h.port}) with no window open. Open its project to see it.`,
    };
  }
  return { kind: 'raise', port: h.port, token };
}

const api = { planGoTo };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.goToSession = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
