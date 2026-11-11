'use strict';
/**
 * claude-custom :: Electron main  -- the app-wide half of the tab shell
 *
 * One Electron process, one project window today (one entry in the projectWindows Map). Everything that belongs to ONE project's
 * window (its BrowserWindow, tab shell, marks, occupancy, views, dev servers, focus and cue state, the one-window claim, the
 * launch folder's MODE) lives in app/project-window.js, made by createProjectWindow(); the tabs/single modes are described there.
 *
 * This file keeps what is app-wide and what must be registered once per process: every ipcMain handler (each reaches a window
 * through stripOwner(e) / viewOwner(sender), never by naming "the" window), the UI store, the tray, the Resources service and
 * sampler, the secret vault, the indexing bridge, the launch order in whenReady and the quit handlers. The decisions themselves
 * are pure and tested elsewhere (host/tab-lifecycle.js, app/tab-model.js, app/tab-shell.js).
 */

const { app, BrowserWindow, WebContentsView, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell, powerMonitor } = require('electron');
const { createToastHolder } = require('./toast-holder');
const { createProjectWindow } = require('./project-window');
const { createProjectRegistry } = require('./project-registry');
const { armQuitWatchdog } = require('./quit-watchdog');
const { createQuitLog, wireQuitLog, markWillQuitEnd } = require('./quit-log');
// BACKLOG #74 A: the quit's timeline, only when CLAUDE_CUSTOM_QUIT_LOG names a file (verify/probe-quit-linger.js); a no-op otherwise.
const QUIT_LOG_FILE = process.env.CLAUDE_CUSTOM_QUIT_LOG || null;
const quitMark = createQuitLog(QUIT_LOG_FILE);
if (QUIT_LOG_FILE) wireQuitLog(app, quitMark);
const { createVault } = require('./secret-vault');
const { createSecretService } = require('./secret-service');
const { registerClipboardHandlers } = require('./clipboard-bridge');
const { registerFavouriteHandlers } = require('./favourites-bridge');
const { registerAvatarHandlers, watchImagesEnabled, AVATAR_KEY } = require('./avatar-bridge');
const { registerLayoutHandlers, watchLayout, LAYOUT_KEY, TREE_NAMES, PRESET_NAMES } = require('./layout-bridge');
const { registerFontHandlers, FONT_NAMES, uiFontScript, readFontSettings } = require('./fonts-bridge');
const { registerChromeHandlers, watchChromeSettings, CHROME_KEY } = require('./window-chrome-bridge');
const { registerPlaybackHandlers } = require('./playback-bridge');
const { registerLeanHandlers, PUSH_CHANNEL: LEAN_PUSH, FACES_PUSH: LEAN_FACES_PUSH } = require('./lean-bridge');
const { createLean, unionDismissed } = require('./lean-state');
const { NO_PORT_ERROR } = require('./tab-shell');
const fs = require('fs');
const path = require('path');
const { projectLabel } = require('../host/project-path');

const { readIdentity, defaultIsAlive } = require('../host/host-identity');
const { lookDir, lookDirState, ensureLookDir } = require('../host/style');
const { createProjectLayoutStore } = require('./project-layout-store');
const { startTimes, createSelfStartTime, isAlive: isPidAlive } = require('../host/proc-start');
const { readOpenPrs, parseOpenPrs } = require('../host/open-prs');
const { readSeams, fixtureReader } = require('../host/probe-seams');
const { sanitizeDim } = require('../host/look');
const { createStore } = require('../host/store');
const { createUsageCounters, countingOff } = require('../host/usage-counters');
const { probePort } = require('../host/port-probe');
// BACKLOG #119 A6: the + form's "From an issue" list (the strip:issues channel); the lane's brief and the tab's link are the window's (app/project-window.js).
const { answerIssuesRequest, issueArg } = require('../host/issues');
const { externalUrl } = require('./external-link');
const { registerCanvasIpc, HOST_RESOLVER_RULES } = require('./canvas-views');
const { readMcpSetting, writeMcpSetting } = require('../host/canvas-settings');
const { readModSetting, writeModSetting } = require('../host/cc-mod-settings');
const fileLink = require('./file-link');
const { createRepoActions } = require('./repo-actions');
// What app/file-link.js may ask the disk (#37): reads, nothing else. lstat and
// readlink come first, so a symlink to a share is refused before stat follows it.
const fileFs = { lstat: (p) => fs.promises.lstat(p), readlink: (p) => fs.promises.readlink(p),
  stat: (p) => fs.promises.stat(p), realpath: (p) => fs.promises.realpath(p) };
const { projectOf, samePath } = require('../host/project-layout');
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
const { createExec: createPowerShellExec, scriptFor: resourceScriptFor } = require('../host/resource-sampler');
// BACKLOG #100 c: ONE sampler for every window of this machine (host/shared-poller.js), one persistent PowerShell, and sampling only
// while someone looks (the cadence table is host/poller-policy.js).
const { createSharedSampler } = require('../host/shared-sampler');
const { createSharedPoller, defaultDir: defaultPollerDir } = require('../host/shared-poller');
const pollerPolicy = require('../host/poller-policy');
const { createPersistentExec } = require('../host/persistent-powershell');
const { killVerified } = require('../host/resource-kill');
const { suspendVerified } = require('../host/process-suspend');
const { createPausePersist } = require('../host/pause-persist');
const pidLedger = require('../host/pid-ledger');
const { killProvenAsync } = require('../host/kill-tree');
const { createStopByPid } = require('../host/stop-by-pid');
const { runStopAll, countUnstoppable, describeUnstoppable } = require('../host/kill-switch');
const { writeFileAtomic } = require('../host/atomic-write');
const { createSeams: createLeftoverSeams } = require('../host/leftovers-seams');
const taskLogsFs = require('../host/task-logs-fs');
const { claudeConfigDir } = require('../host/claude-config-dir');
const os = require('os');
const taskLogsRoot = path.join(require('os').tmpdir(), 'claude');
const { createResourcesService, parseWarnAt } = require('./resources-service');
const { createChipStore, watchChip, KEY: CHIP_KEY } = require('../host/chip-store');
const { createScoreStore } = require('../host/game-scores');
const { listDeps } = require('../host/stop-deps');
// The tray icon (BACKLOG #119 A8): the needs-you count, show/hide, start minimised, minimise on close.
const { createTrayController } = require('./tray-controller');
const { renderTrayIcon } = require('./tray-icon');
const { readTraySettings, writeTraySetting, registerTrayHandlers } = require('./tray-settings');
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
// A probe seam (host/probe-seams.js, uiStateDir) moves these records into the probe's own folder; unset in real use.
const UI_STATE_DIR = readSeams(process.env).uiStateDir || path.join(__dirname, '..', '.harness', 'state');
const uiStore = createStore({ dir: UI_STATE_DIR });
// Invisible feature-use counts (host/usage-counters.js); same file the hosts write. Off when a probe or a test started this main (#97).
const usageCounters = createUsageCounters({ store: uiStore, off: countingOff(process.env) });
const UI_KEY = 'look-global';
const resourceChip = createChipStore(uiStore);
const gameScores = createScoreStore(uiStore);   // #41: the wait games' bests, install-wide
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

// --- the launch --------------------------------------------------------------------
// What this launch's folder makes of itself (the project, its mode, its state root) is worked out by the project window
// (app/project-window.js), made below once the app-wide constants it is handed exist.
const LAUNCH_CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();
const STRIP_HEIGHT = 34;
const POLL_MS = 3000;
const PROBE_PORT = Number(process.env.CLAUDE_CUSTOM_TABS_PROBE) || 0;
// A probe window is killed by pid, which leaves a ghost icon in the notification area until the mouse passes over it. So only the
// tray's own probe (verify/probe-tray.js) gets a tray; in every other probe the tray (and starting hidden) is off.
const TRAY_ON = !PROBE_PORT || process.env.CLAUDE_CUSTOM_TRAY_PROBE === '1';
// One window per project applies to a person's windows. A probe's windows come many to a temp folder, so they are outside the rule
// unless the probe of the rule itself (verify/probe-one-window.js) sets CLAUDE_CUSTOM_ONE_WINDOW_PROBE=1.
const ONE_WINDOW_ON = !PROBE_PORT || process.env.CLAUDE_CUSTOM_ONE_WINDOW_PROBE === '1';
// The probe's secret; every driver command must carry it (Miguel, PR #75 M4).
// handleProbeCommand refuses everything when it's missing or short.
const PROBE_TOKEN = process.env.CLAUDE_CUSTOM_TABS_PROBE_TOKEN || null;
const PROBE_LINE_MAX = 64 * 1024;
// A probe's window stays off the desktop and unfocused (host/probe-window.js); a person's window is untouched.
const forProbe = (opts) => (PROBE_PORT ? require('../host/probe-window').probeWindowOptions(opts) : opts);

// A window another window covers is "occluded", and Chromium then stops
// painting it: capturePage answers an EMPTY image. That is the intermittent
// empty capture the screenshot path retries around (measured 2026-09-30: the
// tab probe failed 1 run in 7 with "capturePage returned an empty image 4
// times" for the strip AND the view, both at once). Only the headless paths
// switch occlusion tracking off, so a person's window is unchanged.
if (process.env.CLAUDE_CUSTOM_SCREENSHOT || PROBE_PORT) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// BACKLOG #71 (Claude's panel): Chromium in this app resolves NO name but loopback. The page the running Claude builds is
// untrusted, and `<link rel=dns-prefetch>` is a DNS query that carries a name of the page's choosing; a CSP and a dead proxy
// both leave it open (verify/probe-canvas-sandbox.js measured it). This rule is the only thing that shuts it. It costs
// nothing today: the app makes no external request of its own through Chromium (the host and this process use Node's
// networking, which this does not touch), and the panel reaches approved hosts through main (app/canvas-fetch.js).
app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);

// A new window must not wait for the E-cores: Chromium starts renderers as background (Idle + EcoQoS), Windows runs those
// on the E-cores only, and with them saturated a new window stayed blank for 60+ s (measured 2026-10-13, the story is in
// test/renderer-backgrounding-wiring.test.js). Priority only: hidden pages are still throttled by Chromium's timers.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Each window's own Chromium cache, so a second window prints no "Unable to move the cache" lines (BACKLOG #215).
require('./cache-dirs').useOwnCaches(app);

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

function attachOnlyText(d) {
  if (d.reason === 'ended') return "That session has ended, so there's nothing to open.";
  if (d.reason === 'other-project') return 'That port now serves another folder, so nothing was opened.';
  return "That session couldn't be identified, so nothing was opened.";
}

// This build's identity files, or NULL when they can't be listed: not "no hosts" (a side host may be running), so the shell looks for
// one under every tab (host/side-session.js sideHostsOf).
// This build and its sibling worktrees: every install whose identity files STOP ALL checks for hosts too old to watch the file.
function stopAllInstalls() {
  try { return installsBeside(INSTALL_DIR); } catch { return [INSTALL_DIR]; }
}

function ownIdentities() {
  try { return identitiesIn(INSTALL_DIR); } catch { return null; }
}

// #129: end a tab's host by pid when its stop message failed (host/stop-by-pid.js).
const stopHostByPid = createStopByPid({ identities: () => ownIdentities(), kill: (pid, start) => killProvenAsync(pid, start), ownPids: [process.pid, process.ppid] });

async function waitForHost(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostListening(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let resources = null;              // the Resources panel's service (#63), built once the shell exists
let resourceSampler = null;
const indexingPages = new Set();       // the indexing overlay's pages (toast, list): they get the interface font like the strip does

// Which project window a sender belongs to, or null: the resolvers are app/project-registry.js's. A gate is BOOLEAN, because every
// bridge requires `isSender(sender) === true` and an object-returning gate would make each of them refuse silently; the owner comes
// from the resolver, after the gate.
const registry = createProjectRegistry();
function stripOwner(event) { return registry.stripOwner(event); }
function viewOwner(sender) { return registry.viewOwner(sender); }
function forEachProject(fn) { registry.forEach(fn); }
const fromStrip = (event) => stripOwner(event) !== null;
const isTabView = (sender) => viewOwner(sender) !== null;
// Holds each OS toast until it's clicked or closed, so its click can't be lost to garbage collection (#145).
const toasts = createToastHolder({
  Notification,
  onClick: (sender) => { const ts = launchWindow.tabShell; if (ts) ts.attentionClick(sender); },   // not viewOwner(sender): the click can outlive its tab view (PR 2: record the owner at show time)
  log: (m) => console.log(m),
});

// The indexing assistant (#66): main's half (startIndexing); the window gets it through attach(). Whether its field has the
// keyboard is the window's (indexFieldFocused).
let indexing = null;

// The tray icon's one controller (created in whenReady), and whether the app is really quitting: a close then goes through
// even with "Minimise to tray on close" on.
let trayController = null;
let quitting = false;

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

const canvasAsks = new Map();      // id -> { owner, resolve }: a host question waiting on the tab's page
let canvasAskSeq = 0;
// PROBE SEAM, only when the probe driver's port AND token are set (the same gate as the other seams): names the probe maps to an address, vouched
// for, so verify/probe-canvas-panel.js can serve a stub on loopback and still reach it BY A NAME through the real broker (which refuses every
// loopback address, and every literal one). Any other name goes to real DNS. A normal run has no map and the broker's own resolver.
const CANVAS_PROBE_HOSTS = (() => {
  if (!PROBE_PORT || !PROBE_TOKEN) return null;
  try { const m = JSON.parse(process.env.CLAUDE_CUSTOM_CANVAS_PROBE_HOSTS || 'null'); return m !== null && typeof m === 'object' ? m : null; } catch { return null; }
})();
const canvasProbeResolve = CANVAS_PROBE_HOSTS === null ? undefined
  : async (name) => (typeof CANVAS_PROBE_HOSTS[name] === 'string' ? [{ address: CANVAS_PROBE_HOSTS[name], family: 4, trusted: true }] : require('dns').promises.lookup(name, { all: true }));

function previewProbeProxy() {
  if (!PROBE_PORT || !PROBE_TOKEN) return undefined;
  const rules = process.env.CLAUDE_CUSTOM_PREVIEW_PROXY;
  if (rules === 'direct') return { mode: 'direct' };
  return typeof rules === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(rules) ? { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: require('./preview-views').PREVIEW_BYPASS } : undefined;
}

const probeConfirms = [];   // the probe driver's record of every confirm it was asked

// The kill switch's STOP ALL (documentation/PLAN_SAFETY_NET.md lane 2): the one question before every session on the machine stops.
// Cancel is the default. The probe driver has nobody to click and never writes the real file: it records the ask and answers no.
// STOP ALL is machine-wide, so the question sits on the window of the strip that asked (`parent`).
async function confirmStopAll(file, parent) {
  if (PROBE_PORT) { probeConfirms.push({ label: 'stop-all', reason: '', unsaved: null }); return false; }
  const r = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Stop every session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Stop every Claude session on this computer?',
    detail: `This writes ${file}. Every claude-custom session on this computer stops within a few seconds, and none starts again until that file is deleted.`,
  });
  return r.response === 0;
}

// A fire-and-forget shell call from IPC or a key never rejects unhandled
// (PR #80 Miguel Y2): it is logged with what was being done.
const logShellError = (what) => (err) => console.error(`[main] ${what} failed:`, (err && err.stack) || err);

// --- the ▾ menu: every running session (Windowless sessions PR 2) -----------------
// Every host of every build beside this one (host/background-hosts.js), proven
// by its OS start time. Open is for this build's own; Stop is PR 1's rules
// (host/stop-holder.js stopHost): never a session with a window open.
const INSTALL_DIR = path.join(__dirname, '..');

function listBackground() {
  return listBackgroundHosts({ ownInstall: INSTALL_DIR }, listDeps(INSTALL_DIR));
}

// --- the tray icon (BACKLOG #119 A8) ----------------------------------------------------------------------------------
// One per window process (each project window is its own Electron main). The rules are app/tray-model.js, the pixels
// app/tray-icon.js, the effects app/tray-controller.js; this hands them the real Electron and the shell.
function startTray() {
  if (!TRAY_ON) return;
  trayController = createTrayController({
    Tray, Menu, nativeImage, renderIcon: renderTrayIcon,
    getSettings: () => readTraySettings(uiStore),
    tabs: () => (launchWindow.tabShell ? launchWindow.tabShell.snapshot().tabs : []),
    windowLabel: () => launchWindow.label,
    isHidden: () => { const w = launchWindow.win; return !w || w.isDestroyed() || !w.isVisible(); },
    background: launchWindow.backgroundModel,
    now: () => Date.now(),
    log: (...a) => console.log(...a),
    actions: {
      focusWindow: launchWindow.focusWindow,
      selectTab: key => launchWindow.tabShell.select(key),
      openBackground: o => launchWindow.backgroundActions.open(o),
      // The same Stop as the ▾ menu: it asks first, every time. Its question needs a visible window to sit on.
      stopBackground: (row) => { launchWindow.focusWindow(); launchWindow.backgroundActions.stop(row).catch(() => {}); },
      hideAll: () => { const w = launchWindow.win; if (w && !w.isDestroyed()) w.hide(); },
      showAll: launchWindow.focusWindow,
      setStartMinimised: on => { writeTraySetting(uiStore, 'startMinimised', on === true); },
      // Unsaved reader text asks Save / Discard / Cancel on the window, so the window has to be visible to be answered.
      quit: () => { if (launchWindow.readerUnsaved.all().length > 0) launchWindow.focusWindow(); app.quit(); },
    },
  });
  launchWindow.attach({ trayController });
  trayController.sync();
  // Started hidden but no icon could be made (no tray area): a window nobody can reach is worse than a visible one.
  const w = launchWindow.win;
  if (!trayController.state().exists && w && !w.isDestroyed() && !w.isVisible()) launchWindow.focusWindow();
}

// --- IPC ---------------------------------------------------------------------------

function registerIpc() {
  // The secret service and the layout store are made once, from the launch's project (constants of the launch, so reading them off
  // the window object is safe). PR 2 of the single-instance work: both become per project.
  const { STATE_ROOT, PROJECT_ROOT } = launchWindow.identity;
  // Claude's panel (#71). The panel's own page talks on canvas:fetch / canvas:send only (registerCanvasIpc: main answers a
  // contents it made, nothing else). The channels below are the TAB's page, the trusted controller, and are gated on it.
  registerCanvasIpc(ipcMain, launchWindow.canvasViews);   // its sender is the panel's own contents, not a tab view (PR 2: dispatch by panel owner)
  ipcMain.handle('canvas:show', (e, req) => (isTabView(e.sender) && req && typeof req === 'object'
    ? viewOwner(e.sender).canvasViews.show(e.sender, req) : { ok: false, error: 'refused' }));
  ipcMain.on('canvas:bounds', (e, rect) => { if (isTabView(e.sender)) viewOwner(e.sender).canvasViews.setBounds(e.sender, rect); });
  ipcMain.on('canvas:cover', (e, on) => { if (isTabView(e.sender)) viewOwner(e.sender).canvasViews.setCovered(e.sender, on === true); });
  ipcMain.on('canvas:hosts', (e, hosts) => { if (isTabView(e.sender)) viewOwner(e.sender).canvasViews.setHosts(e.sender, hosts); });
  ipcMain.on('canvas:set-shelf', (e, items) => { if (isTabView(e.sender)) viewOwner(e.sender).canvasViews.setShelf(e.sender, items); });
  ipcMain.on('canvas:hide', (e) => { if (isTabView(e.sender)) viewOwner(e.sender).canvasViews.hide(e.sender); });
  // The Preview panel and the Dev servers chip (#119 A4). Every channel is the TAB's page, the trusted controller, and is gated on it. The dev
  // server's page has no channel at all: it gets no preload. What `reload`, `devtools` and `openExternal` act on is the view's own current
  // address, read here; the page never supplies one. `show` and `openPort` take a port or typed text, which app/preview-guard.js judges.
  ipcMain.handle('preview:show', (e, req) => (isTabView(e.sender) && req && typeof req === 'object'
    ? viewOwner(e.sender).previewViews.show(e.sender, req) : { ok: false, error: 'refused' }));
  ipcMain.on('preview:bounds', (e, rect) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.setBounds(e.sender, rect); });
  ipcMain.on('preview:cover', (e, on) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.setCovered(e.sender, on === true); });
  ipcMain.on('preview:hide', (e) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.hide(e.sender); });
  ipcMain.on('preview:reload', (e) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.reload(e.sender); });
  ipcMain.on('preview:devtools', (e) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.toggleDevTools(e.sender); });
  ipcMain.on('preview:open-external', (e) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.openExternal(e.sender); });
  ipcMain.on('preview:open-port', (e, port) => { if (isTabView(e.sender)) viewOwner(e.sender).previewViews.openPort(port); });
  ipcMain.handle('devservers:get', (e) => {
    const p = isTabView(e.sender) ? viewOwner(e.sender) : null;
    const tab = p ? p.tabShell.tabForSender(e.sender) : null;
    return tab && p.devServers ? p.devServers.snapshot(tab.key) : null;
  });
  // The Style tab's switch for the panel's MCP server (#71 question 8): the file the host reads when it builds `claude`'s arguments, so a
  // change takes effect on the next session. null means unknown (a read or write that failed): the page keeps asking, never guesses.
  ipcMain.handle('canvas:settings-get', (e) => (isTabView(e.sender) ? readMcpSetting(uiStore.dir) : null));
  ipcMain.handle('canvas:settings-set', (e, on) => (isTabView(e.sender) && typeof on === 'boolean' ? writeMcpSetting(uiStore.dir, on) : null));
  // BACKLOG #119 A2: the Style tab's switch for the claude-custom mod, the same shape as the panel's: the file the host reads when it builds `claude`'s
  // arguments (host/cc-mod-settings.js), so a change takes effect on the next session. null means unknown: the page keeps asking, never guesses.
  ipcMain.handle('ccmod:settings-get', (e) => (isTabView(e.sender) ? readModSetting(uiStore.dir) : null));
  ipcMain.handle('ccmod:settings-set', (e, on) => (isTabView(e.sender) && typeof on === 'boolean' ? writeModSetting(uiStore.dir, on) : null));
  ipcMain.on('canvas:host-answer', (e, a) => {
    if (!isTabView(e.sender)) return;
    const pending = a && canvasAsks.get(a.id);
    if (!pending || pending.owner !== e.sender) return;      // only the tab that was asked can answer
    canvasAsks.delete(a.id);
    pending.resolve(a.answer === 'allow' ? 'allow' : 'deny');
  });
  // The Resources panel (#63). `get` hands a page the last payload; `stop` is the Stop button, which main re-checks in
  // full (host/resource-stop.js) however the page asks.
  ipcMain.handle('resources:get', (e) => (isTabView(e.sender) && resources
    ? resources.get(!!viewOwner(e.sender).selectedView() && viewOwner(e.sender).selectedView().webContents === e.sender)
    : null));
  // The Games panel (#41): the bests for the panel's title, and a raise at the end of a round. The store refuses anything that is
  // not one of our games or not a whole count, so the page can't write anything else.
  ipcMain.handle('games:scores', (e) => (isTabView(e.sender) ? gameScores.read() : null));
  ipcMain.handle('games:submit', (e, game, score) => (isTabView(e.sender) ? gameScores.submit(game, score) : null));
  // Which pages show the Resources panel (the shared poller's 10 s / 30 s steps); keyed by the page, forgotten when it is destroyed.
  const resourceViewers = new Set();
  function noteResourcesViewer(sender, on) {
    if (!resourceViewers.has(sender.id)) {
      resourceViewers.add(sender.id);
      const id = sender.id;
      sender.once('destroyed', () => { resourceViewers.delete(id); if (resources) resources.forgetViewer(id); });
    }
    resources.setViewing(sender.id, on);
  }
  ipcMain.on('resources:viewing', (e, on) => { if (isTabView(e.sender) && resources) noteResourcesViewer(e.sender, on === true); });
  ipcMain.on('resources:chipOn', (e) => { e.returnValue = isTabView(e.sender) ? resourceChip.read() !== false : true; });
  ipcMain.handle('resources:setChip', (e, on) => (isTabView(e.sender) && resources ? resources.setChip(on) : null));
  ipcMain.handle('resources:stop', (e, req) => (isTabView(e.sender) && resources
    ? resources.stop(req)
    : { ok: false, reason: 'refused', text: 'refused' }));
  // Pause / Resume (#19): the same guard as Stop, re-checked in main (host/resource-pause.js) however the page asks.
  ipcMain.handle('resources:pause', (e, req) => (isTabView(e.sender) && resources
    ? resources.pause(req)
    : { ok: false, reason: 'refused', text: 'refused' }));
  ipcMain.handle('resources:resume', (e, req) => (isTabView(e.sender) && resources
    ? resources.resume(req)
    : { ok: false, reason: 'refused', text: 'refused' }));
  ipcMain.handle('resources:stopLeftovers', (e, req) => (isTabView(e.sender) && resources
    ? resources.stopLeftovers(req)
    : { ok: false, text: 'refused' }));
  // The strip page's own channels: gated on the window's OWN webContents, so a
  // tab's page (which has the other preload) cannot use them.
  ipcMain.on('strip:select', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    stripOwner(e).tabShell.select(key);
  });
  ipcMain.on('strip:close', (e, key, ifSafe) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    stripOwner(e).closeTabFlow(key, { ifSafe: ifSafe === true });
  });
  ipcMain.on('strip:stop', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    stripOwner(e).closeTabFlow(key, { stop: true });
  });
  ipcMain.on('strip:contextMenu', (e, key) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    const p = stripOwner(e);
    Menu.buildFromTemplate(p.tabMenuTemplate(key)).popup({ window: p.win });
  });
  // The Lanes ▾ menu (BACKLOG #139): the tabs the strip page couldn't fit, then the lanes with no tab (Not started, Merged, and the
  // ones closed by hand, which Ctrl+Shift+T also reopens). A row selects the lane, which starts its session and gives it a tab.
  // The shortcut is named in the label, not as an accelerator: main registers none (the key is handled in before-input-event).
  ipcMain.on('strip:lanes', (e, hidden) => {
    if (!fromStrip(e)) return;
    const asked = Array.isArray(hidden) ? hidden.filter(k => typeof k === 'string').slice(0, 200) : [];
    const p = stripOwner(e);
    Menu.buildFromTemplate(p.lanesMenuFor(asked)).popup({ window: p.win });
  });
  // Drag to reorder (#141): a lane's tab dropped before another's (null: the end). The shell checks both keys and saves the order.
  ipcMain.on('strip:reorder', (e, key, before) => {
    if (!fromStrip(e) || typeof key !== 'string') return;
    stripOwner(e).tabShell.reorder(key, typeof before === 'string' ? before : null);
  });
  // PR 3: the + menu -- New branch… (Contract A, then E) and a shell tab for the selected lane. The tabs closed by hand
  // are in the Lanes menu now.
  ipcMain.on('strip:plus', (e) => {
    if (!fromStrip(e)) return;
    const p = stripOwner(e);
    Menu.buildFromTemplate(p.plusMenuFor()).popup({ window: p.win });
  });
  // `issue` (BACKLOG #119 A6): the number of the GitHub issue the branch was picked from, so its brief is written.
  ipcMain.on('strip:create', (e, branch, issue) => {
    if (!fromStrip(e) || typeof branch !== 'string' || branch.length > 200) return;
    stripOwner(e).tabShell.createWorktree(branch, issueArg(issue)).catch(logShellError('create'));
  });
  // The form's "From an issue" list: the rows for a query (host/issues.js owns the matching and the naming), and the
  // list opening and closing (the shell's state, so the selected tab's page is hidden while it shows).
  ipcMain.handle('strip:issues', (e, req) => (fromStrip(e) && stripOwner(e).issueService
    ? answerIssuesRequest(stripOwner(e).issueService, stripOwner(e).hostProject.dev, req)
    : { ok: false, text: 'refused' }));
  ipcMain.on('strip:pickerOpen', (e) => {
    if (!fromStrip(e)) return;
    stripOwner(e).tabShell.openPicker();
  });
  ipcMain.on('strip:pickerClose', (e) => {
    if (!fromStrip(e)) return;
    stripOwner(e).tabShell.closePicker();
  });
  ipcMain.on('strip:cancelCreate', (e) => {
    if (!fromStrip(e)) return;
    stripOwner(e).tabShell.cancelCreate();
  });
  // Layout pass L2 (#28): a frameless window's own buttons. Close is the same
  // close as the OS frame's: the window goes, the hosts stay detached.
  ipcMain.on('strip:winMinimize', (e) => {
    if (!fromStrip(e)) return;
    stripOwner(e).win.minimize();
  });
  ipcMain.on('strip:winClose', (e) => {
    if (!fromStrip(e)) return;
    stripOwner(e).win.close();
  });
  // The ▾ menu. Answers when it closes, so the strip can show it was busy
  // (the list takes two powershell.exe, ~1-2 s); one at a time.
  let backgroundBusy = false;
  ipcMain.handle('strip:background', async (e) => {
    if (!fromStrip(e) || backgroundBusy) return;
    backgroundBusy = true;
    try { await stripOwner(e).showBackgroundMenu(); } catch (err) {
      console.log('[main] background menu failed:', err && err.message);
    } finally { backgroundBusy = false; }
  });
  // STOP ALL (host/kill-switch.js): one confirm, then ~/.claude/STOP-ALL, the file every host polls. One at a time. The file comes from
  // the home folder, never the CLI's config dir, so it is the same one every host watches; the probe seam stands in for it.
  let stopAllBusy = false;
  ipcMain.handle('strip:stopAll', async (e) => {
    if (!fromStrip(e) || stopAllBusy) return null;
    stopAllBusy = true;
    const p = stripOwner(e);
    try {
      const r = await runStopAll({
        seam: readSeams(process.env).claudeHome,
        home: os.homedir(),
        confirm: (file) => confirmStopAll(file, p.win),
        write: (f, data) => writeFileAtomic(f, data),
        // Hosts from before the kill switch don't watch the file (Dexter F3): say how many the file can't reach.
        countUnstoppable: () => countUnstoppable({ installs: stopAllInstalls(), identitiesIn, isAlive: defaultIsAlive }),
      });
      console.log(`[main] STOP ALL: ${r.outcome}${r.error ? ` (${r.error})` : ''} -> ${r.file}`);
      if (r.unstoppable) console.log('[main] STOP ALL: ' + r.unstoppable + ' older-build session(s) cannot be stopped by the file');
      if (r.outcome === 'failed' && p.win && !p.win.isDestroyed()) {
        dialog.showMessageBox(p.win, { type: 'error', buttons: ['OK'], message: "Couldn't write the stop file", detail: `${r.file}: ${r.error}. No session was stopped.` }).catch(() => {});
      }
      if (r.outcome === 'written' && r.unstoppable > 0 && p.win && !p.win.isDestroyed()) {
        dialog.showMessageBox(p.win, { type: 'warning', buttons: ['OK'], message: 'Some sessions are not covered', detail: describeUnstoppable(r.unstoppable) }).catch(() => {});
      }
      return r.outcome;
    } finally { stopAllBusy = false; }
  });

  // A tab's page talking to main. Every one gated on "one of THIS window's tab
  // views": a handler that answers anyone is not a boundary.
  // Focus mode's button, its exit, and Ctrl+B while it's on (layout pass L1).
  ipcMain.on('focus:toggle', (e) => {
    if (!isTabView(e.sender)) return;
    const owner = viewOwner(e.sender);
    owner.setFocusMode(!owner.focusMode);
  });
  ipcMain.on('focus:set', (e, on) => {
    if (!isTabView(e.sender) || typeof on !== 'boolean') return;
    viewOwner(e.sender).setFocusMode(on);
  });
  // Is this tab being looked at (selected, window focused)? The page asks before a held message knocks (PR #224, Dexter 4).
  ipcMain.handle('tab:is-looked', (e) => isTabView(e.sender) && viewOwner(e.sender).tabShell.isLooked(e.sender));
  ipcMain.on('tab:status', (e, status) => {
    if (!isTabView(e.sender)) return;
    viewOwner(e.sender).tabShell.report(e.sender, status);
  });
  // The look's accent, for the strip (#64): a #rrggbb and nothing else, kept per tab page and
  // pushed to the strip while that tab is the selected one.
  ipcMain.on('tab:accent', (e, hex) => {
    if (!isTabView(e.sender) || !viewOwner(e.sender).stripAccent.report(e.sender, hex)) return;   // only a #rrggbb is kept
    viewOwner(e.sender).pushStripAccent();
  });
  ipcMain.on('tab:close', (e) => {
    const owner = isTabView(e.sender) ? viewOwner(e.sender) : null;
    const tab = owner ? owner.tabShell.tabForSender(e.sender) : null;
    if (!tab) return;
    if (owner.mode === 'single') { if (owner.win && !owner.win.isDestroyed()) owner.win.close(); return; }
    if (!tab.isDev) owner.closeTabFlow(tab.key);
  });
  ipcMain.handle('tab:goTo', (e, holder) => (isTabView(e.sender)
    ? viewOwner(e.sender).tabShell.goTo(e.sender, holder)
    : { kind: 'explain', text: "That session's window can't be found." }));
  // The Git panel's *Jump to its tab*: select the tab whose worktree is that folder.
  ipcMain.handle('tab:selectFolder', (e, folder) => (isTabView(e.sender)
    ? viewOwner(e.sender).tabShell.selectFolder(e.sender, folder)
    : { kind: 'explain', text: "That tab's window can't be found." }));
  // The Git drawer (Enhancement #46): what the tabs of its worktrees are doing, and *Type /merged*, which
  // switches to that branch's tab and types `/merged` + Enter into its session.
  // Worktree occupancy: a page's first paint asks what is in its folder and what its session launched; after
  // that main pushes `occupancy` on change.
  ipcMain.handle('occupancy:get', (e) => (isTabView(e.sender) ? viewOwner(e.sender).tabShell.occupancyFor(e.sender) : null));
  ipcMain.handle('tab:states', (e, folders) => (isTabView(e.sender) ? viewOwner(e.sender).tabShell.tabStates(e.sender, folders) : []));
  ipcMain.handle('tab:typeMerged', (e, folder, branch) => (isTabView(e.sender)
    ? viewOwner(e.sender).tabShell.typeMerged(e.sender, folder, branch)
    : { kind: 'explain', text: "That tab's window can't be found." }));
  // The target page's answer to a `type-command` (PR #93 Dexter F3): it typed into its own box, or why not.
  ipcMain.on('tab:typed', (e, reply) => {
    if (!isTabView(e.sender)) return;
    viewOwner(e.sender).tabShell.typed(e.sender, reply);
  });
  // BACKLOG #139: the page's answer to `box-state` (is its CLI box at rest?), asked before a merged tab closes by itself.
  ipcMain.on('tab:boxState', (e, reply) => {
    if (!isTabView(e.sender)) return;
    viewOwner(e.sender).tabShell.boxAnswered(e.sender, reply);
  });
  // A link clicked in a tab's terminal (fix/terminal-links): straight to the
  // default browser, no prompt -- only what openInBrowser accepts.
  ipcMain.handle('tab:openExternal', (e, url) => {
    if (!isTabView(e.sender)) return false;
    const tab = viewOwner(e.sender).tabShell.tabForSender(e.sender);
    return openInBrowser(url, tab ? tab.key : 'a tab');
  });
  // A local path in a tab's terminal (#37). Main resolves it against THAT
  // tab's own folder, checks it exists, and decides open or reveal
  // (app/file-link.js); the page only asks. The click asks again, and main
  // decides again: the file can change between hover and click.
  ipcMain.handle('tab:checkPaths', (e, lists) => {
    if (!isTabView(e.sender)) return [];
    const tab = viewOwner(e.sender).tabShell.tabForSender(e.sender);
    return tab ? fileLink.check(lists, tab.cwd, fileFs) : [];
  });
  ipcMain.handle('tab:openPath', (e, p) => {
    if (!isTabView(e.sender)) return { ok: false, why: 'refused' };
    const tab = viewOwner(e.sender).tabShell.tabForSender(e.sender);
    if (!tab) return { ok: false, why: 'refused' };
    // Quoted: a path with a newline in it can't forge a log line (PR #92 Miguel S3).
    console.log(`[main] ${tab.key}: file link ${JSON.stringify(String(p).slice(0, 200))}`);
    return fileLink.open(p, tab.cwd, fileFs, shell);
  });
  // The code reader's unsaved file, or null (#50): kept per tab for the close questions (app/reader-unsaved.js).
  // Only a tab view reports (a single-session window has none, so its reader isn't tracked).
  ipcMain.on('tab:readerDirty', (e, p) => {
    const owner = isTabView(e.sender) ? viewOwner(e.sender) : null;
    const tab = owner ? owner.tabShell.tabForSender(e.sender) : null;
    if (tab) owner.readerUnsaved.report(tab.key, p);
  });
  // The Files tab (#45): Show in Explorer and drag-out. Main resolves the path against THAT tab's own
  // worktree and re-runs the realpath guard; the page only names a path relative to it.
  ipcMain.handle('tab:repoReveal', (e, rel) => {
    const tab = isTabView(e.sender) ? viewOwner(e.sender).tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.reveal(tab.cwd, rel) : { ok: false, why: 'refused' };
  });
  // Drag-out is two steps (PR #95 Miguel M2): the page asks main to PREPARE a file when the pointer reaches its
  // row (guard + is-a-file, cached), and at `dragstart` sends a SYNCHRONOUS start that calls startDrag in the same
  // tick, with nothing awaited between the gesture and the OS drag. `sendSync`: the reply (and any refusal)
  // comes back in the gesture too.
  ipcMain.handle('tab:repoDragPrepare', (e, rel) => {
    const tab = isTabView(e.sender) ? viewOwner(e.sender).tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.prepare(tab.cwd, rel) : { ok: false, why: 'refused' };
  });
  ipcMain.on('tab:repoDragStart', (e, rel) => {
    const tab = isTabView(e.sender) ? viewOwner(e.sender).tabShell.tabForSender(e.sender) : null;
    e.returnValue = tab ? repoActions.dragNow(tab.cwd, rel, (o) => e.sender.startDrag(o)) : { ok: false, why: 'refused' };
  });
  // The async fallback for a file that was not prepared yet: it checks first, then starts.
  ipcMain.handle('tab:repoDrag', (e, rel) => {
    const tab = isTabView(e.sender) ? viewOwner(e.sender).tabShell.tabForSender(e.sender) : null;
    return tab ? repoActions.drag(tab.cwd, rel, (o) => e.sender.startDrag(o)) : { ok: false, why: 'refused' };
  });
  // The receiving side of a host `raise`: select that tab and come forward.
  // flashFrame as well, because Windows may refuse to hand focus to a
  // background process.
  ipcMain.on('tab:raise', (e) => {
    if (!isTabView(e.sender)) return;
    const owner = viewOwner(e.sender);
    if (owner.tabShell.raise(e.sender) && owner.win && !owner.win.isDestroyed()) owner.win.flashFrame(true);
  });

  ipcMain.on('attention', (event, surfaces) => {
    if (!isTabView(event.sender) || !surfaces) return;
    const owner = viewOwner(event.sender);
    // Logged even when nothing is shown. "Suppressed because you are looking at
    // it" and "never arrived" are the same silence otherwise, and telling those
    // two apart is what took two wrong diagnoses to learn.
    if (!surfaces.toast) console.log(`[main] attention: suppressed (focused=${owner.focused})`);
    if (surfaces.toast && Notification.isSupported()) {
      // The click goes to the tab that raised it, and to the window; the holder keeps the toast alive until then.
      toasts.show(surfaces.toast, event.sender);
    }
    // Survives the toast: on Windows the taskbar button keeps flashing until
    // the window is looked at, which is the whole point for a blocked session.
    if (surfaces.flashTaskbar && !owner.focused && owner.win && !owner.win.isDestroyed()) owner.win.flashFrame(true);
    // Raised for ANY unfocused attention, not only urgent ones: "a task
    // finished while you were elsewhere" is precisely the case this is for,
    // and it costs nothing when you are already looking at the window.
    if (!owner.focused) owner.setCue(true);
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
  registerClipboardHandlers({ ipcMain, clipboard, win: launchWindow.win, isSender: isTabView });

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted GLOBALLY next to look-global -- see
  // favourites-bridge.js's header for why main owns this store directly.
  registerFavouriteHandlers({ ipcMain, store: uiStore, win: launchWindow.win, isSender: isTabView });

  // Agent pictures (BACKLOG C #13, #18): the file picker for a portrait and the
  // install-wide "show agent images" toggle, persisted GLOBALLY next to
  // look-global -- see avatar-bridge.js. A push goes to EVERY tab view.
  const avatarSync = {};
  const pushToViews = (channel, value) => launchWindow.forEachView((v) => v.webContents.send(channel, value));
  registerAvatarHandlers({ ipcMain, store: uiStore, win: launchWindow.win, dialog, sync: avatarSync, isSender: isTabView, send: pushToViews });
  // Other project windows are other mains sharing this store: follow their toggle.
  watchImagesEnabled({
    store: uiStore, win: launchWindow.win, sync: avatarSync, send: pushToViews,
    file: path.join(UI_STATE_DIR, `${AVATAR_KEY}.json`),
  });

  // Layout pass L2: "status line in the header" (#27; host/status-relay.js
  // reads the same file on every status fire) and "hide the title bar" (#28;
  // read by createWindow for the next window). See window-chrome-bridge.js.
  // The tray icon's switches (BACKLOG #119 A8), in the same record. Changing one applies at once: the icon appears or goes.
  registerTrayHandlers({ ipcMain, store: uiStore, isSender: isTabView, onChange: () => { if (trayController) trayController.sync(); } });
  const chromeSync = {};
  registerChromeHandlers({ ipcMain, store: uiStore, sync: chromeSync, isSender: isTabView, send: pushToViews });
  watchChromeSettings({
    store: uiStore, sync: chromeSync, send: pushToViews,
    file: path.join(UI_STATE_DIR, `${CHROME_KEY}.json`),
  });

  // Backlog #34: the background video plays only while the window is on screen and on mains.
  // Main reports the facts only it knows (minimised, hidden, on battery); the page decides.
  registerPlaybackHandlers({ ipcMain, win: launchWindow.win, powerMonitor, isSender: isTabView, send: pushToViews });

  // Lean mode (BACKLOG #62): one window-level state, told to every tab page and to the strip. The ☾ button and a
  // /bedtime night (reported by the tab pages from their host's word) drive it; see app/lean-state.js for the rules.
  // The nights the person sent Back to normal are kept across a restart (PR #140 Dexter F2), in the same install-wide record as the dim.
  const leanKept = (uiStore.read(UI_KEY, {}) || {}).leanDismissed;
  // Lean mode's bridge (app/lean-bridge.js): only the window reads it, through attach().
  const leanBridge = registerLeanHandlers({
    lean: createLean({
      dismissed: Array.isArray(leanKept) ? leanKept : [],
      onDismissed: (list) => {
        try { uiStore.update(UI_KEY, {}, (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), leanDismissed: unionDismissed(prev && prev.leanDismissed, list) })); }
        catch (err) { console.error('[main] could not save the dismissed nights:', err && err.message); }
      },
    }),
    ipcMain, isView: isTabView, isStrip: (sender) => fromStrip({ sender }),
    push: (state) => { pushToViews(LEAN_PUSH, state); const w = launchWindow.win; if (w && !w.isDestroyed()) w.webContents.send(LEAN_PUSH, state); },
    // the working agents' portraits go to the strip only (it draws them next to the lean chip)
    pushFaces: (list) => { const w = launchWindow.win; if (w && !w.isDestroyed()) w.webContents.send(LEAN_FACES_PUSH, list); },
  });
  launchWindow.attach({ leanBridge });

  // The dock layout (layout pass L1, see layout-bridge.js). A tab's OWN layout is its host's business, not main's.
  // BACKLOG #211: the layout is each PROJECT's own, in its `.claude-custom\` (the install-wide file only seeds a project
  // that has none yet), so another project's window is never moved by this one. Presets below stay install-wide.
  const layoutStore = createProjectLayoutStore({
    project: createStore({ dir: lookDir(STATE_ROOT) }), fallback: uiStore,
    usable: () => lookDirState(STATE_ROOT, fs) !== 'foreign', log: (...a) => console.warn(...a),
    prepare: () => {
      if (lookDirState(STATE_ROOT, fs) === 'foreign') throw new Error('.claude-custom is a link to somewhere else');
      ensureLookDir(STATE_ROOT, fs);
    },
  });
  const layoutSync = {};
  registerLayoutHandlers({ ipcMain, store: layoutStore, sync: layoutSync, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: layoutStore, sync: layoutSync, send: pushToViews,
    file: layoutStore.pathOf(LAYOUT_KEY),
  });
  // The split-tree layout (dockable panels D1) under its own key. The pair above stays: an older
  // window still writes it, and it is read once to migrate into the tree, never written by this build.
  const treeSync = {};
  registerLayoutHandlers({ ipcMain, store: layoutStore, sync: treeSync, names: TREE_NAMES, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: layoutStore, sync: treeSync, names: TREE_NAMES, send: pushToViews,
    file: layoutStore.pathOf(TREE_NAMES.key),
  });
  // The layout presets (dockable panels D3): a list, install-wide, under its own key. Same bridge, an array.
  const presetSync = {};
  registerLayoutHandlers({ ipcMain, store: uiStore, sync: presetSync, names: PRESET_NAMES, isSender: isTabView, send: pushToViews });
  watchLayout({
    store: uiStore, sync: presetSync, names: PRESET_NAMES, send: pushToViews,
    file: path.join(UI_STATE_DIR, `${PRESET_NAMES.key}.json`),
  });

  // Fonts (BACKLOG #88): the install-wide terminal and interface fonts, the list of installed families, and the same
  // follow-the-other-windows poll the layouts use (watchLayout reads the key and push channel from FONT_NAMES).
  // The tab strip and the indexing overlay are their own pages: they get the interface font as a --font-ui they read (uiFontScript).
  const fontsSync = {};
  const pushFonts = (channel, settings) => {
    pushToViews(channel, settings);
    const script = uiFontScript(settings);
    for (const wc of [launchWindow.win && launchWindow.win.webContents, ...indexingPages]) {
      try { if (wc && !wc.isDestroyed()) wc.executeJavaScript(script).catch(() => {}); } catch { /* the page is going away */ }
    }
  };
  const giveUiFont = (wc) => wc.on('did-finish-load', () => {
    try { wc.executeJavaScript(uiFontScript(readFontSettings(uiStore))).catch(() => {}); } catch { /* the page is going away */ }
  });
  giveUiFont(launchWindow.win.webContents);
  registerFontHandlers({ ipcMain, store: uiStore, sync: fontsSync, isSender: isTabView, send: pushFonts });
  watchLayout({
    store: uiStore, sync: fontsSync, names: FONT_NAMES, send: pushFonts,
    file: path.join(UI_STATE_DIR, `${FONT_NAMES.key}.json`),
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
      indexingPages.add(v.webContents);
      v.webContents.once('destroyed', () => indexingPages.delete(v.webContents));
      v.webContents.on('did-finish-load', () => {
        try { v.webContents.executeJavaScript(uiFontScript(readFontSettings(uiStore))).catch(() => {}); } catch { /* going away */ }
      });
      if (process.env.CLAUDE_CUSTOM_SCREENSHOT || PROBE_PORT) {
        v.webContents.on('console-message', (_e, level, message) => console.log(`[indexing-overlay] ${message}`));
      }
      return v;
    },
    overlayFile: path.join(__dirname, 'indexing-overlay.html'),
    getWin: () => launchWindow.win,
    isStrip: (sender) => fromStrip({ sender }),
    service,
    project: { root: launchWindow.root, label: launchWindow.label },
    docsFor,
    projects,
    viewTop: () => launchWindow.viewTop(),
    focusSelected: () => launchWindow.focusSelected(),
    setFieldFocused: (on) => launchWindow.setIndexFieldFocused(on),
    journalStamp: () => { try { const s = fs.statSync(journalFile); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } },
  });
  launchWindow.attach({ indexing });
  indexing.start(3000);
  indexing.push(true);
  // Warm the chip's list off-thread, so the first click doesn't wait for it.
  setTimeout(() => { projects(launchWindow.root).catch(() => {}); }, 15_000).unref();
}

// --- one window per project -------------------------------------------------------------------------------------
// A second launch of this project is answered by the first window (focus + the lane it named) and ends without a window. The logic is
// host/window-claim.js with these effects handed in; the pipe is up BEFORE the owner file names this process, and the owner says no
// while it is quitting or its start never finished.
const ownStartTime = createSelfStartTime();   // this process's own start time, asked once: the owner file, the claims and the sampler prove "this process" with it

// The project window (app/project-window.js): everything that was this file's per-project state. Made HERE, after every app-wide
// constant it is handed (a const read before its line is a TDZ error). Construction has no side effects: the claim hooks `exit`
// inside run(), and the window itself is made by createWindow() in whenReady.
const launchWindow = createProjectWindow({
  launchCwd: LAUNCH_CWD,
  electron: { app, BrowserWindow, WebContentsView, Menu, dialog, session },
  config: { EXPLICIT_PORT, STRIP_HEIGHT, POLL_MS, PROBE_PORT, PROBE_TOKEN, PROBE_LINE_MAX, TRAY_ON, ONE_WINDOW_ON },
  services: {
    uiStore, readDim, usageCounters, forProbe, openInBrowser, probeConfirms, logShellError, canvasProbeResolve, canvasAsks,
    nextCanvasAskId: () => ++canvasAskSeq,
    previewProbeProxy, stopHostByPid, occupantAt, tokenFileFor, ownIdentities, ownStartTime, waitForHost, HARNESS_DIR, INSTALL_DIR,
    listBackground, capture, stripFileFor,
    isQuitting: () => quitting,
    setQuitting: (v) => { quitting = v; },
  },
});
registry.add(launchWindow);

app.whenReady().then(async () => {
  console.log('[main] project       :', launchWindow.root, `(${launchWindow.mode})`);
  console.log('[main] launched on   :', LAUNCH_CWD);

  // Named and refused (see explicitPort): nothing sensible is left to do, and
  // opening a window anyway would show a terminal wired to nothing.
  if (EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) { app.exit(1); return; }

  // One window per project: before anything is made, ask whether this project's window already exists.
  if (await launchWindow.claim.run() === 'exit') { app.exit(0); return; }

  const seams = readSeams(process.env);
  const openPrsReader = seams.openPrsFixture
    ? fixtureReader(seams.openPrsFixture, { parse: parseOpenPrs, log: (line) => console.log(line) })
    : readOpenPrs;
  launchWindow.startServices({ seams, openPrsReader });

  // The Resources panel (#63). Identity files of every build beside this one say which pids are session hosts;
  // each is proven against the process table (host/resource-tree.js provenHosts) before anything is attributed.
  const resourceInstalls = () => { try { return installsBeside(INSTALL_DIR); } catch { return [INSTALL_DIR]; } };
  const cpuCores = require('os').cpus().length;
  // Read once and REMOVED from the environment, so it never reaches a host, a claude or a window started from them.
  const warnAtSeam = parseWarnAt(process.env.CLAUDE_CUSTOM_RESOURCE_WARN_AT);
  delete process.env.CLAUDE_CUSTOM_RESOURCE_WARN_AT;
  // The first window to start owns the sampling and publishes it; the others read. A probe's UI-state folder keeps its pool apart from the real one.
  const resourcePoller = createSharedPoller({
    dir: defaultPollerDir({ uiStateDir: seams.uiStateDir }),
    self: { pid: process.pid }, selfStart: ownStartTime, pidAlive: isPidAlive,
    // A listed pid whose start is not the recorded one is a reused pid, not the owner (host/pid-ledger.js's rule); a failed query keeps it.
    proveOwner: async (owner) => pollerPolicy.startProof(await startTimes([owner.pid]), owner),
    script: resourceScriptFor, makeExec: () => createPersistentExec(), oneShot: () => createPowerShellExec(),
    log: (...a) => console.log(...a),
  });
  resourceSampler = createSharedSampler({ poller: resourcePoller, cores: cpuCores, onUpdate: (snap) => { if (resources) resources.onUpdate(snap); }, log: (...a) => console.log(...a) });
  const ownProcStart = await ownStartTime().then(s => (typeof s === 'string' ? s : null), () => null);
  resources = createResourcesService({
    sampler: resourceSampler,
    tabs: () => launchWindow.tabShell.snapshot().tabs,
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
    send: (full, light) => { const sel = launchWindow.selectedView(); launchWindow.forEachView((v) => v.webContents.send('resources:state', v === sel ? full : light)); },
    // Stop ends exactly the set the guard computed, leaf first, each re-proved by pid and start time through a handle
    // (host/resource-kill.js): never a bare `taskkill /T`, which follows a stale parent link.
    kill: (targets) => killVerified(targets, { exec: createPowerShellExec(20000) }),
    // Pause / Resume (#19): NtSuspendProcess / NtResumeProcess on a handle that re-proves pid and start time (host/process-suspend.js).
    suspend: (action, targets) => suspendVerified(action, targets, { exec: createPowerShellExec(20000) }),
    // What is paused is kept on disk, so a crash can be undone at the next start (host/pause-persist.js).
    // An owner is a pid AND a start time: 'absent', the running process's start, or null (could not be told).
    pausePersist: createPausePersist({ dir: path.join(uiStore.dir, 'paused'), ownPid: process.pid, ownStart: ownProcStart,
      ownerState: async (pid) => { const m = await startTimes([pid]); return !m ? null : (m.has(pid) ? m.get(pid) : 'absent'); }, log: (...a) => console.log(...a) }),
    // Leftovers (#74): the shared pid ledger, and the stop (by the 15-minute clock or a click) of what it proves is ours. A kill is
    // killProvenAsync: the ledger's start is proven again on a held handle at the moment of the kill, off the main thread
    // (host/kill-tree.js); the launcher and the start are re-asked of Get-Process just before (host/leftovers-seams.js).
    ledger: () => pidLedger.readLedger(),
    reap: createLeftoverSeams({
      startTimes, kill: (pid, start) => killProvenAsync(pid, start),
      removeEntries: (entries) => pidLedger.removeEntries(pidLedger.defaultLedgerFile(), entries),
    }),
    // Big task-output files (#74 F(3)): stat-only scan of %TEMP%\claude every 60 s; the delete is host/task-logs-fs.js deleteTaskLog,
    // the only thing that removes a file. Live sessions are read from the CLI's session registry in main's config dir AND every open tab's (a relative CLAUDE_CONFIG_DIR is anchored on the tab folder).
    taskLogs: {
      everyMs: 60_000,
      scan: () => taskLogsFs.scanTaskFiles(taskLogsRoot),
      registry: () => taskLogsFs.readRegistries(taskLogsFs.registryDirs(launchWindow.tabShell.snapshot().tabs.map(t => t.cwd), claudeConfigDir)),
      remove: (row) => taskLogsFs.deleteTaskLog(taskLogsRoot, row),
    },
    // verify/probe-resource-panel.js only: the warning's CPU threshold (a percentage), 40 when unset or not one
    warnAt: warnAtSeam,
    refreshStrip: () => { const ts = launchWindow.tabShell; if (ts) ts.refresh(); },
    // Q2: install-wide, in the same store as the other window-wide UI state
    chipStore: resourceChip,
    log: (...a) => console.log(...a),
  });
  launchWindow.attach({ resources });
  // Other project windows are other mains sharing the saved file: follow their change of the chip, live, as the panels do.
  watchChip({ file: path.join(UI_STATE_DIR, `${CHIP_KEY}.json`), onChange: () => { if (resources) resources.reloadChip(); } });
  resourceSampler.start();
  resources.refresh();       // the sampler starts idle: wake it now, not when a selection happens to follow
  const sweepPaused = () => resources.wakeLeftover().catch((err) => console.log('[pause] waking the leftovers threw:', err && err.message));   // what a dead run left suspended (#19)
  sweepPaused();
  setInterval(sweepPaused, 60_000).unref();      // ...and a sibling window that died after this one started

  launchWindow.startDevServers();

  // No application menu bar, ever (Ricardo, 2026-09-30: every pixel of vertical
  // space). Electron paints its default File/Edit/View/Window/Help bar on
  // Windows only because none was set; null removes it. Set before the window.
  Menu.setApplicationMenu(null);
  launchWindow.createWindow();
  launchWindow.syncDevServersSampling();       // read AFTER the window exists, and after a start hidden to the tray
  registerIpc();
  startIndexing(seams);
  startTray();

  const first = await launchWindow.open();
  launchWindow.claim.markReady();        // from here a second launch is handed to this window
  if (launchWindow.attachOnlyRefusal) {
    launchWindow.claim.stop();           // this process is about to end: it is no window to hand a launch to
    console.error('[main] Open refused:', launchWindow.attachOnlyRefusal.reason);
    if (!PROBE_PORT && launchWindow.win && !launchWindow.win.isDestroyed()) {
      await dialog.showMessageBox(launchWindow.win, { type: 'info', buttons: ['OK'], message: attachOnlyText(launchWindow.attachOnlyRefusal) });
    }
    app.exit(1);
    return;
  }
  if (launchWindow.mode === 'single' && first && !first.started) {
    // The old behaviour, kept: a refused or unfindable port ends the launch.
    // A host that merely was slow leaves the window up, with its reason and Retry.
    console.error('[main] could not start:', first.error);
    if (first.error === NO_PORT_ERROR || /resolvePort:/.test(String(first.error))) {
      launchWindow.claim.stop();         // markReady() already ran: a launch held on this window must hear no, not ok, before the exit (PR #248 Dexter 1)
      app.exit(1);
      return;
    }
  }
  launchWindow.startPoll();

  // Headless verification path.
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT) launchWindow.runScreenshotPath();
  if (PROBE_PORT) launchWindow.startProbeDriver(PROBE_PORT);
}).catch((err) => {
  // A start that threw must not stay the project's owner: every later launch would be handed to a window that never comes up.
  console.error('[main] startup failed:', (err && err.stack) || err);
  launchWindow.claim.stop();
  const w = launchWindow.win;
  if (!w || w.isDestroyed()) app.exit(1);
});

// Closing the window detaches; it does not end the session.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => { forEachProject((p) => p.stopDevServers()); });
// A quit with processes paused from the Resources panel wakes them first (#19): a frozen process with nobody left to resume it stays frozen.
// The quit is held once, for as long as the resumes take, and then asked for again.
let pausedWoken = false;
app.on('will-quit', (e) => {
  if (!resources || pausedWoken || !resources.hasPaused()) return;
  pausedWoken = true;
  e.preventDefault();
  resources.resumeAll({ deadlineMs: 10000 }).catch(() => {}).finally(() => app.quit());
});
app.on('before-quit', () => { quitting = true; forEachProject((p) => p.claim.stop()); });   // a launch from here on opens its own window (close, then reopen)
app.on('will-quit', () => { if (trayController) trayController.destroy(); if (resourceSampler) resourceSampler.stop(); forEachProject((p) => p.closeOccupancy()); });
// A panel page that called window.print() leaves the browser unable to terminate; this ends the process if quitting stalls (app/quit-watchdog.js).
armQuitWatchdog(app, QUIT_LOG_FILE ? { onFire: () => quitMark('quit watchdog fires') } : {});
if (QUIT_LOG_FILE) markWillQuitEnd(app, quitMark);
