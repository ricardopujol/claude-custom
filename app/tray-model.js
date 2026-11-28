'use strict';
/**
 * The tray icon's rules (BACKLOG #119 A8), pure so they are tested without Electron.
 *
 *   needsYouKeys(tabs)       -> the keys of the tabs whose cue is up (needs input, or finished unseen)
 *   tooltipText({windows, sessions, needs}) -> 'Jiandu · 2 windows · 3 sessions · 1 needs you' (one tray for every window, PR 3)
 *   badgeText(n)             -> '' at 0, the digit to 9, then '9+'
 *   trackCues(prev, ids, now) -> Map cueId -> { root, key, since }: cues are { root, key } pairs
 *   clickTarget(cues, lastUsedRoot) -> { kind: 'tab', root, key } for the oldest cue in any window, else { kind: 'window', root }
 *   windowlessItems(model)   -> the ▾ menu's rows that have no window and are not a tab here
 *   trayTemplate(view, actions) -> the right-click menu's Electron template
 *
 * The cue is the SAME fact the tab dot and the window border use: the tab's own status, which the shell clears the
 * moment the tab is looked at (app/tab-shell.js looked / report). No second signal is added.
 *
 * Main-process only (required, never a page <script>).
 */

// The on-screen name (single-instance PR 3, design §6): the tooltip and Quit say Jiandu. Older strings elsewhere keep their name.
const APP = 'Jiandu';
const SEP = '  ·  ';
// A Windows tooltip is cut at 127 characters; ours is far shorter, but the cap is a property the tests hold.
const MAX_DIGIT = 9;

const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
// Windows menus read `&` as a mnemonic marker; a folder name is not one.
const menuText = s => String(s).replace(/&/g, '&&');

/** Keys of the tabs with a cue up. Strict: only a real `true` counts, and anything that is not a tab is skipped. */
function needsYouKeys(tabs) {
  if (!Array.isArray(tabs)) return [];
  const keys = [];
  for (const t of tabs) {
    const st = t && typeof t === 'object' ? t.status : null;
    if (st && typeof st === 'object' && (st.needsInput === true || st.finished === true)) keys.push(t.key);
  }
  return keys;
}

const plural = (n, one, many, none) => (n === 0 && none ? none : n === 1 ? `1 ${one}` : `${n} ${many}`);
const needsText = n => (n === 1 ? '1 needs you' : `${n} need you`);

/**
 * 'Jiandu · 4 windows · 11 sessions · 2 need you' (single-instance PR 3: one tray for every window). "sessions" is the tabs of every window
 * (not the sessions with no window, which need an OS query: §5 Q4). A count it was not given is left out, never shown as zero.
 */
function tooltipText({ windows, sessions, needs } = {}) {
  const parts = [APP];
  if (isCount(windows)) parts.push(plural(windows, 'window', 'windows', 'no windows'));
  if (isCount(sessions)) parts.push(plural(sessions, 'session', 'sessions', 'no sessions'));
  if (isCount(needs) && needs > 0) parts.push(needsText(needs));
  return parts.join(' · ');
}

/** What is drawn on the badge: nothing at 0 (or for anything that is not a count), the digit up to 9, then 9+. */
function badgeText(n) {
  if (!isCount(n) || n === 0) return '';
  return n > MAX_DIGIT ? `${MAX_DIGIT}+` : String(n);
}

/** A cue's id: its window's root AND its tab key (a `develop` tab exists in every project). */
const cueId = (root, key) => JSON.stringify([String(root), String(key)]);

/** The first time each current cue ({ root, key }) was seen; a cue that cleared is forgotten, so coming back starts it over. */
function trackCues(prev, ids, now) {
  const out = new Map();
  for (const { root, key } of Array.isArray(ids) ? ids : []) {
    const id = cueId(root, key);
    const old = prev && prev.get(id);
    out.set(id, { root, key, since: old ? old.since : now });
  }
  return out;
}

/** Left click: the tab that has waited longest in ANY window, else the window used last. */
function clickTarget(cues, lastUsedRoot = null) {
  let best = null;
  if (cues && typeof cues.values === 'function') {
    for (const c of cues.values()) if (best === null || c.since < best.since) best = c;
  }
  return best ? { kind: 'tab', root: best.root, key: best.key } : { kind: 'window', root: lastUsedRoot === undefined ? null : lastUsedRoot };
}

/** From app/background-menu.js menuModel: sessions with no window of their own, which are not a tab of this window. */
function windowlessItems(model) {
  const items = model && Array.isArray(model.items) ? model.items : [];
  return items.filter(it => it && it.row && it.row.windows === 0 && !(it.open && it.open.kind === 'select-tab'));
}

/** Close hides the window only when something in the tray can bring it back, and never while the app is quitting. */
function hidesOnClose({ settings, trayExists, quitting } = {}) {
  return !!settings && settings.minimiseOnClose === true && trayExists === true && quitting !== true;
}

/** Start hidden only with the tray icon on: a hidden window with no icon would be unreachable. */
function startsHidden(settings) {
  return !!settings && settings.startMinimised === true && settings.trayIcon !== false;
}

const tabsText = n => (n === 1 ? '1 tab' : `${n} tabs`);

/**
 * view: { home, windows: [{ root, label, tabs, needs, waitingKey }], windowless, hidden, startMinimised }
 * actions: { showHome() (with view.home), focusWindow(root, waitingKey), openBackground(open), stopBackground(row), hideAll, showAll, setStartMinimised(on), quit }
 * One row per window in open order (design §6, option A); a disabled "Sessions with no window" head row over those sessions; one Show/Hide
 * row; Start minimised; Quit Jiandu. "Stop that session" goes to stopBackground, the ▾ menu's own Stop: it asks first, every time.
 * PR 4 adds Open project ▸ after the window rows.
 */
function trayTemplate(view, actions) {
  const v = view || {};
  const template = [];
  // Jiandu Home (documentation/DESIGN_PROJECT_HUB.md H3): "Home" above the window rows opens Home, or brings it forward.
  if (v.home === true) {
    template.push({ label: 'Home', click: () => actions.showHome() });
    template.push({ type: 'separator' });
  }
  for (const w of Array.isArray(v.windows) ? v.windows : []) {
    const needs = isCount(w.needs) ? w.needs : 0;
    const tabs = isCount(w.tabs) ? w.tabs : 0;
    // A native menu row can't be bold, so "needs you" is said in words.
    const row = [menuText(w.label || APP), tabsText(tabs), ...(needs > 0 ? [needsText(needs).replace(/^1 /, '')] : [])];
    const waitingKey = typeof w.waitingKey === 'string' ? w.waitingKey : null;
    template.push({ label: row.join(SEP), click: () => actions.focusWindow(w.root, waitingKey) });
  }
  const windowless = Array.isArray(v.windowless) ? v.windowless : [];
  if (windowless.length) {
    template.push({ type: 'separator' });
    template.push({ label: 'Sessions with no window', enabled: false });
    for (const it of windowless) {
      template.push({
        label: menuText(it.label),
        submenu: [
          { label: 'Open', enabled: it.open !== null && it.open !== undefined, click: () => actions.openBackground(it.open) },
          { label: 'Stop that session…', enabled: it.stop === true, click: () => actions.stopBackground(it.row) },
        ],
      });
    }
  }
  template.push({ type: 'separator' });
  template.push(v.hidden === true
    ? { label: 'Show all windows', click: () => actions.showAll() }
    : { label: 'Hide all windows', click: () => actions.hideAll() });
  template.push({
    label: 'Start minimised to tray', type: 'checkbox', checked: v.startMinimised === true,
    click: item => actions.setStartMinimised(!!(item && item.checked)),
  });
  template.push({ type: 'separator' });
  template.push({ label: `Quit ${APP}`, click: () => actions.quit() });
  return template;
}

/** Whether the tray should offer "Show all windows": ANY window is hidden (or there is none to show). `wins` are BrowserWindows (or null). */
function anyWindowHidden(wins) {
  if (!Array.isArray(wins) || wins.length === 0) return true;
  return wins.some((w) => !w || w.isDestroyed() || !w.isVisible());
}

module.exports = { anyWindowHidden, needsYouKeys, tooltipText, badgeText, cueId, trackCues, clickTarget, windowlessItems, trayTemplate, hidesOnClose, startsHidden, MAX_DIGIT, APP };
