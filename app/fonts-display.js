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
const UNSAFE_FAMILY = /["\\;{}<>\u0000-\u001f\u007f]/;

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
  const picked = sanitizeFamily(projectFont) || s.terminalFont;
  const themeFamily = typeof t.family === 'string' && t.family ? t.family : null;
  const themeSize = sanitizeSize(t.size);
  return {
    fontFamily: picked ? stackFor(picked, 'mono') : (themeFamily || FALLBACK_MONO),
    fontSize: s.terminalSize !== null ? s.terminalSize : (themeSize !== null ? themeSize : DEFAULT_TERMINAL_SIZE),
  };
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
    && (!fixedOnly || (typeof isFixed === 'function' && isFixed(f) === true)));
}

/** What the Style tab's Fonts section shows. `settings` null = main has not answered yet ("reading…", never a guessed size). */
function sectionView(settings, projectFont) {
  if (!settings || typeof settings !== 'object') {
    return { known: false, terminalFont: null, size: null, uiFont: null, projectFont: sanitizeFamily(projectFont) };
  }
  const s = sanitizeSettings(settings);
  return {
    known: true,
    terminalFont: s.terminalFont,
    size: s.terminalSize !== null ? s.terminalSize : DEFAULT_TERMINAL_SIZE,
    uiFont: s.uiFont,
    projectFont: sanitizeFamily(projectFont),
  };
}

const API = {
  sanitizeFamily, sanitizeSize, sanitizeSettings, stackFor, effectiveTerminal, isFixedWidth, parseFamilyList, filterFonts, sectionView,
  MIN_TERMINAL_SIZE, MAX_TERMINAL_SIZE, DEFAULT_TERMINAL_SIZE, FALLBACK_MONO, FALLBACK_UI,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.fontsDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
