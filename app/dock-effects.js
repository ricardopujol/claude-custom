'use strict';
/**
 * What a layout redraw may do besides drawing, and the page's focus rules (layout pass L1, PR #82; backlog #36).
 * These lived in app/dock-zones-display.js, which went with L1's four zones (dockable panels D4); the rules did
 * not change. Pure: app/renderer.js feeds in what showed before and after, and does what comes back.
 */

/*
 * WRAPPED IN AN IIFE: plain <script> files share one global scope
 * (test/renderer-scope.test.js). The page sees one name, `dockEffects`.
 */
(function (root) {

// Portraits in a wide (top/bottom) group: the card is a row, so the face is
// bounded by the group's height minus its tab bar and the card's name line.
const WIDE_FACE_CHROME = 60;

/**
 * What a redraw may do besides drawing, given what was showing before and
 * after: which modules just appeared (their panels load), whether the vault
 * was left (its secrets go out of sight), and where keyboard focus goes.
 *
 * Focus moves ONLY when the vault opens or closes. A redraw happens on a
 * resize, a grip drag, a layout pushed from another window or a hello; moving
 * focus to the terminal on those sent the rest of a half-typed secret into
 * the session (PR #82 Dexter F2, Miguel B1).
 */
function renderEffects(before, after, { userAction = false, quiet = false } = {}) {
  const newlyShown = [...after].filter(id => !before.has(id));
  const vaultLeft = before.has('vault') && !after.has('vault');
  const vaultOpened = after.has('vault') && !before.has('vault');
  let focus = null;
  if (vaultOpened) focus = 'vault';
  else if (vaultLeft) focus = 'term';
  // The user's own click or key: typing goes back to the session, as the old
  // setTab did -- but never while the vault is showing.
  else if (userAction && !after.has('vault')) focus = 'term';
  // `quiet`: the panels come back without anyone opening them (lean mode ending, #62): a vault that was open before is not
  // "opened" now, and the keyboard stays where it is (PR #140 Dexter F1).
  if (quiet) focus = null;
  return { newlyShown, vaultLeft, focus };
}

/**
 * What holds keyboard focus, as focusOnOpen reads it: { tag, type, isTerminal,
 * visible, connected }, or null for nothing. `el` is document.activeElement,
 * `termEl` xterm's root element.
 */
function describeFocus(el, termEl) {
  if (!el) return null;
  return {
    tag: el.tagName,
    type: el.type === undefined ? null : el.type,
    isTerminal: !!(termEl && termEl.contains(el)),
    visible: typeof el.getClientRects === 'function' && el.getClientRects().length > 0,
    connected: el.isConnected === true,
  };
}

/**
 * Whether the socket opening focuses the terminal. `first` is whether this is
 * the FIRST open of this page's socket (a flag the page keeps, never read from
 * what has focus: a stored layout showing the vault focuses its search before
 * the socket opens, and that must not cost a new tab the keyboard).
 *
 * ws.onopen fires on every reattach. On a RECONNECT focus stays on any visible
 * element outside the terminal: taking it sent the rest of a half-typed vault
 * secret into the session, and a Tab onto a button then Shift+Tab would send
 * keys there too (backlog #36, the same class as renderEffects above). The
 * terminal takes it only when nothing, the body, its own textarea, or an
 * element that is hidden or gone holds it.
 */
function focusOnOpen(first, held) {
  if (first) return true;
  if (!held || held.isTerminal) return true;
  if (held.tag === 'BODY' || held.tag === 'HTML') return true;
  return !held.visible || !held.connected;
}

/**
 * A tab's own layout changed while the socket was down (PR #82 Dexter F8).
 * `pending` is { layout } the host hasn't confirmed, or null; `incoming` is
 * the host's word (hello or broadcast). The host echoing the pending value
 * settles it; anything else is the host's OLD value and must not undo the
 * user's change -- the pending one is drawn and sent again.
 */
function overrideOnHello(pending, incoming) {
  const value = incoming === undefined ? null : incoming;
  if (!pending) return { apply: value, resend: false, settled: false };
  if (JSON.stringify(pending.layout) === JSON.stringify(value)) return { apply: value, resend: false, settled: true };
  return { apply: pending.layout, resend: true, settled: false };
}

/**
 * Whether a redraw may forget the collapsed groups the layout no longer has (PR #159 Dexter 1). That needs the layout this
 * window will DRAW: the stored global one is in (`layoutLoaded`) and the host has said whether the tab has its own
 * (`helloSeen`). Before the hello a tab with its own layout would be pruned against the global one, losing every collapse
 * of a group only its own layout has.
 */
function pruneReady(layoutLoaded, helloSeen) {
  return layoutLoaded === true && helloSeen === true;
}

const API = { renderEffects, describeFocus, focusOnOpen, overrideOnHello, pruneReady, WIDE_FACE_CHROME };

// One namespace on the page (`window.dockEffects`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockEffects = API;

})(typeof window !== 'undefined' ? window : globalThis);
