'use strict';
/**
 * The page's side of the `ask` protocol (BACKLOG #33), modelled on app/repo-requester.js.
 *
 *   createRequester({ send, setTimer, clearTimer }) ->
 *     request(op, body) -> Promise<reply>    never rejects; { type: 'ask', op, ok: false, error } when it can't be answered
 *     notify(op, body)  -> boolean           a frame nobody waits on, through the same gate; false when it wasn't sent
 *     onMessage(msg)    -> boolean           true when the frame was an `ask` frame (an answer, or nobody's)
 *     setControls(list)                      `hello.controls`: what this host accepts
 *     failAll(reason)                        a dropped socket: every pending ask fails now
 *   hostNote(controls) -> string | null      why the panel can't work, in words
 *
 * Three ways to ask and never be answered, each turned into a plain failure: the host is OLDER than this window (a host that
 * doesn't know `ask` would TYPE the frame into the pty, so nothing is sent until its own hello lists `ask`), the socket is closed,
 * and the host never replies (a per-op deadline; an answer from a model takes far longer than a file read).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askRequester`.
 */
(function (root) {

const TIMEOUTS = Object.freeze({ status: 15_000, places: 45_000, ask: 170_000, explain: 170_000, 'start-ollama': 30_000 });
const DEFAULT_TIMEOUT = 60_000;

const accepts = (controls) => Array.isArray(controls) && controls.includes('ask');
const OLDER = "This session's host is older than this window and can't answer questions about the repo. Restart the session (close this tab and open it again).";

function hostNote(controls) {
  if (accepts(controls)) return null;
  return controls === undefined ? 'Waiting for the session to connect.' : OLDER;
}

function createRequester({ send, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  let controls;
  let seq = 0;
  const pending = new Map();

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(reply);
    return true;
  }

  function request(op, body) {
    const fail = (error) => Promise.resolve({ type: 'ask', op, ok: false, error });
    if (!accepts(controls)) return fail(hostNote(controls));
    const id = ++seq;
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      pending.set(id, entry);
      let sent = false;
      try { sent = send({ type: 'ask', op, seq: id, ...(body || {}) }) !== false; } catch { sent = false; }
      if (!sent) {
        pending.delete(id);
        resolve({ type: 'ask', op, ok: false, error: 'The session is not connected.' });
        return;
      }
      entry.timer = setTimer(() => {
        settle(id, { type: 'ask', op, ok: false, error: 'The session did not answer in time.' });
      }, TIMEOUTS[op] || DEFAULT_TIMEOUT);
    });
  }

  return {
    request,
    onMessage(msg) {
      if (!msg || msg.type !== 'ask') return false;
      if (Number.isInteger(msg.seq)) settle(msg.seq, msg);
      return true;
    },
    // A frame nobody waits on (the panel's on-screen state, a place opened): sent only to a host that lists `ask`, like request(), so an
    // older host never has it typed into the session. True when it was sent.
    notify(op, body) {
      if (!accepts(controls)) return false;
      try { return send({ type: 'ask', op, ...(body || {}) }) !== false; } catch { return false; }
    },
    setControls(list) { controls = list; },
    failAll(reason) {
      for (const id of [...pending.keys()]) settle(id, { type: 'ask', ok: false, error: reason });
    },
  };
}

const API = { createRequester, hostNote, TIMEOUTS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askRequester = API;

})(typeof window !== 'undefined' ? window : globalThis);
