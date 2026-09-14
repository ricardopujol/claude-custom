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
];

// Agents, because it is the panel that changes on its own: the roster reacts to
// the session, the vault only reacts to you. Opening on the reactive one makes
// the sidebar useful without being touched.
const DEFAULT_TAB = 'agents';

const known = id => TABS.some(t => t.id === id);

function nextTab(current, clicked) {
  if (!known(clicked)) return current;        // a typo must not blank the sidebar
  return current === clicked ? null : clicked; // clicking the active tab hides it
}

if (typeof module !== 'undefined' && module.exports) module.exports = { nextTab, TABS, DEFAULT_TAB };
else if (typeof window !== 'undefined') Object.assign(window, { nextTab, TABS, DEFAULT_TAB });
