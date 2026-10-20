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
 * deps: Tray, Menu, nativeImage, renderIcon(text) -> { width, height, bgra }, getSettings(), tabs() -> [{ key, status }],
 *       windowLabel(), isHidden(), background() -> Promise<the ▾ menu's model>, now(), log(...),
 *       actions { focusWindow, selectTab(key), openBackground(open), stopBackground(row), hideAll, showAll,
 *                 setStartMinimised(on), quit }
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
  let counts = { count: 0, sessions: 0 };
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
    const tabs = deps.tabs();
    const keys = needsYouKeys(tabs);
    cues = trackCues(cues, keys, deps.now());
    counts = { count: keys.length, sessions: Array.isArray(tabs) ? tabs.length : 0 };
    if (!tray) return;
    const badge = badgeText(counts.count);
    if (badge !== shown.badge) { shownImage = imageFor(badge); tray.setImage(shownImage); shown.badge = badge; }
    const tip = tooltipText({ sessions: counts.sessions, needs: counts.count });
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
    const target = clickTarget(cues);
    if (target.kind === 'tab') deps.actions.selectTab(target.key);
    deps.actions.focusWindow();
  }

  // The menu's template, built from the live state. Separate from popup() so a probe can read and click it without a real menu.
  async function template() {
    let background = null;
    // The list of sessions with no window reads the OS; a failure leaves the rest of the menu, not no menu.
    try { background = await deps.background(); } catch (err) { log(`[main] tray: could not list background sessions: ${err && err.message}`); }
    if (!tray) return null;
    update();
    const settings = deps.getSettings() || {};
    return trayTemplate({
      windowLabel: deps.windowLabel(), tabs: counts.sessions, needs: counts.count, hidden: deps.isHidden(),
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
      cues: [...cues.keys()], image: imageInfo() };
  }

  /** The nativeImage on the Tray now (a probe saves it as a PNG to look at), or null. */
  const image = () => shownImage;

  return { sync, state, image, click, popup, template, destroy };
}

module.exports = { createTrayController };
