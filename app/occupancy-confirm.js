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
 *     it is open (up to HOLD_MAX characters; the rest is dropped, never queued without limit). *Type*
 *     releases all of it, once, in order, and approves the agents that are there: not asked again for that
 *     run. *Wait* drops it and remembers nothing, so the next keystroke asks again. Escape while the question
 *     is open is Wait.
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

const HOLD_MAX = 256;
const ESC = '\x1b';

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
  let held = null;                 // the held text, or null when no question is open

  const asking = () => held !== null;
  const tell = () => { try { onChange({ asking: asking() }); } catch { /* a listener must not wedge the confirm */ } };
  const release = (text) => { try { send(text); } catch { /* the socket is the caller's to report */ } };
  const unconfirmed = () => [...present].some(id => !confirmed.has(id));

  function setClaims(claims) {
    present = idsOf(claims);
    for (const id of [...confirmed]) if (!present.has(id)) confirmed.delete(id);   // that run ended
    if (asking() && present.size === 0) {
      const text = held;
      held = null;
      release(text);
      tell();
    }
  }

  function input(data) {
    if (!isKeystroke(data) || present.size === 0 || (!asking() && !unconfirmed())) {
      release(data);
      return 'sent';
    }
    if (asking() && data === ESC) { wait(); return 'dropped'; }
    const wasAsking = asking();
    if (!wasAsking) held = '';
    if (held.length + data.length > HOLD_MAX) { if (!wasAsking) tell(); return 'dropped'; }
    held += data;
    if (!wasAsking) tell();
    return 'held';
  }

  function type() {
    if (!asking()) return false;
    const text = held;
    held = null;
    for (const id of present) confirmed.add(id);
    release(text);
    tell();
    return true;
  }

  function wait() {
    if (!asking()) return false;
    held = null;
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
