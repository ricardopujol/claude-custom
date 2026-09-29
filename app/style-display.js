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
  { id: 'avatars', title: 'Agent pictures' },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;
// What an <input type=color> is handed before anything is known. It shows
// black for any invalid value, which would read as a real choice.
const FALLBACK_BG = '#11131a';
const FALLBACK_TEXT = '#c7cede';
const FALLBACK_ACCENT = '#d08c4a';
const FALLBACK_DIM = '#6d7689';

// Strict, never coercing: an absent fraction is "unknown", not 0%.
function toPercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function errorOf(state) {
  return (state && typeof state.error === 'string' && state.error) || null;
}

const THEME_RESET = "Back to the theme's colour";

// `painted` is the colour on screen (the merged theme's), and is the value
// shown while unset. Set, the picker keeps the person's choice; when the
// readability guard moved it (Dexter, accent review #2), `painted` says to what.
function colourView(set, painted, fallback, resetTitle) {
  const paintedHex = typeof painted === 'string' && HEX_RE.test(painted) ? painted.toLowerCase() : null;
  if (typeof set === 'string' && HEX_RE.test(set)) {
    const value = set.toLowerCase();
    const view = { value, isSet: true, resetTitle };
    if (paintedHex && paintedHex !== value) view.painted = paintedHex;
    return view;
  }
  return { value: paintedHex || fallback, isSet: false, resetTitle };
}

function coloursSectionView(state) {
  const s = state || {};
  return {
    known: !!state && (typeof s.baseBg === 'string' || typeof s.appColor === 'string'),
    app: colourView(s.appColor, s.baseBg, FALLBACK_BG, THEME_RESET),
    text: colourView(s.textColor, s.baseText, FALLBACK_TEXT, THEME_RESET),
    // Unset, these show the colour actually painted: the theme's accent, and
    // the secondary text derived from Text and App (Miguel, accent review #1:
    // so its Reset does not claim to restore a theme colour).
    accent: colourView(s.accentColor, s.baseAccent, FALLBACK_ACCENT, "Back to the theme's accent"),
    secondary: colourView(s.secondaryColor, s.baseDim, FALLBACK_DIM,
      'Back to automatic: worked out from Text and App'),
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

/**
 * The "Agent pictures" section (BACKLOG C #3, #18): the user-set default
 * picture for every agent, and the install-wide "show agent images" toggle.
 *
 * Absence is never blank and never a confident answer: not-yet-read is
 * "reading…", nothing-set says so, and only a well-formed `{ set: true }` from
 * the host draws a file name. The toggle is strict -- only a real boolean is
 * known; anything else is null ("not read yet").
 */
function avatarsSectionView(state) {
  const g = state && state.global;
  const known = !!g && typeof g === 'object' && typeof g.set === 'boolean';
  let globalDescription = 'reading…';
  if (known && g.set) {
    globalDescription = typeof g.file === 'string' && g.file
      ? `${g.file} (your global default picture, used for every agent without a picture of its own)`
      : 'your global default picture (used for every agent without a picture of its own)';
  } else if (known) {
    globalDescription = 'none set (built-in placeholder)';
  }
  const imagesEnabled = state && typeof state.imagesEnabled === 'boolean' ? state.imagesEnabled : null;
  return {
    globalDescription,
    globalSet: known && g.set === true,
    imagesEnabled,
    imagesDescription: imagesEnabled === null ? 'reading…'
      : imagesEnabled ? 'Pictures, GIFs and video are shown on the agent cards.'
        : 'Agent images are off: every card shows its initials, and no picture or video is loaded.',
    error: errorOf(state),
  };
}

const SECTION_VIEWS = {
  colours: coloursSectionView,
  background: backgroundSectionView,
  inactive: inactiveSectionView,
  avatars: avatarsSectionView,
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

// The sections a host reply can be tagged with -- also the only state keys a
// tag may address, so an arbitrary `ask` string never becomes a property name.
const ASKABLE = ['colours', 'background'];

function emptyStyleState() {
  return {
    colours: null,
    background: { source: null, setAt: null, error: null, darkness: null },
    inactive: { dim: null },
    avatars: { global: null, imagesEnabled: null, error: null },
  };
}

/**
 * The panel's next state after a host message (`hello` or `style`).
 *
 * Dexter F2: a refusal is routed by the `ask` tag the host ECHOES from the
 * request it answers, not by whichever request was sent last -- with a slow
 * image copy in flight, "last sent" is a different section. And a success
 * clears only its OWN section's error, so one section's success does not wipe
 * another's still-true failure. Untagged (older host, or a hello) falls back
 * to background for an error and clears everything for a success.
 *
 * Dexter F3: a refusal leaves every stored value as it was, so the renderer
 * can repaint the stored darkness and theme over any failed preview.
 *
 * The inactive dim is main's, never the host's, so it is carried through.
 */
function reduceStyle(prev, msg) {
  const state = prev || emptyStyleState();
  const m = msg || {};
  const ask = ASKABLE.includes(m.ask) ? m.ask : null;
  if (typeof m.error === 'string' && m.error) {
    const key = ask || 'background';
    return { ...state, [key]: { ...(state[key] || {}), error: m.error } };
  }
  const style = m.style || m;
  const look = style.look || {};
  const chrome = (m.theme && m.theme.chrome) || {};
  const keep = (key) => (ask && ask !== key && state[key] ? state[key].error || null : null);
  return {
    // Unset colours show the theme's own value -- which, with nothing set, is
    // exactly what the merged theme's chrome holds.
    colours: {
      appColor: look.appColor, textColor: look.textColor,
      accentColor: look.accentColor, secondaryColor: look.secondaryColor,
      baseBg: chrome.bg, baseText: chrome.text, baseAccent: chrome.accent, baseDim: chrome.dim,
      error: keep('colours'),
    },
    background: {
      source: style.source || 'generated', setAt: style.setAt || null,
      darkness: look.darkness, error: keep('background'),
    },
    inactive: state.inactive,
    avatars: state.avatars || emptyStyleState().avatars,
  };
}

/**
 * The next state after a host message that concerns the GLOBAL default
 * picture: `hello` (which carries the current one) and a `portrait` reply
 * tagged `global`. A per-agent portrait reply returns the SAME object, so a
 * caller can tell nothing changed. A refusal keeps the stored value and shows
 * the reason -- it never repaints the row as though the change had landed.
 */
function reduceAvatars(prev, msg) {
  const state = prev || emptyStyleState();
  const m = msg || {};
  const cur = state.avatars || emptyStyleState().avatars;
  const wellFormed = (g) => !!g && typeof g === 'object' && typeof g.set === 'boolean';
  if (m.type === 'hello') {
    return { ...state, avatars: { ...cur, global: wellFormed(m.globalPortrait) ? m.globalPortrait : cur.global } };
  }
  if (m.type === 'portrait' && m.global === true) {
    const global = wellFormed(m.globalPortrait) ? m.globalPortrait : cur.global;
    const error = m.ok === true ? null : (typeof m.reason === 'string' && m.reason ? m.reason : 'the picture was not changed');
    return { ...state, avatars: { ...cur, global, error } };
  }
  return state;
}

/** Records the desired "show agent images" state; anything but a boolean is ignored. */
function reduceImagesEnabled(prev, enabled) {
  const state = prev || emptyStyleState();
  if (typeof enabled !== 'boolean') return state;
  return { ...state, avatars: { ...(state.avatars || emptyStyleState().avatars), imagesEnabled: enabled } };
}

const API = {
  reduceStyle, emptyStyleState, styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource, backgroundSectionView, toPercent,
  avatarsSectionView, reduceAvatars, reduceImagesEnabled,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else Object.assign(root, API);

})(typeof window !== 'undefined' ? window : globalThis);
