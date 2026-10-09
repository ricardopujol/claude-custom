'use strict';
/**
 * What the shortcuts sheet draws (BACKLOG #43): the markup of the grouped rows for a search query, from the one key
 * table (app/shortcut-table.js). Pure; app/renderer.js owns opening, closing, focus and the search box.
 *
 * Wrapped in an IIFE: the renderer loads this as a plain <script> in one shared global scope.
 */
(function (root) {

const table = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./shortcut-table') : root.shortcutTable;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const keysHtml = (row) => row.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('+');

const rowHtml = (row) =>
  '<div class="sc-row">' +
    `<span class="sc-name">${esc(row.name)}</span>` +
    (row.owner === 'claude' ? '<span class="sc-cli" title="This key belongs to the claude CLI, not to claude-custom">Claude Code</span>' : '') +
    `<span class="sc-keys">${keysHtml(row)}</span>` +
  '</div>';

/** The sheet's body for `query`: every group with a matching row, or a line saying nothing matched. */
function sheetBodyHtml(query) {
  const q = typeof query === 'string' ? query : '';
  const groups = table.groupedRows(q);
  if (groups.length === 0) return `<p class="sc-none">No shortcut matches &ldquo;${esc(q.trim())}&rdquo;.</p>`;
  return groups.map((g) => `<section class="sc-group"><h3>${esc(g.group)}</h3>${g.rows.map(rowHtml).join('')}</section>`).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sheetBodyHtml };
} else {
  root.shortcutsDisplay = { sheetBodyHtml };
}

})(typeof window !== 'undefined' ? window : globalThis);
