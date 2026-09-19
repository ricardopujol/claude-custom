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
const CONTROL_TYPES = new Set(['resize', 'health', 'input', 'models', 'seat', 'fog', 'drop']);

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

module.exports = {
  validResizeDims, parseControlFrame, handleFrame,
  MIN_TERMINAL_DIM, MAX_TERMINAL_DIM, CONTROL_TYPES,
};
