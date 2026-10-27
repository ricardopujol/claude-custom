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

const accepts = (controls, type = 'repo') => Array.isArray(controls) && controls.includes(type);

const OLDER = "This session's host is older than this window and can't list files. Restart the session (close this tab and open it again) to browse files.";

// `undefined` is "no hello yet" (the socket opens before the host says hello): not a claim about the host.
function hostNote(controls) {
  if (accepts(controls)) return null;
  return controls === undefined ? 'Waiting for the session to connect.' : OLDER;
}

// `type` and `older` let another conversation reuse this (the Changes panel's `changes`, app/changes-display.js): same seq, timeout, hello gate.
function createRequester({ send, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout, type = 'repo', older = OLDER } = {}) {
  let controls;
  let seq = 0;
  const pending = new Map();
  const changed = [];
  const overlayReady = [];

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(reply);
    return true;
  }

  function request(action, body) {
    const fail = (error) => Promise.resolve({ type, action, ok: false, error });
    if (!accepts(controls, type)) return fail(controls === undefined ? 'Waiting for the session to connect.' : older);
    const id = ++seq;
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      pending.set(id, entry);
      entry.timer = setTimer(() => settle(id, { type, action, ok: false, error: 'the host did not answer in time' }), TIMEOUT_MS);
      let sent = false;
      try { sent = send({ ...(body || {}), type, action, seq: id }) !== false; } catch { sent = false; }
      if (!sent) settle(id, { type, action, ok: false, error: 'not connected to the session' });
    });
  }

  function onMessage(msg) {
    if (!msg || msg.type !== type) return false;
    if (msg.action === 'changed' && msg.seq === undefined) {
      for (const fn of changed) { try { fn(); } catch (err) { console.error('[repo] changed listener threw', err); } }
      return true;
    }
    // the host re-read the overlay (a tool_result landed after the file change) and it differs (PR #95 R2-1)
    if (msg.action === 'overlay-ready' && msg.seq === undefined) {
      for (const fn of overlayReady) { try { fn(); } catch (err) { console.error('[repo] overlay-ready listener threw', err); } }
      return true;
    }
    return settle(msg.seq, msg);
  }

  // A dropped socket also forgets what its host accepted (PR #95 Dexter D7): the next socket may reach another
  // host, an older one that would type a `repo` frame into its pty. Nothing is sent until ITS hello.
  function failAll(reason) {
    controls = undefined;
    for (const id of [...pending.keys()]) settle(id, { type, ok: false, error: String(reason) });
  }

  return {
    request, onMessage, failAll,
    onChanged: (fn) => { changed.push(fn); },
    onOverlayReady: (fn) => { overlayReady.push(fn); },
    setControls: (list) => { controls = list; },
  };
}

const API = { createRequester, hostNote, TIMEOUT_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoRequester = API;

})(typeof window !== 'undefined' ? window : globalThis);
