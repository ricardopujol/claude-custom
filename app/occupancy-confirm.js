'use strict';
/**
 * The first-keystroke confirm in a worktree an agent is writing in (backlog #47, DESIGN_WORKTREE_OCCUPANCY.md,
 * decision 3: "inform + one confirm"). Nothing is made read-only -- that would fight the founding bet of
 * wrapping the real CLI -- but a person about to become a second writer is asked once.
 *
 *   createConfirm({ send, onChange }) -> { setClaims, input, type, wait, state }
 *
 *   setClaims(here)   the live claims in THIS tab's folder (the page's `occupancy.here`)
 *   input(data)       the person's typing: 'sent' | 'held' | 'dropped'
 *   type() / wait()   the two answers to "An agent is writing here. Type anyway?"; true when there was a
 *                     question to answer
 *   state()           { asking }
 *
 * THE RULES (each has a test)
 *   - Never asked with no live claim: with none, every key goes straight through.
 *   - The first keystroke of an unconfirmed run opens the question and is HELD, with whatever follows while
 *     it is open. *Type* releases every held piece, once, in order, EACH THROUGH send (a paste arrives as
 *     its own control frame, so pieces are never glued together), and approves the agents that are there:
 *     not asked again for that run. *Wait* drops it and remembers nothing, so the next keystroke asks again.
 *   - THE HOLD IS BOUNDED, AND NEVER SPLICED. A piece is one keystroke or one whole paste frame. The first
 *     piece is always held, however long (the question never opens over nothing, and a paste is not lost).
 *     After that the held pieces may total HOLD_MAX characters; the first piece that doesn't fit is dropped
 *     AND SO IS EVERYTHING AFTER IT until the question is answered -- holding a later key would let *Type*
 *     send "fix " + Enter with the middle cut out (PR #96, Dexter F4 / Miguel Y1).
 *   - FROM THE KEYBOARD: Escape while the question is open is Wait; Enter while it is open is Type, and that
 *     Enter is not sent (the person presses it again to submit: nothing reaches the CLI unseen). Ctrl+C with
 *     nothing held goes straight through and asks nothing: stopping your own session writes nothing, and it
 *     is the first key a person reaches for when two writers meet (Miguel Y2). It approves nothing.
 *   - A RUN is one agent_id's stay. A second agent arriving is a new run (asked again); an agent whose claim
 *     went away and came back (the same id resumed) is a new run too.
 *   - The agent finishing while the question is open closes it and releases what was held: nothing is in
 *     the way any more.
 *   - The terminal's own replies are not typing: focus reports, mouse reports, cursor-position and device
 *     reports and OSC/DCS answers always pass, even while the question is open (holding them would stall the
 *     CLI's UI), and never open it.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js): the page loads this as a plain <script>.
 * One name leaves it: `occupancyConfirm`.
 */
(function (root) {

const HOLD_MAX = 64 * 1024;
const ESC = '\x1b';
const ENTER = '\r';
const CTRL_C = '\x03';

// What xterm answers ON ITS OWN (never typed): focus in/out, SGR and X10 mouse reports, cursor-position,
// device-attributes and status reports, and OSC / DCS replies. Arrow keys and friends end in A-D, H, F, ~, P-S
// and are NOT here.
const PROTOCOL = [
  /^\x1b\[[IO]$/,
  /^\x1b\[<\d+;\d+;\d+[Mm]$/,
  /^\x1b\[M[\s\S]{3}$/,
  /^\x1b\[[?>]?[\d;]*[Rcn]$/,
  /^\x1b[\]P][\s\S]/,      // an OSC / DCS answer has a body; Alt+] and Alt+Shift+P are two characters
];

function isKeystroke(data) {
  if (typeof data !== 'string' || data === '') return false;
  return !PROTOCOL.some(re => re.test(data));
}

const idsOf = (claims) => new Set((Array.isArray(claims) ? claims : [])
  .filter(c => c && typeof c === 'object' && typeof c.agentId === 'string' && c.agentId !== '')
  .map(c => c.agentId));

function createConfirm({ send, onChange = () => {} } = {}) {
  let present = new Set();         // the agent ids in this folder right now
  const confirmed = new Set();     // the ones the person said Type to
  let held = null;                 // the held pieces (in order), or null when no question is open
  let heldLength = 0;
  let overflowed = false;          // a piece was dropped since the question opened: so is everything after it

  const asking = () => held !== null;
  const close = () => { const pieces = held; held = null; heldLength = 0; overflowed = false; return pieces; };
  const tell = () => { try { onChange({ asking: asking() }); } catch { /* a listener must not wedge the confirm */ } };
  const release = (data) => { try { send(data); } catch { /* the socket is the caller's to report */ } };
  const releaseAll = (pieces) => { for (const piece of pieces) release(piece); };
  const unconfirmed = () => [...present].some(id => !confirmed.has(id));

  function setClaims(claims) {
    present = idsOf(claims);
    for (const id of [...confirmed]) if (!present.has(id)) confirmed.delete(id);   // that run ended
    if (asking() && present.size === 0) {
      releaseAll(close());
      tell();
    }
  }

  function input(data) {
    if (!isKeystroke(data) || present.size === 0 || (!asking() && !unconfirmed())) {
      release(data);
      return 'sent';
    }
    if (!asking()) {
      if (data === CTRL_C) { release(data); return 'sent'; }
      held = [data];                       // the first piece: always held, whatever its length
      heldLength = data.length;
      tell();
      return 'held';
    }
    if (data === ESC) { wait(); return 'dropped'; }
    if (data === ENTER) { type(); return 'dropped'; }
    if (overflowed || heldLength + data.length > HOLD_MAX) { overflowed = true; return 'dropped'; }
    held.push(data);
    heldLength += data.length;
    return 'held';
  }

  function type() {
    if (!asking()) return false;
    const pieces = close();
    for (const id of present) confirmed.add(id);
    releaseAll(pieces);
    tell();
    return true;
  }

  function wait() {
    if (!asking()) return false;
    close();
    tell();
    return true;
  }

  return { setClaims, input, type, wait, state: () => ({ asking: asking() }) };
}

const api = { createConfirm, isKeystroke, HOLD_MAX };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.occupancyConfirm = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
