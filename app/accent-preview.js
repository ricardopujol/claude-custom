'use strict';
/**
 * The Style tab's live accent preview (backlog #64, Miguel F3 + F4).
 *
 *   previewChrome(hex, chrome) -> { accent, onAccent }
 *       What a SAVED look would paint for this accent: the picked colour moved
 *       just far enough to read on the bg and panel (host/look.js derivePalette),
 *       and its label colour. So the colour does not jump when the pick is
 *       committed. host/look.js is node-only (it requires the background
 *       module), so the few lines of colour maths are mirrored here;
 *       test/accent-preview.test.js pins them against the real derivePalette.
 *   frameThrottle(schedule, fn) -> call(arg)
 *       At most one `fn` per animation frame, with the LAST argument given: a
 *       colour picker fires `input` dozens of times a second, and each repaint
 *       also costs an IPC to main and a send to the strip.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it:
 * `accentPreview`.
 */
(function (root) {

const MIN_CONTRAST = 4.5;
const ON_ACCENT = '#12141c';     // host/look.js ON_ACCENT
const HEX_RE = /^#([0-9a-f]{6})$/i;

function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = HEX_RE.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function formatHex({ r, g, b }) {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function mix(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const ch = (k) => Math.round(ca[k] + (cb[k] - ca[k]) * t);
  return formatHex({ r: ch('r'), g: ch('g'), b: ch('b') });
}

function luminance(hex) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function ensureContrastAll(color, againsts) {
  const worst = (c) => Math.min(...againsts.map((a) => contrastRatio(c, a)));
  if (worst(color) >= MIN_CONTRAST) return color;
  const primary = againsts[0];
  const extreme = contrastRatio('#ffffff', primary) >= contrastRatio('#000000', primary) ? '#ffffff' : '#000000';
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(color, extreme, step / 20);
    if (worst(candidate) >= MIN_CONTRAST) return candidate;
  }
  return extreme;
}

/** `null` when `hex` is not a #rrggbb: there is nothing to preview. */
function previewChrome(hex, chrome) {
  if (!parseHex(hex)) return null;
  const c = chrome || {};
  const surfaces = [c.bg, c.panel].filter((s) => parseHex(s));
  const accent = surfaces.length ? ensureContrastAll(hex.toLowerCase(), surfaces) : hex.toLowerCase();
  return { accent, onAccent: ensureContrastAll(ON_ACCENT, [accent]) };
}

/**
 * `schedule(cb)` is requestAnimationFrame in the page. The first call in a frame
 * schedules; later calls in the same frame only replace the pending argument.
 */
function frameThrottle(schedule, fn) {
  let pending = false;
  let latest;
  return function call(arg) {
    latest = arg;
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      fn(latest);
    });
  };
}

const api = { previewChrome, frameThrottle };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.accentPreview = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
