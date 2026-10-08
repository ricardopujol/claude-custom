'use strict';
/**
 * claude-custom :: Electron main  -- the tab shell (PR 2, worktree tabs)
 *
 * One window per PROJECT, one tab per git worktree. The window's own page is
 * the tab strip (app/tab-strip.html); each STARTED tab is a WebContentsView
 * showing today's renderer.html against that tab's own detached host.
 *
 * Deliberately thin. The decisions -- which worktrees are tabs
 * (host/tab-lifecycle.js), what the strip draws (app/tab-model.js), which port
 * a starting tab gets, what a poll observes, who a message came from
 * (app/tab-shell.js) -- are pure and tested. This file only builds the effects
 * they are handed: sockets, child processes, views, menus, dialogs.
 *
 * MODES
 *   tabs    CLAUDE_CUSTOM_CWD is inside a container project (`<root>\dev` +
 *           sibling worktrees) and CLAUDE_CUSTOM_PORT is unset.
 *   single  everything else: a flat repo, a folder in no project, or ANY launch
 *           that names its port. One tab on that folder, no close, no poller --
 *           exactly what a window was before tabs, so every verify/ probe that
 *           launches one host on one folder by port keeps working unchanged.
 */

const { app, BrowserWindow, WebContentsView, Menu, Notification, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell, powerMonitor } = require('electron');
const { createVault } = require('./secret-vault');
const { createSecretService } = require('./secret-service');
const { registerClipboardHandlers } = require('./clipboard-bridge');
const { registerFavouriteHandlers } = require('./favourites-bridge');
const { registerAvatarHandlers, watchImagesEnabled, AVATAR_KEY } = require('./avatar-bridge');
const { registerLayoutHandlers, watchLayout, LAYOUT_KEY, TREE_NAMES, PRESET_NAMES } = require('./layout-bridge');
const { readChromeSettings, ensureStatusDefault, registerChromeHandlers, watchChromeSettings, viewTop, CHROME_KEY } = require('./window-chrome-bridge');
const { registerPlaybackHandlers } = require('./playback-bridge');
const { createShell, handleProbeCommand, probeLineReader, shortcutFor, shortcutWillAct, focusStep, menuText, NO_PORT_ERROR } = require('./tab-shell');
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { projectLabel } = require('../host/project-path');

const { resolvePort } = require('../host/port-for-project');
const { decideAttach } = require('../host/handshake');
const { readIdentity, readTokenFile } = require('../host/host-identity');
const { readLook, lookDirState, ensureLookDir } = require('../host/style');
// Worktree occupancy (backlog #44 + #47): which worktree each agent is working in, from the claim files the
// launching hosts write. This window only READS them; host/occupancy-service.js is where "live" is decided.
const { createOccupancyService } = require('../host/occupancy-service');
const { occupancyDir, createClaimWriter } = require('../host/occupancy-store');
const { startTimes, createSelfStartTime } = require('../host/proc-start');
// ...and it PRODUCES the ones no host can: claims read off the subagent transcripts, for sessions that no
// host of this build runs (a plain terminal, an older build). host/occupancy-transcripts.js.
const { createTranscriptScanner } = require('../host/occupancy-transcripts');
const { createRootsProvider } = require('../host/worktree-roots');
const { defaultProjectsDir } = require('../host/session-model');
const { readOpenPrs, parseOpenPrs, openPrFor } = require('../host/open-prs');
const { readSeams, fixtureReader } = require('../host/probe-seams');
const tabMarks = require('./tab-marks');
const { marksFileFor, loadMarks, saveMarks } = require('../host/tab-marks-store');
const { sanitizeDim } = require('../host/look');
const { createStore } = require('../host/store');
const { hostEnv } = require('../host/tab-env');
const { sendControl } = require('../host/host-client');
const { probePort } = require('../host/port-probe');
const { createOps, scriptsDir } = require('../host/worktree-ops');
const { readMergedMarker } = require('../host/merged-marker');
const { externalUrl } = require('./external-link');
const { createStripAccent } = require('./strip-accent');
const fileLink = require('./file-link');
const { createRepoActions } = require('./repo-actions');
// What app/file-link.js may ask the disk (#37): reads, nothing else. lstat and
// readlink come first, so a symlink to a share is refused before stat follows it.
const fileFs = { lstat: (p) => fs.promises.lstat(p), readlink: (p) => fs.promises.readlink(p),
  stat: (p) => fs.promises.stat(p), realpath: (p) => fs.promises.realpath(p) };
const { projectOf, stateRoot, samePath } = require('../host/project-layout');
// The repo browser's two main-only actions (#45): Show in Explorer, and the drag-out. Both re-run the path
// guard against the asking tab's own worktree, and neither ever opens or runs a file (app/repo-actions.js).
// The drag icon is a small accent-coloured square: startDrag wants a non-empty image, and a real file icon
// would cost an async lookup that must finish before the pointer moves on.
let repoDragIcon = null;
const repoActions = createRepoActions({
  shell,
  icon: () => {
    if (!repoDragIcon) {
      const size = 32;
      const px = Buffer.alloc(size * size * 4);
      for (let i = 0; i < px.length; i += 4) { px[i] = 0x4a; px[i + 1] = 0x8c; px[i + 2] = 0xd0; px[i + 3] = 0xcc; }   // BGRA
      repoDragIcon = nativeImage.createFromBitmap(px, { width: size, height: size });
    }
    return repoDragIcon;
  },
});
const { listBackgroundHosts, installsBeside, identitiesIn } = require('../host/background-hosts');
// The Resources panel (#63): one sampler in this process, its policy and payloads in app/resources-service.js.
const { createSampler, createExec: createPowerShellExec } = require('../host/resource-sampler');
const { killVerified } = require('../host/resource-kill');
const pidLedger = require('../host/pid-ledger');
const { killProvenAsync } = require('../host/kill-tree');
const { createSeams: createLeftoverSeams } = require('../host/leftovers-seams');
const { createResourcesService, parseWarnAt } = require('./resources-service');
const { createChipStore, watchChip, KEY: CHIP_KEY } = require('../host/chip-store');
const { stopHost } = require('../host/stop-holder');
const { listDeps, hostStopDeps } = require('../host/stop-deps');
const { attachEnv, attachOnlyDecision } = require('../host/launch-target');
const { menuModel } = require('./background-menu');
const { menuTemplate, createBackgroundActions, popupUntilClosed, stopAllDetail } = require('./background-actions');
// The indexing assistant (#66): a field in the strip; Enter appends the note verbatim to the selected project's backlog
// `## Inbox` (no model). The service is host/indexing-service.js; main's half (channels, the toast and list views over
// the tabs) is app/indexing-bridge.js.
const { createIndexingService } = require('../host/indexing-service');
const { createJournal } = require('../host/indexing-journal');
const indexWriter = require('../host/indexing-writer');
const { projectChoices, readRecentsOffThread } = require('../host/indexing-projects');
const { createIndexingBridge } = require('./indexing-bridge');

// Install-wide UI state that belongs to no one project: today only how dark an
// unfocused window gets. The same .harness/state the host's store uses, under
// its own key, so neither side can clobber the other's file.
const uiStore = createStore({ dir: path.join(__dirname, '..', '.harness', 'state') });
const UI_KEY = 'look-global';
const resourceChip = createChipStore(uiStore);
const readDim = () => sanitizeDim((uiStore.read(UI_KEY, {}) || {}).unfocusedDim);

// An explicit CLAUDE_CUSTOM_PORT is honoured exactly and never stepped: someone
// who names a port means that port, and quietly moving them to another one would
// be the same class of silent substitution this whole change removes.
// PARSED STRICTLY. Dexter F10: `Number(x) || null` turns CLAUDE_CUSTOM_PORT=7742x
// into NaN into null, and the port is then DERIVED with no message -- which is
// the silent substitution the comment above says this whole change removes.
// `=0` was swallowed the same way and `=0x1e1a` was accepted as 7706.
function explicitPort() {
  const raw = process.env.CLAUDE_CUSTOM_PORT;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[main] CLAUDE_CUSTOM_PORT is not a port: ${JSON.stringify(raw)}`);
    console.error('[main] refusing to guess -- unset it to derive the port from the project');
    return { bad: raw };
  }
  return n;
}
const EXPLICIT_PORT = explicitPort();

// --- what this window is ----------------------------------------------------------
const LAUNCH_CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();
const PROJECT = projectOf(LAUNCH_CWD);
const MODE = (PROJECT && PROJECT.kind === 'container' && EXPLICIT_PORT === null) ? 'tabs' : 'single';
// What hostEnv hands each host as its project. A folder in no project is its
// own root and state, as the host would work out for itself.
const HOST_PROJECT = PROJECT || { kind: 'none', root: LAUNCH_CWD, dev: LAUNCH_CWD };
const PROJECT_ROOT = HOST_PROJECT.root;
const STATE_ROOT = stateRoot(HOST_PROJECT);
// The name on the window and on every tab's header: the same source the host
// labels itself from (its PROJECT_ROOT).
const WINDOW_LABEL = projectLabel(PROJECT_ROOT);
const STRIP_HEIGHT = 34;
const POLL_MS = 3000;
const PROBE_PORT = Number(process.env.CLAUDE_CUSTOM_TABS_PROBE) || 0;
// The probe's secret; every driver command must carry it (Miguel, PR #75 M4).
// handleProbeCommand refuses everything when it's missing or short.
const PROBE_TOKEN = process.env.CLAUDE_CUSTOM_TABS_PROBE_TOKEN || null;
const PROBE_LINE_MAX = 64 * 1024;

// A window another window covers is "occluded", and Chromium then stops
// painting it: capturePage answers an EMPTY image. That is the intermittent
// empty capture the screenshot path retries around (measured 2026-09-30: the
// tab probe failed 1 run in 7 with "capturePage returned an empty image 4
// times" for the strip AND the view, both at once). Only the headless paths
// switch occlusion tracking off, so a person's window is unchanged.
if (process.env.CLAUDE_CUSTOM_SCREENSHOT || PROBE_PORT) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// `hosts/<port>.token`, and nothing else: written only by the host that won
// that port's bind (PR #75 F2), so it names whoever is listening. Null when it
// can't be read.
function tokenFileFor(port) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.harness', 'hosts', `${port}.token`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// The token of the host on THIS port, preferred over the shared file, which is
// last-writer-wins once a second project is open. Falling back to the shared
// one keeps a host started before this change reattachable -- in a single-tab
// window only. In tabs mode the shared file is whichever of N hosts started
// last, so a fallback there hands a tab another host's token (Dexter, PR #75
// F5): the per-port file or nothing. Null when none can be read: a tab then
// says so instead of connecting with a guess.
function tokenForRunningHost(port) {
  const own = tokenFileFor(port);
  if (own || MODE === 'tabs') return own;
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.harness', 'session-token'), 'utf8').trim();
  } catch { /* fall through to the environment */ }
  return process.env.CLAUDE_CUSTOM_TOKEN || null;
}

// One probe for every "is anyone there?" question. The tab shell's poll needs
// its three answers (a refusal is "the session ended"; a timeout is not); the
// port walk only needs to know whether something answered.
async function isHostListening(port) {
  return (await probePort(port)) === 'listening';
}

const HARNESS_DIR = path.join(__dirname, '..', '.harness');

/**
 * Who, if anyone, is on this port?
 *
 *   null   nothing is listening
 *   {cwd}  our host, and it says which project it serves
 *   {}     something IS listening and could not be identified
 *
 * The third case is the one that matters and the reason the socket is probed at
 * all rather than trusting the identity file alone: a file can be stale while a
 * stranger holds the port, and "listening but unidentified" must stay
 * distinguishable from "free".
 */
async function occupantAt(port) {
  if (!(await isHostListening(port))) return null;
  return readIdentity({ dir: HARNESS_DIR, port }) || {};
}

// Set when an attach-only window (Open from ▾) was refused: the window says
// why and ends, instead of starting a session nobody asked for.
let attachOnlyRefusal = null;
function attachOnlyText(d) {
  if (d.reason === 'ended') return "That session has ended, so there's nothing to open.";
  if (d.reason === 'other-project') return 'That port now serves another folder, so nothing was opened.';
  return "That session couldn't be identified, so nothing was opened.";
}

// Returns { port, action } or null when the user named a port we must not take.
// Per TAB: each tab's folder hashes to its own port.
async function chooseHostPort(tab) {
  if (EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) return null;   // named and refused above
  if (EXPLICIT_PORT) {
    // Opened from the ▾ menu: attach to that host or refuse, never spawn one.
    const decision = attachOnlyDecision(decideAttach({
      requestedCwd: tab.cwd,
      occupant: await occupantAt(EXPLICIT_PORT),
    }), process.env);
    if (decision.attachOnly) attachOnlyRefusal = decision;
    if (decision.action === 'refuse') {
      console.error(`[main] refusing port ${EXPLICIT_PORT}: ${decision.reason}` +
        (decision.occupiedBy ? ` (serving ${decision.occupiedBy})` : ''));
      console.error('[main] unset CLAUDE_CUSTOM_PORT to let the port be derived from the project');
      return null;
    }
    return { port: EXPLICIT_PORT, action: decision.action };
  }
  return resolvePort({ cwd: tab.cwd, occupantAt });
}

function spawnHost(tab, port, token) {
  const hostPath = path.join(__dirname, '..', 'host', 'host.js');
  // detached:true is the point — the host must outlive this window so a session
  // driven from Remote Control survives the GUI being closed.
  // Log to a FILE, not to pipes. Pipes belong to this Electron process, so
  // when the window closes they close with it -- and the next time the detached
  // host writes to stdout it takes EPIPE and dies. The host logs on every hook
  // event, so "detached" sessions were dying almost immediately, which is
  // exactly the detach property this spawn exists to provide.
  const logPath = path.join(__dirname, '..', '.harness', 'host.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  const logFd = fs.openSync(logPath, 'a');

  // hostEnv drops the inherited per-tab keys and sets this tab's own, so one
  // tab's token or port can never reach another's host. It passes everything
  // else through, which is how CLAUDE_CUSTOM_BIN reaches a probe's host.
  const child = spawn(process.execPath, [hostPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: hostEnv(process.env, { cwd: tab.cwd, port, token, project: HOST_PROJECT }),
  });
  console.log('[main] host log:', logPath);
  child.unref();
  try { fs.closeSync(logFd); } catch { /* the child has its own copy */ }
  return child;
}

async function waitForHost(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostListening(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// `git worktree list --porcelain` from dev. LC_ALL=C: git translates the lock
// reason "initializing", and a localized git would make a half-created worktree
// openable (Dexter R2 N5). Rejects on any failure: that is "no observation".
function listWorktrees() {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', HOST_PROJECT.dev, 'worktree', 'list', '--porcelain'], {
      env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// --- tab marks (#40, DESIGN_TAB_MARKS.md) -------------------------------------------
// The file is re-read before every menu, every save and every poll, so a mark
// set in another window of this project shows here by the next poll. Two
// windows saving in the same instant can lose one of the two marks (read,
// set, write, with no lock): accepted for a purely visual mark (Miguel #87 G1).
let marks = { state: 'missing', store: tabMarks.emptyMarks() };

function reloadMarks() {
  marks = loadMarks(marksFileFor(STATE_ROOT));
  return marks;
}

/**
 * Set (or, with null, clear) a branch's mark; true when it was saved. Never
 * writes over a file it couldn't read.
 */
function chooseMark(branch, id) {
  const cur = reloadMarks();
  if (cur.store === null) return false;
  let saved = false;
  try {
    const next = tabMarks.setMark(cur.store, branch, id);
    saveMarks(STATE_ROOT, next);
    marks = { state: 'ok', store: next };
    saved = true;
  } catch (err) {
    console.error('[marks] could not save:', err && err.message);
  }
  if (tabShell) tabShell.refresh();
  return saved;
}

// Marks on branches that no longer exist go (/merged --sweep deleted them).
// A git that fails, or answers nothing, prunes nothing.
function pruneGoneMarks() {
  execFile('git', ['-C', HOST_PROJECT.dev, 'for-each-ref', '--format=%(refname)', 'refs/heads'], {
    timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  }, (err, stdout) => {
    if (err) return;
    const live = tabMarks.liveBranchesFrom(String(stdout));
    const cur = reloadMarks();
    if (live === null || cur.state !== 'ok') return;
    const next = tabMarks.pruneMarks(cur.store, live);
    if (tabMarks.markCount(next) === tabMarks.markCount(cur.store)) return;
    try {
      saveMarks(STATE_ROOT, next);
      marks = { state: 'ok', store: next };
    } catch (err2) {
      console.error('[marks] could not prune:', err2 && err2.message);
    }
    if (tabShell) tabShell.refresh();
  });
}

/** The tab's **Mark ▸** submenu, built from the file as it is now. */
function markSubmenu(branch) {
  const cur = reloadMarks();
  const m = tabMarks.markMenuModel(cur.store, branch, cur.state);
  return {
    label: m.enabled ? 'Mark' : `Mark (${m.why})`,
    enabled: m.enabled,
    submenu: [
      // Checkboxes, not a radio group: Electron ticks a radio group's first item
      // when none is, so an unmarked tab would show "Review this code" ticked (Dexter #87 F2).
      ...m.rows.map(r => ({ label: r.label, type: 'checkbox', checked: r.checked, click: () => chooseMark(branch, r.choose) })),
      { type: 'separator' },
      { label: 'Clear mark', enabled: m.canClear, click: () => chooseMark(branch, null) },
    ],
  };
}

let win = null;
let tabShell = null;
let resHistoryView = null;         // the view the Resources service last re-sent the history to (#63 follow-up)
let resources = null;              // the Resources panel's service (#63), built once the shell exists
let resourceSampler = null;
let occupancyService = null;       // worktree occupancy (#44 + #47): the live claims, read from the claim folder
let transcriptOccupancy = null;    // ...and the fallback producer: claims read off the subagent transcripts
const liveViews = new Set();          // every WebContentsView that currently shows a tab

const fromStrip = (event) => !!win && !win.isDestroyed() && !!event && event.sender === win.webContents;
const isTabView = (sender) => !!tabShell && tabShell.isTabView(sender);
const forEachView = (fn) => { for (const v of liveViews) { if (!v.webContents.isDestroyed()) fn(v); } };

// Focus mode (layout pass L1, #1): only the terminal shows. Per window and not
// saved. The tab view covers the strip, and every view hides its own header
// and zones when told.
let focusMode = false;
// The indexing assistant (#66): main's half (startIndexing), and whether its field has the keyboard (a publish must not
// take it, as for the branch form).
let indexing = null;
let indexFieldFocused = false;
// Layout pass L2 (#28): this window's frame, fixed at creation. A frameless
// window keeps its strip in focus mode: it's the only title bar (Dexter L2 #3).
let windowFrameless = false;

function layoutView(view) {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const top = viewTop({ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT });
  view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function setFocusMode(on) {
  focusMode = !!on;
  forEachView(layoutView);
  if (indexing) indexing.relayout();
  forEachView((v) => v.webContents.send('focus-mode', focusMode));
}

// The window's state that every tab view shows: focus (dim) and the
// finished-task cue. Kept HERE, not only in the pages: `webContents.send`
// before a page has registered its listener is dropped on the floor, and a
// reload while the cue is up would clear it for good.
let cueOn = false;
let focused = false;

function createWindow() {
  // Layout pass L2 (#28): read once, for THIS window -- a frame can't change on
  // an open window, so a later toggle applies to the next one.
  ensureStatusDefault(uiStore);   // #67: write the default the relay reads, before anything asks
  const chrome = readChromeSettings(uiStore);
  windowFrameless = chrome.framelessWindow === true;
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Frameless: no OS title bar; the strip drags the window and draws its own
    // minimise and close (app/tab-strip.js windowChrome). The title still
    // feeds alt-tab and the taskbar.
    frame: !chrome.framelessWindow,
    // Room for the terminal's minimum and two side zones (app/dock-layout.js S7).
    minWidth: 640,
    minHeight: 480,
    // The project's own app colour when it has one, so a window does not
    // flash the default blue before the page paints its look.
    backgroundColor: readLook(STATE_ROOT).appColor || '#11131a',
    title: WINDOW_LABEL,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-strip.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'tab-strip.html'), { query: chrome.framelessWindow ? { frameless: '1' } : {} });
  registerShortcuts(win.webContents);

  // FOCUS IS TRACKED, NOT ASKED FOR. Naomi, PR #33, measured in a real window:
  // `win.isFocused()` returns TRUE while the window is minimized, so the cue
  // and the taskbar flash were both skipped and nothing logged -- a dropped
  // cue is indistinguishable from no task having finished. 2 of 13 trials,
  // and it still failed 5 seconds after minimizing, so it is not a race that
  // settles.
  //
  // The EVENTS fired reliably in every one of her runs; it is the
  // point-in-time query that lies. So the events are the source of truth.
  focused = win.isFocused();
  // The pages darken themselves while unfocused, so the window you are typing
  // into is the one that is not dimmed. The dim level is read FRESH on every
  // send: it is install-wide, so a slider moved in another project's window
  // takes effect here the next time this one loses focus, with no watcher.
  const focusPayload = () => ({ focused, dim: readDim() });
  const sendFocus = () => {
    if (win.isDestroyed()) return;
    const payload = focusPayload();
    forEachView((v) => v.webContents.send('window-focus', payload));
  };
  const focusSelected = () => {
    if (indexFieldFocused) return;          // #66: coming back to the window keeps a half-typed note's keyboard
    const sel = selectedView();
    if (sel && !sel.webContents.isDestroyed()) { sel.webContents.focus(); lastFocusedView = sel; }
  };
  win.on('focus', () => {
    focused = true;
    sendFocus();
    win.flashFrame(false);
    setCue(false);            // looked at: the cue has done its job
    tabShell.looked();        // ...and so has the selected tab's pulse (#31)
    focusSelected();
  });
  win.on('blur', () => { focused = false; sendFocus(); });
  win.on('minimize', () => { focused = false; if (resources) resources.setMinimised(true); });
  win.on('restore', () => { focused = win.isFocused(); sendFocus(); if (resources) resources.setMinimised(false); });
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => { forEachView(layoutView); if (indexing) indexing.relayout(); });
  }
  // FF3: the page sets its own <title>, and a page title WINS over the one
  // given to BrowserWindow. Without this the window silently reverts to
  // whatever tab-strip.html says the moment it loads.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(WINDOW_LABEL);
  });
  // The strip is sent its model as it changes; a (re)load asks for the last one.
  win.webContents.on('did-finish-load', () => {
    if (lastStripPayload) win.webContents.send('strip-model', lastStripPayload);
    win.webContents.send('strip-accent', lastStripAccent);
    if (indexing) indexing.push(true);
  });
  // A click on the strip takes the keyboard from the view (Dexter, PR #75 R2-4),
  // so the next selection -- even of the same tab -- focuses its view again.
  win.webContents.on('focus', () => { lastFocusedView = null; });
  win.on('closed', () => { win = null; if (tabShell) tabShell.destroy(); });
  return win;
}

// Attention raised from main, not from the page. The renderer's own
// Notification is subject to page permission and can neither flash the
// taskbar nor focus the window when clicked; this can do all three.
// FF4: a cue that survives until the window is LOOKED AT. The taskbar flash
// stops at the OS's discretion and is invisible in alt-tab, which shows a title
// and a thumbnail and nothing else. A border is part of the thumbnail, so it is
// legible exactly where you decide which window to return to.
//
// DECLARED ABOVE ITS CALLER. Miguel, PR #33, A7: it used to sit 23 lines
// below the handler that calls it, safe only because that handler runs
// asynchronously -- one synchronous call away from a TDZ ReferenceError.
//
// The state is kept here, not only in the pages. A5: `webContents.send`
// before the renderer has registered its listener is dropped on the floor,
// and a reload while the cue is up would clear it permanently -- a cue that
// silently stops meaning anything is worse than no cue, because the next
// real one says nothing either.
function setCue(on) {
  cueOn = !!on;
  forEachView((v) => v.webContents.send('attention-cue', cueOn));
}

function selectedView() {
  if (!tabShell) return null;
  const sel = tabShell.snapshot().selectedKey;
  const tab = sel ? tabShell.tabByKey(sel) : null;
  return tab && tab.view ? tab.view : null;
}

// --- the tab views ---------------------------------------------------------------

// The ONE way a link leaves the app (fix/terminal-links): only what
// app/external-link.js accepts (http/https, no credentials) reaches
// shell.openExternal; everything else -- above all the `about:blank` of a
// blank window.open, which Windows has no app for -- is logged and dropped.
// What was opened is logged too, so a link that misled is traceable.
function openInBrowser(url, from) {
  const target = externalUrl(url);
  if (!target) {
    console.log(`[main] ${from}: not opening ${String(url).slice(0, 200)} (not an http(s) link)`);
    return false;
  }
  console.log(`[main] ${from}: opening ${target.slice(0, 200)} in the default browser`);
  shell.openExternal(target).catch((err) => console.error('[main] openExternal failed:', err && err.message));
  return true;
}

function createTabView(tab) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.contentView.addChildView(view);
  if (indexing) indexing.raise();    // #66: the toast and the list stay over every tab view
  layoutView(view);
  view.setVisible(false);       // shown by applySelection once it is the selected tab
  liveViews.add(view);

  const wc = view.webContents;
  registerShortcuts(wc);
  wc.on('did-finish-load', () => {
    if (wc.isDestroyed()) return;
    wc.send('window-focus', { focused, dim: readDim() });
    if (cueOn) wc.send('attention-cue', true);
    if (focusMode) wc.send('focus-mode', true);
  });
  wc.on('render-process-gone', (_e, d) => console.error(`[main] ${tab.key}: renderer gone:`, d.reason));
  wc.on('did-fail-load', (_e, code, desc) => console.error(`[main] ${tab.key}: load failed:`, code, desc));
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT || PROBE_PORT) {
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['verbose', 'info', 'warn', 'error'][level] || level;
      console.log(`[renderer:${tag}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
    });
  }
  // Any external link opens in the real browser, never in-app -- and only an
  // http(s) one. A blank window.open() arrives here as `about:blank`, which
  // Windows has no app for (fix/terminal-links): that is dropped, not opened.
  wc.setWindowOpenHandler(({ url }) => {
    openInBrowser(url, tab.key);
    return { action: 'deny' };
  });

  wc.loadFile(path.join(__dirname, 'renderer.html'), {
    query: { port: String(tab.port), cwd: tab.cwd,
             // FF21: the header's project name, painted before the host even
             // answers -- same source of truth as the OS window title above.
             project: WINDOW_LABEL,
             // The token the host will demand: this tab's own.
             token: tab.token,
             tab: process.env.CLAUDE_CUSTOM_SIDE_TAB || '',
             demosecret: process.env.CLAUDE_CUSTOM_DEMO_SECRET || '',
             flourish: process.env.CLAUDE_CUSTOM_FLOURISH || '',
             probe: PROBE_PORT ? '1' : '',
             // Which close button the blocked pane offers: tab | dev | single.
             tabmode: tabShell.tabmodeOf(tab) },
  });
  return view;
}

function destroyTabView(tab) {
  const view = tab.view;
  if (!view) return;
  liveViews.delete(view);
  try { win.contentView.removeChildView(view); } catch { /* the window is going away */ }
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
}

// --- pushing the model out: strip, visibility, menu ------------------------------

let lastStripPayload = null;
let lastFocusedView = null;   // the tab view that last received keyboard focus
let stripWasBusy = false;     // the branch form was open at the last publish

// The accent each tab's page reported (#64). The strip is the window's own page, so it only
// hears the SELECTED tab's: the colour the person chose follows the tab they are looking at.
// A selected tab that hasn't reported yet shows null (the strip's default), never the previous
// tab's colour (app/strip-accent.js). lastStripAccent is only what a reloaded strip page is told.
const stripAccent = createStripAccent();
let lastStripAccent = null;
function pushStripAccent() {
  if (!win || win.isDestroyed()) return;
  const sel = selectedView();
  lastStripAccent = sel && !sel.webContents.isDestroyed() ? stripAccent.show(sel.webContents) : null;
  win.webContents.send('strip-accent', lastStripAccent);
  if (indexing) indexing.setAccent(lastStripAccent);
}

function applySelection(snapshot) {
  for (const tab of snapshot.tabs) {
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.setVisible(tab.key === snapshot.selectedKey);
  }
  // Keyed on the VIEW, not on a changed selection: a view created for the
  // already-selected tab has never had the keyboard (Dexter F4 / Miguel M1),
  // and a selection with no view leaves nothing holding it (Dexter R2-4).
  const sel = selectedView();
  const live = sel && !sel.webContents.isDestroyed() ? sel : null;
  // PR 3: the branch form is in the strip page. It takes the keyboard when it
  // opens (and again when a creation fails), and keeps it while it takes
  // typing -- not while Contract A runs, so Ctrl+Tab meanwhile reaches a view
  // (PR #80 Dexter F7).
  // #66: the same holds for the indexing field while it has the keyboard.
  const stripBusy = (!!snapshot.create && snapshot.create.phase !== 'running') || indexFieldFocused;
  if (stripBusy && !stripWasBusy && win && !win.isDestroyed()) win.webContents.focus();
  stripWasBusy = stripBusy;
  const step = focusStep(lastFocusedView, { windowFocused: focused, selectedView: live, stripBusy });
  if (step.focus) live.webContents.focus();
  lastFocusedView = step.lastFocused;
  pushStripAccent();
  // The Resources panel runs its process-tree sample only for the SELECTED tab's page (#63).
  if (resources) resources.refresh();
  // Only the selected page's payload carries the one-hour history, so a page that has just been selected is sent it now,
  // not up to 10 s later (#63 follow-up).
  if (resources && live !== resHistoryView) { resHistoryView = live; resources.resend(); }
}

// Ctrl+Alt+T. A form that is ALREADY open is not a transition, so neither
// applySelection nor the strip page would hand it the keyboard: do it here, or
// the branch name typed next goes into the terminal (PR #90 Dexter F3).
function openBranchForm() {
  const wasOpen = !!tabShell.snapshot().create;
  if (!tabShell.openCreate()) return false;
  if (wasOpen && win && !win.isDestroyed()) {
    win.webContents.focus();
    win.webContents.executeJavaScript("document.getElementById('create-branch').focus()").catch(() => {});
  }
  return true;
}

// Keyboard shortcuts, with no menu bar to carry them. Registered on the strip
// AND on every tab view (focus is usually in a view). preventDefault ONLY for a
// key shortcutFor names: everything else reaches xterm untouched.
function registerShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    const action = shortcutFor(input);
    if (!action || !shortcutWillAct(action, tabShell)) return;
    event.preventDefault();
    // A held key is swallowed (it must not type Tab into the terminal) but acts
    // once: repeating would spin through tabs, starting a host on each.
    if (input.isAutoRepeat) return;
    if (action === 'next-tab') tabShell.next();
    else if (action === 'prev-tab') tabShell.previous();
    else if (action === 'reopen-tab') tabShell.reopen().catch(logShellError('reopen'));
    else if (action === 'new-branch') openBranchForm();
    else if (action === 'focus-mode') setFocusMode(!focusMode);
    else if (action === 'index-note') { if (indexing) indexing.focusField(); }
    else if (action === 'devtools') {
      const v = selectedView();
      if (v && !v.webContents.isDestroyed()) v.webContents.toggleDevTools();
    }
  });
}

function onShellChanged(snapshot) {
  if (!win || win.isDestroyed()) return;
  applySelection(snapshot);
  lastStripPayload = {
    model: snapshot.model, selectedKey: snapshot.selectedKey, notice: snapshot.notice, closeNotice: snapshot.closeNotice,
    mode: snapshot.mode, create: snapshot.create,
  };
  win.webContents.send('strip-model', lastStripPayload);
}

// Hand close (criterion 5): ask first, every time; then the reducer's stop +
// close. Nothing on disk is touched.
async function closeTabFlow(key) {
  if (!key || !tabShell) return null;
  return tabShell.closeTab(key);
}

async function confirmClose(tab) {
  // The probe driver has nobody to click.
  if (PROBE_PORT) return true;
  const label = tab.branch || projectLabel(tab.cwd);
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['End session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `End the session in ${label}?`,
    detail: 'The folder stays.',
  });
  return r.response === 0;
}

// A fire-and-forget shell call from IPC or a key never rejects unhandled
// (PR #80 Miguel Y2): it is logged with what was being done.
const logShellError = (what) => (err) => console.error(`[main] ${what} failed:`, (err && err.stack) || err);

function focusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- the ▾ menu: every running session (Windowless sessions PR 2) -----------------
// Every host of every build beside this one (host/background-hosts.js), proven
// by its OS start time. Open is for this build's own; Stop is PR 1's rules
// (host/stop-holder.js stopHost): never a session with a window open.
const INSTALL_DIR = path.join(__dirname, '..');

function listBackground() {
  return listBackgroundHosts({ ownInstall: INSTALL_DIR }, listDeps(INSTALL_DIR));
}

async function backgroundModel() {
  const tabsByPort = new Map();
  for (const t of tabShell.snapshot().tabs) if (Number.isInteger(t.port)) tabsByPort.set(t.port, t.key);
  // A folder in no project has no project to stop all of (Dexter, PR #83 F6).
  return menuModel(await listBackground(), { now: Date.now(), tabsByPort, projectRoot: PROJECT ? PROJECT_ROOT : null });
}

// The effects, with everything they touch handed in (app/background-actions.js).
const backgroundActions = createBackgroundActions({
  select: key => tabShell.select(key),
  focusWindow,
  // Attach-only: it attaches to that host or refuses (host/launch-target.js).
  spawnWindow: ({ cwd, port }) => {
    const child = spawn(process.execPath, [INSTALL_DIR], {
      detached: true, stdio: 'ignore', env: attachEnv(process.env, { cwd, port }),
    });
    child.on('error', err => console.log('[main] Open (background) failed:', err.message));
    child.unref();
    return { pid: child.pid };
  },
  // The probe driver has nobody to click.
  confirmStop: async (row) => {
    if (PROBE_PORT || !win || win.isDestroyed()) return true;
    const ok = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Stop session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Stop the session in ${row.cwd}?`,
      detail: `Build ${row.build}, pid ${row.pid}. Its claude ends with it. A session with a window open is never stopped.`,
    });
    return ok.response === 0;
  },
  confirmStopAll: async (rows) => {
    if (PROBE_PORT || !win || win.isDestroyed()) return true;
    const ok = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [`Stop ${rows.length} session${rows.length === 1 ? '' : 's'}`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Stop every session in ${PROJECT_ROOT} that has no window open?`,
      detail: stopAllDetail(rows),
    });
    return ok.response === 0;
  },
  inform: async (text) => {
    if (PROBE_PORT || !win || win.isDestroyed()) return;
    await dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], message: text });
  },
  stopHost: row => stopHost({ row }, hostStopDeps()),
  log: msg => console.log(msg),
});

async function showBackgroundMenu() {
  const template = menuTemplate(await backgroundModel(), {
    open: o => backgroundActions.open(o),
    stop: row => { backgroundActions.stop(row).catch(() => {}); },
    stopAll: rows => { backgroundActions.stopAll(rows).catch(() => {}); },
  });
  await popupUntilClosed(Menu.buildFromTemplate(template), win);
}

// --- IPC ---------------------------------------------------------------------------

function registerIpc() {
  // The Resources panel (#63). `get` hands a page the last payload; `stop` is the Stop button, which main re-checks in
  // full (host/resource-stop.js) however the page asks.
  ipcMain.handle('resources:get', (e) => (isTabView(e.sender) && resources
    ? resources.get(!!selectedView() && selectedView().webContents === e.sender)
    : null));
  ipcMain.on('resources:chipOn', (e) => { e.returnValue = isTabView(e.sender) ? resourceChip.read() !== false : true; });
  ipcMain.handle('resources:setChip', (e, on) => (isTabView(e.sender) && resources ? resources.setChip(on) : null));
  ipcMain.handle('resources:stop', (e, req) => (isTabView(e.sender) && resources
    ? resources.stop(req)
    : { ok: false, reason: 'refused', text: 'refused' }));
  ipcMain.handle('resources:stopLeftovers', (e, req) => (isTabView(e.sender) && resources
    ? resources.stopLeftovers(req)
    : { ok: false, text: 'refused' }));
  // The strip page's own channels: gated on the window's OWN webContents, so a
  // tab's page (which has the other preload) cannot use them.
  ipcMain.on('strip:select', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    tabShell.select(key);
  });
  ipcMain.on('strip:close', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    closeTabFlow(key);
  });
  ipcMain.on('strip:contextMenu', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    const st = tabShell.menuState(key);
    Menu.buildFromTemplate([
      markSubmenu(tabShell.branchOf(key)),
      { type: 'separator' },
      { label: 'Allow a second session here', enabled: st.override, click: () => tabShell.override(key) },
      { label: 'Close tab', enabled: st.close, click: () => closeTabFlow(key) },
    ]).popup({ window: win });
  });
  // PR 3: the + menu -- New branch… (Contract A, then E), then the tabs closed
  // by hand in this window, most recent first.
  ipcMain.on('strip:plus', (e) => {
    if (!fromStrip(e)) return;
    const m = tabShell.plusMenu();
    // The shortcut is named in the label, not as an accelerator: main registers
    // none (the key is handled in before-input-event).
    const reopen = m.reopen.map((r, i) => ({
      label: `Reopen ${menuText(r.label)}${i === 0 ? '  (Ctrl+Shift+T)' : ''}`,
      click: () => tabShell.reopen(r.key).catch(logShellError('reopen')),
    }));
    Menu.buildFromTemplate([
      {
        label: m.create.enabled ? 'New branch…' : `New branch… (${m.create.why})`,
        enabled: m.create.enabled,
        click: () => tabShell.openCreate(),
      },
      ...(reopen.length ? [{ type: 'separator' }, ...reopen] : []),
    ]).popup({ window: win });
  });
  ipcMain.on('strip:create', (e, branch) => {
    if (!fromStrip(e) || typeof branch !== 'string' || branch.length > 200) return;
    tabShell.createWorktree(branch).catch(logShellError('create'));
  });
  ipcMain.on('strip:cancelCreate', (e) => {
    if (!fromStrip(e)) return;
    tabShell.cancelCreate();
  });
  // Layout pass L2 (#28): a frameless window's own buttons. Close is the same
  // close as the OS frame's: the window goes, the hosts stay detached.
  ipcMain.on('strip:winMinimize', (e) => {
    if (!fromStrip(e)) return;
    win.minimize();
  });
  ipcMain.on('strip:winClose', (e) => {
    if (!fromStrip(e)) return;
    win.close();
  });
  // The ▾ menu. Answers when it closes, so the strip can show it was busy
  // (the list takes two powershell.exe, ~1-2 s); one at a time.
  let backgroundBusy = false;
  ipcMain.handle('strip:background', async (e) => {
    if (!fromStrip(e) || backgroundBusy) return;
    backgroundBusy = true;
    try { await showBackgroundMenu(); } catch (err) {
      console.log('[main] background menu failed:', err && err.message);
    } finally { backgroundBusy = false; }
  });

  // A tab's page talking to main. Every one gated on "one of THIS window's tab
  // views": a handler that answers anyone is not a boundary.
  // Focus mode's button, its exit, and Ctrl+B while it's on (layout pass L1).
  ipcMain.on('focus:toggle', (e) => {
    if (!isTabView(e.sender)) return;
    setFocusMode(!focusMode);
  });
  ipcMain.on('focus:set', (e, on) => {
    if (!isTabView(e.sender) || typeof on !== 'boolean') return;
    setFocusMode(on);
  });
  ipcMain.on('tab:status', (e, status) => {
    if (!isTabView(e.sender)) return;
    tabShell.report(e.sender, status);
  });
  // The look's accent, for the strip (#64): a #rrggbb and nothing else, kept per tab page and
  // pushed to the strip while that tab is the selected one.
  ipcMain.on('tab:accent', (e, hex) => {
    if (!isTabView(e.sender) || !stripAccent.report(e.sender, hex)) return;   // only a #rrggbb is kept
    pushStripAccent();
  });
  ipcMain.on('tab:close', (e) => {
    const tab = isTabView(e.sender) ? tabShell.tabForSender(e.sender) : null;
    if (!tab) return;
    if (MODE === 'single') { if (win && !win.isDestroyed()) win.close(); return; }
    if (!tab.isDev) closeTabFlow(tab.key);
  });
  ipcMain.handle('tab:goTo', (e, holder) => (isTabView(e.sender)
    ? tabShell.goTo(e.sender, holder)
    : { kind: 'explain', text: "That session's window can't be found." }));
  // The Git panel's *Jump to its tab*: select the tab whose worktree is that folder.
  ipcMain.handle('tab:selectFolder', (e, folder) => (isTabView(e.sender)
    ? tabShell.selectFolder(e.sender, folder)
    : { kind: 'explain', text: "That tab's window can't be found." }));
  // The Git drawer (Enhancement #46): what the tabs of its worktrees are doing, and *Type /merged*, which
  // switches to that branch's tab and types `/merged` + Enter into its session.
  // Worktree occupancy: a page's first paint asks what is in its folder and what its session launched; after
  // that main pushes `occupancy` on change.
  ipcMain.handle('occupancy:get', (e) => (isTabView(e.sender) ? tabShell.occupancyFor(e.sender) : null));
  ipcMain.handle('tab:states', (e, folders) => (isTabView(e.sender) ? tabShell.tabStates(e.sender, folders) : []));
  ipcMain.handle('tab:typeMerged', (e, folder, branch) => (isTabView(e.sender)
    ? tabShell.typeMerged(e.sender, folder, branch)
    : { kind: 'explain', text: "That tab's window can't be found." }));
  // The target page's answer to a `type-command` (PR #93 Dexter F3): it typed into its own box, or why not.
  ipcMain.on('tab:typed', (e, reply) => {
    if (!isTabView(e.sender)) return;
    tabShell.typed(e.sender, reply);
  });
  // A link clicked in a tab's terminal (fix/terminal-links): straight to the
  // default browser, no prompt -- only what openInBrowser accepts.
  ipcMain.handle('tab:openExternal', (e, url) => {
    if (!isTabView(e.sender)) return false;
    const tab = tabShell.tabForSender(e.sender);
    return openInBrowser(url, tab ? tab.key : 'a tab');
  });
  // A local path in a tab's terminal (#37). Main resolves it against THAT
  // tab's own folder, checks it exists, and decides open or reveal
  // (app/file-link.js); the page only asks. The click asks again, and main
  // decides again: the file can change between hover and click.
  ipcMain.handle('tab:checkPaths', (e, lists) => {
    if (!isTabView(e.sender)) return [];
    const tab = tabShell.tabForSender(e.sender);
    return tab ? fileLink.check(lists, tab.cwd, fileFs) : [];
  });
  ipcMain.handle('tab:openPath', (e, p) => {
    if (!isTabView(e.sender)) return { ok: false, why: 'refused' };
    const tab = tabShell.tabForSender(e.sender);
    if (!tab) return { ok: false, why: 'refused' };
    // Quoted: a path with a newline in it can't forge a log line (PR #92 Miguel S3).
    console.log(`[main] ${tab.key}: file link ${JSON.stringify(String(p).slice(0, 200))}`);
    return fileLink.open(p, tab.cwd, fileFs, shell);
  });
  // The Files tab (#45): Show in Explorer and drag-out. Main resolves the path against THAT tab's own
  // worktree and re-runs the realpath guard; the page only names a path relative to it.
  ipcMain.handle('tab:repoReveal', (e, rel) => {
    const tab = isTabView(e.sender) ? tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.reveal(tab.cwd, rel) : { ok: false, why: 'refused' };
  });
  // Drag-out is two steps (PR #95 Miguel M2): the page asks main to PREPARE a file when the pointer reaches its
  // row (guard + is-a-file, cached), and at `dragstart` sends a SYNCHRONOUS start that calls startDrag in the same
  // tick, with nothing awaited between the gesture and the OS drag. `sendSync`: the reply (and any refusal)
  // comes back in the gesture too.
  ipcMain.handle('tab:repoDragPrepare', (e, rel) => {
    const tab = isTabView(e.sender) ? tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.prepare(tab.cwd, rel) : { ok: false, why: 'refused' };
  });
  ipcMain.on('tab:repoDragStart', (e, rel) => {
    const tab = isTabView(e.sender) ? tabShell.tabForSender(e.sender) : null;
    e.returnValue = tab ? repoActions.dragNow(tab.cwd, rel, (o) => e.sender.startDrag(o)) : { ok: false, why: 'refused' };
  });
  // The async fallback for a file that was not prepared yet: it checks first, then starts.
  ipcMain.handle('tab:repoDrag', (e, rel) => {
    const tab = isTabView(e.sender) ? tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.drag(tab.cwd, rel, (o) => e.sender.startDrag(o)) : { ok: false, why: 'refused' };
  });
  // The receiving side of a host `raise`: select that tab and come forward.
  // flashFrame as well, because Windows may refuse to hand focus to a
  // background process.
  ipcMain.on('tab:raise', (e) => {
    if (!isTabView(e.sender)) return;
    if (tabShell.raise(e.sender) && win && !win.isDestroyed()) win.flashFrame(true);
  });

  ipcMain.on('attention', (event, surfaces) => {
    if (!isTabView(event.sender) || !surfaces) return;
    // Logged even when nothing is shown. "Suppressed because you are looking at
    // it" and "never arrived" are the same silence otherwise, and telling those
    // two apart is what took two wrong diagnoses to learn.
    if (!surfaces.toast) console.log(`[main] attention: suppressed (focused=${focused})`);
    if (surfaces.toast && Notification.isSupported()) {
      const n = new Notification({
        title: String(surfaces.toast.title || 'claude-custom'),
        body: String(surfaces.toast.body || ''),
        silent: !!surfaces.toast.silent,
      });
      // The click goes to the tab that raised it, and to the window.
      n.on('click', () => { tabShell.attentionClick(event.sender); });
      n.show();
    }
    // Survives the toast: on Windows the taskbar button keeps flashing until
    // the window is looked at, which is the whole point for a blocked session.
    if (surfaces.flashTaskbar && !focused && win && !win.isDestroyed()) win.flashFrame(true);
    // Raised for ANY unfocused attention, not only urgent ones: "a task
    // finished while you were elsewhere" is precisely the case this is for,
    // and it costs nothing when you are already looking at the window.
    if (!focused) setCue(true);
    if (surfaces.toast) {
      console.log(`[main] attention: ${surfaces.toast.title}` +
        ` (silent=${surfaces.toast.silent}, flash=${!!surfaces.flashTaskbar})`);
    }
    if (surfaces.toast) console.log(`[main] attention body: ${surfaces.toast.body}`);
  });

  // The secret store lives HERE, in main. Not in the host: the host owns the
  // pty, so keeping secrets out of it means no wiring mistake can put one into
  // the session. Not in the renderer: the window would then hold the file and
  // every value in it.
  const secrets = createSecretService({
    // The project's STATE root: secrets are scoped to the project (every tab
    // shares them) unless explicitly shared; the vault file itself is
    // per-INSTALL, which is why the scope has to be enforced rather than implied
    // by where the file lives. NEW entries go under it.
    project: STATE_ROOT,
    // ...and entries saved earlier stay visible: under the project root (the
    // container path, before the 2026-09-28 layout move) or the folder this
    // window was launched on. Visibility only; `add` still gets ONE path.
    scopes: [PROJECT_ROOT, LAUNCH_CWD].filter((p) => !samePath(p, STATE_ROOT)),
    // DELIBERATELY NOT WRAPPED IN try/catch, and that rests on an invariant:
    // `createVault` CONSTRUCTS FOR ANY BYTES ON DISK, reporting the vault as
    // healthy or damaged rather than throwing.
    //
    // Miguel asked for this line, and the history is why. When `load()` threw on
    // a malformed lock record, this call took the whole window down with it --
    // no panel, no damage message, no melt button (Dexter G3). Wrapping it here
    // would have been worse: a window whose vault panel is silently dead is the
    // class this repo has already paid for four times (careerDisplay,
    // quotaDisplay, isPanelToggle, `.vault-row`). So the throw was removed
    // instead of the crash being caught.
    //
    // The invariant is pinned as a RULE, not by example, in
    // test/vault-damaged-path.test.js -- eighteen adversarial byte shapes
    // including a UTF-8 BOM. If you add a throw to `load()`, that test fails and
    // this comment is what it means.
    vault: createVault({
      file: path.join(__dirname, '..', '.harness', 'secrets.enc'),
      crypto: safeStorage,
    }),
    clipboard: {
      writeText: (t) => clipboard.writeText(t),
      readText: () => clipboard.readText(),
      clear: () => clipboard.writeText(''),
    },
  });

  const fromWindow = (event) => isTabView(event.sender);
  ipcMain.handle('secrets:available', (e) => fromWindow(e) && secrets.available());
  ipcMain.handle('secrets:list', (e, query) => (fromWindow(e) ? secrets.list({ query }) : []));
  ipcMain.handle('secrets:add', (e, entry) => (fromWindow(e) ? secrets.add(entry || {}) : { ok: false }));
  ipcMain.handle('secrets:remove', (e, id) => (fromWindow(e) ? secrets.remove(id) : { ok: false }));
  ipcMain.handle('secrets:reveal', (e, id) => (fromWindow(e) ? secrets.reveal(id) : { ok: false }));
  ipcMain.handle('secrets:copy', (e, id) => (fromWindow(e) ? secrets.copy(id) : { ok: false }));

  // The lock. Same `fromWindow` gate as everything above it: a handler that
  // answers anyone is not a boundary.
  // `hasKey: true` as well as `locked: true`, and `count: null`. An unauthorized
  // sender must get the shape that draws as LOCKED and reveals nothing --
  // `hasKey: false` with `locked: true` was already safe, but it says "locked
  // vault with no key", which is not a state that exists. Now this default and
  // the service's (secret-service.js, Dexter F6 / Miguel A2) are the same object.
  ipcMain.handle('secrets:lockState', (e) =>
    (fromWindow(e) ? secrets.lockState() : { hasKey: true, locked: true, count: null }));
  ipcMain.handle('secrets:setKey', (e, key) =>
    (fromWindow(e) ? secrets.setKey(key) : { ok: false }));
  ipcMain.handle('secrets:unlock', (e, key) =>
    (fromWindow(e) ? secrets.unlock(key) : { ok: false }));
  ipcMain.handle('secrets:lock', (e) => (fromWindow(e) ? secrets.lock() : { ok: false }));
  ipcMain.handle('secrets:removeKey', (e) => (fromWindow(e) ? secrets.removeKey() : { ok: false }));
  ipcMain.handle('secrets:melt', (e) => (fromWindow(e) ? secrets.melt() : { ok: false }));

  // Ctrl+V (BACKLOG #12, #8): the page asks, main reads the clipboard.
  registerClipboardHandlers({ ipcMain, clipboard, win, isSender: isTabView });

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted GLOBALLY next to look-global -- see
  // favourites-bridge.js's header for why main owns this store directly.
  registerFavouriteHandlers({ ipcMain, store: uiStore, win, isSender: isTabView });

  // Agent pictures (BACKLOG C #13, #18): the file picker for a portrait and the
  // install-wide "show agent images" toggle, persisted GLOBALLY next to
  // look-global -- see avatar-bridge.js. A push goes to EVERY tab view.
  const avatarSync = {};
  const pushToViews = (channel, value) => forEachView((v) => v.webContents.send(channel, value));
  registerAvatarHandlers({ ipcMain, store: uiStore, win, dialog, sync: avatarSync, isSender: isTabView, send: pushToViews });
  // Other project windows are other mains sharing this store: follow their toggle.
  watchImagesEnabled({
    store: uiStore, win, sync: avatarSync, send: pushToViews,
    file: path.join(__dirname, '..', '.harness', 'state', `${AVATAR_KEY}.json`),
  });

  // Layout pass L2: "status line in the header" (#27; host/status-relay.js
  // reads the same file on every status fire) and "hide the title bar" (#28;
  // read by createWindow for the next window). See window-chrome-bridge.js.
  const chromeSync = {};
  registerChromeHandlers({ ipcMain, store: uiStore, sync: chromeSync, isSender: isTabView, send: pushToViews });
  watchChromeSettings({
    store: uiStore, sync: chromeSync, send: pushToViews,
    file: path.join(__dirname, '..', '.harness', 'state', `${CHROME_KEY}.json`),
  });

  // Backlog #34: the background video plays only while the window is on screen and on mains.
  // Main reports the facts only it knows (minimised, hidden, on battery); the page decides.
  registerPlaybackHandlers({ ipcMain, win, powerMonitor, isSender: isTabView, send: pushToViews });

  // The global dock layout (layout pass L1): install-wide like the toggle above,
  // and followed across project windows the same way -- see layout-bridge.js.
  // A tab's OWN layout is its host's business, not main's.
  const layoutSync = {};
  registerLayoutHandlers({ ipcMain, store: uiStore, sync: layoutSync, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: uiStore, sync: layoutSync, send: pushToViews,
    file: path.join(__dirname, '..', '.harness', 'state', `${LAYOUT_KEY}.json`),
  });
  // The split-tree layout (dockable panels D1) under its own key. The pair above stays: an older
  // window still writes it, and it is read once to migrate into the tree, never written by this build.
  const treeSync = {};
  registerLayoutHandlers({ ipcMain, store: uiStore, sync: treeSync, names: TREE_NAMES, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: uiStore, sync: treeSync, names: TREE_NAMES, send: pushToViews,
    file: path.join(__dirname, '..', '.harness', 'state', `${TREE_NAMES.key}.json`),
  });
  // The layout presets (dockable panels D3): a list, install-wide, under its own key. Same bridge, an array.
  const presetSync = {};
  registerLayoutHandlers({ ipcMain, store: uiStore, sync: presetSync, names: PRESET_NAMES, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: uiStore, sync: presetSync, names: PRESET_NAMES, send: pushToViews,
    file: path.join(__dirname, '..', '.harness', 'state', `${PRESET_NAMES.key}.json`),
  });

  // The install-wide unfocused-window dim: the one Style-tab setting that is
  // not project-scoped, so it lives here rather than going to the host.
  ipcMain.handle('look:getDim', (e) => (fromWindow(e) ? readDim() : null));
  ipcMain.handle('look:setDim', (e, value) => {
    if (!fromWindow(e)) return null;
    const dim = sanitizeDim(value);
    try {
      uiStore.update(UI_KEY, {}, (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), unfocusedDim: dim }));
    } catch (err) {
      console.error('[main] could not save the unfocused dim:', err && err.message);
      return null;
    }
    return dim;
  });

  // Headless verification of the secret store. The unit tests inject a fake
  // cipher, so they say nothing about whether DPAPI actually works here; this
  // exercises the real safeStorage and the real OS clipboard. It prints only
  // BOOLEANS -- never the secret, which would defeat the thing being tested.
  if (process.env.CLAUDE_CUSTOM_VAULT_PROBE) {
    const value = process.env.CLAUDE_CUSTOM_VAULT_PROBE;
    setTimeout(() => {
      console.log('[vault-probe] available:', secrets.available());
      const added = secrets.add({ label: 'probe entry', secret: value });
      console.log('[vault-probe] stored:', added.ok, added.error || '');
      const listed = secrets.list();
      console.log('[vault-probe] listed:', listed.length);
      console.log('[vault-probe] list-leaks:', JSON.stringify(listed).includes(value));
      if (added.ok) {
        const shown = secrets.reveal(added.entry.id);
        console.log('[vault-probe] revealed-matches:', shown.ok && shown.secret === value);
        secrets.copy(added.entry.id);
        console.log('[vault-probe] clipboard-matches:', clipboard.readText() === value);
        // Deliberately NOT removed. The probe's strongest assertion is that the
        // file holds no plaintext, and deleting the entry first made that
        // assertion pass against an empty 25-byte vault -- vacuously true.
        console.log('[vault-probe] left-on-disk: true');
      }
    }, 2500);
  }
}

// --- headless verification ---------------------------------------------------------

async function capture(wc, file) {
  // RETRIED. capturePage intermittently returns an empty image -- observed
  // several times in a row while the host, the hooks and the renderer all
  // reported healthy, so it is the capture and not the page. Reporting it
  // as a probe failure sent me looking for a product bug that was not
  // there, more than once.
  let png = null;
  for (let attempt = 1; attempt <= 4 && !(png && png.length); attempt++) {
    if (attempt > 1) {
      console.log(`[main] capturePage came back empty, retry ${attempt - 1}`);
      await new Promise(r => setTimeout(r, 700));
    }
    try {
      png = (await wc.capturePage()).toPNG();
    } catch (err) {
      console.log('[main] capturePage threw:', err.message);
    }
  }
  if (!png || png.length === 0) throw new Error('capturePage returned an empty image 4 times');
  fs.writeFileSync(file, png);
  // Verify before exiting. app.exit() is a hard exit that has been
  // observed truncating the file to zero bytes even after a synchronous
  // write, and a 0-byte PNG reads as "the GUI rendered nothing" rather
  // than as the write race it actually is.
  const onDisk = fs.statSync(file).size;
  if (onDisk !== png.length) throw new Error(`wrote ${png.length}B but file is ${onDisk}B`);
  return onDisk;
}

// The strip's file next to the view's: <name>.png -> <name>.strip.png
const stripFileFor = (file) => file.replace(/(\.png)?$/i, '.strip.png');

// CLAUDE_CUSTOM_SCREENSHOT=<file> renders the real window, waits for the TUI to
// draw, writes a PNG and exits. The GUI is the one surface the headless probes
// cannot reach, so this is how it gets checked at all rather than assumed to
// look right. Since the window's own page is the strip, the PNG is of the
// SELECTED TAB's view, and the strip is written beside it.
function runScreenshotPath() {
  const outFile = process.env.CLAUDE_CUSTOM_SCREENSHOT;
  const waitMs = Number(process.env.CLAUDE_CUSTOM_SCREENSHOT_DELAY) || 12000;

  // Optional keystroke drive. The renderer's custom key handler -- above all
  // the hardcoded Shift+Enter -- is the one piece of the input path that the
  // headless probes cannot reach, because it lives in xterm's browser-side
  // event handling rather than on the wire.
  if (process.env.CLAUDE_CUSTOM_INPUT_TEST) {
    const type = text => {
      const sel = selectedView();
      if (!sel) return;
      for (const ch of text) sel.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    };
    const key = (keyCode, modifiers = []) => {
      const sel = selectedView();
      if (!sel) return;
      sel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      sel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    setTimeout(() => {
      win.focus();
      const sel = selectedView();
      if (sel) sel.webContents.focus();
      type('LINE-ONE');
      // If Shift+Enter is mishandled this SUBMITS instead of inserting a
      // newline, which the screenshot shows unmistakably.
      key('Enter', ['shift']);
      type('LINE-TWO');
    }, Math.max(1000, waitMs - 3000));
  }

  setTimeout(async () => {
    try {
      const sel = selectedView();
      if (!sel) throw new Error('no selected tab has a view to capture');
      const bytes = await capture(sel.webContents, outFile);
      console.log(`[main] screenshot written: ${outFile} (${bytes} bytes)`);
      const stripBytes = await capture(win.webContents, stripFileFor(outFile));
      console.log(`[main] strip screenshot written: ${stripFileFor(outFile)} (${stripBytes} bytes)`);
    } catch (err) {
      console.error('[main] screenshot failed:', err.message);
    }
    // Let the filesystem settle before the hard exit.
    setTimeout(() => app.exit(0), 400);
  }, waitMs);
}

// The tab probe's driver (verify/probe-worktree-tabs.js). Does NOTHING unless
// CLAUDE_CUSTOM_TABS_PROBE names a port. Newline-JSON over 127.0.0.1 only; the
// commands are app/tab-shell.js's handleProbeCommand's and nothing else.
function startProbeDriver(port) {
  const labelKey = (label) => {
    const e = tabShell.model().find((x) => x.label === label);
    return e ? e.key : null;
  };
  const api = {
    async state() {
      const model = tabShell.model();
      const hosts = tabShell.snapshot().tabs.map((t) => {
        const id = Number.isInteger(t.port) ? readIdentity({ dir: HARNESS_DIR, port: t.port }) : null;
        return { label: t.branch || projectLabel(t.cwd), key: t.key, cwd: t.cwd, started: t.started, port: t.port, pid: id ? id.pid : null };
      });
      // What the strip page ACTUALLY painted, read out of its DOM: this is what
      // catches a page that loaded but drew nothing.
      let stripDom = null;
      try {
        stripDom = JSON.parse(await win.webContents.executeJavaScript(
          "JSON.stringify([...document.querySelectorAll('.tab')].map(t => ({ label: (t.querySelector('.label') || {}).textContent, selected: t.classList.contains('selected'), dim: t.classList.contains('dim'), pulse: ['pulse-needs', 'pulse-done'].find(c => t.classList.contains(c)) || null, anim: getComputedStyle(t).animationName, bg: getComputedStyle(t).backgroundColor, hasClose: !!t.querySelector('.x'), resWarn: (t.querySelector('.res-warn') || {}).textContent || null, badge: (t.querySelector('.badge') || {}).textContent || null, mark: t.querySelector('.mark') ? { text: t.querySelector('.mark').textContent, title: t.querySelector('.mark').title, beforeLabel: t.querySelector('.mark').nextElementSibling === t.querySelector('.label'), width: Math.round(t.querySelector('.mark').getBoundingClientRect().width) } : null })))"));
      } catch (err) { stripDom = { error: err.message }; }
      // Worktree occupancy (#44 + #47): what the strip painted for each tab -- the hatched edge, its tags and its
      // hover -- read back from the DOM (verify/probe-worktree-occupancy.js); and the night tab (#52: night class,
      // moon, background, animation -- verify/probe-terminal-bar.js).
      let stripOccupancy = null;
      try {
        stripOccupancy = JSON.parse(await win.webContents.executeJavaScript(
          "JSON.stringify([...document.querySelectorAll('.tab')].map(t => ({ label: (t.querySelector('.label') || {}).textContent, occupied: t.classList.contains('occupied'), warn: t.classList.contains('occupied-warn'), tags: [...t.querySelectorAll('.agent-tag')].map(x => x.textContent), title: t.title, edge: getComputedStyle(t, '::after').backgroundImage, edgeAnimation: getComputedStyle(t, '::after').animationName, edgeHeight: getComputedStyle(t, '::after').height, night: t.classList.contains('night'), moon: !!t.querySelector('.moon'), bg: getComputedStyle(t).backgroundColor, anim: getComputedStyle(t).animationName })))"));
      } catch (err) { stripOccupancy = { error: err.message }; }
      // PR 3: the + and the strip's own line, as painted.
      let stripChrome = null;
      try {
        stripChrome = JSON.parse(await win.webContents.executeJavaScript(
          "JSON.stringify({ plus: !document.getElementById('plus').hidden, form: !document.getElementById('create').hidden, alert: document.getElementById('strip-alert').hidden ? null : document.getElementById('strip-alert').textContent, pane: document.getElementById('pane').hidden ? null : document.getElementById('pane-text').textContent })"));
      } catch (err) { stripChrome = { error: err.message }; }
      let viewDom = null;
      const sel = selectedView();
      if (sel) {
        try {
          viewDom = JSON.parse(await sel.webContents.executeJavaScript(
            "JSON.stringify({ xterm: document.querySelectorAll('.xterm').length, title: (document.getElementById('title') || {}).textContent || null, hasTerm: typeof term !== 'undefined', "
            // Layout pass L2 (#27): the header's copy of the CLI status row.
            + "statusFields: (() => { const el = document.getElementById('status-fields'); if (!el) return null; const r = el.getBoundingClientRect(); return { hidden: el.hidden, text: el.textContent, rect: { left: Math.round(r.left), width: Math.round(r.width), right: Math.round(r.right) }, viewport: window.innerWidth, display: getComputedStyle(el).display, scrollWidth: el.scrollWidth, focusRight: Math.round(((document.getElementById('focus-btn') || el).getBoundingClientRect()).right) }; })() })"));
        } catch (err) { viewDom = { error: err.message }; }
      }
      // No menu bar: no application menu AND none on the window.
      const noMenuBar = Menu.getApplicationMenu() === null && !win.isMenuBarVisible();
      // Layout pass L2 (#28): a frameless window's content fills the whole
      // window, and its strip is the title bar (verify/probe-window-chrome.js).
      let windowChromeDom = null;
      try {
        windowChromeDom = JSON.parse(await win.webContents.executeJavaScript(
          "JSON.stringify({ frameless: document.body.classList.contains('frameless'), min: !document.getElementById('win-min').hidden, close: !document.getElementById('win-close').hidden, drag: getComputedStyle(document.getElementById('strip')).webkitAppRegion || getComputedStyle(document.getElementById('strip')).getPropertyValue('-webkit-app-region') })"));
      } catch (err) { windowChromeDom = { error: err.message }; }
      const windowFrame = { bounds: win.getBounds(), content: win.getContentBounds(), dom: windowChromeDom };
      const snap = tabShell.snapshot();
      return {
        mode: MODE, selectedKey: snap.selectedKey, tabs: model, hosts, stripDom, stripOccupancy, stripChrome, viewDom, noMenuBar, windowFrame,
        create: snap.create, reopenable: tabShell.plusMenu().reopen,
      };
    },
    // PR 3: what the + menu and the branch form do, without a mouse.
    // Started, not awaited: the probe watches the setup's progress through `state`.
    async create(branch) { tabShell.createWorktree(branch).catch(logShellError('create')); return { ok: true }; },
    async reopen() { return tabShell.reopen(); },
    // #40: the same call the Mark ▸ menu's click makes.
    async mark(branch, id) {
      const saved = chooseMark(branch, id);
      return saved ? { ok: true, state: marks.state } : { ok: false, state: marks.state, error: 'not saved' };
    },
    // Dexter #87 F2: the submenu as ELECTRON built it, so its own defaults show.
    async markMenu(branch) {
      const built = Menu.buildFromTemplate([markSubmenu(branch)]).items[0];
      return {
        ok: true, label: built.label, enabled: built.enabled,
        items: built.submenu.items.filter(i => i.type !== 'separator')
          .map(i => ({ label: i.label, type: i.type, checked: i.checked, enabled: i.enabled })),
      };
    },
    async cancelCreate() { return { ok: tabShell.cancelCreate() }; },
    // The window's own `focus` handler, run as the OS would.
    async windowFocus() { win.emit('focus'); return { ok: true, osFocused: win.isFocused() }; },
    async select(label) {
      const key = labelKey(label);
      if (!key) return { ok: false, error: `no tab labelled ${label}` };
      await tabShell.select(key);
      const t = tabShell.tabByKey(key);
      return { ok: true, started: !!(t && t.started), error: t ? t.error : null };
    },
    async close(label) {
      const key = labelKey(label);
      if (!key) return { ok: false, error: `no tab labelled ${label}` };
      return tabShell.closeTab(key);
    },
    // Layout pass L1: a named action in the selected view (renderer.js
    // window.__dockProbe, defined only on a page opened with ?probe=1). The
    // request is passed as JSON data, never spliced in as code.
    async view(action, args) {
      const sel = selectedView();
      if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
      const req = JSON.stringify(JSON.stringify({ action, args }));
      const out = await sel.webContents.executeJavaScript(
        `window.__dockProbe ? window.__dockProbe(JSON.parse(${req})) : JSON.stringify({ ok: false, error: 'no probe hook' })`);
      return JSON.parse(out);
    },
    async screenshot(file) {
      const sel = selectedView();
      const viewBytes = sel ? await capture(sel.webContents, file) : 0;
      const stripBytes = await capture(win.webContents, stripFileFor(file));
      return { ok: true, viewBytes, stripBytes, stripFile: stripFileFor(file) };
    },
    async key(key, modifiers) {
      const sel = selectedView();
      if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
      const before = tabShell.snapshot().selectedKey;
      // Down then up, as a keyboard does; the handler acts on the down only.
      sel.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      sel.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
      return { ok: true, before };
    },
    // #34: the window as the OS minimises and restores it (the real events fire), and the OS's
    // reduced-motion preference emulated on the selected view through the debugger protocol.
    async windowState(state) {
      if (state === 'minimize') win.minimize(); else win.restore();
      return { ok: true, minimized: win.isMinimized() };
    },
    async reducedMotion(on) {
      const sel = selectedView();
      if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
      const dbg = sel.webContents.debugger;
      if (on) {
        if (!dbg.isAttached()) dbg.attach('1.3');
        await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        return { ok: true, on };
      }
      // Off: clear the emulation and let go of the view (Miguel M8, PR #91) -- an attached debugger
      // left behind holds the page in a state no real window is in, and blocks DevTools on it.
      if (dbg.isAttached()) {
        try { await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } finally { dbg.detach(); }
      }
      return { ok: true, on, attached: dbg.isAttached() };
    },
    async quit() {
      setTimeout(() => app.exit(0), 200);
      return { ok: true };
    },
    async background() {
      const m = await backgroundModel();
      const strip = await win.webContents.executeJavaScript(
        "JSON.stringify((b => b && { text: b.textContent, title: b.title })(document.getElementById('bg')))");
      return { ok: true, footer: m.footer, items: m.items.map(it => ({ label: it.label, open: it.open, stop: it.stop, port: it.row.port, exact: it.row.exact })), button: JSON.parse(strip) };
    },
    async backgroundStop(port) {
      const it = (await backgroundModel()).items.find(x => x.row.port === port);
      if (!it) return { ok: false, error: `no running session on port ${port}` };
      const r = await backgroundActions.stop(it.row);
      return { ok: true, outcome: r.outcome, how: r.how || null, text: r.text || null };
    },
    async backgroundOpen(port) {
      const it = (await backgroundModel()).items.find(x => x.row.port === port);
      if (!it) return { ok: false, error: `no running session on port ${port}` };
      if (!it.open) return { ok: false, error: 'that session has no Open' };
      return { ok: true, ...(backgroundActions.open(it.open) || { failed: true }) };
    },
    async backgroundStopAll() {
      const m = await backgroundModel();
      if (!m.stopAll) return { ok: false, error: 'no project root' };
      const r = await backgroundActions.stopAll(m.stopAll.rows);
      return { ok: true, ports: m.stopAll.rows.map(x => x.port),
        results: (r.results || []).map(x => ({ port: x.row.port, outcome: x.outcome })) };
    },
  };
  const server = net.createServer((sock) => {
    // Capped (Miguel, PR #75 M4): a peer that never sends a newline is cut off.
    const reader = probeLineReader(PROBE_LINE_MAX);
    sock.on('data', (d) => {
      const { lines, overflow } = reader.push(String(d));
      if (overflow) { sock.destroy(); return; }
      for (const line of lines) {
        handleProbeCommand(line, api, PROBE_TOKEN)
          .then((r) => { try { sock.write(JSON.stringify(r) + '\n'); } catch { /* probe went away */ } });
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (err) => console.error('[main] probe driver:', err.message));
  server.listen(port, '127.0.0.1', () => console.log(`[main] probe driver listening on ${port}`));
}

// --- the indexing assistant (#66) ----------------------------------------------------------
// One per window, sharing one install-wide journal with the others. The probe seam points it at a throwaway journal.
function startIndexing(seams) {
  const journalFile = seams.indexingJournal || path.join(HARNESS_DIR, 'state', 'indexing-notes.jsonl');
  const docsFor = (root) => { const p = projectOf(root); return indexWriter.docsOf(p || { root, dev: root }); };
  const service = createIndexingService({
    journal: createJournal({ file: journalFile }),
    docsFor,
    log: (...a) => console.log(...a),
  });
  // The chip's projects: host/recent.js scans transcripts (2.7 s cold here), so it runs in a worker, kept 5 minutes.
  let recents = null;
  let recentsAt = 0;
  const projects = async (current) => {
    if (recents === null || Date.now() - recentsAt > 5 * 60_000) {
      const r = await readRecentsOffThread({ projectsDir: seams.projectsDir || undefined });
      if (r) { recents = r; recentsAt = Date.now(); }
    }
    return projectChoices({
      current, recents, projectOf, labelOf: projectLabel,
      hasBacklog: (p) => { const d = indexWriter.docsOf(p); return d.ok === true && fs.existsSync(d.backlog); },
    });
  };
  indexing = createIndexingBridge({
    ipcMain, Menu, shell,
    copyText: (text) => clipboard.writeText(text),
    makeView: () => {
      const v = new WebContentsView({
        webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload-indexing.js') },
      });
      v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      if (process.env.CLAUDE_CUSTOM_SCREENSHOT || PROBE_PORT) {
        v.webContents.on('console-message', (_e, level, message) => console.log(`[indexing-overlay] ${message}`));
      }
      return v;
    },
    overlayFile: path.join(__dirname, 'indexing-overlay.html'),
    getWin: () => win,
    isStrip: (sender) => fromStrip({ sender }),
    service,
    project: { root: PROJECT_ROOT, label: WINDOW_LABEL },
    docsFor,
    projects,
    viewTop: () => viewTop({ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT }),
    focusSelected: () => {
      const sel = selectedView();
      if (sel && !sel.webContents.isDestroyed()) { sel.webContents.focus(); lastFocusedView = sel; }
    },
    setFieldFocused: (on) => { indexFieldFocused = on; },
    journalStamp: () => { try { const s = fs.statSync(journalFile); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } },
  });
  indexing.start(3000);
  indexing.push(true);
  // Warm the chip's list off-thread, so the first click doesn't wait for it.
  setTimeout(() => { projects(PROJECT_ROOT).catch(() => {}); }, 15_000).unref();
}

app.whenReady().then(async () => {
  console.log('[main] project       :', PROJECT_ROOT, `(${MODE})`);
  console.log('[main] launched on   :', LAUNCH_CWD);

  // Named and refused (see explicitPort): nothing sensible is left to do, and
  // opening a window anyway would show a terminal wired to nothing.
  if (EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) { app.exit(1); return; }

  const seams = readSeams(process.env);
  const openPrsReader = seams.openPrsFixture
    ? fixtureReader(seams.openPrsFixture, { parse: parseOpenPrs, log: (line) => console.log(line) })
    : readOpenPrs;
  occupancyService = createOccupancyService({
    dir: occupancyDir(STATE_ROOT),
    // The watcher creates the folder if it is missing (a first claim must be seen). Through the look folder's
    // own guard: a `.claude-custom` that is a link to somewhere else is never written through, and a fresh
    // one gets its .gitignore before anything lands in it.
    ensureDir: () => {
      if (lookDirState(STATE_ROOT, fs) === 'foreign') throw new Error('.claude-custom is a link to somewhere else');
      ensureLookDir(STATE_ROOT, fs);
      fs.mkdirSync(occupancyDir(STATE_ROOT), { recursive: true });
    },
    startTimes,
    onChange: () => { if (tabShell) tabShell.refresh(); },
    log: (...a) => console.log(...a),
  });
  transcriptOccupancy = createTranscriptScanner({
    projectsDir: seams.projectsDir || defaultProjectsDir(),
    roots: createRootsProvider({ cwd: STATE_ROOT, log: (...a) => console.log(...a) }),
    // The SAME store the hosts write to. The proof a reader checks is this window's own process: its claims
    // go dark with it, and close() removes the ones it still owns.
    writer: createClaimWriter({ stateRoot: STATE_ROOT, log: (...a) => console.log(...a) }),
    dir: occupancyDir(STATE_ROOT),
    ownPid: process.pid,
    ownStartedAt: createSelfStartTime(),
    // one producer per agent: what the readers already show as live is left to whoever wrote it
    liveClaims: () => occupancyService.current(),
    log: (...a) => console.log(...a),
  });
  tabShell = createShell({
    mode: MODE,
    container: PROJECT ? PROJECT.root : null,
    cwd: LAUNCH_CWD,
    launchedFrom: LAUNCH_CWD,
    log: (...a) => console.log(...a),
    git: { list: listWorktrees, marker: readMergedMarker },
    marks: { markFor: (branch) => tabMarks.markFor(marks.store, branch) },
    // #63: each tab's "over 40% CPU for 30 s" chip, from the Resources service (cleared while the panel is hidden).
    resources: { warnFor: (key) => (resources ? resources.warnFor(key) : null) },
    // #44 + #47: the live claims (the strip's hatched edge, each page's banner and card lines).
    occupancy: { claims: () => occupancyService.current() },
    // Type /merged's own open-PR check (PR #93 Miguel I3): gh in that worktree, or the probe's fixture.
    prs: { openFor: (folder, branch) => openPrFor(folder, branch, { read: openPrsReader }) },
    // agent-creator's worktree scripts (Contracts A, C, E); the probe points
    // CLAUDE_CUSTOM_WORKTREE_SCRIPTS at stand-ins.
    ops: createOps({ dir: scriptsDir(process.env) }),
    hosts: {
      choosePort: chooseHostPort,
      probe: (port) => probePort(port),
      spawn: ({ tab, port, token }) => spawnHost(tab, port, token),
      wait: (port) => waitForHost(port),
      tokenFor: tokenForRunningHost,
      tokenFile: tokenFileFor,
      // One secret, handed to the host AND the tab's page. In a single-tab window
      // a named CLAUDE_CUSTOM_TOKEN still wins, as it always did.
      newToken: () => (MODE === 'single' && process.env.CLAUDE_CUSTOM_TOKEN)
        || require('crypto').randomBytes(24).toString('hex'),
      control: (c) => sendControl(c),
      // planGoTo's readers: another install's identity file and token, by its dir.
      identity: ({ install, port }) => readIdentity({ dir: path.join(install, '.harness'), port }),
      readToken: (install, port) => readTokenFile({ dir: path.join(install, '.harness'), port }),
    },
    views: {
      create: createTabView,
      destroy: destroyTabView,
      send: (tab, channel, payload) => {
        if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.send(channel, payload);
      },
      owns: (tab, sender) => !!tab.view && tab.view.webContents === sender,
    },
    ui: {
      confirmClose,
      changed: onShellChanged,
      focusWindow,
      isFocused: () => focused,
    },
  });

  // The Resources panel (#63). Identity files of every build beside this one say which pids are session hosts;
  // each is proven against the process table (host/resource-tree.js provenHosts) before anything is attributed.
  const resourceInstalls = () => { try { return installsBeside(INSTALL_DIR); } catch { return [INSTALL_DIR]; } };
  const cpuCores = require('os').cpus().length;
  // Read once and REMOVED from the environment, so it never reaches a host, a claude or a window started from them.
  const warnAtSeam = parseWarnAt(process.env.CLAUDE_CUSTOM_RESOURCE_WARN_AT);
  delete process.env.CLAUDE_CUSTOM_RESOURCE_WARN_AT;
  resourceSampler = createSampler({ cores: cpuCores, onUpdate: (snap) => { if (resources) resources.onUpdate(snap); }, log: (...a) => console.log(...a) });
  resources = createResourcesService({
    sampler: resourceSampler,
    tabs: () => tabShell.snapshot().tabs,
    claims: () => {
      const out = [];
      for (const install of resourceInstalls()) {
        let entries;
        try { entries = identitiesIn(install); } catch { continue; }
        for (const { port, parsed } of entries) {
          if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0 && parsed.port === port && typeof parsed.cwd === 'string') {
            out.push({ pid: parsed.pid, port, cwd: parsed.cwd, processStartedAt: parsed.processStartedAt });
          }
        }
      }
      return out;
    },
    installDirs: resourceInstalls,
    ownPid: process.pid,
    cores: cpuCores,
    // a worktree's cwd names its PROJECT (the folder that holds `dev\`), the way the window title does
    labelOf: (cwd) => { const p = projectOf(cwd); return projectLabel(p ? p.root : cwd); },
    send: (full, light) => { const sel = selectedView(); forEachView((v) => v.webContents.send('resources:state', v === sel ? full : light)); },
    // Stop ends exactly the set the guard computed, leaf first, each re-proved by pid and start time through a handle
    // (host/resource-kill.js): never a bare `taskkill /T`, which follows a stale parent link.
    kill: (targets) => killVerified(targets, { exec: createPowerShellExec(20000) }),
    // Leftovers (#74): the shared pid ledger, and the stop (by the 15-minute clock or a click) of what it proves is ours. A kill is
    // killProvenAsync: the ledger's start is proven again on a held handle at the moment of the kill, off the main thread
    // (host/kill-tree.js); the launcher and the start are re-asked of Get-Process just before (host/leftovers-seams.js).
    ledger: () => pidLedger.readLedger(),
    reap: createLeftoverSeams({
      startTimes, kill: (pid, start) => killProvenAsync(pid, start),
      removeEntries: (entries) => pidLedger.removeEntries(pidLedger.defaultLedgerFile(), entries),
    }),
    // verify/probe-resource-panel.js only: the warning's CPU threshold (a percentage), 40 when unset or not one
    warnAt: warnAtSeam,
    refreshStrip: () => { if (tabShell) tabShell.refresh(); },
    // Q2: install-wide, in the same store as the other window-wide UI state
    chipStore: resourceChip,
    log: (...a) => console.log(...a),
  });
  // Other project windows are other mains sharing the saved file: follow their change of the chip, live, as the panels do.
  watchChip({ file: path.join(__dirname, '..', '.harness', 'state', `${CHIP_KEY}.json`), onChange: () => { if (resources) resources.reloadChip(); } });
  resourceSampler.start();
  resources.refresh();       // the sampler starts idle: wake it now, not when a selection happens to follow

  // No application menu bar, ever (Ricardo, 2026-09-30: every pixel of vertical
  // space). Electron paints its default File/Edit/View/Window/Help bar on
  // Windows only because none was set; null removes it. Set before the window.
  Menu.setApplicationMenu(null);
  createWindow();
  registerIpc();
  startIndexing(seams);

  reloadMarks();
  if (MODE === 'tabs') pruneGoneMarks();
  occupancyService.start();
  transcriptOccupancy.start();
  const first = await tabShell.open();
  if (attachOnlyRefusal) {
    console.error('[main] Open refused:', attachOnlyRefusal.reason);
    if (!PROBE_PORT && win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], message: attachOnlyText(attachOnlyRefusal) });
    }
    app.exit(1);
    return;
  }
  if (MODE === 'single' && first && !first.started) {
    // The old behaviour, kept: a refused or unfindable port ends the launch.
    // A host that merely was slow leaves the window up, with its reason and Retry.
    console.error('[main] could not start:', first.error);
    if (first.error === NO_PORT_ERROR || /resolvePort:/.test(String(first.error))) { app.exit(1); return; }
  }
  if (MODE === 'tabs') setInterval(() => { reloadMarks(); tabShell.poll(); }, POLL_MS);

  // Headless verification path.
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT) runScreenshotPath();
  if (PROBE_PORT) startProbeDriver(PROBE_PORT);
});

// Closing the window detaches; it does not end the session.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => { if (resourceSampler) resourceSampler.stop(); if (transcriptOccupancy) transcriptOccupancy.close(); if (occupancyService) occupancyService.close(); });
