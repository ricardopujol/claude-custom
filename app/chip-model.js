'use strict';
/**
 * Chrome grammar A (Ricardo's pick, 2026-10-26): every header item is one chip shape, icon, value, and a 28 px micro-bar when there is
 * a fill. The decisions behind that, pure, so nothing in a browser script has to be trusted untested:
 *   microBar(fraction)   how many of the bar's 28 px are filled, or UNKNOWN (never an empty bar: no value is not zero)
 *   warningsChip(items)  the header's warnings as ONE chip with a count; the detail goes in the hover text, never in the chrome
 *
 * WRAPPED IN AN IIFE: renderer.html loads these as plain <script> tags sharing ONE global scope (test/renderer-scope.test.js).
 */
(function (root) {

const BAR_PX = 28;

/** `{ known, px }`. A strict typeof, because Number(null) is 0 and an absent value must not draw a confident empty bar. */
function microBar(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return { known: false, px: 0 };
  return { known: true, px: Math.round(Math.min(1, Math.max(0, fraction)) * BAR_PX) };
}

/** Items are `{ text, title? }`; anything without a non-empty string text is no warning. */
function warningsChip(items) {
  const real = (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object' && typeof i.text === 'string' && i.text !== '');
  if (!real.length) return { shown: false, count: 0, label: '', title: '' };
  return {
    shown: true,
    count: real.length,
    label: String(real.length),
    title: real.map(i => (typeof i.title === 'string' && i.title !== '' ? i.title : i.text)).join('\n'),
  };
}

/**
 * The HP chip: what it says, how full its bar is, and whether it shimmers or is dimmed. `last` is the last KNOWN value
 * ({ label, fraction } or null), which the caller keeps. While the suite runs the chip keeps that value and bar, dimmed (stale),
 * and shimmers; an unknown result that is not running is a dash with no bar and no movement. `known` is what to remember next
 * (null when this call has no new known value).
 */
function healthChip(h, last) {
  const running = !!(h && h.running);
  const state = h && h.state;
  const finished = !running && state !== 'unknown' && h && typeof h.passed === 'number' && typeof h.total === 'number';
  if (finished) {
    const label = `${h.passed}/${h.total}`;
    return { label, bar: microBar(h.fraction), running: false, stale: false, known: { label, fraction: h.fraction } };
  }
  if (running && last) return { label: last.label, bar: microBar(last.fraction), running: true, stale: true, known: null };
  return { label: '—', bar: microBar(null), running, stale: false, known: null };
}

const API = { BAR_PX, microBar, warningsChip, healthChip };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.chipModel = API;

})(typeof window !== 'undefined' ? window : globalThis);
