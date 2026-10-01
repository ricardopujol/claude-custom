'use strict';
/**
 * The client->host control protocol, kept testable in isolation from the
 * websocket/pty wiring.
 *
 * Miguel, code review 2026-09-14 on `host/host.js`: a single try wrapped both
 * `JSON.parse` and every handler's side effects, so a handler that THREW (an
 * unvalidated resize, reliably) was caught by the same catch that means "not
 * control JSON" -- and the raw control-message text was then typed into the
 * pty as literal keystrokes. Reachable by any malformed control frame, into a
 * session that may be running with permissions bypassed.
 *
 * The fix is three pure pieces, applied in order: classify the frame BEFORE
 * doing anything with it (`parseControlFrame`), validate the specific fields
 * a handler needs before it touches anything with a side effect
 * (`validResizeDims`), and keep the classify/dispatch/fall-through SHAPE
 * itself testable without a live pty or websocket (`handleFrame`) -- Miguel
 * and Dexter's second-round review (2026-09-15) both flagged that the first
 * version of this file tested the two leaf functions but never the property
 * that actually mattered: a throwing dispatch must never reach literal input.
 */

// node-pty throws on cols/rows <= 0, NaN, or non-finite; @xterm/headless
// instead silently clamps to a minimum of 2 COLUMNS (MINIMUM_COLS in
// @xterm/xterm's BufferService -- "less than 2 can mess with wide chars").
// Unvalidated, the two resize targets disagree on a bad frame and the replay
// buffer desyncs permanently: xterm clamps to 2 cols, node-pty applies
// whatever was sent, and a serialized 2-column screen is then handed to every
// future attach. Dexter, logic review 2026-09-15: a lower bound of `>= 1`
// admits cols=1, the exact value that desyncs the two -- the bound must match
// xterm's actual minimum, not node-pty's.
const MIN_TERMINAL_DIM = 2;

// Miguel, code review 2026-09-15, measured: a resize to (10000, 10000) is
// accepted by a `<= 10000` bound and allocates +1154MB / blocks the event
// loop 602ms against this host's own 80ms hook-helper connect budget. Lowered
// to 2000 -- still far beyond any real terminal -- and pinned by an explicit
// boundary test, because a module-scope constant produces zero mutants under
// this project's mutmut setup and would otherwise drift unnoticed.
const MAX_TERMINAL_DIM = 2000;

function validResizeDims(cols, rows) {
  const dim = v => Number.isInteger(v) && v >= MIN_TERMINAL_DIM && v <= MAX_TERMINAL_DIM;
  return dim(cols) && dim(rows);
}

// The complete vocabulary of client->host control messages. Dexter + Miguel,
// 2026-09-15: the first version of this classifier accepted ANY JSON object
// carrying a string `type`, so a pasted JSON Schema fragment or a Google
// service-account key (both start `{"type":"..."}`) matched the classifier,
// matched no handler in host.js's dispatch, and was silently discarded with
// no log and no trace -- a regression versus the pre-fix behaviour, which
// typed it. Classifying by IDENTITY (is this one of ours?) rather than by
// SHAPE (does it look like it could be one of ours?) restores the old
// fall-through for everything else.
const CONTROL_TYPES = new Set([
  'resize', 'health', 'input', 'models', 'seat', 'fog', 'drop',
  // Both sides of this merge added a type. Taking either alone makes the
  // other's frames fall through to `term.write` -- verbatim JSON typed into
  // a session running --dangerously-skip-permissions. That has happened
  // twice in this repo already (#24's `drop`, #29's `bugvault`), both times
  // by resolving this exact list in favour of one side. `portrait` is FF7's.
  'bugvault', 'projects', 'open', 'style', 'portrait',
  // The tool belt (BACKLOG #17). Left off this list, an equip frame would be
  // TYPED into the pty as literal JSON -- the hole described above.
  'loadout-equip', 'loadout-unequip',
  // BACKLOG #14: {type:'roster', action:'hide'|'unhide', agent}. Absent from
  // this list, a hide click would be typed into the session as JSON.
  'roster',
  // BACKLOG #10: open/close an agent's activity log. Listed here or the frame
  // is typed into the pty (see the comment above).
  'agent-log',
  // Extension X1: *Open anyway* on a window the session lock blocked. Typed
  // into the pty instead, it would reach a pty that doesn't exist yet.
  'lock-override',
  // Worktree tabs (PR 2). `stop`: closing a tab by hand ends its host; typed
  // into the pty it would land in a session that may be running
  // --dangerously-skip-permissions. `raise`: *Go to that session* asks the
  // host to bring its windows forward -- the same hole if it is left off.
  'stop', 'raise',
  // *Stop that session* on a blocked pane: this host ends the lock's holder
  // (host/stop-holder.js). Typed into the pty it would be the hole above.
  'lock-stop-holder',
  // ...and what it asks the holder: stop, but only with no window attached --
  // decided by the holder in one step (idleStopVerdict below).
  'stop-if-idle',
]);

// `null` means "treat this frame as literal input"; otherwise the parsed
// control message. A frame is control JSON only if it parses AND carries a
// KNOWN type -- see CONTROL_TYPES above.
function parseControlFrame(text) {
  if (!text.startsWith('{')) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || !CONTROL_TYPES.has(msg.type)) return null;
  return msg;
}

/**
 * The classify/dispatch/fall-through shape, extracted so it can be tested
 * without a live pty or websocket. `dispatch(msg)` is the caller's actual
 * handler (the resize/health/input/models/seat/fog if-chain in host.js);
 * `writeInput(text)` is `term.write`.
 *
 * Returns `{ handled, msg?, error? }`. `handled: false` means the frame was
 * literal input and `writeInput` was called with it. `handled: true` means
 * `dispatch` was called; `error` is set if it threw -- logging that is the
 * caller's job, since only the caller knows how to reach the client.
 *
 * The property this function exists to guarantee: a throwing `dispatch` NEVER
 * causes `writeInput` to be called. That is the entire content of Miguel's
 * original B1 finding, and it lives here now instead of only in host.js's
 * untested wiring.
 */
function handleFrame(text, dispatch, writeInput) {
  const msg = parseControlFrame(text);
  if (msg) {
    try {
      dispatch(msg);
    } catch (error) {
      return { handled: true, msg, error };
    }
    return { handled: true, msg };
  }
  writeInput(text);
  return { handled: false };
}

// An agent name is a file name or a hook payload's agent_type -- somebody
// else's string. It is only ever COMPARED with names the host already holds,
// never joined into a path, but it is still bounded and typed before use.
const MAX_AGENT_NAME = 200;

/**
 * `{ action, agent }` for a well-formed agent-log request, else `null`.
 * `open` needs an agent; `close` may omit it (it closes whatever is open).
 */
function validAgentLogRequest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const { action, agent } = msg;
  const named = typeof agent === 'string' && agent.length > 0 && agent.length <= MAX_AGENT_NAME;
  if (action === 'open') return named ? { action, agent } : null;
  if (action === 'close') {
    if (agent === undefined || agent === null) return { action, agent: null };
    return named ? { action, agent } : null;
  }
  return null;
}

/**
 * The clients a `raise` frame brings a window forward for: everyone attached
 * EXCEPT the sender. The sender is a one-shot client (host/host-client.js), not
 * a window -- counting it made `windows: 0` impossible, and 0 is the answer
 * "no window open" that *Go to that session* turns into words.
 */
function raiseTargets(clients, sender) {
  return [...(clients || [])].filter(c => c !== sender);
}

// A window that left this recently is reloading or reconnecting (the renderer
// retries within ~1 s): its session is in use, not abandoned.
const WINDOW_GONE_GRACE_MS = 5000;
// host/host-client.js connects, sends one frame and goes, in well under this.
const ONE_SHOT_MAX_MS = 2000;

/**
 * The holder's answer to `stop-if-idle` (*Stop that session*, Dexter PR #76
 * F2): counted and acted on in ONE step, so no window can attach between a
 * "how many windows?" and a "stop". `windows` excludes the asking client.
 *   { stop: true, windows: 0 }
 *   { stop: false, windows }                 a window is attached
 *   { stop: false, windows: 0, recent: true } one left within the grace
 * A count that isn't a non-negative integer never stops anything.
 */
function idleStopVerdict({ windows, lastWindowLeftAt, now, graceMs = WINDOW_GONE_GRACE_MS } = {}) {
  if (!(Number.isInteger(windows) && windows >= 0)) return { stop: false, windows: null };
  if (windows > 0) return { stop: false, windows };
  if (typeof lastWindowLeftAt === 'number' && now - lastWindowLeftAt < graceMs) {
    return { stop: false, windows: 0, recent: true };
  }
  return { stop: true, windows: 0 };
}

// Did a WINDOW just leave, or a one-shot control client? Only a window's going
// starts the grace above -- else every `raise` would hold off the next stop.
function leftAsWindow(openedAt, closedAt) {
  if (typeof openedAt !== 'number') return true;
  return closedAt - openedAt >= ONE_SHOT_MAX_MS;
}

module.exports = {
  raiseTargets, idleStopVerdict, leftAsWindow, WINDOW_GONE_GRACE_MS, ONE_SHOT_MAX_MS,
  validAgentLogRequest, MAX_AGENT_NAME,
  validResizeDims, parseControlFrame, handleFrame,
  MIN_TERMINAL_DIM, MAX_TERMINAL_DIM, CONTROL_TYPES,
};
