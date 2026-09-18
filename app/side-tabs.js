'use strict';
/**
 * Which side panel is showing.
 *
 * A named, clickable tab strip rather than a keyboard shortcut: the sidebar is
 * a place you can see and point at. Clicking the active tab collapses the whole
 * sidebar, so "hide it" needs no second control in a panel this narrow.
 *
 * The vault tab is the seed of something larger -- a personal chest, once the
 * harness has a visual identity of its own. Keeping the tab list as data is
 * what makes renaming or re-skinning it a one-line change later.
 */

const TABS = [
  { id: 'agents', label: 'Agents', title: 'Who is working, and on what' },
  { id: 'vault', label: 'Vault', title: 'Local encrypted secrets' },
  { id: 'fog', label: 'Map', title: 'What this project has actually been read' },
  { id: 'models', label: 'Models', title: 'Browse every model OpenRouter offers, and seat the council' },
];

// Agents, because it is the panel that changes on its own: the roster reacts to
// the session, the vault only reacts to you. Opening on the reactive one makes
// the sidebar useful without being touched.
const DEFAULT_TAB = 'agents';

const known = id => TABS.some(t => t.id === id);


/**
 * Is this key event the panel toggle?
 *
 * Pure, and it lives here rather than inline in renderer.js because of how it
 * failed: the toggle was a `document` keydown listener, and xterm's textarea
 * always has focus, so the event was consumed by the terminal and Ctrl+B went
 * to the pty as  -- readline's backward-char. The keybinding appeared to
 * "not work" while silently editing the user's command line.
 *
 * That alone would be a nuisance. Combined with a collapsed sidebar -- which
 * hides its own tab bar, because the bar lives inside #roster -- it was a DEAD
 * END: nothing to click, and the only documented way back typed into the shell.
 * The state persists, so it survived restarts and looked exactly like "the tabs
 * are gone."
 *
 * The fix is for the caller to ask this INSIDE xterm's own
 * attachCustomKeyEventHandler and return false, which is the only place that
 * can stop the terminal consuming the key.
 */
function isPanelToggle(e) {
  return !!e && e.type === 'keydown' && !!e.ctrlKey && !e.shiftKey && !e.altKey
    && !e.metaKey && e.code === 'KeyB';
}

function nextTab(current, clicked) {
  if (!known(clicked)) return current;        // a typo must not blank the sidebar
  return current === clicked ? null : clicked; // clicking the active tab hides it
}

if (typeof module !== 'undefined' && module.exports) module.exports = { nextTab, isPanelToggle, TABS, DEFAULT_TAB, isKnownTab: known };
else if (typeof window !== 'undefined') Object.assign(window, { nextTab, TABS, DEFAULT_TAB, isKnownTab: known });
