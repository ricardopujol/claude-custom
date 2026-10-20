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
  { id: 'fonts', title: 'Fonts' },
  { id: 'background', title: 'Background' },
  { id: 'inactive', title: 'Inactive windows' },
  { id: 'avatars', title: 'Agent pictures' },
  { id: 'window', title: 'Window' },
  { id: 'tray', title: 'System tray' },
  { id: 'panel', title: "Claude's panel" },
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

// The CLI takes its theme when the host STARTS it, and a window reopening only reattaches to the running one.
const MODE_NOTE = "Claude's colours switch the next time this session restarts";

// Dark or light, on either side of the comparison: a never-chosen mode, 'auto' and the dark families read as dark,
// and 'light-ansi' / 'light-daltonized' as light (only the light or dark half is compared, not the family).
const modeOf = (v) => (typeof v === 'string' && v.startsWith('light') ? 'light' : 'dark');

function coloursSectionView(state) {
  const s = state || {};
  const mode = modeOf(s.mode);
  return {
    mode,
    // The CLI takes its theme when it starts, so while the look and the running CLI disagree the person is told.
    cliNote: mode === modeOf(s.cliTheme) ? null : MODE_NOTE,
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
    const what = state.kind === 'video' ? 'your video' : 'your image';
    return when ? `${what}, set ${when}` : what;
  }
  return 'generated for this project';
}

function backgroundSectionView(state) {
  const isOverride = !!(state && state.source === 'override');
  // #92: Plain colour paints the project's app colour instead of the picture (the picture's file stays on disk).
  const plainColour = !!(state && state.backgroundMode === 'colour');
  const note = (state && typeof state.videoError === 'string' && state.videoError) || null;
  return {
    description: plainColour ? 'Plain colour: your app colour, no picture' : describeSource(state),
    plainColour,
    // The darkness slider needs something to darken: your own picture, or the plain colour.
    showVeil: isOverride || plainColour,
    // Only meaningful once there IS an override -- resetting a generated
    // background to itself is not an action, so the button starts disabled.
    isOverride,
    isVideo: !!(state && state.kind === 'video'),
    // Why the video isn't showing (codec, corruption); the file stays.
    note,
    // "Match colours to this background" needs the person's own picture, and a
    // frame to take colours from -- a video that won't play has none.
    canMatch: isOverride && note === null && !plainColour,
    darknessPercent: toPercent(state && state.darkness),
    // In light mode the veil over the picture is light, so the slider is how bright it gets.
    veilLabel: modeOf(state && state.mode) === 'light' ? 'Brightness' : 'Darkness',
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

/**
 * Layout pass L2's two install-wide window settings (app/window-chrome-bridge.js
 * owns them). Strict like the images toggle: only a real boolean is known,
 * anything else is null, "reading…", never a guessed OFF.
 */
function windowSectionView(state) {
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const statusInHeader = bool(state && state.statusInHeader);
  const framelessWindow = bool(state && state.framelessWindow);
  return {
    statusInHeader,
    framelessWindow,
    // Miguel L2 Y3: the header mirrors cost, lines, time and ctx>200k, not
    // whatever else a person's own statusLine command printed -- say it stops.
    // Dexter L2 #4: the CLI redraws its row only on its next status update.
    statusDescription: statusInHeader === null ? 'reading…'
      : statusInHeader ? "Cost, lines and time show in each tab's header, and the terminal gets that row back. "
        + "Your own status line command doesn't run while this is on. A switch shows at the CLI's next status update."
        : "The status line shows under the terminal's input box, drawn by your own status line command. "
          + "A switch shows at the CLI's next status update.",
    framelessDescription: framelessWindow === null ? 'reading…'
      : framelessWindow ? 'The next window opens with no title bar: the tabs are the top row.'
        : 'Windows keep their title bar. A change applies to the next window you open.',
  };
}

/**
 * #71 question 8 (Ricardo, 2026-10-06: the recommendation): whether Claude's panel is offered to the CLI at all. Strict like the
 * toggles above: only a real boolean is known, anything else is null, "reading…". It changes what the next session is started with.
 */
function panelSectionView(state) {
  const mcp = state && typeof state.mcp === 'boolean' ? state.mcp : null;
  return {
    mcp,
    mcpDescription: mcp === null ? 'reading…'
      : mcp ? "Claude can build things in its panel (it's offered to the CLI as a tool). A change applies when claude-custom next starts this tab's session; one already running keeps what it has."
        : "Claude's panel is not offered to the CLI: it can't build anything there. A change applies when claude-custom next starts this tab's session; one already running keeps what it has.",
  };
}

/**
 * The tray icon's two Style switches (BACKLOG #119 A8; app/tray-settings.js owns them, "start minimised" lives in the tray's
 * own menu). Strict like the window toggles: only a real boolean is known, anything else is null, "reading…".
 */
function traySectionView(state) {
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const trayIcon = bool(state && state.trayIcon);
  const minimiseOnClose = bool(state && state.minimiseOnClose);
  return {
    trayIcon,
    minimiseOnClose,
    trayDescription: trayIcon === null ? 'reading…'
      : trayIcon ? 'An icon in the notification area shows how many sessions need you. Click it to go to the one that has waited longest; right-click for the rest.'
        : 'No tray icon. A toast and the window border still tell you when a session needs you.',
    closeDescription: minimiseOnClose === null ? 'reading…'
      : minimiseOnClose ? (trayIcon === false
        ? 'Closing the window closes it, because this needs the tray icon: with the icon off there would be no way back to a hidden window.'
        : 'Closing the window hides it to the tray; the sessions keep running and the icon brings it back. Quit from the tray menu.')
        : 'Closing the window closes it, as it always did. The sessions keep running.',
  };
}

const SECTION_VIEWS = {
  colours: coloursSectionView,
  background: backgroundSectionView,
  inactive: inactiveSectionView,
  avatars: avatarsSectionView,
  window: windowSectionView,
  tray: traySectionView,
  panel: panelSectionView,
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
    background: { source: null, kind: null, setAt: null, error: null, videoError: null, darkness: null, mode: null, backgroundMode: null },
    inactive: { dim: null },
    avatars: { global: null, imagesEnabled: null, error: null },
    window: { statusInHeader: null, framelessWindow: null },
    tray: { trayIcon: null, minimiseOnClose: null },
    panel: { mcp: null },
  };
}

// Is this announcement the file the panel already holds? Then nothing reloads.
function sameBackground(prev, style) {
  return !!prev && prev.source === 'override' && style.source === 'override'
    && prev.kind === (style.kind === 'video' ? 'video' : 'image') && prev.setAt === (style.setAt || null);
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
      mode: look.mode,
      // What the running CLI was started with. Only a hello says; a style change is not a relaunch, so a
      // message without it keeps what the panel already knew.
      cliTheme: typeof style.cliTheme === 'string' || style.cliTheme === null
        ? style.cliTheme : (state.colours && state.colours.cliTheme),
      error: keep('colours'),
    },
    background: {
      source: style.source || 'generated', kind: style.kind === 'video' ? 'video' : 'image', setAt: style.setAt || null,
      darkness: look.darkness, mode: look.mode, backgroundMode: look.backgroundMode === 'colour' ? 'colour' : null, error: keep('background'),
      // The note is about ONE file: the same file re-announced (a darkness change) is not reloaded, so
      // it stands; a different file, kind or a reset is tried afresh.
      videoError: sameBackground(state.background, style) ? (state.background.videoError || null) : null,
    },
    inactive: state.inactive,
    avatars: state.avatars || emptyStyleState().avatars,
    window: state.window || emptyStyleState().window,
    tray: state.tray || emptyStyleState().tray,           // main's, never the host's: a style message must not lose it
    panel: state.panel || emptyStyleState().panel,       // the host never reports it: a style message must not lose it
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
    // A quiet message is the host's own watcher echoing (or another window's
    // change): it refreshes the picture but says nothing about the user's last
    // action, so it neither sets nor clears the error (Dexter N1, PR #64 r2).
    if (m.quiet === true) return { ...state, avatars: { ...cur, global } };
    const error =m.ok === true ? null : (typeof m.reason === 'string' && m.reason ? m.reason : 'the picture was not changed');
    return { ...state, avatars: { ...cur, global, error } };
  }
  return state;
}

/**
 * The renderer's own finding that the background video can't be played (the
 * <video> `error` event): a quiet note in the Background section, no background,
 * the file left in place. `null` clears it. Only a string lands.
 */
function reduceVideoError(prev, note) {
  const state = prev || emptyStyleState();
  const cur = state.background || emptyStyleState().background;
  if (note !== null && typeof note !== 'string') return state;
  return { ...state, background: { ...cur, videoError: note || null } };
}

/** Records the desired "show agent images" state; anything but a boolean is ignored. */
function reduceImagesEnabled(prev, enabled) {
  const state = prev || emptyStyleState();
  if (typeof enabled !== 'boolean') return state;
  return { ...state, avatars: { ...(state.avatars || emptyStyleState().avatars), imagesEnabled: enabled } };
}

/** Records main's window-chrome settings; only real booleans land, per key. */
function reduceChromeSettings(prev, settings) {
  const state = prev || emptyStyleState();
  if (!settings || typeof settings !== 'object') return state;
  const cur = state.window || emptyStyleState().window;
  const pick = (k) => (typeof settings[k] === 'boolean' ? settings[k] : cur[k]);
  return { ...state, window: { statusInHeader: pick('statusInHeader'), framelessWindow: pick('framelessWindow') } };
}

/** Records main's tray switches; only real booleans land, per key (start-minimised is the tray menu's, not shown here). */
function reduceTraySettings(prev, settings) {
  const state = prev || emptyStyleState();
  if (!settings || typeof settings !== 'object') return state;
  const cur = state.tray || emptyStyleState().tray;
  const pick = (k) => (typeof settings[k] === 'boolean' ? settings[k] : cur[k]);
  return { ...state, tray: { trayIcon: pick('trayIcon'), minimiseOnClose: pick('minimiseOnClose') } };
}

/** Records the panel's MCP switch as main reports it; only a real boolean lands (null = main couldn't tell: stay unknown). */
function reduceCanvasMcp(prev, value) {
  const state = prev || emptyStyleState();
  if (typeof value !== 'boolean') return state;
  return { ...state, panel: { ...(state.panel || emptyStyleState().panel), mcp: value } };
}

// How long to wait before asking main again for the panel switch after a read that gave no answer (PR #125 Miguel M3): 1 s, doubling, at most
// 30 s, and it gives up (null) after CANVAS_MCP_MAX_TRIES asks. Until then the box stays "reading..."; a later change or a reload asks afresh.
const CANVAS_MCP_MAX_TRIES = 8;
function canvasMcpRetryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt + 1 >= CANVAS_MCP_MAX_TRIES) return null;
  return Math.min(1000 * 2 ** attempt, 30000);
}

const API = {
  reduceStyle, emptyStyleState, styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource, backgroundSectionView, toPercent,
  avatarsSectionView, reduceAvatars, reduceImagesEnabled, windowSectionView, reduceChromeSettings, reduceVideoError,
  traySectionView, reduceTraySettings,
  coloursSectionView, panelSectionView, reduceCanvasMcp, canvasMcpRetryDelay, CANVAS_MCP_MAX_TRIES,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else Object.assign(root, API);

})(typeof window !== 'undefined' ? window : globalThis);
