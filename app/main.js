'use strict';
/**
 * claude-custom :: Electron main  -- the app-wide half of the tab shell
 *
 * One Electron process per install (single-instance PR 3), any number of project windows (PR 2). A launch first runs the APP LOCK
 * (host/app-claim.js over `<state>\app.json` and the app pipe; on/off and where is host/app-lock-config.js, NOT Electron's
 * requestSingleInstanceLock, which is per user-data folder and would hand a test build's launch to the daily app): a running Jiandu of this
 * install gets the folder and this launch ends; else this process becomes it. Every open (that handoff, the tray, the ▾ menu, the probe
 * driver, a crash restore) is openProject (app/open-project.js) behind one queue (app/open-queue.js). Every window holds its own one-window
 * claim on the process's ONE routed window pipe (host/window-router.js). One tray speaks for every window; quit asks once for every
 * window's unsaved text (app/quit-gate.js); the crash-restore record is host/open-windows.js.
 * Everything that belongs to ONE project's window (its BrowserWindow, tab shell, marks, occupancy, views, dev servers, focus and cue
 * state, the one-window claim, the launch folder's MODE) lives in app/project-window.js, made by createProjectWindow() and started by
 * its own start(); the tabs/single modes are described there. app/project-registry.js is the registry of the windows.
 *
 * This file keeps what is app-wide and what must be registered once per process: every ipcMain handler (each reaches a window
 * through stripOwner(e) / viewOwner(sender) / registry.panelOwner(sender), or a per-window unit or record found the same way, never by
 * naming "the" window), the UI store, the tray (it sums and lists every window), the Resources service and sampler (over every window),
 * the per-project records (secrets, layout: app/project-records.js) and units (lean, indexing overlay), startProject (open a project in
 * this process), the launch order in whenReady and the quit handlers. The decisions themselves are pure and tested elsewhere
 * (host/tab-lifecycle.js, app/tab-model.js, app/tab-shell.js).
 */

const { app, BrowserWindow, WebContentsView, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell, powerMonitor, webContents } = require('electron');
const { createToastHolder, clickFor } = require('./toast-holder');
const { createProjectWindow } = require('./project-window');
const { createProjectRegistry } = require('./project-registry');
const { createPushers } = require('./push-targets');
const { createBusyGate } = require('./busy-gate');
const { createSeenGate } = require('./seen-gate');
const { createAppApi, startProbeServer } = require('./probe-driver');
const { createProjectLifecycle } = require('./project-lifecycle');
const { anyWindowHidden, needsYouKeys, windowlessItems, hidesOnClose, startsHidden } = require('./tray-model');
const { createHomeWindow } = require('./home-window');
const { createHomeController, windowFacts } = require('./home-controller');
const { createProjectRecords } = require('./project-records');
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
const { registerLeanHandlers, createLeanUnit, PUSH_CHANNEL: LEAN_PUSH, FACES_PUSH: LEAN_FACES_PUSH } = require('./lean-bridge');
const { createLean, unionDismissed } = require('./lean-state');
const { NO_PORT_ERROR } = require('./tab-shell');
const fs = require('fs');
const path = require('path');
const { projectLabel } = require('../host/project-path');

const { readIdentity, defaultIsAlive } = require('../host/host-identity');
const { lookDir, lookDirState, ensureLookDir } = require('../host/style');
const { createProjectLayoutStore } = require('./project-layout-store');
const { startTimes, patientStartTimes, createSelfStartTime, retryExec: procRetryExec, isAlive: isPidAlive } = require('../host/proc-start');
const { readOpenPrs, parseOpenPrs } = require('../host/open-prs');
const { readSeams, fixtureReader } = require('../host/probe-seams');
const { sanitizeDim } = require('../host/look');
const { createStore } = require('../host/store');
const { createUsageCounters, countingOff } = require('../host/usage-counters');
const { probePort } = require('../host/port-probe');
// BACKLOG #119 A6: the + form's "From an issue" list (the strip:issues channel); the lane's brief and the tab's link are the window's (app/project-window.js).
const { answerIssuesRequest, issueArg } = require('../host/issues');
const { externalUrl } = require('./external-link');
const { registerCanvasIpc, panelDispatch, HOST_RESOLVER_RULES } = require('./canvas-views');
const { readMcpSetting, writeMcpSetting } = require('../host/canvas-settings');
const { readModSetting, writeModSetting } = require('../host/cc-mod-settings');
const fileLink = require('./file-link');
const { createRepoActions } = require('./repo-actions');
// What app/file-link.js may ask the disk (#37): reads, nothing else. lstat and
// readlink come first, so a symlink to a share is refused before stat follows it.
const fileFs = { lstat: (p) => fs.promises.lstat(p), readlink: (p) => fs.promises.readlink(p),
  stat: (p) => fs.promises.stat(p), realpath: (p) => fs.promises.realpath(p) };
const { projectOf, samePath, isInside, normPath } = require('../host/project-layout');
const windowFocus = require('../host/window-focus');
const { createWindowRouter } = require('../host/window-router');
// The app lock (single-instance PR 3): one Jiandu process per install, a second launch hands its folder here.
const { appLockConfig } = require('../host/app-lock-config');
const { createAppClaim, ENV_NAMES: LAUNCH_ENV_NAMES } = require('../host/app-claim');
const { createOpenQueue } = require('./open-queue');
const { createOpenProject } = require('./open-project');
const { createQuitGate, questionText } = require('./quit-gate');
const { createAppLifecycle } = require('./app-lifecycle');
// The tray's one list of sessions with no window, over every window's tabs (appBackgroundModel).
const { menuModel } = require('./background-menu');
const { restoreDecision, createOpenWindowsWriter, readRecord } = require('../host/open-windows');
const appOwner = require('../host/app-owner');
const { proveOwner } = require('../host/owner-file');
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
const { createHomeRecord } = require('./home-record');
const { createHomePaths } = require('./home-paths');
const { createScoreStore } = require('../host/game-scores');
const { listDeps, hostStopDeps } = require('../host/stop-deps');
const { stopHost } = require('../host/stop-holder');
const { stopFolder, ENDED: STOP_ENDED } = require('../host/stop-folder');
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
const { createIndexingOverlay, registerIndexingHandlers } = require('./indexing-bridge');

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
// Jiandu Home (documentation/DESIGN_PROJECT_HUB.md): the projects Jiandu opened, the pins and the removed set, install-wide.
// Its disk facts per path are cached (app/home-paths.js, PR #263 Miguel Y2): a Home sync on main never stats a path it already placed,
// and never a UNC or \\?\ path at all. Cleared when the controller's source lists change.
const homePaths = createHomePaths({ projectOf, exists: (p) => fs.existsSync(p) });
const homeRecord = createHomeRecord({ store: uiStore, projectOf: homePaths.projectOf, log: (l) => console.log(l) });
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
// `claude-custom --home` (host/launch-target.js homeEnv): open Jiandu Home and no project. Read once and REMOVED, so no host or window
// started from here inherits it.
const HOME_LAUNCH = process.env.CLAUDE_CUSTOM_HOME === '1';
delete process.env.CLAUDE_CUSTOM_HOME;
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
const { pushToAll, pushToProject } = createPushers(registry);
function stripOwner(event) { return registry.stripOwner(event); }
function viewOwner(sender) { return registry.viewOwner(sender); }
function forEachProject(fn) { registry.forEach(fn); }
const fromStrip = (event) => stripOwner(event) !== null;
const isTabView = (sender) => viewOwner(sender) !== null;
// Holds each OS toast until it's clicked or closed, so its click can't be lost to garbage collection (#145).
const toasts = createToastHolder({
  Notification,
  onClick: clickFor(registry),   // the owner is recorded at show time (not viewOwner(sender): the click can outlive its tab view)
  log: (m) => console.log(m),
});

// The indexing assistant (#66): the app-wide half (startIndexing: the service, the chip's project list, the journal stamp). Each window's own
// overlay is made with its units (makeWindowUnits) and handed to the window through attach(). Whether its field has the keyboard is the
// window's (indexFieldFocused).
let indexingApp = null;
// The per-window units main makes for a window: its lean unit (over the process's one lean state, appLean) and its indexing overlay. Window -> { lean, overlay }.
const windowUnits = new Map();
// Backlog #34's playback bridge: one registration, watched per window (watchPlayback).
let playback = null;

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
// ONE tray for the process (single-instance PR 3, design §6 option A): it sums and lists every window. The rules are app/tray-model.js,
// the pixels app/tray-icon.js, the effects app/tray-controller.js; this hands them the real Electron, the registry and the shell.
// The sessions with no window: ONE list for the process, with the tab ports of every window (a tab of any window is not "windowless").
async function appBackgroundModel() {
  const tabsByPort = new Map();
  registry.forEach((p) => { if (p.tabShell) for (const t of p.tabShell.snapshot().tabs) if (Number.isInteger(t.port)) tabsByPort.set(t.port, t.key); });
  return menuModel(await listBackground(), { now: Date.now(), tabsByPort, projectRoot: null });
}
function startTray() {
  if (!TRAY_ON) return;
  trayController = createTrayController({
    Tray, Menu, nativeImage, renderIcon: renderTrayIcon,
    getSettings: () => readTraySettings(uiStore),
    windows: () => registry.list().map((p) => ({ root: p.root, label: p.label, tabs: p.tabShell ? p.tabShell.snapshot().tabs : [] })),
    lastUsed: () => { const w = registry.lastUsed(); return w ? w.root : null; },
    // ANY window hidden: hideAll / showAll act on every window, so the menu must offer "Show all" while one of them is hidden (PR #256 Dexter 6)
    // Jiandu Home counts as a window here (PR #263 Dexter 7; an open question, the default built): Show all / Hide all act on it too
    isHidden: () => anyWindowHidden([...registry.list().map((p) => p.win), ...(homeWindow.isOpen() ? [homeWindow.win()] : [])]),
    background: () => appBackgroundModel(),
    now: () => Date.now(),
    log: (...a) => console.log(...a),
    actions: {
      // Jiandu Home: the menu's Home row, and a left click with no project window to go to
      showHome: () => showHome(),
      // A row, or a left click: that window, and the tab waiting in it when there is one.
      focusWindow: (root, key) => { const w = registry.get(root); if (!w) return; if (key && w.tabShell) w.tabShell.select(key); w.focusWindow(); },
      // Open on a session with no window: a window here, in this process (DESIGN_TABS_SESSIONS.md 3.4; never an attach-only process).
      openBackground: (o) => (o && typeof o.cwd === 'string' ? openProject({ cwd: o.cwd, port: o.port, show: 'shown' }) : undefined),
      // The same Stop as the ▾ menu: it asks first, every time. Its question sits on the session's project window when that is open, else on
      // the window used last, shown first.
      stopBackground: (row) => {
        const p = row && typeof row.cwd === 'string' ? projectOf(row.cwd) : null;
        const w = (p && registry.get(p.root)) || registry.lastUsed();
        if (!w) return;
        w.focusWindow();
        w.backgroundActions.stop(row).catch(() => {});
      },
      hideAll: () => { registry.forEach((p) => { const w = p.win; if (w && !w.isDestroyed()) w.hide(); }); const h = homeWindow.win(); if (h) h.hide(); },
      // Home first, so a project window ends in front
      showAll: () => { if (homeWindow.isOpen()) homeWindow.show(); registry.forEach((p) => p.focusWindow()); },
      setStartMinimised: on => { writeTraySetting(uiStore, 'startMinimised', on === true); },
      // Unsaved reader text asks Save / Discard / Cancel on the window, so that window has to be visible to be answered.
      // The one quit question (app/quit-gate.js, before-quit) sits on a dirty window, shown first: the tray only asks to quit.
      quit: () => app.quit(),
    },
  });
  trayController.sync();
}

// --- Jiandu Home (documentation/DESIGN_PROJECT_HUB.md; plan documentation/PLAN_PROJECT_HUB.md H-PR2) -------------------------------
// ONE Home window per process (app/home-window.js), its logic app/home-controller.js (no Electron), its cards app/home-model.js. Home is
// not a project window: the registry never holds it, Electron's window-all-closed counts it (H5), and while it is open the last project
// window is dropped like any other (the lifecycle's othersStay) and the process stays (the app lifecycle's homeOpen).
const HOME_RECENTS = 50;              // the brief's default: how many Claude Code projects Home reads
const homeWindow = createHomeWindow({
  BrowserWindow, screen: require('electron').screen, store: uiStore,
  preload: path.join(__dirname, 'preload-home.js'), page: path.join(__dirname, 'home.html'), forProbe,
  hidesOnClose: () => hidesOnClose({ settings: readTraySettings(uiStore), trayExists: !!trayController && trayController.state().exists, quitting }),
  onChanged: () => windowsChanged(),
  // the project window's session-end rule (sessionEnded below): quitting, so a hidden Home closes, and the record clean (PR #263 Dexter 2)
  onSessionEnd: () => { quitting = true; markRecordClean(); },
  // a Home closed for good forgets its filter: the next Home starts with every card and an empty box (PR #263 Dexter 1)
  onClosed: () => homeController.closed(),
  log: (l) => console.log(l),
});
const homeController = createHomeController({
  record: homeRecord,
  readRecents: () => readRecentsOffThread({ projectsDir: readSeams(process.env).projectsDir || undefined, limit: HOME_RECENTS }),
  // each LIVE project window's tabs, needs and lanes (app/home-controller.js windowFacts; a dead registered window is closed: Dexter 8)
  windows: () => windowFacts(registry.list(), needsYouKeys),
  windowless: async () => windowlessItems(await appBackgroundModel()).map((it) => ({ cwd: it.row && it.row.cwd })),
  projectOf: homePaths.projectOf, exists: homePaths.exists, keyOf: normPath, labelOf: (root) => projectLabel(root),
  push: (payload) => homeWindow.send(payload),
  onSourcesChanged: () => homePaths.clear(),
  effects: {
    // every open takes the one open path (app/open-queue.js -> app/open-project.js): today's launch rules; H4: the project comes forward
    open: (cwd) => { openProject({ cwd, show: 'shown' }).catch(() => {}); },
    goTo: (root) => { const w = registry.get(root); if (w) w.focusWindow(); },
    closeWindow: (root) => { const w = registry.get(root); const bw = w && w.win; if (bw && !bw.isDestroyed()) bw.close(); },
    // through app/file-link.js, as every path handed to the OS is (#37: a folder opens in Explorer, nothing is ever run)
    showInExplorer: (root) => {
      fileLink.open(root, root, fileFs, shell).then((r) => { if (!r || r.ok !== true) console.log(`[main] home: Show in Explorer: ${r && r.why}`); },
        (err) => console.log(`[main] home: Show in Explorer: ${err && err.message}`));
    },
    chooseFolder: () => {
      const parent = homeWindow.win();
      const ask = { title: 'Choose a folder', properties: ['openDirectory'] };
      (parent ? dialog.showOpenDialog(parent, ask) : dialog.showOpenDialog(ask)).then((r) => {
        if (r && r.canceled !== true && Array.isArray(r.filePaths) && typeof r.filePaths[0] === 'string') openProject({ cwd: r.filePaths[0], show: 'shown' }).catch(() => {});
      }).catch(() => {});
    },
    // H-PR3 Stop its sessions: `claude-custom <folder> --stop`'s loop (host/stop-folder.js) with its deps, so the two cannot drift.
    // stopHost never stops a session with a window open, and never a pid it cannot prove.
    stopSessions: async (root) => {
      const rep = await stopFolder({ folder: root }, { list: () => listBackground(), stopHost: (row) => stopHost({ row }, hostStopDeps()) });
      for (const x of rep.results) console.log(`[main] home: Stop its sessions: ${x.outcome} (pid ${x.row.pid}, port ${x.row.port})`);
      const ended = rep.results.filter((x) => STOP_ENDED.has(x.outcome)).length;
      return { stopped: ended, kept: rep.kept, late: rep.late, verified: rep.verified === true,
        texts: rep.results.filter((x) => !STOP_ENDED.has(x.outcome)).map((x) => x.text) };
    },
    // H-PR3 New lane: the strip's + (app/tab-shell.js createWorktree) in the project's window, opened first when it is not
    newLane: async (root, branch) => {
      const o = await openProject({ cwd: root, show: 'shown' });
      if (!o || o.ok !== true) return { ok: false, error: (o && o.error) || 'the project did not open' };
      if (o.elsewhere) return { ok: false, error: 'that project\'s window is in another Jiandu; make the lane there' };
      const w = registry.get(o.root || root);
      const shell = w && w.tabShell;
      if (!shell) return { ok: false, error: 'the project\'s window did not start' };
      if (shell.snapshot().mode !== 'tabs') return { ok: false, error: 'a new lane needs a project with worktrees (a dev folder)' };
      return shell.createWorktree(branch);       // returned: the controller awaits it and answers its rejection
    },
  },
  log: (l) => console.log(l),
});
// Show Home (the --home launch, the app pipe's type 'home', the tray's Home, a restore): made, or brought forward, and its lists read again
// (forced: a show is when a person looks, so the cached disk facts go too).
function showHome({ hidden = false } = {}) {
  homeWindow.show({ hidden });
  homeController.refresh({ force: true }).catch(() => {});
}
function registerHomeIpc() {
  ipcMain.on('home:ready', (e) => { if (homeWindow.isSender(e.sender)) homeWindow.send(homeController.model()); });
  // an invoke: the page says what happened from main's answer, never before it (PR #263 Miguel Y3)
  ipcMain.handle('home:act', async (e, msg) => {
    if (!homeWindow.isSender(e.sender)) return { ok: false, error: 'not the Home page' };
    const r = await homeController.act(msg);      // Stop its sessions and New lane answer later (H-PR3)
    if (!r.ok) console.log(`[main] home: ${JSON.stringify(msg && msg.action)} refused: ${r.error}`);
    return r;
  });
  // While Home is shown its lists stay fresh: the recents and the windowless sessions at most once a minute (app/home-controller.js
  // RECENTS_MAX_AGE_MS), so this beat starts no powershell of its own (Miguel G2). The live state comes with every strip push.
  setInterval(() => { if (homeWindow.isVisible()) homeController.refresh().catch(() => {}); }, 30_000).unref();
}


  // The secret store lives HERE, in main. Not in the host: the host owns the
  // pty, so keeping secrets out of it means no wiring mistake can put one into
  // the session. Not in the renderer: the window would then hold the file and
  // every value in it.
function makeProjectSecrets(p) {
  const { stateRoot: STATE_ROOT, root: PROJECT_ROOT, launchCwd: LAUNCH_CWD } = p;
  return createSecretService({
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
}

// The dock layout (layout pass L1, see layout-bridge.js). A tab's OWN layout is its host's business, not main's.
// BACKLOG #211: the layout is each PROJECT's own, in its `.claude-custom` folder, so another project's window is never moved by this one; the
// install-wide file only seeds a project that has none yet. Presets stay install-wide (registerIpc).
function makeProjectLayoutStore(p) {
  const STATE_ROOT = p.stateRoot;
  return createProjectLayoutStore({
    project: createStore({ dir: lookDir(STATE_ROOT) }), fallback: uiStore,
    usable: () => lookDirState(STATE_ROOT, fs) !== 'foreign', log: (...a) => console.warn(...a),
    prepare: () => {
      if (lookDirState(STATE_ROOT, fs) === 'foreign') throw new Error('.claude-custom is a link to somewhere else');
      ensureLookDir(STATE_ROOT, fs);
    },
  });
}

// Each project window's secrets, layout store and layout watchers (app/project-records.js). Made when a window is.
const projectRecords = createProjectRecords({
  makeSecrets: makeProjectSecrets,
  makeLayoutStore: makeProjectLayoutStore,
  pushToProject,
  log: (...a) => console.log(...a),
  // Other project windows are other mains sharing the store files: follow their change, live. The pair stays for older windows.
  watch: ({ layoutStore, layoutSync, treeSync, send }) => [
    watchLayout({ store: layoutStore, sync: layoutSync, send, file: layoutStore.pathOf(LAYOUT_KEY) }),
    watchLayout({ store: layoutStore, sync: treeSync, names: TREE_NAMES, send, file: layoutStore.pathOf(TREE_NAMES.key) }),
  ],
});

// --- IPC ---------------------------------------------------------------------------

function registerIpc() {
  // Claude's panel (#71). The panel's own page talks on canvas:fetch / canvas:send only (registerCanvasIpc: main answers a
  // contents it made, nothing else). The channels below are the TAB's page, the trusted controller, and are gated on it.
  registerCanvasIpc(ipcMain, panelDispatch((s) => registry.panelOwner(s)));   // its sender is the panel's own contents, not a tab view: routed by panel owner
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
  const backgroundBusy = createBusyGate();     // per window's strip: a busy ▾ in one window never blocks another's
  ipcMain.handle('strip:background', async (e) => {
    if (!fromStrip(e)) return;
    const owner = stripOwner(e);
    if (!backgroundBusy.enter(owner)) return;
    try { await owner.showBackgroundMenu(); } catch (err) {
      console.log('[main] background menu failed:', err && err.message);
    } finally { backgroundBusy.leave(owner); }
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
      toasts.show(surfaces.toast, { sender: event.sender, owner });
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


  const fromWindow = (event) => isTabView(event.sender);
  // Each window's secrets are its own service over its own vault (Q1 default: unlocking in one window leaves another locked).
  const secretsFor = (event) => (fromWindow(event) ? projectRecords.secretsOf(viewOwner(event.sender)) : null);
  ipcMain.handle('secrets:available', (e) => { const s = secretsFor(e); return s !== null && s.available(); });
  ipcMain.handle('secrets:list', (e, query) => { const s = secretsFor(e); return s !== null ? s.list({ query }) : []; });
  ipcMain.handle('secrets:add', (e, entry) => { const s = secretsFor(e); return s !== null ? s.add(entry || {}) : { ok: false }; });
  ipcMain.handle('secrets:remove', (e, id) => { const s = secretsFor(e); return s !== null ? s.remove(id) : { ok: false }; });
  ipcMain.handle('secrets:reveal', (e, id) => { const s = secretsFor(e); return s !== null ? s.reveal(id) : { ok: false }; });
  ipcMain.handle('secrets:copy', (e, id) => { const s = secretsFor(e); return s !== null ? s.copy(id) : { ok: false }; });

  // The lock. Same `fromWindow` gate as everything above it: a handler that
  // answers anyone is not a boundary.
  // `hasKey: true` as well as `locked: true`, and `count: null`. An unauthorized
  // sender must get the shape that draws as LOCKED and reveals nothing --
  // `hasKey: false` with `locked: true` was already safe, but it says "locked
  // vault with no key", which is not a state that exists. Now this default and
  // the service's (secret-service.js, Dexter F6 / Miguel A2) are the same object.
  ipcMain.handle('secrets:lockState', (e) => {
    const s = secretsFor(e);
    return s !== null ? s.lockState() : { hasKey: true, locked: true, count: null };
  });
  ipcMain.handle('secrets:setKey', (e, key) => { const s = secretsFor(e); return s !== null ? s.setKey(key) : { ok: false }; });
  ipcMain.handle('secrets:unlock', (e, key) => { const s = secretsFor(e); return s !== null ? s.unlock(key) : { ok: false }; });
  ipcMain.handle('secrets:lock', (e) => { const s = secretsFor(e); return s !== null ? s.lock() : { ok: false }; });
  ipcMain.handle('secrets:removeKey', (e) => { const s = secretsFor(e); return s !== null ? s.removeKey() : { ok: false }; });
  ipcMain.handle('secrets:melt', (e) => { const s = secretsFor(e); return s !== null ? s.melt() : { ok: false }; });

  // Ctrl+V (BACKLOG #12, #8): the page asks, main reads the clipboard.
  registerClipboardHandlers({ ipcMain, clipboard, isSender: isTabView });

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted GLOBALLY next to look-global -- see
  // favourites-bridge.js's header for why main owns this store directly.
  registerFavouriteHandlers({ ipcMain, store: uiStore, isSender: isTabView });

  // Agent pictures (BACKLOG C #13, #18): the file picker for a portrait and the
  // install-wide "show agent images" toggle, persisted GLOBALLY next to
  // look-global -- see avatar-bridge.js. A push goes to EVERY tab view.
  const avatarSync = {};
  const windowOf = (sender) => { const p = viewOwner(sender); return p ? p.win : null; };   // the asking page's own window (a dialog's parent)
  registerAvatarHandlers({ ipcMain, store: uiStore, dialog, sync: avatarSync, isSender: isTabView, send: pushToAll, parentFor: windowOf });
  // Other project windows are other mains sharing this store: follow their toggle.
  watchImagesEnabled({
    store: uiStore, sync: avatarSync, send: pushToAll,
    file: path.join(UI_STATE_DIR, `${AVATAR_KEY}.json`),
  });

  // Layout pass L2: "status line in the header" (#27; host/status-relay.js
  // reads the same file on every status fire) and "hide the title bar" (#28;
  // read by createWindow for the next window). See window-chrome-bridge.js.
  // The tray icon's switches (BACKLOG #119 A8), in the same record. Changing one applies at once: the icon appears or goes.
  registerTrayHandlers({ ipcMain, store: uiStore, isSender: isTabView, onChange: () => { if (trayController) trayController.sync(); } });
  const chromeSync = {};
  registerChromeHandlers({ ipcMain, store: uiStore, sync: chromeSync, isSender: isTabView, send: pushToAll });
  watchChromeSettings({
    store: uiStore, sync: chromeSync, send: pushToAll,
    file: path.join(UI_STATE_DIR, `${CHROME_KEY}.json`),
  });

  // Backlog #34: the background video plays only while the window is on screen and on mains.
  // Main reports the facts only it knows (minimised, hidden, on battery); the page decides. One registration; each window is watched.
  playback = registerPlaybackHandlers({ ipcMain, powerMonitor, isSender: isTabView, winOf: (sender) => { const p = viewOwner(sender); return p ? p.win : null; } });
  registry.forEach(watchPlayback);      // a window made before this ran (every later one is watched from its onWindowCreated)

  // Lean mode (BACKLOG #62): each window's own state, told to that window's tab pages and strip (app/lean-bridge.js createLeanUnit, made
  // by makeWindowUnits). The channels are registered once and each message goes to the unit of the window it came from.
  registerLeanHandlers({
    ipcMain,
    unitOf: (sender) => {
      const v = viewOwner(sender);
      if (v !== null) { const u = windowUnits.get(v); return u ? { unit: u.lean, isView: true } : null; }
      const st = registry.stripOwner({ sender });
      if (st !== null) { const u = windowUnits.get(st); return u ? { unit: u.lean, isView: false } : null; }
      return null;
    },
  });

  // The dock layout and the split tree are each PROJECT's own: registered once, served from the asking page's window's own store
  // (app/project-records.js; the watchers that follow the files are started with the window's record).
  registerLayoutHandlers({ ipcMain, scopeFor: projectRecords.scopeFor(viewOwner, 'layoutSync') });
  registerLayoutHandlers({ ipcMain, names: TREE_NAMES, scopeFor: projectRecords.scopeFor(viewOwner, 'treeSync') });
  // The layout presets (dockable panels D3): a list, install-wide, under its own key. Same bridge, an array.
  const presetSync = {};
  registerLayoutHandlers({ ipcMain, store: uiStore, sync: presetSync, names: PRESET_NAMES, isSender: isTabView, send: pushToAll });
  watchLayout({
    store: uiStore, sync: presetSync, names: PRESET_NAMES, send: pushToAll,
    file: path.join(UI_STATE_DIR, `${PRESET_NAMES.key}.json`),
  });

  // Fonts (BACKLOG #88): the install-wide terminal and interface fonts, the list of installed families, and the same
  // follow-the-other-windows poll the layouts use (watchLayout reads the key and push channel from FONT_NAMES).
  // The tab strip and the indexing overlay are their own pages: they get the interface font as a --font-ui they read (uiFontScript).
  const fontsSync = {};
  const pushFonts = (channel, settings) => {
    pushToAll(channel, settings);
    const script = uiFontScript(settings);
    const strips = []; registry.forEach((p) => strips.push(p.win && p.win.webContents));   // every window's strip page, then the overlays
    for (const wc of [...strips, ...indexingPages]) {
      try { if (wc && !wc.isDestroyed()) wc.executeJavaScript(script).catch(() => {}); } catch { /* the page is going away */ }
    }
  };
  registry.forEach(giveUiFont);     // a window made before this ran (every later one gets it from its onWindowCreated)
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
      // Read now, not at registration: registerIpc runs before startProject makes the launch window's record (PR #256 Miguel B2).
      const secrets = projectRecords.secretsOf(launchWindow);     // the launch window's service (null before it exists)
      if (secrets === null) { console.log('[vault-probe] no secret service for the launch window'); return; }
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
// The service and the journal are shared by every window; each window has its own overlay (project, toast, list, views). The probe seam points
// the journal at a throwaway one.
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
  const journalStamp = () => { try { const st = fs.statSync(journalFile); return `${st.size}:${st.mtimeMs}`; } catch { return 'none'; } };
  indexingApp = { service, docsFor, projects, journalStamp };
  registerIndexingHandlers({
    ipcMain,
    overlayOfStrip: (sender) => { const p = registry.stripOwner({ sender }); const u = p !== null ? windowUnits.get(p) : null; return u ? u.overlay : null; },
    overlayOfPage: (sender) => { for (const u of windowUnits.values()) if (u.overlay.partOf({ sender }) !== null) return u.overlay; return null; },
  });
  // ONE timer for the process: the service ticks once, then each window's overlay decides, by its own last stamp, whether that was news.
  const timer = setInterval(() => {
    Promise.resolve(service.tick()).catch(() => {}).then(() => {
      const stamp = journalStamp();
      for (const u of windowUnits.values()) u.overlay.tick(stamp);
    });
  }, 3000);
  if (typeof timer.unref === 'function') timer.unref();
  // Warm the chip's list off-thread, so the first click doesn't wait for it.
  setTimeout(() => { const w = launchWindow || registry.first(); if (w) projects(w.root).catch(() => {}); }, 15_000).unref();
}

/** One window's overlay (its own project, toast, list and views) over the shared service. */
function makeIndexingOverlay(pw) {
  const { service, docsFor, projects } = indexingApp;
  return createIndexingOverlay({
    Menu, shell,
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
    getWin: () => pw.win,
    service,
    project: { root: pw.root, label: pw.label },
    docsFor,
    projects,
    viewTop: () => pw.viewTop(),
    focusSelected: () => pw.focusSelected({ evenWithField: true }),   // the overlay's own leave / close-list: the person is done with the field
    setFieldFocused: (on) => pw.setIndexFieldFocused(on),
  });
}

/** What a window gets when main makes it: its lean state and its indexing overlay, handed to the window before anything runs. */
// Lean mode is ONE state for the whole process (Ricardo, 2026-11-11: "All of Jiandu"): lean on in any window, or a /bedtime night in any
// project, makes every window lean, and a window opened while lean comes up lean. Nights are kept per tab view (owner = the view's id), so a
// closed view still drops its own night; faces stay per window's strip. Made once, on first use.
let sharedLean = null;
function appLean() {
  if (sharedLean !== null) return sharedLean;
  // The nights the person sent Back to normal are kept across a restart (PR #140 Dexter F2), in the same install-wide record as the dim.
  const leanKept = (uiStore.read(UI_KEY, {}) || {}).leanDismissed;
  sharedLean = createLean({
    dismissed: Array.isArray(leanKept) ? leanKept : [],
    onDismissed: (list) => {
      try { uiStore.update(UI_KEY, {}, (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), leanDismissed: unionDismissed(prev && prev.leanDismissed, list) })); }
      catch (err) { console.error('[main] could not save the dismissed nights:', err && err.message); }
    },
  });
  return sharedLean;
}
// Every window's views and strip hear a lean change.
function pushLeanToAll(state) {
  registry.forEach((p) => {
    pushToProject(p)(LEAN_PUSH, state);
    const w = p.win;
    if (w && !w.isDestroyed()) w.webContents.send(LEAN_PUSH, state);
  });
}
function makeWindowUnits(pw) {
  const toStrip = (channel, value) => { const w = pw.win; if (w && !w.isDestroyed()) w.webContents.send(channel, value); };
  const lean = createLeanUnit({
    lean: appLean(),
    push: pushLeanToAll,
    // the working agents' portraits go to this window's strip only (it draws them next to the lean chip)
    pushFaces: (list) => toStrip(LEAN_FACES_PUSH, list),
  });
  const overlay = makeIndexingOverlay(pw);
  windowUnits.set(pw, { lean, overlay });
  pw.attach({ leanBridge: lean, indexing: overlay });
  overlay.push(true);
}

// What a window is handed the moment it is made (its own pages are loading, so this tick): the interface font and the playback watch.
const fontGiven = new WeakSet();
function giveUiFont(pw) {
  const w = pw.win;
  if (!w || fontGiven.has(pw)) return;
  fontGiven.add(pw);
  w.webContents.on('did-finish-load', () => {
    try { w.webContents.executeJavaScript(uiFontScript(readFontSettings(uiStore))).catch(() => {}); } catch { /* the page is going away */ }
  });
}
const playbackWatched = new Map();      // window -> the function that stops watching it
function watchPlayback(pw) {
  if (playback === null || !pw.win || playbackWatched.has(pw)) return;
  playbackWatched.set(pw, playback.watch(pw.win, pushToProject(pw)));
}
function windowCreated(pw) { giveUiFont(pw); watchPlayback(pw); }

// --- one window per project -------------------------------------------------------------------------------------
// A second launch of this project is answered by the first window (focus + the lane it named) and ends without a window. The logic is
// host/window-claim.js with these effects handed in; the pipe is up BEFORE the owner file names this process, and the owner says no
// while it is quitting or its start never finished.
// This process's own start time, asked once: the owner file, the claims and the sampler prove "this process" with it. A first query that
// timed out on a busy machine is asked once more on the longer budget (fix/owner-proof: it was 'no-self-start', a second process).
const ownStartTime = createSelfStartTime({ retryExec: procRetryExec });

// --- the Resources service (#63) -----------------------------------------------------------------------------
// One per process, made before any window: windows read it through getResources(). Its tabs are the union of every window's.
const allTabs = () => registry.list().flatMap((p) => (p.tabShell ? p.tabShell.snapshot().tabs : []));
async function startResources(seams) {
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
    tabs: allTabs,
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
    // every window's views hear it; each window's SELECTED view gets the full payload (with the history), the rest the light one
    send: (full, light) => registry.forEach((p) => { const sel = p.selectedView(); p.forEachView((v) => v.webContents.send('resources:state', v === sel ? full : light)); }),
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
      registry: () => taskLogsFs.readRegistries(taskLogsFs.registryDirs(allTabs().map(t => t.cwd), claudeConfigDir)),
      remove: (row) => taskLogsFs.deleteTaskLog(taskLogsRoot, row),
    },
    // verify/probe-resource-panel.js only: the warning's CPU threshold (a percentage), 40 when unset or not one
    warnAt: warnAtSeam,
    refreshStrip: () => registry.forEach((p) => { const ts = p.tabShell; if (ts) ts.refresh(); }),
    // Q2: install-wide, in the same store as the other window-wide UI state
    chipStore: resourceChip,
    log: (...a) => console.log(...a),
  });
  // Other project windows are other mains sharing the saved file: follow their change of the chip, live, as the panels do.
  watchChip({ file: path.join(UI_STATE_DIR, `${CHIP_KEY}.json`), onChange: () => { if (resources) resources.reloadChip(); } });
  resourceSampler.start();
  resources.refresh();       // the sampler starts idle: wake it now, not when a selection happens to follow
  const sweepPaused = () => resources.wakeLeftover().catch((err) => console.log('[pause] waking the leftovers threw:', err && err.message));   // what a dead run left suspended (#19)
  sweepPaused();
  setInterval(sweepPaused, 60_000).unref();      // ...and a sibling window that died after this one started
}

// The process's ONE window pipe (single-instance PR 3, host/window-router.js): every window's claim registers its entry here, and a launch
// of any project this process holds is routed to that project's window by the root it names.
const windowRouter = createWindowRouter({ listen: windowFocus.listen, pid: process.pid, projectOf, samePath, isInside, log: (...a) => console.log(...a) });

// --- the app lock (single-instance PR 3) -------------------------------------------------------------------------------------------
// Whether it is on for this launch, and where app.json lives, is one pure table (host/app-lock-config.js): off for a named port,
// attach-only, the screenshot path and every probe but the single-instance one (which then has its own state folder).
const APP_LOCK = appLockConfig({ env: process.env, installDir: INSTALL_DIR, explicitPort: EXPLICIT_PORT, seams: readSeams(process.env) });
// Every open of a project in this process goes through ONE queue (app/open-queue.js): one at a time, a stuck start frees its slot.
const opener = createOpenProject({
  startProject: (cwd, opts) => startProject(cwd, opts),
  exists: (p) => fs.existsSync(p),
  pickLane: (tabs, o) => require('../host/window-owner').pickLane(tabs, o),
  envNames: LAUNCH_ENV_NAMES,
  ownEnv: process.env,
  closeWindow: (pw) => { const w = pw.win; if (w && !w.isDestroyed()) w.destroy(); },
  log: (l) => console.log(l),
});
const openQueue = createOpenQueue({ open: (o) => opener.openProject(o), log: (l) => console.log(l) });
function openProject(o) { return openQueue.push(o); }
// The claim a launch runs first: hand the folder to the running Jiandu of this install ('exit'), or become it. Ready only once the first
// window settled and this process decided to stay (whenReady); until then a launch is held, so an owner that ends never swallowed one.
const appClaim = createAppClaim({
  enabled: APP_LOCK.on,
  // the owner proves itself on its app pipe first (host/app-claim.js); the query behind it gets its one retry (fix/owner-proof)
  dir: APP_LOCK.dir, pid: process.pid, ownStart: () => ownStartTime(), startTimes: patientStartTimes,
  launchCwd: LAUNCH_CWD, installDir: INSTALL_DIR, probe: APP_LOCK.probe, env: process.env, samePath,
  // Jiandu Home: `claude-custom --home` sends type 'home' (host/app-claim.js), and the running Jiandu shows its Home
  home: HOME_LAUNCH,
  act: (msg) => (msg.home === true ? showHome() : openProject({ cwd: msg.cwd, env: msg.env, show: 'shown' })),
  onExit: (fn) => onProcessExit('app', fn),        // main's one exit hook (below); its entry is never dropped
  refuse: () => appLifecycle.refuseLaunches(),     // the quit question is up: a launch opens its own process (PR #258 Dexter 13)
  log: (...a) => console.log(...a),
});
// A launch handed to the running Jiandu leaves with app.exit(0), which skips will-quit: its cache folder goes now (app/cache-dirs.js).
function removeOwnCache() { require('./cache-dirs').removeOwn(); }

// ONE process 'exit' hook for every window (a listener per window warns past ten): each window's claim releases its owner file here, since
// app.exit skips will-quit. A window that closed while another stays has released its file in dispose(), so its entry goes (dropExit).
const exitHooks = new Map();         // window -> [fn]
process.on('exit', () => {
  for (const fns of exitHooks.values()) for (const fn of fns) { try { fn(); } catch { /* the next launch proves a leftover dead */ } }
});
function onProcessExit(pw, fn) { const fns = exitHooks.get(pw) || []; fns.push(fn); exitHooks.set(pw, fns); }

// The process-level decisions (app/app-lifecycle.js, behaviour-tested): the lock, the restore record, the quit. Main hands in the effects.
const OPEN_WINDOWS_FILE = path.join(UI_STATE_DIR, 'open-windows.json');
const appLifecycle = createAppLifecycle({
  registry, openQueue, appClaim, lockOn: APP_LOCK.on, pid: process.pid,
  ownStart: () => ownStartTime(),
  readLockOwner: () => (APP_LOCK.on ? appOwner.read(APP_LOCK.dir) : null),
  readRecord: () => readRecord(OPEN_WINDOWS_FILE),
  // PR #261 Dexter 3: the query with its one retry; an 'unknown' after one slow query would keep no window of a crashed run
  proveOwner: (owner) => proveOwner(owner, { startTimes: patientStartTimes }),
  decide: (record, proof, launchRoot) => restoreDecision({ record, proof, bootAt: Date.now() - os.uptime() * 1000, launchRoot,
    exists: (p) => fs.existsSync(p), samePath }),
  makeWriter: ({ owner, owns }) => createOpenWindowsWriter({ file: OPEN_WINDOWS_FILE, owner, owns, homeOpen: () => homeWindow.isOpen(),
    homeHidden: () => homeWindow.isHidden() }),
  // Jiandu Home: an open Home keeps the process (H5), and a crash restore brings it back when it was open (H9), hidden when it was
  // hidden to the tray and a tray is there to reach it (PR #263 Miguel G1)
  homeOpen: () => homeWindow.isOpen(),
  showHome: (o) => showHome({ hidden: !!o && o.hidden === true && !!trayController && trayController.state().exists }),
  openProject: (o) => openProject(o),
  quit: () => app.quit(),
  getLaunchWindow: () => launchWindow,
  quitGate: { reset: () => quitGate.reset(), asking: () => quitGate.asking() },
  setQuitting: (v) => { quitting = v; },
  isQuitting: () => quitting,
  log: (l) => console.log(l),
});
const quitIfEmpty = () => appLifecycle.quitIfEmpty();
const ownsAppLock = () => appLifecycle.ownsAppLock();
const markRecordClean = () => appLifecycle.markRecordClean();
const quitCancelled = () => appLifecycle.quitCancelled();
const dirtyParent = () => appLifecycle.dirtyParent();
// A displaced owner claims app.json again once its displacer let go of it (PR #258 Dexter 2): looked at every 30 s while running.
setInterval(() => { appLifecycle.reclaimTick().catch(() => {}); }, 30_000).unref();

// --- quit: one question for every window's unsaved reader text (single-instance PR 3, app/quit-gate.js) ----------------------------
// The question sits on the dirty window used last (else the first dirty one), shown first if hidden. Asked in before-quit, before any
// claim stops, so Cancel has nothing to undo. Under the probe driver nobody is asked: the answer is discard, and it is recorded.
const quitGate = createQuitGate({
  windows: () => appLifecycle.gateWindows(),       // only windows still there (PR #258 Dexter 6)
  ask: async (dirty) => {
    const parent = dirtyParent();
    if (parent) parent.focusWindow();
    const q = questionText(dirty);
    const w = parent && parent.win && !parent.win.isDestroyed() ? parent.win : null;
    const opts = { type: 'warning', buttons: q.buttons, defaultId: 2, cancelId: 2, message: q.message, detail: q.detail };
    const r = await (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts));
    return ['save', 'discard', 'cancel'][r.response] || 'cancel';
  },
  notify: (detail) => { const p = dirtyParent(); if (!PROBE_PORT && p && p.win && !p.win.isDestroyed()) dialog.showMessageBox(p.win, { type: 'info', message: 'Jiandu did not quit', detail }); },
  waitCleared: async (w) => {
    for (let i = 0; i < 80; i++) { if (w.pw.readerUnsaved.all().length === 0) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  },
  quit: () => app.quit(),
  probe: !!PROBE_PORT,
  // the probe reads this line after the process ended (verify/probe-single-instance.js case 7): window names and file names only
  record: (entry) => {
    probeConfirms.push(entry);
    console.log(`[main] quit question (probe, answered discard): ${JSON.stringify(entry.unsaved)}`);
    // every registered window as the gate saw it (a window left out of the question says why: no window, or no text)
    console.log(`[main] quit question windows (probe): ${JSON.stringify(registry.list().map((p) => ({ window: p.label, live: !!p.win && !p.win.isDestroyed(), unsaved: p.readerUnsaved.all().length })))}`);
  },
  log: (l) => console.log(l),
});

// ONE place that hears "the set of windows, or what they show, changed" (single-instance PR 3): a window started (the lifecycle), closed,
// or was minimised, restored, hidden or shown. The Resources sampler asks who is looking, and the tray syncs.
const seenGate = createSeenGate({ registry, getResources: () => resources });
function windowsChanged() {
  seenGate();
  if (trayController) trayController.sync();
  appLifecycle.syncRecord();
  if (homeWindow.isOpen()) homeController.sync();     // Jiandu Home: a fresh model at every shell change (the strip push is stripPushed)
}

// What every project window is handed (app/project-window.js). The Resources service, the tray and the lean/indexing units are read live.
const windowServices = {
  uiStore, readDim, usageCounters, forProbe, openInBrowser, probeConfirms, logShellError, canvasProbeResolve, canvasAsks,
  nextCanvasAskId: () => ++canvasAskSeq,
  previewProbeProxy, stopHostByPid, occupantAt, tokenFileFor, ownIdentities, ownStartTime, waitForHost, HARNESS_DIR, INSTALL_DIR,
  listBackground, capture, stripFileFor,
  isQuitting: () => quitting,
  setQuitting: (v) => { quitting = v; },
  onWindowCreated: (pw) => windowCreated(pw),
  onClosed: (pw) => lifecycle.projectClosed(pw),
  getResources: () => resources,
  getTray: () => trayController,
  // a window was minimised, restored, hidden or shown: who is looking changed, and so did the tray's Show/Hide row
  seenChanged: () => windowsChanged(),
  windowRouter, onProcessExit,
  onFocused: (pw) => registry.touch(pw),
  openProject: (o) => openProject(o),
  quitCancelled: () => quitCancelled(),
  sessionEnded: () => markRecordClean(),          // Windows ends the session (log off, shut down): a shutdown is a clean quit, not a crash
  // the strip push, the tray's other sync moment: Home's "needs you" and tab counts follow it, coalesced (PR #263 Miguel Y1)
  stripPushed: () => { if (homeWindow.isOpen()) homeController.syncSoon(); },
};

// The project window (app/project-window.js): everything that is one project's. Made by startProject, after every app-wide constant it is
// handed (a const read before its line is a TDZ error). Construction has no side effects: the claim hooks `exit` inside run(), and the
// window itself is made by start(). `launch` is this process's own launch window: an explicit port is its alone (§3.1).
function makeWindow(cwd, { launch }) {
  return createProjectWindow({
    launchCwd: cwd,
    electron: { app, BrowserWindow, WebContentsView, Menu, dialog, session },
    config: { EXPLICIT_PORT: launch ? EXPLICIT_PORT : null, STRIP_HEIGHT, POLL_MS, PROBE_PORT, TRAY_ON, ONE_WINDOW_ON },
    services: windowServices,
  });
}
// The process's own launch window, once whenReady's startProject made it (null before, and when its project's window is another process's).
let launchWindow = null;

// What a window's start() is handed: the probe's seams and the open-PR reader (set in whenReady).
let appStart = null;

// Opening a project in this process and closing one (app/project-lifecycle.js, pure and tested for behaviour): the window's claim, then its
// record (secrets, layout), its units (lean, indexing), then its own start(); a window that closed while another stays is disposed and
// everything main holds for it goes.
const lifecycle = createProjectLifecycle({
  registry,
  rootOf: (cwd) => { const p = projectOf(cwd); return p ? p.root : cwd; },
  makeWindow: (cwd, opts) => makeWindow(cwd, opts),
  dropExit: (pw) => exitHooks.delete(pw),
  makeRecord: (pw) => projectRecords.make(pw),
  stopRecord: (pw) => projectRecords.stop(pw),
  makeUnits: (pw) => makeWindowUnits(pw),
  dropUnits: (pw) => windowUnits.delete(pw),
  dropWatch: (pw) => { const unwatch = playbackWatched.get(pw); if (unwatch) { playbackWatched.delete(pw); unwatch(); } },
  getAppStart: () => appStart,
  // Started hidden but no icon could be made (no tray area): a window nobody can reach is worse than a visible one.
  afterStart: (pw) => {
    const w = pw.win;
    if (trayController && !trayController.state().exists && w && !w.isDestroyed() && !w.isVisible()) pw.focusWindow();
    recordOpened(pw);
  },
  // the count and the tooltip speak for the first window that is left, and the Resources sampler asks again who is looking
  onChanged: () => windowsChanged(),
  // Jiandu Home is open: no window-all-closed comes for the last project window, so it is dropped like any other
  othersStay: () => homeWindow.isOpen(),
});
const startProject = lifecycle.startProject;
// Jiandu Home's record (app/home-record.js): a project window that started is a project Jiandu opened. A record that could not be
// written (a busy or damaged file) logs one line and never costs the window.
function recordOpened(pw) {
  try { homeRecord.opened(pw.root); } catch (err) { console.log(`[main] home-projects: ${err && err.message}`); }
}

app.whenReady().then(async () => {
  console.log('[main] launched on   :', LAUNCH_CWD);

  // Named and refused (see explicitPort): nothing sensible is left to do, and
  // opening a window anyway would show a terminal wired to nothing.
  if (EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) { app.exit(1); return; }

  // One Jiandu process per install (single-instance PR 3): before any service or window, hand this launch to the running one. A handed-over
  // launch removes its own cache folder (app.exit skips will-quit) and ends.
  console.log(`[main] app lock      : ${APP_LOCK.on ? `on (${APP_LOCK.dir})` : `off (${APP_LOCK.reason})`}`);
  if (await appClaim.run() === 'exit') {
    removeOwnCache();
    app.exit(0);
    return;
  }

  const seams = readSeams(process.env);
  const openPrsReader = seams.openPrsFixture
    ? fixtureReader(seams.openPrsFixture, { parse: parseOpenPrs, log: (line) => console.log(line) })
    : readOpenPrs;
  appStart = { seams, openPrsReader };
  await startResources(seams);

  // No application menu bar, ever (Ricardo, 2026-09-30: every pixel of vertical
  // space). Electron paints its default File/Edit/View/Window/Help bar on
  // Windows only because none was set; null removes it. Set before the window.
  Menu.setApplicationMenu(null);
  registerIpc();
  startIndexing(seams);
  startTray();
  registerHomeIpc();
  // A crash of the last owner: which windows come back (host/open-windows.js). They open after the launch window, through the queue.
  // A --home launch opens no project, so none is left out of the restore.
  const restorePlan = await appLifecycle.decideRestore(HOME_LAUNCH ? null : (projectOf(LAUNCH_CWD) || { root: LAUNCH_CWD }).root);   // decides, writes nothing (PR #258 Dexter 8)

  // `claude-custom --home` (Jiandu Home, H3): Home and no project window. It obeys "Start minimised to tray" as the first launch
  // window does; a Home asked for later (the app pipe, the tray) always shows.
  if (HOME_LAUNCH) {
    const hidden = startsHidden(readTraySettings(uiStore)) && !!trayController && trayController.state().exists;
    showHome({ hidden });
    console.log(`[main] home          : shown${hidden ? ' (hidden: Start minimised to tray)' : ''}`);
    appLifecycle.beginRecord();
    appClaim.markReady();
    appLifecycle.runRestores(restorePlan).catch(() => {});
    startProbe();
    return;
  }

  // One window per project: the launch window's claim runs inside startProject, before the window is registered or made; a project whose
  // window is another process's has had this launch handed there, and this process ends with no window.
  // The first launch obeys "Start minimised to tray" ('setting'); a launch handed over later always shows its window (§5 Q1).
  const launched = await startProject(LAUNCH_CWD, { launch: true, show: 'setting' });
  // Its project's window is another process's (another install, or the app lock off): the launch was handed there.
  if (launched.elsewhere) { quitIfEmpty(); return; }
  launchWindow = launched.pw;            // startProject already ran its claim's markReady(): from here a second launch is handed to it
  const { first } = launched;
  console.log('[main] project       :', launchWindow.root, `(${launchWindow.mode})`);
  if (launchWindow.attachOnlyRefusal) {
    launchWindow.claim.stop();           // this process is about to end: it is no window to hand a launch to
    appClaim.stop();                     // ...and no process to hand one to: a launch held on the app pipe hears no
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
      appClaim.stop();
      app.exit(1);
      return;
    }
  }
  // The first window settled and this process stays: from here a launch of ANY project of this install is handed here.
  if (quitIfEmpty()) return;
  appLifecycle.beginRecord();           // the record's first write, only now that this process stays (PR #258 Dexter 8 / Miguel I1)
  appClaim.markReady();
  appLifecycle.runRestores(restorePlan).catch(() => {});
  launchWindow.startPoll();

  // Headless verification path.
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT) launchWindow.runScreenshotPath();
  startProbe();
}).catch((err) => {
  // A start that threw must not stay the project's owner: every later launch would be handed to a window that never comes up.
  console.error('[main] startup failed:', (err && err.stack) || err);
  forEachProject((p) => p.claim.stop());
  appClaim.stop();
  // A window that already exists is left running (only the ownership is dropped); with none up, the process ends.
  if (!registry.list().some((p) => p.win && !p.win.isDestroyed())) app.exit(1);
});

// One probe server for the process (app/probe-driver.js): every command names its window by project root (the launch window when it names
// none; a --home launch has none). Jiandu Home's own commands read and click the REAL Home page (verify/probe-home.js).
function startProbe() {
  if (!PROBE_PORT) return;
  startProbeServer({
    port: PROBE_PORT, token: PROBE_TOKEN, lineMax: PROBE_LINE_MAX,
    appApi: createAppApi({ probePort: PROBE_PORT, token: PROBE_TOKEN, tempRoot: os.tmpdir(), registry, launchWindow, openProject, countWebContents: () => webContents.getAllWebContents().length, portNamed: !!EXPLICIT_PORT,
      appLock: () => ({ owns: ownsAppLock(), file: APP_LOCK.on ? appOwner.fileOf(APP_LOCK.dir) : null, pid: process.pid }),
      openWindows: () => readRecord(OPEN_WINDOWS_FILE),
      home: homeProbeApi() }),
    windowApi: (root) => {
      const pw = root === undefined ? (launchWindow ? registry.get(launchWindow.root) : null) : registry.get(root);
      return pw ? pw.probeApi() : null;
    },
  });
}

// The Home probe's reach (only with the probe driver's port and token): the window's state, and a real click or typing in its page.
function homeProbeApi() {
  const page = async (js) => { const w = homeWindow.win(); return w ? w.webContents.executeJavaScript(js) : null; };
  return {
    async state() {
      const w = homeWindow.win();
      const dom = w ? await page(`({ title: document.title, cards: [...document.querySelectorAll('.card')].map((c) => ({ key: c.dataset.key,
        cls: c.className, state: (c.querySelector('.state') || {}).textContent || '',
        ask: (c.querySelector('.confirm .question') || {}).textContent || null, note: (c.querySelector('.card-note') || {}).textContent || null,
        form: !!c.querySelector('.lane-form') })), summary: document.getElementById('summary').textContent,
        empty: (document.querySelector('.empty') || {}).textContent || null, notice: document.getElementById('notice').textContent,
        filter: document.getElementById('filter').value, url: location.href, homeDisplay: typeof window.homeDisplay })`) : null;
      return { open: homeWindow.isOpen(), visible: homeWindow.isVisible(), focused: !!w && w.isFocused(), bounds: w ? w.getBounds() : null, dom };
    },
    // a real click on the card's button (`act` is its data-act), as a person would make it
    async click(key, act) {
      const r = await page(`(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.dataset.key === ${JSON.stringify(key)});
        const b = c && c.querySelector('[data-act=' + JSON.stringify(${JSON.stringify(act)}) + ']'); if (!b) return false; b.click(); return true; })()`);
      return r === true ? { ok: true } : { ok: false, error: 'no such button' };
    },
    async type(text) {
      const r = await page(`(() => { const f = document.getElementById('filter'); f.value = ${JSON.stringify(text)};
        f.dispatchEvent(new Event('input')); return true; })()`);
      return r === true ? { ok: true } : { ok: false, error: 'Home is not open' };
    },
    async show() { showHome(); return { ok: true }; },
    // H-PR3: a value typed into a card's New lane form field, with the event a person's typing raises
    async field(key, field, value) {
      const r = await page(`(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.dataset.key === ${JSON.stringify(key)});
        const f = c && c.querySelector('[data-field=' + JSON.stringify(${JSON.stringify(field)}) + ']'); if (!f) return false; f.value = ${JSON.stringify(value)};
        f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
      return r === true ? { ok: true } : { ok: false, error: 'no such field' };
    },
    // the page sets location (a renderer navigation, as a dropped link makes one); Miguel B1's guard must leave home.html in place
    async navigate(url) {
      const r = await page(`(() => { location.href = ${JSON.stringify(url)}; return true; })()`);
      return r === true ? { ok: true } : { ok: false, error: 'Home is not open' };
    },
    // Home's own close, as its close button makes it (H5: with no window left, Jiandu quits)
    async close() { const w = homeWindow.win(); if (!w) return { ok: false, error: 'Home is not open' }; w.close(); return { ok: true }; },
  };
}

// Closing the window detaches; it does not end the session.
// The last window closed: quit, unless a launch already told ok is being opened (app/app-lifecycle.js; PR #258 Dexter 7 / Miguel I2).
app.on('window-all-closed', () => {
  appLifecycle.onWindowAllClosed();
});

app.on('will-quit', () => { forEachProject((p) => p.stopDevServers()); });
// A quit is not a crash: the record is written clean (synchronously: the process may end right after). A quit held below and asked again
// writes it clean again, which changes nothing.
app.on('will-quit', () => { markRecordClean(); });
// The process's one window pipe closes with the quit (PR #258 Miguel S4): an old sender then gets a socket error, as before PR 3.
app.on('will-quit', () => { windowRouter.stop().catch(() => {}); });
// A quit with processes paused from the Resources panel wakes them first (#19): a frozen process with nobody left to resume it stays frozen.
// The quit is held once, for as long as the resumes take, and then asked for again.
let pausedWoken = false;
app.on('will-quit', (e) => {
  if (!resources || pausedWoken || !resources.hasPaused()) return;
  pausedWoken = true;
  e.preventDefault();
  resources.resumeAll({ deadlineMs: 10000 }).catch(() => {}).finally(() => app.quit());
});
// ONE before-quit handler: the quit gate first (held for its one question, nothing stopped yet); only once it passes does the quit begin,
// and a launch from here on opens its own process (close, then reopen).
app.on('before-quit', (e) => {
  if (quitGate.onBeforeQuit(e)) return;
  // clean FIRST: stopping the app claim releases app.json, and the record is written only while this process owns it
  // (verify/probe-single-instance.js case 7 found it the other way round: the will-quit write was refused)
  markRecordClean();
  quitting = true; forEachProject((p) => p.claim.stop()); appClaim.stop();
});
app.on('will-quit', () => { if (trayController) trayController.destroy(); if (resourceSampler) resourceSampler.stop(); forEachProject((p) => p.closeOccupancy()); });
// A panel page that called window.print() leaves the browser unable to terminate; this ends the process if quitting stalls (app/quit-watchdog.js).
armQuitWatchdog(app, QUIT_LOG_FILE ? { onFire: () => quitMark('quit watchdog fires') } : {});
if (QUIT_LOG_FILE) markWillQuitEnd(app, quitMark);
