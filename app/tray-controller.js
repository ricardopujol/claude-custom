'use strict';
/**
 * The tray icon's effects (BACKLOG #119 A8), with Electron handed in so they are tested without it. The rules are
 * app/tray-model.js's; the pixels are app/tray-icon.js's. This keeps the one Tray:
 *
 *   sync()      reads the settings and the tabs: makes the Tray (once) or removes it, and brings the image and tooltip up to
 *               date. Cheap when nothing changed, so main calls it on every shell change.
 *   state()     { exists, tooltip, badge, count, sessions } -- what the Tray shows now (the probe reads it).
 *   click()     left click: the tab that has waited longest and the window, else just the window.
 *   popup()     right click: the menu, built at that moment from the live state (template() is the same, unshown).
 *   destroy()   the app is going away.
 *
 * ONE controller for the process (single-instance PR 3): it sums and lists every window. Cues are { root, key } pairs (a develop tab is in
 * every project); a closed window is no longer listed, so its cues are forgotten at the next sync.
 *
 * deps: Tray, Menu, nativeImage, renderIcon(text) -> { width, height, bgra }, getSettings(),
 *       windows() -> [{ root, label, tabs: [{ key, status }] }] (the open windows, in open order), lastUsed() -> root | null,
 *       isHidden(), background() -> Promise<the ▾ menu's model, over every window>, now(), log(...),
 *       actions { focusWindow(root, key|null), openBackground(open), stopBackground(row), hideAll, showAll, setStartMinimised(on), quit }
 *
 * Main-process only (required, never a page <script>).
 */

const {
  needsYouKeys, tooltipText, badgeText, trackCues, clickTarget, windowlessItems, trayTemplate,
} = require('./tray-model');

function createTrayController(deps) {
  const log = deps.log || (() => {});
  let tray = null;
  let destroyed = false;
  let cues = new Map();
  let shown = { badge: null, tooltip: null };
  let shownImage = null;
  let counts = { count: 0, sessions: 0, windows: 0 };
  let rows = [];                        // the windows as the menu shows them: { root, label, tabs, needs, waitingKey }
  const images = new Map();

  function imageFor(text) {
    let img = images.get(text);
    if (!img) {
      const { width, height, bgra } = deps.renderIcon(text);
      // The bitmap is 2x: Windows shows it at 16 logical px, crisp at 200% and scaled down at 100%.
      img = deps.nativeImage.createFromBitmap(bgra, { width, height, scaleFactor: 2 });
      images.set(text, img);
    }
    return img;
  }

  function make() {
    try {
      tray = new deps.Tray(imageFor(''));
    } catch (err) {
      tray = null;
      log(`[main] tray: could not make the tray icon: ${err && err.message}`);
      return;
    }
    shown = { badge: '', tooltip: null };
    shownImage = imageFor('');
    tray.on('click', click);
    tray.on('right-click', () => { popup().catch(e => log(`[main] tray menu failed: ${e && e.message}`)); });
  }

  function remove() {
    if (!tray) return;
    try { tray.destroy(); } catch { /* already gone */ }
    tray = null;
    shown = { badge: null, tooltip: null };
    shownImage = null;
  }

  function update() {
    let wins = [];
    try { wins = deps.windows(); } catch (err) { log(`[main] tray: could not list the windows: ${err && err.message}`); }
    if (!Array.isArray(wins)) wins = [];
    const ids = [];
    for (const w of wins) for (const key of needsYouKeys(w.tabs)) ids.push({ root: w.root, key });
    cues = trackCues(cues, ids, deps.now());
    rows = wins.map((w) => {
      let oldest = null;
      for (const c of cues.values()) if (c.root === w.root && (oldest === null || c.since < oldest.since)) oldest = c;
      return { root: w.root, label: w.label, tabs: Array.isArray(w.tabs) ? w.tabs.length : 0, needs: needsYouKeys(w.tabs).length, waitingKey: oldest ? oldest.key : null };
    });
    counts = { count: ids.length, sessions: rows.reduce((n, r) => n + r.tabs, 0), windows: rows.length };
    if (!tray) return;
    const badge = badgeText(counts.count);
    if (badge !== shown.badge) { shownImage = imageFor(badge); tray.setImage(shownImage); shown.badge = badge; }
    const tip = tooltipText({ windows: counts.windows, sessions: counts.sessions, needs: counts.count });
    if (tip !== shown.tooltip) { tray.setToolTip(tip); shown.tooltip = tip; }
  }

  function sync() {
    if (destroyed) return;
    const settings = deps.getSettings();
    if (settings && settings.trayIcon === false) { remove(); cues = new Map(); return; }
    if (!tray) make();
    update();
  }

  function click() {
    const target = clickTarget(cues, deps.lastUsed());
    if (target.kind === 'tab') deps.actions.focusWindow(target.root, target.key);
    else if (target.root !== null) deps.actions.focusWindow(target.root, null);
    else if (hasHome()) deps.actions.showHome();          // Jiandu Home: no project window to go to, so Home
  }
  const hasHome = () => typeof deps.actions.showHome === 'function';

  // The menu's template, built from the live state. Separate from popup() so a probe can read and click it without a real menu.
  async function template() {
    let background = null;
    // The list of sessions with no window reads the OS; a failure leaves the rest of the menu, not no menu.
    try { background = await deps.background(); } catch (err) { log(`[main] tray: could not list background sessions: ${err && err.message}`); }
    if (!tray) return null;
    update();
    const settings = deps.getSettings() || {};
    return trayTemplate({
      home: hasHome(), windows: rows, hidden: deps.isHidden(),
      startMinimised: settings.startMinimised === true, windowless: windowlessItems(background),
    }, deps.actions);
  }

  async function popup() {
    const t = await template();
    if (t && tray) tray.popUpContextMenu(deps.Menu.buildFromTemplate(t));
  }

  function destroy() { destroyed = true; remove(); }

  // What the Tray shows, for a probe: the image's size and a digest of its pixels (a Tray can't be screenshotted), or null.
  function imageInfo() {
    try {
      if (!shownImage || typeof shownImage.toBitmap !== 'function') return null;
      const size = typeof shownImage.getSize === 'function' ? shownImage.getSize() : null;
      return { size, sha1: require('crypto').createHash('sha1').update(shownImage.toBitmap()).digest('hex') };
    } catch { return null; }
  }

  function state() {
    return { exists: tray !== null, tooltip: shown.tooltip, badge: shown.badge, count: counts.count, sessions: counts.sessions,
      windows: counts.windows, rows: rows.map((r) => ({ ...r })), cues: [...cues.values()].map(({ root, key }) => ({ root, key })), image: imageInfo() };
  }

  /** The nativeImage on the Tray now (a probe saves it as a PNG to look at), or null. */
  const image = () => shownImage;

  return { sync, state, image, click, popup, template, destroy };
}

module.exports = { createTrayController };
