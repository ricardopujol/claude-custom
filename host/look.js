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
// Images and short video loops (backlog #34): host/background-media.js owns which is which.
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('./background-media');
const ACCEPTED_EXTENSIONS = Object.freeze([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

// A darkness of 1 would paint the veil fully opaque and the image would be
// gone -- that is "remove the image", which has its own button.
const MAX_DARKNESS = 0.95;

const DEFAULT_LOOK = Object.freeze({
  version: 1,
  appColor: null,
  textColor: null,
  accentColor: null,
  secondaryColor: null,
  darkness: 0.5,
  background: null,
  // Backlog #25. 'dark' | 'light' | null (never chosen: reads as dark, and the CLI is sent no theme, so an
  // existing project keeps whatever theme the person had). The fields above are the look of THIS mode;
  // `other` holds the colours and veil of the opposite mode, so a flip swaps them without losing either.
  mode: null,
  other: null,
});

const OTHER_COLOUR_KEYS = Object.freeze(['appColor', 'textColor', 'accentColor', 'secondaryColor']);

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

function sanitizeMode(v) {
  return v === 'light' || v === 'dark' ? v : null;
}

// The stored look of the opposite mode: colours and a veil, nothing else. The background is one file
// for both modes, so it is never part of this.
function sanitizeOther(v) {
  if (!isPlainObject(v)) return null;
  const out = {};
  for (const key of OTHER_COLOUR_KEYS) out[key] = normalHex(v[key]);
  out.darkness = sanitizeDarkness(v.darkness);
  return out;
}

/** 'light' or 'dark': a never-chosen mode reads as dark. */
function effectiveMode(look) {
  return look && look.mode === 'light' ? 'light' : 'dark';
}

/**
 * The theme to hand the CLI (`--settings`), or null to leave its own choice alone. `userTheme` is the theme the
 * person already uses: a daltonized or ANSI family survives the flip (dark-ansi <-> light-ansi).
 */
function cliThemeFor(look, userTheme) {
  const mode = look && (look.mode === 'light' || look.mode === 'dark') ? look.mode : null;
  if (!mode) return null;
  const family = typeof userTheme === 'string' ? /^(?:dark|light)-(daltonized|ansi)$/.exec(userTheme) : null;
  return family ? `${mode}-${family[1]}` : mode;
}

// A light look's background must be at least this bright (well clear of the ~0.18 mid-tone), and the colours it falls
// back to when the person's own are missing or not light. host/palette-gen.js checks SAFE_LOOK_LIGHT against every pair.
const LIGHT_BG_FLOOR = 0.6;
const SAFE_LOOK_LIGHT = Object.freeze({
  appColor: '#f4f5f8',
  textColor: '#1c1f29',
  accentColor: '#9a4a00',
  secondaryColor: '#4a5060',
});

/**
 * The look as it is PAINTED. A dark look is as stored. A light look cannot trust its App colour (Reset, a hand-picked
 * #202020, a stored look with no colours): a missing or non-light one becomes the light palette's own, and every unset
 * colour is filled from it, so chrome, terminal and the CLI's light theme always sit on a light surface.
 */
function resolveLook(look) {
  if (effectiveMode(look) !== 'light') return look;
  const app = normalHex(look.appColor);
  const pick = (key) => normalHex(look[key]) || SAFE_LOOK_LIGHT[key];
  return {
    ...look,
    appColor: app && luminance(app) >= LIGHT_BG_FLOOR ? app : SAFE_LOOK_LIGHT.appColor,
    textColor: pick('textColor'),
    accentColor: pick('accentColor'),
    secondaryColor: pick('secondaryColor'),
  };
}

function sanitizeLook(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_LOOK };
  return {
    version: 1,
    appColor: normalHex(raw.appColor),
    textColor: normalHex(raw.textColor),
    accentColor: normalHex(raw.accentColor),
    secondaryColor: normalHex(raw.secondaryColor),
    darkness: sanitizeDarkness(raw.darkness),
    background: sanitizeBackground(raw.background),
    mode: sanitizeMode(raw.mode),
    other: sanitizeOther(raw.other),
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

// WCAG contrast ratio, 1 (identical) .. 21 (black on white).
function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// WCAG AA for normal text. Always reachable: for any `against`, black or
// white is at least ~4.58:1 from it.
const MIN_CONTRAST = 4.5;

/**
 * `color` if it already reads against `against`; otherwise `color` walked
 * toward whichever of black and white contrasts more, just far enough.
 *
 * Dexter F4: a person picks colours one at a time, so a perfectly reasonable
 * app colour can equal the terminal's (or the UI's) text colour and make it
 * vanish -- and an invisible Style tab cannot be used to undo it. A choice
 * that already reads is returned untouched.
 */
function ensureContrast(color, against) {
  return ensureContrastAll(color, [against]);
}

/**
 * ensureContrast against SEVERAL surfaces at once -- the UI text sits on both
 * the bg and the panel (header, tab strip), which differ slightly (Dexter,
 * accent review #3).
 *
 * The FIRST surface is the guarantee: the extreme walked toward is the one that
 * reads best on it, so 4.5:1 there always holds. The others are met whenever
 * that extreme can meet them. For a mid-tone bg (luminance near 0.18) no colour
 * at all reaches 4.5:1 on both it and a slightly lighter panel -- found by the
 * property test with #7265b1 -- and the panel then gets the extreme's best.
 */
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

// The theme's dark label on the accent (the inner-agent pill). Kept when it
// reads on the chosen accent, walked to white-ish when it does not.
const ON_ACCENT = '#12141c';

/**
 * The chrome colours for this look, over the registry theme's `chrome`.
 * Keys it does not own (ok, bad) pass through untouched, and so does an accent
 * the person has not set.
 */
function derivePalette(rawLook, baseChrome) {
  const look = resolveLook(rawLook);
  const base = { ...(baseChrome || {}) };
  const appColor = normalHex(look && look.appColor);
  const textColor = normalHex(look && look.textColor);
  const accentColor = normalHex(look && look.accentColor);
  const secondaryColor = normalHex(look && look.secondaryColor);
  if (!appColor && !textColor && !accentColor && !secondaryColor) return base;

  const out = { ...base };
  if (appColor) {
    const toward = luminance(appColor) < 0.5 ? '#ffffff' : '#000000';
    out.bg = appColor;
    out.panel = mix(appColor, toward, PANEL_MIX);
    out.border = mix(appColor, toward, BORDER_MIX);
  }
  if (textColor) out.text = textColor;
  // Every surface UI text is drawn on: the bg and the panel (header, tabs).
  const surfaces = [out.bg, out.panel].filter((c) => parseHex(c));
  const readable = (hex) => (surfaces.length ? ensureContrastAll(hex, surfaces) : hex);
  if ((appColor || textColor) && parseHex(out.text) && parseHex(out.bg)) {
    out.text = readable(out.text);
    // Dim is re-derived whenever either end moved: the base theme's dim was
    // tuned against the base background, and against a new one it can vanish.
    out.dim = mix(out.text, out.bg, DIM_MIX);
  }
  // A chosen accent or secondary colour is used as given when it reads, and
  // moved just far enough when it would vanish -- a separate guard from the
  // derived dim above, which is never overridden unless the person set one.
  if (accentColor) {
    out.accent = readable(accentColor);
    out.onAccent = ensureContrast(ON_ACCENT, out.accent);
  }
  if (secondaryColor) out.dim = readable(secondaryColor);
  return out;
}

/**
 * xterm's theme for this look. Only the background follows the app colour, so
 * the terminal does not sit in a differently-coloured box; the CLI's own text
 * colours are deliberately NOT this feature's to change.
 */
function terminalOverride(rawLook, baseTerminal) {
  const look = resolveLook(rawLook);
  const out = { ...(baseTerminal || {}) };
  const appColor = normalHex(look && look.appColor);
  if (!appColor) return out;
  if (effectiveMode(look) === 'light') {
    // The CLI runs its light theme in a light look, so its default text is dark: the terminal's own
    // foreground follows the look's text colour instead of pushing the app colour dark.
    out.background = appColor;
    out.foreground = ensureContrast(normalHex(look.textColor), appColor);
    return out;
  }
  // Moved away from the CLI's own text colour when it would hide it -- this
  // feature cannot change that text, so the background is what must give.
  out.background = parseHex(out.foreground) ? ensureContrast(appColor, out.foreground) : appColor;
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
  parseHex, formatHex, sanitizeLook, effectiveMode, cliThemeFor, resolveLook, SAFE_LOOK_LIGHT, LIGHT_BG_FLOOR, derivePalette, terminalOverride, applyLook, luminance, sanitizeDim,
  contrastRatio, ensureContrast, ensureContrastAll, MIN_CONTRAST,
  DEFAULT_LOOK, MAX_DARKNESS, ACCEPTED_EXTENSIONS, DEFAULT_DIM, MAX_DIM,
};
