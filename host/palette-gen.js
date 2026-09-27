'use strict';
/**
 * A random, READABLE look for a project that has none yet (backlog #15), and
 * for the Style tab's re-roll button.
 *
 * PURE. No fs, no clock -- the randomness is injected (`rng`, default
 * Math.random) so every test replays exactly. host/style.js decides WHEN a look
 * is generated and writes it; this module only decides WHAT it is.
 *
 * Only the look colours are generated (appColor, textColor, accentColor,
 * secondaryColor, darkness). The terminal's 16 ANSI colours are the CLI's, not
 * this feature's.
 *
 * Colours are picked in OKLCH, where "same L" really does mean "same
 * lightness" across hues, so one hue can be rotated for the accent without the
 * accent jumping in brightness. The conversion to sRGB is written out below
 * (Björn Ottosson's OKLab matrices) rather than pulled in as a dependency.
 *
 * DARK BACKGROUNDS ONLY. host/look.js:150 documents that a mid-tone background
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

const { derivePalette, contrastRatio, luminance, MAX_DARKNESS } = require('./look');

const MIN_TEXT_CONTRAST = 4.5;
const MIN_CONTROL_CONTRAST = 3;
// Well clear of the ~0.18 mid-tone that look.js:150 names as unsatisfiable.
const MAX_BG_LUMINANCE = 0.06;
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
  darkness: 0.5,
});

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
function lookFailures(look, { terminalForeground = DEFAULT_TERMINAL_FG } = {}) {
  const missing = COLOUR_KEYS.filter((k) => !(look && typeof look[k] === 'string' && HEX_RE.test(look[k])));
  if (missing.length) return missing.map((k) => `${k} is not set`);

  const out = [];
  const bgLum = luminance(look.appColor);
  if (bgLum > MAX_BG_LUMINANCE) {
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
  if (HEX_RE.test(String(terminalForeground))) {
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
function drawLook(rng) {
  const hue = between(rng, 0, 360);
  // Accent roughly opposite the background's hue, so it stands out from it.
  const accentHue = (hue + between(rng, 150, 210)) % 360;
  const secondaryHue = (hue + between(rng, -25, 25) + 360) % 360;
  return {
    appColor: oklchToHex(between(rng, 0.17, 0.25), between(rng, 0.015, 0.05), hue),
    textColor: oklchToHex(between(rng, 0.9, 0.96), between(rng, 0.005, 0.025), hue),
    accentColor: oklchToHex(between(rng, 0.76, 0.84), between(rng, 0.09, 0.15), accentHue),
    secondaryColor: oklchToHex(between(rng, 0.73, 0.79), between(rng, 0.02, 0.06), secondaryHue),
    darkness: Math.min(MAX_DARKNESS, Math.round(between(rng, 0.4, 0.7) * 100) / 100),
  };
}

/**
 * A look that passes lookFailures, or SAFE_LOOK after MAX_ATTEMPTS draws that
 * did not. `candidate` replaces the draw -- for tests of the retry itself.
 */
function generateLook(rng = Math.random, { terminalForeground = DEFAULT_TERMINAL_FG, candidate = drawLook } = {}) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const look = candidate(rng);
    if (lookFailures(look, { terminalForeground }).length === 0) return look;
  }
  return { ...SAFE_LOOK };
}

module.exports = {
  generateLook, drawLook, lookFailures, oklchToHex, SAFE_LOOK, MAX_ATTEMPTS, DEFAULT_TERMINAL_FG,
  MIN_TEXT_CONTRAST, MIN_CONTROL_CONTRAST, MAX_BG_LUMINANCE,
};
