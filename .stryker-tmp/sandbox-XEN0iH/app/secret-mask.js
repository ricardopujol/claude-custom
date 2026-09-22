// @ts-nocheck
'use strict';
/**
 * Whether the secret input is showing its text.
 *
 * Small, but the rules are worth stating in one place: a masked field cannot be
 * checked against what you pasted, and an unmasked one that STAYS unmasked is a
 * secret sitting on screen for as long as the window is open.
 *
 * So revealing is deliberate and temporary. It survives nothing: not storing
 * the entry, not leaving the panel.
 */

function createMask() {
  let shown = false;

  return {
    visible: () => shown,
    toggle: () => { shown = !shown; return shown; },

    // Both of these SET rather than toggle, so calling them twice cannot flip
    // the field back to visible.
    stored: () => { shown = false; },   // the next secret is not this one
    left: () => { shown = false; },     // nobody reopening the tab asked to see it

    inputType: () => (shown ? 'text' : 'password'),
    // Labelled with the ACTION, not the state: a button that says "Hidden"
    // reads backwards to half the people who look at it.
    label: () => (shown ? 'Hide' : 'Show'),
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMask };
else if (typeof window !== 'undefined') window.createMask = createMask;
