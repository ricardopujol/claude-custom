'use strict';
/**
 * A project's LOOK: the colours and background a person picked for one folder,
 * so each project's window is recognisable at a glance.
 *
 * PURE. No fs, no clock, no DOM -- host/style.js reads and writes the file,
 * the renderer paints. This module only decides what a stored look MEANS:
 *
 *   sanitizeLook   anything read off disk -> a look this code can trust
 *   derivePalette  a look + the registry theme's chrome -> the CSS colours
 *   terminalOverride  a look + the registry terminal theme -> xterm's theme
 *
 * The registry theme (host/themes.js) stays the BASE. A look only overrides
 * what the person actually set; an unset field keeps the base's value, so a
 * look.json with just an app colour does not also reset the text.
 *
 * Every read defaults. A hand-edited or half-written look.json must degrade to
 * "the registry theme", never throw on the attach path and never turn an
 * absent number into a confident 0 (`Number(null)` -- see CLAUDE.md).
 */

// Formats a background copy may be stored as. Shared with host/style.js, which
// refuses anything else at upload time -- the same list, so a file that got in
// through the front door is never refused on the way back out.
const ACCEPTED_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

// A darkness of 1 would paint the veil fully opaque and the image would be
// gone -- that is "remove the image", which has its own button.
const MAX_DARKNESS = 0.95;

const DEFAULT_LOOK = Object.freeze({
  version: 1,
  appColor: null,
  textColor: null,
  darkness: 0.5,
  background: null,
});

// Panel and border are the app colour pushed a little toward contrast, so a
// person picks ONE colour and the chrome still has visible edges. Tuned by eye
// against the cold-blue theme's own bg/panel/border spacing.
const PANEL_MIX = 0.05;
const BORDER_MIX = 0.14;
// Secondary text: the text colour pulled most of the way toward the background.
const DIM_MIX = 0.45;

const HEX_RE = /^#([0-9a-f]{6})$/i;
const BACKGROUND_FILE_RE = new RegExp(`^background\\.(${ACCEPTED_EXTENSIONS.join('|')})$`, 'i');

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

function normalHex(hex) {
  return parseHex(hex) ? hex.toLowerCase() : null;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Strict: a real, finite number or nothing. A string '0.9' is refused rather
// than coerced -- the writer only ever stores numbers, so a string means the
// file was edited by hand or corrupted, and the default is the honest answer.
function sanitizeDarkness(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_LOOK.darkness;
  return Math.min(MAX_DARKNESS, Math.max(0, v));
}

// The file must be exactly `background.<accepted ext>` -- a bare name that
// cannot climb out of the project's .claude-custom/ folder, whatever the
// JSON says. This is host/style.js's old isInside invariant made structural.
function sanitizeBackground(v) {
  if (!isPlainObject(v) || typeof v.file !== 'string') return null;
  if (!BACKGROUND_FILE_RE.test(v.file)) return null;
  const setAt = typeof v.setAt === 'string' && !Number.isNaN(Date.parse(v.setAt)) ? v.setAt : null;
  return { file: v.file.toLowerCase(), setAt };
}

function sanitizeLook(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_LOOK };
  return {
    version: 1,
    appColor: normalHex(raw.appColor),
    textColor: normalHex(raw.textColor),
    darkness: sanitizeDarkness(raw.darkness),
    background: sanitizeBackground(raw.background),
  };
}

function mix(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const ch = (k) => Math.round(ca[k] + (cb[k] - ca[k]) * t);
  return formatHex({ r: ch('r'), g: ch('g'), b: ch('b') });
}

// WCAG relative luminance, 0 (black) .. 1 (white).
function luminance(hex) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The chrome colours for this look, over the registry theme's `chrome`.
 * Keys it does not own (accent, ok, bad) pass through untouched.
 */
function derivePalette(look, baseChrome) {
  const base = { ...(baseChrome || {}) };
  const appColor = normalHex(look && look.appColor);
  const textColor = normalHex(look && look.textColor);
  if (!appColor && !textColor) return base;

  const out = { ...base };
  if (appColor) {
    const toward = luminance(appColor) < 0.5 ? '#ffffff' : '#000000';
    out.bg = appColor;
    out.panel = mix(appColor, toward, PANEL_MIX);
    out.border = mix(appColor, toward, BORDER_MIX);
  }
  if (textColor) out.text = textColor;
  // Dim is re-derived whenever either end moved: the base theme's dim was
  // tuned against the base background, and against a new one it can vanish.
  if (parseHex(out.text) && parseHex(out.bg)) out.dim = mix(out.text, out.bg, DIM_MIX);
  return out;
}

/**
 * xterm's theme for this look. Only the background follows the app colour, so
 * the terminal does not sit in a differently-coloured box; the CLI's own text
 * colours are deliberately NOT this feature's to change.
 */
function terminalOverride(look, baseTerminal) {
  const out = { ...(baseTerminal || {}) };
  const appColor = normalHex(look && look.appColor);
  if (appColor) out.background = appColor;
  return out;
}

/**
 * The registry theme with this project's look merged in -- what the host
 * sends the view, so the renderer paints it with the applyTheme it already
 * has and never needs this module in a browser scope. The base is not mutated.
 */
function applyLook(theme, look) {
  const base = theme || {};
  return {
    ...base,
    chrome: derivePalette(look, base.chrome),
    terminal: terminalOverride(look, base.terminal),
  };
}

// How dark a window that is NOT focused gets -- install-wide, one value for
// every window, because its job is telling windows apart, not identifying a
// project. Capped below black: an unfocused window must still show which
// project it is.
const DEFAULT_DIM = 0.45;
const MAX_DIM = 0.8;

function sanitizeDim(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_DIM;
  return Math.min(MAX_DIM, Math.max(0, v));
}

module.exports = {
  parseHex, formatHex, sanitizeLook, derivePalette, terminalOverride, applyLook, luminance, sanitizeDim,
  DEFAULT_LOOK, MAX_DARKNESS, ACCEPTED_EXTENSIONS, DEFAULT_DIM, MAX_DIM,
};
