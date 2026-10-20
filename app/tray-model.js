'use strict';
/**
 * The tray icon's rules (BACKLOG #119 A8), pure so they are tested without Electron.
 *
 *   needsYouKeys(tabs)       -> the keys of the tabs whose cue is up (needs input, or finished unseen)
 *   tooltipText({sessions, needs}) -> 'claude-custom · 3 sessions · 1 needs you'
 *   badgeText(n)             -> '' at 0, the digit to 9, then '9+'
 *   trackCues(prev, keys, now) -> Map key -> when that cue first appeared
 *   clickTarget(cues)        -> { kind: 'tab', key } for the oldest cue, else { kind: 'window' }
 *   windowlessItems(model)   -> the ▾ menu's rows that have no window and are not a tab here
 *   trayTemplate(view, actions) -> the right-click menu's Electron template
 *
 * The cue is the SAME fact the tab dot and the window border use: the tab's own status, which the shell clears the
 * moment the tab is looked at (app/tab-shell.js looked / report). No second signal is added.
 *
 * Main-process only (required, never a page <script>).
 */

const APP = 'claude-custom';
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

const sessionsText = n => (n === 0 ? 'no sessions' : n === 1 ? '1 session' : `${n} sessions`);
const needsText = n => (n === 1 ? '1 needs you' : `${n} need you`);

/** A count it was not given is left out, never shown as zero. */
function tooltipText({ sessions, needs } = {}) {
  const parts = [APP];
  if (isCount(sessions)) parts.push(sessionsText(sessions));
  if (isCount(needs) && needs > 0) parts.push(needsText(needs));
  return parts.join(' · ');
}

/** What is drawn on the badge: nothing at 0 (or for anything that is not a count), the digit up to 9, then 9+. */
function badgeText(n) {
  if (!isCount(n) || n === 0) return '';
  return n > MAX_DIGIT ? `${MAX_DIGIT}+` : String(n);
}

/** The first time each current cue was seen; a cue that cleared is forgotten, so coming back starts it over. */
function trackCues(prev, keys, now) {
  const out = new Map();
  for (const k of keys) out.set(k, prev && prev.has(k) ? prev.get(k) : now);
  return out;
}

/** Left click: the tab that has waited longest, else the window as it was. */
function clickTarget(cues) {
  let best = null;
  if (cues && typeof cues.entries === 'function') {
    for (const [key, since] of cues.entries()) if (best === null || since < best.since) best = { key, since };
  }
  return best ? { kind: 'tab', key: best.key } : { kind: 'window' };
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
 * view: { windowLabel, tabs, needs, hidden, startMinimised, windowless }
 * actions: { focusWindow, openBackground(open), stopBackground(row), hideAll, showAll, setStartMinimised(on), quit }
 * "Stop that session" goes to stopBackground, which is the ▾ menu's own Stop: it asks first, every time.
 */
function trayTemplate(view, actions) {
  const v = view || {};
  const needs = isCount(v.needs) ? v.needs : 0;
  const tabs = isCount(v.tabs) ? v.tabs : 0;
  // A native menu row can't be bold, so "needs you" is said in words.
  const windowRow = [menuText(v.windowLabel || APP), tabsText(tabs), ...(needs > 0 ? [needsText(needs).replace(/^1 /, '')] : [])];
  const template = [{ label: windowRow.join(SEP), click: () => actions.focusWindow() }];
  const windowless = Array.isArray(v.windowless) ? v.windowless : [];
  if (windowless.length) {
    template.push({ type: 'separator' });
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

module.exports = { needsYouKeys, tooltipText, badgeText, trackCues, clickTarget, windowlessItems, trayTemplate, hidesOnClose, startsHidden, MAX_DIGIT, APP };
