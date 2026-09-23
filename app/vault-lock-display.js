'use strict';
/**
 * What the vault lock panel should show, given the state main reports.
 *
 * Here rather than in `renderer.js` for the reason this project keeps
 * relearning: a decision inline in the renderer is a decision nothing can
 * test, and this one has four states, a destructive action and a confirmation
 * step. `spendOf`, `projectLabel` and `rosterWidth` all moved out for the same
 * reason, the last one only after a reviewer caught the clamp being untestable
 * where it sat.
 *
 * FOUR STATES, not three. The fourth is the one worth naming:
 *
 *   open-no-key   the default. Offers "set a key".
 *   open-with-key unlocked and protected. Offers lock, replace, destroy.
 *   locked        needs the key. Offers unlock and, deliberately, melt.
 *   confirm-melt  melt asked for and not yet confirmed.
 *
 * `confirm-melt` exists because melt is irreversible and unrecoverable, and a
 * single click on a button next to a password field is not consent. This is the
 * one place in the harness where a wrong click destroys data with no way back,
 * so the confirmation states the cost in words rather than asking "are you
 * sure?".
 *
 * WRAPPED IN AN IIFE, deliberately, from the first line: the renderer loads
 * every script as a plain `<script src>` tag sharing ONE global scope, and this
 * project has shipped silently-dead renderer modules three times because of it.
 */

(function (root) {

// Only shown when the vault holds nothing to lose. Melting an empty vault is
// not a decision worth a confirmation, and offering one teaches the user to
// click through the confirmation that matters.
function vaultLockDisplay(state, { confirmingMelt = false, entryCount = null } = {}) {
  const s = state && typeof state === 'object' ? state : {};

  // Absence is LOCKED, never open. A lock panel that guesses "probably fine"
  // while the answer is still in flight is the one direction this must not
  // fail: it would offer to reveal a vault it knows nothing about.
  //
  // THE OLD VERSION DID NOT IMPLEMENT THAT, and its test did not notice.
  // Miguel, PR #42, B1. It read:
  //
  //     const locked = s.locked === true || s.hasKey === undefined;
  //
  // which says "absence of `hasKey` is locked" -- so anything malformed in
  // `locked` drew the vault OPEN. Measured: `{hasKey:true}`,
  // `{hasKey:true, locked:null}` and `{hasKey:true, locked:'yes'}` all rendered
  // `open-with-key` with the label list showing. The third is the one that
  // stings: `'yes'` is truthy and any reader would take it for "closed".
  //
  // And the test named `AN UNKNOWN STATE IS LOCKED, never open` enumerated six
  // shapes that ALL omitted `hasKey` -- so it pinned the implementation's
  // spelling rather than the rule in its own title, and stayed green with the
  // hole wide open. Same defect this project keeps finding: a test asserting how
  // a thing is written instead of what it must do.
  //
  // So now only a COMPLETE, BOOLEAN state opens the panel. Everything else is
  // locked, including shapes nobody has thought of yet.
  const known = s.hasKey === true || s.hasKey === false;
  const hasKey = s.hasKey === true;
  const locked = !known || s.locked !== false;

  if (locked) {
    return {
      state: confirmingMelt ? 'confirm-melt' : 'locked',
      note: 'the vault is locked',
      // The count is shown only when known, and only to make the cost of melt
      // concrete. "lose 6 secrets" is a decision; "lose all secrets" is a
      // slogan.
      meltWarning: 'Melting replaces the vault with an empty one. '
        + (Number.isFinite(entryCount) && entryCount > 0
          ? `All ${entryCount} secrets in it are destroyed permanently. `
          : 'Everything in it is destroyed permanently. ')
        + 'There is no backup and no recovery. Do this only if the key is lost.',
      canUnlock: true,
      canMelt: true,
      showList: false,
    };
  }

  if (!hasKey) {
    return {
      state: 'open-no-key',
      note: 'no key set — anyone at this machine can read the vault',
      canSetKey: true,
      showList: true,
    };
  }

  return {
    state: 'open-with-key',
    note: 'unlocked — it will lock again when the harness restarts',
    canLock: true,
    canSetKey: true,        // replacing a key is setting one, while open
    canRemoveKey: true,
    showList: true,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { vaultLockDisplay };
} else {
  root.vaultLockDisplay = vaultLockDisplay;
}

})(typeof window !== 'undefined' ? window : globalThis);
