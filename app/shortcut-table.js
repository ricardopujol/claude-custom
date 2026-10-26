'use strict';
/**
 * The shortcuts page's ONE key table (BACKLOG #43).
 *
 * Three places handle keys: main's `shortcutFor` (app/tab-shell.js, `handler: 'main'`), the renderer's own handlers
 * (`handler: 'renderer'`), and the CLI (`handler: 'claude'`: not ours, listed so the page is complete and marked
 * "Claude Code"). test/shortcut-table.test.js keeps the table true: a `main` row names its `action` and a `sample`
 * input that `shortcutFor` must map to that action, every action `shortcutFor` can return must have a row, and a
 * `renderer` row's `where` must still be a string in app/renderer.js.
 *
 * Wrapped in an IIFE: the renderer loads this as a plain <script> in one shared global scope.
 */
(function (root) {

const GROUPS = ['Tabs', 'Panels', 'Claude Code', 'This page'];

const main = (group, name, keys, action, sample) => ({ group, name, keys, owner: 'app', handler: 'main', action, sample });
const own = (group, name, keys, where) => ({ group, name, keys, owner: 'app', handler: 'renderer', where });
const cli = (name, keys) => ({ group: 'Claude Code', name, keys, owner: 'claude', handler: 'claude' });

const ROWS = [
  main('Tabs', 'Next tab', ['Ctrl', 'Tab'], 'next-tab', { key: 'Tab', control: true }),
  main('Tabs', 'Previous tab', ['Ctrl', 'Shift', 'Tab'], 'prev-tab', { key: 'Tab', control: true, shift: true }),
  main('Tabs', 'Reopen the last closed tab', ['Ctrl', 'Shift', 'T'], 'reopen-tab', { key: 'T', control: true, shift: true }),
  main('Tabs', 'New branch tab', ['Ctrl', 'Alt', 'T'], 'new-branch', { key: 't', control: true, alt: true }),

  own('Panels', 'Show or hide every panel', ['Ctrl', 'B'], 'isPanelToggle(e)'),
  main('Panels', 'Focus mode: only the terminal', ['Ctrl', 'Shift', 'F'], 'focus-mode', { key: 'F', control: true, shift: true }),
  own('Panels', 'Diagnostics', ['Ctrl', 'Shift', 'D'], "e.code === 'KeyD'"),
  main('Panels', 'Note for the indexing assistant', ['Ctrl', 'Alt', 'N'], 'index-note', { key: 'n', control: true, alt: true }),
  main('Panels', 'Developer tools', ['F12'], 'devtools', { key: 'F12' }),
  main('Panels', 'Developer tools', ['Ctrl', 'Shift', 'I'], 'devtools', { key: 'I', control: true, shift: true }),

  own('Claude Code', 'Paste', ['Ctrl', 'V'], 'isPasteKey(e)'),
  own('Claude Code', 'Copy the selected text', ['Ctrl', 'C'], 'copyKeyAction('),
  own('Claude Code', 'New line without sending', ['Shift', 'Enter'], "e.key === 'Enter' && e.shiftKey"),
  cli('Interrupt Claude', ['Esc']),
  cli('Interrupt, when no text is selected', ['Ctrl', 'C']),
  cli('Cycle the permission mode', ['Shift', 'Tab']),
  cli('Show or hide the task list', ['Ctrl', 'T']),
  cli('Search the prompt history', ['Ctrl', 'R']),

  main('This page', 'Open the shortcuts page', ['F1'], 'shortcuts', { key: 'F1' }),
  own('This page', 'Close it', ['Esc'], "e.key === 'Escape' && shortcutsOpen"),
];

const keysText = (row) => row.keys.join('+');

// Case, spaces and "+" don't matter: "ctrl+b", "Ctrl B" and "ctrl + b" are the same search.
// A trailing s is dropped from longer words, so "panels" finds "panel" and "tabs" finds "tab".
const words = (s) => String(s == null ? '' : s).toLowerCase().split(/[\s+]+/).filter(Boolean)
  .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));

/** The rows where every word of `query` starts a word of the name or keys, in table order. A blank query keeps them all. */
function filterRows(query) {
  const want = words(query);
  if (want.length === 0) return ROWS.slice();
  return ROWS.filter((r) => {
    const have = words(`${r.name} ${keysText(r)}`);
    return want.every((w) => have.some((h) => h.startsWith(w)));
  });
}

/** `filterRows` grouped in page order; a group with no match is left out. */
function groupedRows(query) {
  const rows = filterRows(query);
  return GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GROUPS, ROWS, keysText, filterRows, groupedRows };
} else {
  root.shortcutTable = { GROUPS, ROWS, keysText, filterRows, groupedRows };
}

})(typeof window !== 'undefined' ? window : globalThis);
