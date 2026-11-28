'use strict';
/**
 * The ONE Jiandu Home window of the process (documentation/DESIGN_PROJECT_HUB.md H1, H4, H5; plan documentation/PLAN_PROJECT_HUB.md
 * H-PR2). Electron is handed in, so the rules run under plain node.
 *
 *   show({ hidden })   make it (hidden: Start minimised to tray), or bring the one there is forward: shown, restored, focused
 *   isOpen()           a Home window exists (shown, hidden or minimised): it keeps the process (app/app-lifecycle.js homeOpen)
 *   isVisible()        open, shown and not minimised
 *   isHidden()         open and hidden to the tray (not minimised): the crash record keeps it (PR #263 Miguel G1)
 *   send(payload)      push the page its model ('home:model'); nothing when Home is closed
 *   isSender(wc)       the Home window's own webContents, and nothing else (the IPC gate)
 *
 * Not a project window: the registry never holds it, but Electron's window-all-closed counts it, which gives H5 with no new rule (Home
 * closes; with no window left Jiandu quits). With minimise-on-close (hidesOnClose(), app/tray-model.js) a close hides it to the tray.
 * Its size and place are kept in uiStore under STORE_KEY (saved on every close and hide: the normal bounds and a `maximized` flag;
 * app/home-bounds.js decides whether they are used). Secure by construction: context isolation, no Node, a sandbox, its own preload
 * with two members (app/preload-home.js), every navigation refused and every window open denied (app/nav-guard.js).
 *
 * deps: BrowserWindow, screen, store (uiStore), preload, page, forProbe(opts), hidesOnClose(), onChanged(), onSessionEnd(), log.
 */

const { boundsToUse, boundsToSave, DEFAULT_SIZE, MIN_SIZE } = require('./home-bounds');
const { guardNavigation } = require('./nav-guard');

const STORE_KEY = 'home-window';
const TITLE = 'Jiandu Home';

function createHomeWindow({ BrowserWindow, screen, store, preload, page, forProbe = (o) => o, hidesOnClose = () => false, onChanged = () => {},
  onSessionEnd = () => {}, log = () => {} }) {
  let win = null;
  const alive = () => !!win && !win.isDestroyed();
  const changed = () => { try { onChanged(); } catch (err) { log(`[main] home: onChanged threw: ${err && err.message}`); } };

  function savedBounds() {
    let areas = [];
    try { areas = screen.getAllDisplays().map((d) => d.workArea); } catch { areas = []; }
    let rec = null;
    try { rec = store.read(STORE_KEY, {}); } catch { rec = null; }
    return { bounds: boundsToUse(rec && rec.bounds, areas), maximized: !!rec && rec.maximized === true };
  }

  // A maximised Home keeps its NORMAL bounds and the flag (PR #263 Dexter 5): getBounds() of a maximised window is the screen.
  function saveBounds() {
    if (!alive()) return;
    let maximized = false;
    try { maximized = typeof win.isMaximized === 'function' && win.isMaximized() === true; } catch { maximized = false; }
    const b = boundsToSave(maximized && typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds());
    if (!b) return;
    try { store.update(STORE_KEY, {}, (prev) => ({ ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}), bounds: b, maximized })); }
    catch (err) { log(`[main] home: could not keep its size and place: ${err && err.message}`); }
  }

  function make(hidden) {
    const { bounds: b, maximized } = savedBounds();
    win = new BrowserWindow(forProbe({
      ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height }),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: hidden !== true,
      title: TITLE,
      backgroundColor: '#11131a',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
    }));
    const w = win;
    // Miguel B1 (PR #204's rule for every page with a bridge): Home is loaded once with loadFile and never navigates. A link or a file
    // dropped on it would load that page in this webContents WITH the `home` bridge, so every navigation is refused and no window opens.
    guardNavigation(w.webContents, log);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('close', (e) => {
      saveBounds();
      let hide = false;
      try { hide = hidesOnClose() === true; } catch { hide = false; }
      if (hide) { e.preventDefault(); w.hide(); changed(); }
    });
    w.on('closed', () => { if (win === w) win = null; changed(); });
    for (const ev of ['show', 'hide', 'minimize', 'restore']) w.on(ev, changed);
    // Windows ends the session (log off, shut down): a clean quit, as a project window says it (PR #263 Dexter 2). A Home-only process
    // has no project window to hear it, and a Home hidden to the tray must not stand in the session end's way.
    w.on('session-end', () => { try { onSessionEnd(); } catch (err) { log(`[main] home: session-end threw: ${err && err.message}`); } });
    // maximize() shows a window, so a Home made hidden (Start minimised) maximises at its first show
    if (maximized) { if (hidden === true) w.once('show', () => { if (!w.isDestroyed()) w.maximize(); }); else w.maximize(); }
    w.loadFile(page);
  }

  function show({ hidden = false } = {}) {
    if (!alive()) {
      make(hidden);
    } else if (hidden !== true) {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      win.show();
    }
    if (hidden !== true) win.focus();
    changed();
  }

  function send(payload) {
    if (!alive()) return;
    try { win.webContents.send('home:model', payload); } catch (err) { log(`[main] home: send failed: ${err && err.message}`); }
  }

  return {
    show,
    send,
    isOpen: () => alive(),
    isVisible: () => alive() && win.isVisible() && !(typeof win.isMinimized === 'function' && win.isMinimized()),
    isHidden: () => alive() && !win.isVisible(),
    isSender: (wc) => alive() && !!wc && wc === win.webContents,
    win: () => (alive() ? win : null),
  };
}

module.exports = { createHomeWindow, STORE_KEY, TITLE };
