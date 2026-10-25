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

/*
 * WRAPPED IN AN IIFE for the reason app/usage-display.js is: the renderer loads
 * these as plain <script> tags sharing one global scope, and `TABS`,
 * `DEFAULT_TAB`, `known` and `nextTab` were all leaking into it. Enforced by
 * test/renderer-scope.test.js.
 */
(function (root) {

const TABS = [
  { id: 'agents', label: 'Agents', title: 'Who is working, and on what' },
  { id: 'vault', label: 'Vault', title: 'Local encrypted secrets' },
  // 'bugvault', not 'vault' or 'bugs': 'vault' is already the secret-clipboard
  // tab above, and 'bugs' would collide with nothing today but reads as too
  // generic once a project also tracks, say, GitHub issues.
  { id: 'bugvault', label: 'Bug vault', title: 'Recurring defect classes, grouped by category and by how they were found' },
  // The Files tab (#45) took the Map's slot. The id stays `fog`: saved layouts and the dock tests name it, and a
  // renamed id would drop it from every stored layout.
  { id: 'fog', label: 'Files', title: 'Browse this worktree and read its files; what Claude touched is marked' },
  // Layout pass L3 (documentation/PLAN_GIT_TREE.md): every branch on one dial.
  { id: 'git', label: 'Git', title: 'Every branch this project has grown' },
  { id: 'models', label: 'Models', title: 'Browse every model OpenRouter offers, and seat the council' },
  { id: 'projects', label: 'Projects', title: 'Switch to another project, each in its own window' },
  { id: 'style', label: 'Style', title: 'How the harness looks' },
  // BACKLOG #51: favourite skills as emoji buttons. An ordinary module like the rest: it docks, moves and
  // hides through the same layout (app/dock-tree.js), which this entry does not touch.
  { id: 'wand', label: 'Wand', title: 'Favourite skills: one click types the command, you press Enter' },
  // BACKLOG #63: CPU and memory per session, per project and in total. An ordinary module like the rest: it docks, moves
  // and hides through the same layout, and it samples only while it is showing (app/resources-service.js).
  { id: 'resources', label: 'Resources', title: 'CPU and memory: which session is using the machine' },
  // BACKLOG #119 A7: what will run, when, from which session: wakeups, loops, bedtime nights and cron jobs of every session in one list. An
  // ordinary module like the rest: it docks, moves and hides through the same layout. Read-only; a click selects the session's tab.
  { id: 'schedules', label: 'Schedules', title: 'What will run, when, and from which session: wakeups, loops, bedtime nights and cron jobs' },
  // BACKLOG #71: a panel the running Claude builds itself, a sandboxed page per tab. An ordinary module like the rest, with
  // one difference: it starts hidden (app/dock-tree.js HIDDEN_UNTIL_USED) and docks itself on the right the first time
  // Claude renders into it, which only happens when it is asked to.
  { id: 'canvas', label: "Claude's panel", title: 'A panel Claude builds for this session: a clock, a list of artifacts, a button that asks something' },
  // BACKLOG #119 A4: the page of a dev server this worktree runs, in a sandboxed view that only reaches this computer. An ordinary module
  // like the rest; it docks at its own width (app/dock-tree.js OWN_ROW_SIZE).
  { id: 'preview', label: 'Preview', title: 'The page of a dev server running in this worktree: only localhost opens here' },
  // BACKLOG #33: ask about this repo, or have the code you selected explained, by a local model (or Haiku / Sonnet on your plan).
  // An ordinary module like the rest: it docks, moves and hides through the same layout.
  { id: 'ask', label: 'Ask', title: 'Ask where something is in this repo, or have selected code explained: a local model answers, and every place is a link' },
  // BACKLOG #41: three wait games (app/games-display.js). An ordinary module like the rest. It pauses itself and hands the keyboard
  // back to the terminal whenever Claude needs Ricardo or finishes, and it draws only while it is on screen.
  { id: 'games', label: 'Games', title: 'Stack the PRs, Merge 2048 and Pipeline: something to do while Claude works. It stops when Claude needs you' },
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
 * to the pty as \x02 -- readline's backward-char. The keybinding appeared to
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

// isPanelToggle IS EXPORTED, and that is load-bearing rather than tidy.
// app/renderer.js calls it as a bare global inside
// term.attachCustomKeyEventHandler. Before the IIFE above, every top-level
// function here was implicitly global, so the call worked without anyone
// listing it. Wrapping the file removes that, and omitting it here would
// re-break Ctrl+B in the real window exactly as PR #27 found it -- with the
// full suite green, because renderer-scope.test.js checks what LEAKS out, not
// what fails to get out. Found resolving the #26/#27 merge conflict.
const API = { nextTab, isPanelToggle, TABS, DEFAULT_TAB, isKnownTab: known };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else Object.assign(root, API);

})(typeof window !== 'undefined' ? window : globalThis);
