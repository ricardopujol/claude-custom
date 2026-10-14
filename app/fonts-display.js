'use strict';
/**
 * Fonts (BACKLOG #88): what the person picked, and what the window should draw with.
 *
 * PURE, like app/style-display.js: no DOM, no fs. Main stores the app-wide pick (app/fonts-bridge.js), a project's look can
 * override the terminal font (host/look.js `terminalFont`), and the renderer paints from what this module decides:
 *
 *   sanitizeSettings   anything read off disk or off the wire -> settings this code can trust
 *   stackFor           a family -> a CSS font stack that ALWAYS ends in the fallbacks, so a missing font never leaves blank text
 *   effectiveTerminal  project override > app-wide pick > the registry theme > the built-in default
 *   isFixedWidth       decided by MEASURING, because only the renderer knows how a family really resolves
 *   filterFonts        the searchable list, the terminal list fixed-width only
 *   parseFamilyList    main's host-side enumeration -> a clean list
 *
 * The list is enumerated host-side because Electron 33 has no `queryLocalFonts` (measured 2026-10-14).
 *
 * "Not chosen" is `null`, never a number or a name (`Number(null)` is 0 -- see CLAUDE.md): the size stays null until the person picks one.
 *
 * WRAPPED IN AN IIFE and publishes ONE global (`fontsDisplay`); see app/bg-media-display.js's header and test/renderer-scope.test.js.
 */

(function (root) {

const MIN_TERMINAL_SIZE = 10;
const MAX_TERMINAL_SIZE = 24;
const DEFAULT_TERMINAL_SIZE = 14;
const MAX_FAMILY_LENGTH = 100;

// The stacks that stay behind any pick. The mono one is host/themes.js's glyph-complete chain (box drawing, braille, blocks).
const FALLBACK_MONO = '"Cascadia Mono", "CaskaydiaCove Nerd Font", Consolas, monospace';
const FALLBACK_UI = '"Segoe UI", system-ui, sans-serif';

// A family goes into a CSS value inside double quotes: anything that could close the quote, the declaration or the rule is refused.
// U+FFFD is what a mis-decoded name looks like: it resolves to no font, so it is refused rather than listed.
const UNSAFE_FAMILY = /["\\;{}<>\u0000-\u001f\u007f\ufffd]/;

function sanitizeFamily(v) {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (!name || name.length > MAX_FAMILY_LENGTH || UNSAFE_FAMILY.test(name)) return null;
  return name;
}

// Strict: a real, finite number or nothing. A string '16' means a hand-edited file and is refused, not coerced.
function sanitizeSize(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(MAX_TERMINAL_SIZE, Math.max(MIN_TERMINAL_SIZE, Math.round(v)));
}

function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { terminalFont: sanitizeFamily(r.terminalFont), terminalSize: sanitizeSize(r.terminalSize), uiFont: sanitizeFamily(r.uiFont) };
}

/** 'mono' or 'ui'. A null or unsafe family gives the bare fallback stack. */
function stackFor(family, kind) {
  const fallback = kind === 'ui' ? FALLBACK_UI : FALLBACK_MONO;
  const name = sanitizeFamily(family);
  return name ? `"${name}", ${fallback}` : fallback;
}

/**
 * The terminal's font as it should be painted. `themeFont` is the registry theme's `{ family, size }` (either may be absent): it is
 * what the terminal used before this feature, so an install that never picked anything looks exactly as it did.
 */
function effectiveTerminal({ settings, projectFont, themeFont } = {}) {
  const s = sanitizeSettings(settings);
  const t = themeFont && typeof themeFont === 'object' ? themeFont : {};
  const themeFamily = typeof t.family === 'string' && t.family ? t.family : null;
  // The project's pick, then the app-wide one, then the fallbacks: a pick that is not installed here (set on another PC) falls
  // through to the next one the person made, not straight to the default.
  const picks = pickedFamilies(projectFont, s.terminalFont);
  const themeSize = themeSizeOf(t);
  return {
    fontFamily: picks.length ? stackForChain(picks, 'mono') : (themeFamily || FALLBACK_MONO),
    fontSize: s.terminalSize !== null ? s.terminalSize : (themeSize !== null ? themeSize : DEFAULT_TERMINAL_SIZE),
  };
}

/** The names the person picked for the terminal, most specific first, without repeats or unsafe values. */
function pickedFamilies(projectFont, appFont) {
  const out = [];
  for (const f of [projectFont, appFont]) {
    const name = sanitizeFamily(f);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** `"A", "B", <fallbacks>`: an unsafe name is skipped. */
function stackForChain(names, kind) {
  const fallback = kind === 'ui' ? FALLBACK_UI : FALLBACK_MONO;
  const safe = (Array.isArray(names) ? names : []).map(sanitizeFamily).filter(Boolean);
  return [...safe.map((n) => `"${n}"`), fallback].join(', ');
}

// The registry theme's own size is not the person's pick: it is kept exactly as the theme says (a presentation theme may say 28).
function themeSizeOf(t) {
  return t && typeof t.size === 'number' && Number.isFinite(t.size) && t.size > 0 ? t.size : null;
}

/**
 * Is this family fixed-width? `measure(text)` returns the drawn width of `text` in that family (the renderer passes a canvas
 * `measureText`). Narrow, wide and punctuation glyphs must all agree. A font that cannot be measured is NOT claimed to be fixed-width.
 */
function isFixedWidth(measure) {
  if (typeof measure !== 'function') return false;
  try {
    const widths = ['iiiiiiii', 'WWWWWWWW', 'mmmmmmmm', '........'].map((s) => measure(s));
    if (!widths.every((w) => typeof w === 'number' && Number.isFinite(w) && w > 0)) return false;
    return Math.max(...widths) - Math.min(...widths) < 0.01;
  } catch {
    return false;
  }
}

/** main's PowerShell/fc-list output -> sorted unique family names. Vertical (@) variants, blanks and oversize lines are dropped. */
function parseFamilyList(stdout) {
  if (typeof stdout !== 'string') return [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name.startsWith('@') || name.length > MAX_FAMILY_LENGTH || UNSAFE_FAMILY.test(name)) continue;
    seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** The picker's rows: case-insensitive substring search; `fixedOnly` keeps the families `isFixed(name)` accepts. */
function filterFonts(families, query, { fixedOnly = false, isFixed } = {}) {
  if (!Array.isArray(families)) return [];
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  return families.filter((f) => typeof f === 'string'
    && (!q || f.toLowerCase().includes(q))
    && (!fixedOnly || (!SYMBOL_FAMILY.test(f) && typeof isFixed === 'function' && isFixed(f) === true)));
}

// Symbol and icon fonts draw every letter as a same-width glyph, so they measure "fixed" and are no use in a terminal.
const SYMBOL_FAMILY = /wingdings|webdings|dingbats|^symbol$|marlett|emoji|\bicons?\b|segoe fluent icons|segoe mdl2/i;

/**
 * Should the page ask main for the installed fonts now? Only once the Fonts section is actually in front of the person (enumerating
 * spawns a process and measuring touches every family), never while another ask is in flight, and again after `ttlMs` so a font
 * installed later appears. `lastAt` is when the last answer came (0 = never).
 */
function shouldAskForList({ visible, haveList, lastAt, now, ttlMs, busy } = {}) {
  if (visible !== true || busy === true) return false;
  if (!haveList) return true;
  return typeof now === 'number' && typeof lastAt === 'number' && now - lastAt >= ttlMs;
}

/** What the Style tab's Fonts section shows. `settings` null = main has not answered yet ("reading…", never a guessed size). */
function sectionView(settings, projectFont, themeSize) {
  if (!settings || typeof settings !== 'object') {
    return { known: false, terminalFont: null, size: null, uiFont: null, projectFont: sanitizeFamily(projectFont) };
  }
  const s = sanitizeSettings(settings);
  return {
    known: true,
    terminalFont: s.terminalFont,
    // The size the terminal really has: the pick, else the theme's own, else the default (never a constant that differs from the screen).
    size: s.terminalSize !== null ? s.terminalSize : (themeSizeOf({ size: themeSize }) !== null ? themeSizeOf({ size: themeSize }) : DEFAULT_TERMINAL_SIZE),
    uiFont: s.uiFont,
    projectFont: sanitizeFamily(projectFont),
  };
}

const API = {
  sanitizeFamily, sanitizeSize, sanitizeSettings, stackFor, stackForChain, shouldAskForList, effectiveTerminal, isFixedWidth, parseFamilyList, filterFonts, sectionView,
  MIN_TERMINAL_SIZE, MAX_TERMINAL_SIZE, DEFAULT_TERMINAL_SIZE, FALLBACK_MONO, FALLBACK_UI,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.fontsDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
