'use strict';
/**
 * BACKLOG #27 -- the tab header's copy of the CLI's status row: lines
 * +/-, duration, ctx>200k (no cost since the chrome grammar) (the header already shows project/branch, model,
 * effort and the context fill). Input: host/hook-session.js readStatusFields,
 * via the host's `statusFields` message.
 *
 * Warpaint's formats (warpaint\src\statusline.js), so moving the row changes
 * where it is, not what it says. A null or non-positive value draws nothing:
 * cost 0 and duration under a minute are noise there too, and `typeof` checks
 * keep an unreported value from becoming a confident "$0" (Number(null) is 0).
 *
 * WRAPPED IN AN IIFE, and that is not style: renderer.html loads these as plain
 * <script> tags sharing ONE global scope (test/renderer-scope.test.js).
 */
(function (root) {

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function lines(added, removed) {
  const parts = [positive(added) ? '+' + added : null, positive(removed) ? '-' + removed : null];
  const shown = parts.filter(Boolean);
  return shown.length ? shown.join('/') : null;
}

function duration(ms) {
  if (!positive(ms)) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return null;
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h' + String(mins % 60).padStart(2, '0');
}

/**
 * The header's chips, in order; [] when there's nothing to say. No cost: on Max there is no extra spend, so a dollar figure was noise
 * (Ricardo, 2026-10-26, chrome grammar). `icon` names a Lucide icon the page draws (app/chip-icons.js).
 */
function statusFieldsChips(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return [
    { key: 'lines', icon: 'diff', text: lines(fields.linesAdded, fields.linesRemoved) },
    { key: 'time', icon: 'clock', text: duration(fields.durationMs) },
    { key: 'ctx', icon: 'gauge', text: fields.over200k === true ? 'ctx>200k' : null },
  ].filter(c => c.text);
}

/** The text of each chip, for a plain reader. */
function statusFieldsText(fields) {
  return statusFieldsChips(fields).map(c => c.text);
}

/**
 * What the header's #status-fields shows. Shown only while "status line in
 * the header" is exactly true (unknown or off: the CLI's own row is, or may
 * be, saying it already) AND there's something to say.
 */
function statusFieldsView(fields, statusInHeader) {
  const chips = statusFieldsChips(fields);
  return { chips, shown: statusInHeader === true && chips.length > 0 };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { statusFieldsText, statusFieldsChips, statusFieldsView };
} else {
  root.statusFieldsText = statusFieldsText;
  root.statusFieldsChips = statusFieldsChips;
  root.statusFieldsView = statusFieldsView;
}

})(typeof window !== 'undefined' ? window : globalThis);
