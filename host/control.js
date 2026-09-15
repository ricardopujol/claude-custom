'use strict';
/**
 * The two pieces of the client->host control protocol worth testing in
 * isolation from the websocket/pty wiring: is a text frame a control message
 * at all, and is a requested resize safe to apply.
 *
 * Miguel, code review 2026-09-14 on `host/host.js`: a single try wrapped both
 * `JSON.parse` and every handler's side effects, so a handler that THREW (an
 * unvalidated resize, reliably) was caught by the same catch that means "not
 * control JSON" -- and the raw control-message text was then typed into the
 * pty as literal keystrokes. Reachable by any malformed control frame, into a
 * session that may be running with permissions bypassed.
 *
 * The fix is these two pure checks, applied in order: classify the frame
 * BEFORE doing anything with it, then validate the specific fields a handler
 * needs before it touches anything with a side effect. Neither step can throw.
 */

// node-pty throws on cols/rows <= 0, NaN, or non-finite; @xterm/headless
// instead silently clamps to a minimum of 2. Unvalidated, the two resize
// targets disagree on a bad frame and the replay buffer desyncs permanently
// (xterm clamps to 2 cols, node-pty throws and never resizes, and a serialized
// 2-column screen is then handed to every future attach). Applying both
// targets only when both would agree is what keeps them atomic.
const MAX_TERMINAL_DIM = 10000;
function validResizeDims(cols, rows) {
  const dim = v => Number.isInteger(v) && v >= 1 && v <= MAX_TERMINAL_DIM;
  return dim(cols) && dim(rows);
}

// `null` means "treat this frame as literal input"; otherwise the parsed
// control message. A frame is control JSON only if it parses AND carries a
// string `type` -- a bare `{"foo":"bar"}` is valid JSON a user could
// genuinely type or paste, not a control message, and must fall through to
// the terminal rather than being silently swallowed.
function classifyFrame(text) {
  if (!text.startsWith('{')) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  return msg;
}

module.exports = { validResizeDims, classifyFrame };
