'use strict';
/**
 * BACKLOG #27 -- the tab header's copy of the CLI's status row: cost, lines
 * +/-, duration, ctx>200k (the header already shows project/branch, model,
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

function cost(usd) {
  if (!positive(usd)) return null;
  return usd < 0.01 ? '<$0.01' : '$' + usd.toFixed(2);
}

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

/** The header's segments, in warpaint's order; [] when there's nothing to say. */
function statusFieldsText(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return [
    cost(fields.costUsd),
    lines(fields.linesAdded, fields.linesRemoved),
    duration(fields.durationMs),
    fields.over200k === true ? 'ctx>200k' : null,
  ].filter(Boolean);
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { statusFieldsText };
} else {
  root.statusFieldsText = statusFieldsText;
}

})(typeof window !== 'undefined' ? window : globalThis);
