'use strict';
/**
 * How the Style tab should be DRAWN, given what the host reports.
 *
 * FF6: a container that GROWS, with exactly one section today (the background
 * image). `STYLE_SECTIONS` is the registry that makes adding a second section
 * later a one-array-element change rather than a new panel -- the same reason
 * app/side-tabs.js keeps TABS as data instead of hardcoding a tab strip.
 *
 * PURE, like app/projects-display.js: this module returns plain strings and
 * flags, never HTML. renderer.js builds and escapes the actual markup -- the
 * same division of labour projectsDisplay uses, so escaping stays in the one
 * place that already has an `escapeHtml` and this module stays testable with
 * `require()` alone, no DOM.
 *
 * WRAPPED IN AN IIFE for the reason app/usage-display.js is: the renderer
 * loads these as plain <script> tags sharing ONE global scope, and a
 * top-level `const` here would collide with an identically named one in a
 * sibling file and kill this whole file silently. Enforced by
 * test/renderer-scope.test.js.
 */

(function (root) {

const STYLE_SECTIONS = [
  { id: 'colours', title: 'Colours' },
  { id: 'background', title: 'Background image' },
  { id: 'inactive', title: 'Inactive windows' },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;
// What an <input type=color> is handed before anything is known. It shows
// black for any invalid value, which would read as a real choice.
const FALLBACK_BG = '#11131a';
const FALLBACK_TEXT = '#c7cede';

// Strict, never coercing: an absent fraction is "unknown", not 0%.
function toPercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function errorOf(state) {
  return (state && typeof state.error === 'string' && state.error) || null;
}

function colourView(set, base, fallback) {
  if (typeof set === 'string' && HEX_RE.test(set)) return { value: set.toLowerCase(), isSet: true };
  const value = typeof base === 'string' && HEX_RE.test(base) ? base.toLowerCase() : fallback;
  return { value, isSet: false };
}

function coloursSectionView(state) {
  const s = state || {};
  return {
    known: !!state && (typeof s.baseBg === 'string' || typeof s.appColor === 'string'),
    app: colourView(s.appColor, s.baseBg, FALLBACK_BG),
    text: colourView(s.textColor, s.baseText, FALLBACK_TEXT),
    error: errorOf(state),
  };
}

function inactiveSectionView(state) {
  const dimPercent = toPercent(state && state.dim);
  return {
    dimPercent,
    description: dimPercent === null ? 'reading…' : "How dark a window gets while you're typing in another one. Applies to every window.",
  };
}

// Strict, not coercing -- Number(null) is 0, this codebase's named trap, and
// an invalid/absent timestamp must read as "no time known", never as epoch.
function formatSetAt(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

// What the current source of the background actually is, in words. The two
// facts the brief names explicitly: "generated for this project" vs.
// "your image, set <when>".
function describeSource(state) {
  if (!state || !state.source) return 'reading…';
  if (state.source === 'override') {
    const when = formatSetAt(state.setAt);
    return when ? `your image, set ${when}` : 'your image';
  }
  return 'generated for this project';
}

function backgroundSectionView(state) {
  return {
    description: describeSource(state),
    // Only meaningful once there IS an override -- resetting a generated
    // background to itself is not an action, so the button starts disabled.
    isOverride: !!(state && state.source === 'override'),
    darknessPercent: toPercent(state && state.darkness),
    error: errorOf(state),
  };
}

const SECTION_VIEWS = {
  colours: coloursSectionView,
  background: backgroundSectionView,
  inactive: inactiveSectionView,
};

/**
 * `state` is keyed by section id, the same shape the registry uses --
 * `{ background: { source, setAt, error } }` today, one more key per future
 * section. Unknown section ids (there are none yet) get a null view rather
 * than throwing, so a future section with no view function still renders its
 * title.
 */
function styleDisplay(state) {
  return STYLE_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    view: SECTION_VIEWS[section.id] ? SECTION_VIEWS[section.id](state && state[section.id]) : null,
  }));
}

const API = { styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource, backgroundSectionView, toPercent };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else Object.assign(root, API);

})(typeof window !== 'undefined' ? window : globalThis);
