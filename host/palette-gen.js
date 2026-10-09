'use strict';
/**
 * A random, READABLE look for a project that has none yet (backlog #15), and
 * for the Style tab's re-roll button.
 *
 * PURE. No fs, no clock -- the randomness is injected (`rng`, default
 * Math.random) so every test replays exactly. host/style.js decides WHEN a look
 * is generated and writes it; this module only decides WHAT it is.
 *
 * Only the four look colours are generated (appColor, textColor, accentColor,
 * secondaryColor). Not darkness: that's the veil over a custom background
 * image, a Background-section control, and rolling it from "Random colours"
 * could drop a 0.9 veil over a bright photo to 0.4 (Dexter F2). Not the
 * terminal's 16 ANSI colours either: those are the CLI's.
 *
 * Colours are picked in OKLCH, where "same L" really does mean "same
 * lightness" across hues, so one hue can be rotated for the accent without the
 * accent jumping in brightness. The conversion to sRGB is written out below
 * (Björn Ottosson's OKLab matrices) rather than pulled in as a dependency.
 *
 * TWO MODES (backlog #25): 'dark' (the default, below) and 'light'. A light look is the same generator
 * with light ranges (RANGES) and its own luminance floor, run through the SAME pairs. In light mode the
 * terminal's text is the look's own text colour (host/look.js terminalOverride), so the CLI-text pair is
 * covered by the text-on-background pair and no terminal foreground is needed.
 *
 * DARK MODE: DARK BACKGROUNDS ONLY. host/look.js:150 documents that a mid-tone background
 * (luminance ~0.18) cannot carry 4.5:1 on both it and its panel -- and a light
 * one is no better here: the CLI's own text colour (a light #c7cede in the
 * default theme) is not this feature's to change, so terminalOverride would
 * push a light app colour dark again and the terminal would sit in a
 * differently-coloured box. So the generator only draws dark backgrounds, and
 * the check refuses anything above MAX_BG_LUMINANCE whatever produced it.
 *
 * GENERATE, THEN VERIFY WHAT IS RENDERED. A candidate is run through the same
 * derivePalette the app paints with, and every pair below must hold on the
 * DERIVED colours. It must also come out of derivation unmoved: derivePalette
 * silently walks an unreadable colour toward black or white, which would make
 * the check pass on colours nobody chose. A candidate that fails is redrawn,
 * at most MAX_ATTEMPTS times, and then the fixed SAFE_LOOK is used.
 *
 * THE PAIRS (WCAG contrast ratio):
 *   >= 4.5:1  text, accent and secondary (dim) on the bg AND on the panel --
 *             all three are drawn as text on both surfaces (the accent colours
 *             active tab labels and links; the secondary colour is the dim text)
 *   >= 4.5:1  the pill label (onAccent) on the accent
 *   >= 4.5:1  the terminal's foreground on the app colour, so terminalOverride
 *             leaves the terminal background equal to the app's
 *   >= 3:1    accent and secondary against the BORDER colour -- the controls
 *             (slider fill, focused/seated outlines, button labels) sit on or
 *             beside an edge drawn in that colour. The border itself is NOT
 *             held to 3:1 against the bg: derivePalette makes it a fixed 14%
 *             mix, a decorative edge rather than a control, and no generated
 *             colour can change that.
 */

const { derivePalette, contrastRatio, luminance } = require('./look');

const MIN_TEXT_CONTRAST = 4.5;
const MIN_CONTROL_CONTRAST = 3;
// Well clear of the ~0.18 mid-tone that look.js:150 names as unsatisfiable.
const MAX_BG_LUMINANCE = 0.06;
// A light look's background must be at least this bright: well clear of the same ~0.18 mid-tone.
const MIN_LIGHT_BG_LUMINANCE = 0.6;
const MAX_ATTEMPTS = 20;
// host/themes.js DEFAULT_THEME.terminal.foreground -- the host passes the
// resolved theme's own, this is only the default for a bare call.
const DEFAULT_TERMINAL_FG = '#c7cede';

// Checked by test/palette-gen.test.js to pass every pair above.
const SAFE_LOOK = Object.freeze({
  appColor: '#16181f',
  textColor: '#e6e8ee',
  accentColor: '#e0a060',
  secondaryColor: '#a0a6b4',
});

// Checked by test/light-mode.test.js to pass every pair above in light mode.
const SAFE_LOOK_LIGHT = Object.freeze({
  appColor: '#f4f5f8',
  textColor: '#1c1f29',
  accentColor: '#9a4a00',
  secondaryColor: '#4a5060',
});

// The OKLCH ranges each colour is drawn from, per mode. [lo, hi] pairs; the order the draws are made in
// (drawLook / drawLookFrom below) is fixed, so a seeded rng replays the same dark looks it always did.
const RANGES = Object.freeze({
  dark: Object.freeze({
    bgL: [0.17, 0.25], bgC: [0.015, 0.05], bgCSeeded: [0.025, 0.05],
    textL: [0.9, 0.96], textC: [0.005, 0.025],
    accentL: [0.76, 0.84], accentC: [0.09, 0.15],
    secondaryL: [0.73, 0.79], secondaryC: [0.02, 0.06],
  }),
  light: Object.freeze({
    bgL: [0.94, 0.98], bgC: [0.005, 0.03], bgCSeeded: [0.012, 0.035],
    textL: [0.2, 0.28], textC: [0.01, 0.03],
    accentL: [0.4, 0.5], accentC: [0.1, 0.16],
    secondaryL: [0.38, 0.45], secondaryC: [0.02, 0.06],
  }),
});
const rangesFor = (mode) => (mode === 'light' ? RANGES.light : RANGES.dark);

// --- OKLCH -> sRGB ------------------------------------------------------------

function oklchToLinear(L, C, h) {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const GAMUT_EPS = 1e-4;
const inGamut = (rgb) => rgb.every((c) => c >= -GAMUT_EPS && c <= 1 + GAMUT_EPS);

function encode(c) {
  const x = Math.min(1, Math.max(0, c));
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(s * 255).toString(16).padStart(2, '0');
}

/**
 * OKLCH (L 0..1, C >= 0, h degrees) to #rrggbb. A chroma sRGB cannot show is
 * reduced -- binary search at fixed L and h -- rather than channel-clipped,
 * which would shift the hue and the lightness both.
 */
function oklchToHex(L, C, h) {
  let rgb = oklchToLinear(L, C, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid;
    }
    rgb = oklchToLinear(L, lo, h);
  }
  return '#' + rgb.map(encode).join('');
}

// --- the check ------------------------------------------------------------------

const COLOUR_KEYS = ['appColor', 'textColor', 'accentColor', 'secondaryColor'];
const HEX_RE = /^#[0-9a-f]{6}$/i;
const ratio = (a, b) => contrastRatio(a, b).toFixed(2);

/**
 * Every reason this look is not safe to hand someone, as sentences; [] when it
 * is. Checked on the palette derivePalette actually renders.
 */
function lookFailures(look, { terminalForeground = DEFAULT_TERMINAL_FG, mode = 'dark' } = {}) {
  const missing = COLOUR_KEYS.filter((k) => !(look && typeof look[k] === 'string' && HEX_RE.test(look[k])));
  if (missing.length) return missing.map((k) => `${k} is not set`);

  const out = [];
  const light = mode === 'light';
  const bgLum = luminance(look.appColor);
  if (light && bgLum < MIN_LIGHT_BG_LUMINANCE) {
    out.push(`background ${look.appColor} is not light (luminance ${bgLum.toFixed(3)} < ${MIN_LIGHT_BG_LUMINANCE}; mid-tone or dark)`);
  }
  if (!light && bgLum > MAX_BG_LUMINANCE) {
    out.push(`background ${look.appColor} is not dark (luminance ${bgLum.toFixed(3)} > ${MAX_BG_LUMINANCE}; mid-tone or light)`);
  }

  const p = derivePalette(look, {});
  const rendered = [['bg', 'appColor'], ['text', 'textColor'], ['accent', 'accentColor'], ['dim', 'secondaryColor']];
  for (const [key, field] of rendered) {
    if (p[key] !== look[field].toLowerCase()) {
      out.push(`${field} ${look[field]} would be moved to ${p[key]} by the derivation (${key})`);
    }
  }

  const need = (fg, bg, min, label) => {
    if (contrastRatio(fg, bg) < min) out.push(`${label}: ${fg} on ${bg} is ${ratio(fg, bg)}:1 < ${min}:1`);
  };
  for (const [surfaceName, surface] of [['bg', p.bg], ['panel', p.panel]]) {
    need(p.text, surface, MIN_TEXT_CONTRAST, `text on ${surfaceName}`);
    need(p.accent, surface, MIN_TEXT_CONTRAST, `accent on ${surfaceName}`);
    need(p.dim, surface, MIN_TEXT_CONTRAST, `secondary (dim) on ${surfaceName}`);
  }
  need(p.onAccent, p.accent, MIN_TEXT_CONTRAST, 'pill label (onAccent) on accent');
  need(p.accent, p.border, MIN_CONTROL_CONTRAST, 'accent control on border');
  need(p.dim, p.border, MIN_CONTROL_CONTRAST, 'secondary (dim) control on border');
  if (!light && HEX_RE.test(String(terminalForeground))) {
    need(terminalForeground, look.appColor, MIN_TEXT_CONTRAST, 'terminal text on background');
  }
  return out;
}

// --- the generator ----------------------------------------------------------------

const between = (rng, lo, hi) => lo + (hi - lo) * rng();

/**
 * One draw, unchecked. Ranges are chosen so a draw nearly always passes; the
 * check, not these numbers, is the guarantee.
 */
function drawLook(rng, mode = 'dark') {
  const r = rangesFor(mode);
  const hue = between(rng, 0, 360);
  // Accent roughly opposite the background's hue, so it stands out from it.
  const accentHue = (hue + between(rng, 150, 210)) % 360;
  const secondaryHue = (hue + between(rng, -25, 25) + 360) % 360;
  return {
    appColor: oklchToHex(between(rng, ...r.bgL), between(rng, ...r.bgC), hue),
    textColor: oklchToHex(between(rng, ...r.textL), between(rng, ...r.textC), hue),
    accentColor: oklchToHex(between(rng, ...r.accentL), between(rng, ...r.accentC), accentHue),
    secondaryColor: oklchToHex(between(rng, ...r.secondaryL), between(rng, ...r.secondaryC), secondaryHue),
  };
}

/**
 * A look that passes lookFailures for THIS terminal foreground: a draw, or
 * SAFE_LOOK after MAX_ATTEMPTS draws that didn't -- or null when SAFE_LOOK
 * fails too. It's only proven safe for the default theme's light CLI text; a
 * light-background terminal theme (dark text) can carry no dark app colour at
 * all, and the caller must write nothing rather than a look that fails
 * (Dexter F1). `candidate` replaces the draw -- for tests of the retry itself.
 */
function generateLook(rng = Math.random, { terminalForeground = DEFAULT_TERMINAL_FG, candidate = drawLook, mode = 'dark' } = {}) {
  const passes = (look) => lookFailures(look, { terminalForeground, mode }).length === 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const look = candidate(rng, mode);
    if (passes(look)) return look;
  }
  const safe = mode === 'light' ? SAFE_LOOK_LIGHT : SAFE_LOOK;
  return passes(safe) ? { ...safe } : null;
}

// Why generateLook came back empty, in words for the Style tab and the log.
function noLookReason(terminalForeground) {
  return `no random look reads against this theme's terminal text (${terminalForeground}) -- ` +
    'random looks are dark, and this terminal text needs a light background';
}

// --- a look seeded by a background's own colours (backlog #34) ---------------------
//
// "Match colours to this background": the renderer samples the picture (or the
// video's current frame) and sends a handful of dominant colours -- never the
// image. These tint the same generator: the app colour and text take the
// background's hue, the accent takes a DIFFERENT dominant hue when there is
// one, and every candidate still has to pass the same gates as a random look.

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * #rrggbb to OKLCH { L, C, h }, or null. `h` is in degrees, and NULL when there is
 * no chroma: a grey has no hue, and 0 would be a hue -- red (Dexter D1, PR #91).
 */
function hexToOklch(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear((n >> 16) & 255);
  const g = srgbToLinear((n >> 8) & 255);
  const b = srgbToLinear(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  const h = C < 1e-4 ? null : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C: C < 1e-4 ? 0 : C, h };
}

// Fewer than this much chroma is a grey: its hue is rounding noise, not a colour.
const CHROMA_MIN = 0.03;
const MAX_SEEDS = 8;
// An accent seed must differ from the base hue by at least this, or the accent
// would just be the background again.
const ACCENT_HUE_GAP = 30;

const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/**
 * What the seeds say, or null when none is a colour: `base` (the hue the app
 * colour and text take -- the first CHROMATIC seed, or neutral when the whole
 * picture is grey) and `accent` (the most vivid seed of another hue, or null).
 * Anything that is not #rrggbb is skipped, and only the first MAX_SEEDS are read.
 */
function seedParts(seeds) {
  if (!Array.isArray(seeds)) return null;
  const all = seeds.slice(0, MAX_SEEDS).map(hexToOklch).filter(Boolean);
  if (!all.length) return null;
  const chromatic = all.filter((c) => c.C >= CHROMA_MIN);
  const base = chromatic.length ? chromatic[0] : { L: all[0].L, C: 0, h: null };
  let accent = null;
  for (const c of chromatic) {
    if (hueGap(c.h, base.h) >= ACCENT_HUE_GAP && (!accent || c.C > accent.C)) accent = c;
  }
  return { base, accent };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (h) => ((h % 360) + 360) % 360;

/**
 * The hues of one draw: `hue` (app colour and text) and `accentHue`, or both
 * null for a grey picture -- it has no hue, so none is invented (Dexter D1).
 * The accent keeps ACCENT_HUE_GAP from the app colour AFTER the jitter: the
 * seeds were checked for the gap, and ±3° on each side could undo it, so a
 * drawn accent closer than the gap is pushed back out to it (Dexter D3).
 */
function drawHues(rng, parts) {
  const { base, accent } = parts;
  if (typeof base.h !== 'number' || !(base.C >= CHROMA_MIN)) return { hue: null, accentHue: null };
  const hue = wrap(base.h + between(rng, -3, 3));
  if (!accent) return { hue, accentHue: wrap(base.h + between(rng, 150, 210)) };
  let accentHue = wrap(accent.h + between(rng, -3, 3));
  if (hueGap(accentHue, hue) < ACCENT_HUE_GAP) {
    accentHue = wrap(hue + (wrap(accentHue - hue) <= 180 ? ACCENT_HUE_GAP : -ACCENT_HUE_GAP));
  }
  return { hue, accentHue };
}

/**
 * One seeded draw, unchecked, like drawLook. A grey picture gives a grey look --
 * every colour neutral, the accent too; a coloured one keeps its hue within a
 * few degrees so a re-roll varies without leaving the picture's colour.
 */
function drawLookFrom(rng, parts, mode = 'dark') {
  const r = rangesFor(mode);
  const { base, accent } = parts;
  const { hue, accentHue } = drawHues(rng, parts);
  if (hue === null) {
    return {
      appColor: oklchToHex(between(rng, ...r.bgL), 0, 0),
      textColor: oklchToHex(between(rng, ...r.textL), 0, 0),
      accentColor: oklchToHex(between(rng, ...r.accentL), 0, 0),
      secondaryColor: oklchToHex(between(rng, ...r.secondaryL), 0, 0),
    };
  }
  const accentChroma = accent ? clamp(accent.C * between(rng, 0.9, 1.1), ...r.accentC) : between(rng, ...r.accentC);
  return {
    appColor: oklchToHex(between(rng, ...r.bgL), between(rng, ...r.bgCSeeded), hue),
    textColor: oklchToHex(between(rng, ...r.textL), between(rng, ...r.textC), hue),
    accentColor: oklchToHex(between(rng, ...r.accentL), accentChroma, accentHue),
    secondaryColor: oklchToHex(between(rng, ...r.secondaryL), between(rng, ...r.secondaryC), wrap(base.h + between(rng, -25, 25))),
  };
}

/** The draw with every random choice at its midpoint: the safe fallback, still seeded. */
function tameDraw(parts, mode = 'dark') {
  return drawLookFrom(() => 0.5, parts, mode);
}

/**
 * A look for a background with these seeds that passes lookFailures for THIS
 * terminal foreground -- or null, never a failing look and never an unseeded
 * one: a draw, else the tame draw after MAX_ATTEMPTS misses, else a refusal.
 * (generateLook falls back to SAFE_LOOK; that would be a fixed palette sold as
 * a match, so this does not.) `candidate` replaces the draw, for tests.
 */
function generateLookFrom(seeds, rng = Math.random, { terminalForeground = DEFAULT_TERMINAL_FG, candidate = drawLookFrom, mode = 'dark' } = {}) {
  const parts = seedParts(seeds);
  if (!parts) return null;
  const passes = (look) => lookFailures(look, { terminalForeground, mode }).length === 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const look = candidate(rng, parts, mode);
    if (passes(look)) return look;
  }
  const tame = tameDraw(parts, mode);
  return passes(tame) ? tame : null;
}

function noSeedsReason() {
  return 'no usable colours were sampled from this background';
}

module.exports = {
  generateLook, drawLook, lookFailures, noLookReason, oklchToHex, SAFE_LOOK, SAFE_LOOK_LIGHT, MIN_LIGHT_BG_LUMINANCE, RANGES, MAX_ATTEMPTS, DEFAULT_TERMINAL_FG,
  MIN_TEXT_CONTRAST, MIN_CONTROL_CONTRAST, MAX_BG_LUMINANCE,
  generateLookFrom, drawLookFrom, drawHues, seedParts, hexToOklch, tameDraw, noSeedsReason, MAX_SEEDS, ACCENT_HUE_GAP,
};
