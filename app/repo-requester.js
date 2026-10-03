'use strict';
/**
 * The page's side of the `repo` protocol (#45 / #32).
 *
 *   createRequester({ send, setTimer, clearTimer }) ->
 *     request(action, body) -> Promise<reply>   never rejects; { ok: false, error } when it can't be answered
 *     onMessage(msg)       -> boolean           true when the frame was an answer to an ask (or a push)
 *     onChanged(fn)                              the host's `changed` push (the worktree changed)
 *     setControls(list)                          `hello.controls`: what this host accepts
 *     failAll(reason)                            a dropped socket: every pending ask fails now
 *   hostNote(controls) -> string | null          why the Files tab can't work, in words
 *
 * THREE WAYS TO ASK AND NEVER GET AN ANSWER, each turned into a plain failure:
 *   - the HOST IS OLDER than this page. Hosts outlive windows, so a freshly updated page can attach to a host
 *     that doesn't know `repo`; that host would TYPE the frame into the pty. So nothing is sent until the
 *     host's own `hello.controls` lists `repo` (the check host/host-client.js makes for `stop`).
 *   - the socket is closed: send() answers false.
 *   - the host never replies: TIMEOUT_MS.
 * Every ask carries a `seq`, echoed by the host, so an answer goes to ITS ask and a late one (after a
 * timeout) is nobody's.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoRequester`.
 */
(function (root) {

const TIMEOUT_MS = 15000;

const accepts = (controls) => Array.isArray(controls) && controls.includes('repo');

const OLDER = "This session's host is older than this window and can't list files. Restart the session (close this tab and open it again) to browse files.";

// `undefined` is "no hello yet" (the socket opens before the host says hello): not a claim about the host.
function hostNote(controls) {
  if (accepts(controls)) return null;
  return controls === undefined ? 'Waiting for the session to connect.' : OLDER;
}

function createRequester({ send, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  let controls;
  let seq = 0;
  const pending = new Map();
  const changed = [];

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(reply);
    return true;
  }

  function request(action, body) {
    const fail = (error) => Promise.resolve({ type: 'repo', action, ok: false, error });
    if (!accepts(controls)) return fail(hostNote(controls));
    const id = ++seq;
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      pending.set(id, entry);
      entry.timer = setTimer(() => settle(id, { type: 'repo', action, ok: false, error: 'the host did not answer in time' }), TIMEOUT_MS);
      let sent = false;
      try { sent = send({ ...(body || {}), type: 'repo', action, seq: id }) !== false; } catch { sent = false; }
      if (!sent) settle(id, { type: 'repo', action, ok: false, error: 'not connected to the session' });
    });
  }

  function onMessage(msg) {
    if (!msg || msg.type !== 'repo') return false;
    if (msg.action === 'changed' && msg.seq === undefined) {
      for (const fn of changed) { try { fn(); } catch (err) { console.error('[repo] changed listener threw', err); } }
      return true;
    }
    return settle(msg.seq, msg);
  }

  function failAll(reason) {
    for (const id of [...pending.keys()]) settle(id, { type: 'repo', ok: false, error: String(reason) });
  }

  return {
    request, onMessage, failAll,
    onChanged: (fn) => { changed.push(fn); },
    setControls: (list) => { controls = list; },
  };
}

const API = { createRequester, hostNote, TIMEOUT_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoRequester = API;

})(typeof window !== 'undefined' ? window : globalThis);
