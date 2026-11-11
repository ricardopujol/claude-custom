'use strict';
/**
 * claude-custom :: one project's window, as an object (single-instance PR 1).
 *
 * Everything that belongs to ONE project's window used to be a module-level `let` or `const` in app/main.js, because there was
 * exactly one project per Electron process: the launch folder and what it makes of itself (PROJECT, MODE, ...), the BrowserWindow,
 * its tab shell, marks, strip layout, occupancy and transcript scanners, issues, canvas and preview views, dev servers, focus mode,
 * cue and focus state, the close question and the one-window claim. They live here now, in a closure made by
 * createProjectWindow(); main.js keeps a Map of them (projectWindows) with one entry for now, so the next lane can make a second.
 * Behaviour is unchanged: still one project per process.
 *
 * WHAT STAYS IN main.js: every ipcMain registration (ipcMain.handle throws on a second one, so a window never touches ipcMain), the
 * app-wide services (the UI store, the tray, the Resources service and sampler, the secret vault, the indexing bridge, the quit
 * handlers) and the per-process constants. A window is HANDED what it needs:
 *
 *   electron   { app, BrowserWindow, WebContentsView, Menu, dialog, session }: this module never requires 'electron', so it loads
 *              under plain `node --test`, and the moved code keeps its text (`win = new BrowserWindow(...)`)
 *   config     per-process constants (EXPLICIT_PORT, STRIP_HEIGHT, POLL_MS, PROBE_PORT, PROBE_TOKEN, ...)
 *   services   app-wide effects the window calls (uiStore, forProbe, openInBrowser, the host helpers, isQuitting / setQuitting, ...)
 *   attach()   the app-wide services that come into being later (resources, trayController, leanBridge, indexing), handed over the
 *              moment main assigns its own binding, so the window sees each become non-null at the same moment main does
 *
 * Every handed value is required: a missing electron member, config value or service throws at construction, naming itself.
 *
 * MODES (what a launch folder makes of itself; the window's `mode`)
 *   tabs    the launch folder is inside a container project (`<root>dev` + sibling worktrees) and CLAUDE_CUSTOM_PORT is unset:
 *           one tab per git worktree, a poller, closable tabs. The window's own page is the tab strip (app/tab-strip.html); each STARTED
 *           tab is a WebContentsView showing renderer.html against that tab's own detached host.
 *   single  everything else: a flat repo, a folder in no project, or ANY launch that names its port. One tab on that folder, no close,
 *           no poller -- exactly what a window was before tabs, so every verify/ probe that launches one host on one folder by port
 *           keeps working unchanged.
 *
 * main.js reads window state live through getters (win, tabShell, focused, ...): never cache one across an await, because the
 * window's 'closed' handler sets `win = null`. (The launch's constants -- identity, root, mode -- never change and may be read once.) Anything in a handler that needs a window's state reaches it through
 * stripOwner(e) / viewOwner(sender) in main.js, which find the owner in the Map: the seam the next lane widens.
 */

const { tabViewWebPreferences } = require('./tab-view-prefs');
const { cueFlash } = require('./cue-flash');
const { readChromeSettings, ensureStatusDefault, viewTop } = require('./window-chrome-bridge');
const { PUSH_CHANNEL: LEAN_PUSH, FACES_PUSH: LEAN_FACES_PUSH } = require('./lean-bridge');
const { createShell, handleProbeCommand, probeLineReader, shortcutFor, shortcutWillAct, focusStep, menuText, lanesMenuTemplate, plusMenuTemplate } = require('./tab-shell');
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { projectLabel } = require('../host/project-path');
const { resolvePort } = require('../host/port-for-project');
const { decideAttach } = require('../host/handshake');
const { readIdentity, readTokenFile } = require('../host/host-identity');
const { readLook, lookDirState, ensureLookDir } = require('../host/style');
const { createOccupancyService } = require('../host/occupancy-service');
const { readCloseFacts } = require('../host/close-safety');
const { occupancyDir, createClaimWriter } = require('../host/occupancy-store');
const { startTimes } = require('../host/proc-start');
const windowOwner = require('../host/window-owner');
const windowFocus = require('../host/window-focus');
const { createWindowClaim } = require('../host/window-claim');
const { createTranscriptScanner } = require('../host/occupancy-transcripts');
const { createRootsProvider } = require('../host/worktree-roots');
const { defaultProjectsDir } = require('../host/session-model');
const { openPrFor } = require('../host/open-prs');
const tabMarks = require('./tab-marks');
const { marksFileFor, loadMarks, saveMarks } = require('../host/tab-marks-store');
const { hostEnv } = require('../host/tab-env');
const { isSideKey, sideHostsOf, laneHostsOf, readerSessionIds } = require('../host/side-session');
const { isShellKey, shellHostsOf } = require('../host/shell-tab');
const { sendControl } = require('../host/host-client');
const { probePort } = require('../host/port-probe');
const { createOps, scriptsDir } = require('../host/worktree-ops');
const { createIssueService, issueForBranch, resolveIssueUrl } = require('../host/issues');
const { createLaneBriefWriter } = require('../host/issue-lane');
const { createIssueLinks, issueLinksFileFor } = require('../host/issue-links');
const { createStripLayout, stripLayoutFileFor } = require('../host/strip-layout');
const { readMergedMarker } = require('../host/merged-marker');
const { guardNavigation } = require('./nav-guard');
const { createCanvasViews } = require('./canvas-views');
const { createPreviewViews } = require('./preview-views');
const { createDevServersService } = require('./dev-servers-service');
const devServersHost = require('../host/dev-servers');
const { lookup: lookupPortBlock } = require('../host/port-blocks');
const { worktreeRoot } = require('../host/worktree-env');
const { createStripAccent } = require('./strip-accent');
const { createUnsaved, closeDetail, guardWindowClose } = require('./reader-unsaved');
const { projectOf, stateRoot, samePath } = require('../host/project-layout');
const { createPersistentExec } = require('../host/persistent-powershell');
const { stopHost } = require('../host/stop-holder');
const { hostStopDeps } = require('../host/stop-deps');
const { attachEnv, attachOnlyDecision } = require('../host/launch-target');
const { menuModel } = require('./background-menu');
const { menuTemplate, createBackgroundActions, popupUntilClosed, stopAllDetail } = require('./background-actions');
const { hidesOnClose, startsHidden } = require('./tray-model');
const { readTraySettings, writeTraySetting } = require('./tray-settings');

// What main must hand a window. A missing one throws AT CONSTRUCTION, naming itself: a silent default (isQuitting () => false) would
// instead change behaviour far away (a hidden-to-tray window that never closes on a real quit). canvasProbeResolve is the one
// service that is legitimately undefined (it's the probe seam, absent in a normal run), so it isn't listed.
const REQUIRED_ELECTRON = ['app', 'BrowserWindow', 'WebContentsView', 'Menu', 'dialog', 'session'];
const REQUIRED_CONFIG = ['EXPLICIT_PORT', 'STRIP_HEIGHT', 'POLL_MS', 'PROBE_PORT', 'PROBE_TOKEN', 'PROBE_LINE_MAX', 'TRAY_ON', 'ONE_WINDOW_ON'];
const REQUIRED_SERVICES = ['uiStore', 'readDim', 'usageCounters', 'forProbe', 'openInBrowser', 'probeConfirms', 'logShellError', 'canvasAsks',
  'nextCanvasAskId', 'previewProbeProxy', 'stopHostByPid', 'occupantAt', 'tokenFileFor', 'ownIdentities', 'ownStartTime', 'waitForHost',
  'HARNESS_DIR', 'INSTALL_DIR', 'listBackground', 'capture', 'stripFileFor', 'isQuitting', 'setQuitting'];

function requireAll(kind, bag, names) {
  for (const name of names) {
    if (bag === null || typeof bag !== 'object' || bag[name] === undefined) throw new Error(`createProjectWindow: missing ${kind} "${name}"`);
  }
}

function createProjectWindow({ launchCwd, electron, config, services }) {
  if (typeof launchCwd !== 'string' || launchCwd === '') throw new Error('createProjectWindow: missing launchCwd');
  requireAll('electron member', electron, REQUIRED_ELECTRON);
  requireAll('config value', config, REQUIRED_CONFIG);
  requireAll('service', services, REQUIRED_SERVICES);
  const { app, BrowserWindow, WebContentsView, Menu, dialog, session } = electron;
  const { EXPLICIT_PORT, STRIP_HEIGHT, POLL_MS, PROBE_PORT, PROBE_TOKEN, PROBE_LINE_MAX, TRAY_ON, ONE_WINDOW_ON } = config;
  const {
    uiStore, readDim, usageCounters, forProbe, openInBrowser, probeConfirms, logShellError, canvasProbeResolve, canvasAsks,
    nextCanvasAskId, previewProbeProxy, stopHostByPid, occupantAt, tokenFileFor, ownIdentities, ownStartTime, waitForHost,
    HARNESS_DIR, INSTALL_DIR, listBackground, capture, stripFileFor, isQuitting, setQuitting,
  } = services;

  // --- what this window is ----------------------------------------------------------
  const LAUNCH_CWD = launchCwd;
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

  // The app-wide services that come into being after this window, handed over by attach() (null until then).
  let resources = null;              // the Resources panel's service (#63)
  let trayController = null;         // the tray icon's one controller
  let leanBridge = null;             // lean mode's bridge (app/lean-bridge.js)
  let indexing = null;               // the indexing assistant (#66): main's half (startIndexing)
  const CANVAS_ASK_TIMEOUT_MS = 5 * 60 * 1000;

  // The code reader's unsaved edits per tab (#50), reported by the page, so ending a tab can say they'd be lost.
  const readerUnsaved = createUnsaved();

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

  // Set when an attach-only window (Open from ▾) was refused: the window says
  // why and ends, instead of starting a session nobody asked for.
  let attachOnlyRefusal = null;

  // Returns { port, action } or null when the user named a port we must not take.
  // Per TAB: each tab's folder hashes to its own port.
  async function chooseHostPort(tab) {
    // #81: a branch tab's side session is looked for as a side host, on a port of its own: never the window's explicit one
    // (that is the branch tab's), and the walk never attaches it to the folder's own host.
    const side = tab.side === true;
    // A5: so is a branch tab's shell: a host of its own, found only as a shell host.
    const companion = side || tab.shell === true;
    if (!companion && EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) return null;   // named and refused above
    if (!companion && EXPLICIT_PORT) {
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
    return resolvePort({ cwd: tab.cwd, occupantAt, side, kind: tab.shell === true ? 'shell' : undefined });
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
      env: hostEnv(process.env, { cwd: tab.cwd, port, token, project: HOST_PROJECT, side: tab.side === true, shell: tab.shell === true }),
    });
    console.log('[main] host log:', logPath);
    child.unref();
    try { fs.closeSync(logFd); } catch { /* the child has its own copy */ }
    return child;
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

  /**
   * A tab's right-click menu, as a template: the strip's popup builds it, and so does the probe driver's tabMenu (a native popup
   * nobody can click), so the item a probe clicks is the item a person clicks.
   */
  function tabMenuTemplate(key) {
    const st = tabShell.menuState(key);
    // #81: the read-only side session. On a side tab the menu is this item (it reopens one that has stopped) and its close (Ricardo's
    // look, 2026-10-26: a side tab couldn't be closed).
    const side = tabShell.sideMenu(key);
    const sideItem = {
      label: side.enabled ? side.label : `${side.label} (${side.why})`,
      enabled: side.enabled,
      click: () => tabShell.openSide(side.target).catch(logShellError('open side session')),
    };
    // #119 A5: a plain shell in the tab's folder. On a shell tab the menu is this item (it restarts one whose shell has exited) and
    // its close (Ricardo's look, 2026-10-26: a shell tab couldn't be closed). Named shellState, not shell: Electron's shell is
    // imported under that name.
    const shellState = tabShell.shellMenu(key);
    const shellItem = {
      label: shellState.enabled ? shellState.label : `${shellState.label} (${shellState.why})`,
      enabled: shellState.enabled,
      click: () => tabShell.openShell(shellState.target).catch(logShellError('open shell')),
    };
    const closeShellItem = { label: 'Close shell', enabled: st.close, click: () => closeTabFlow(key) };
    const closeSideItem = { label: 'Close side session', enabled: st.close, click: () => closeTabFlow(key) };
    if (isSideKey(key)) return [sideItem, { type: 'separator' }, closeSideItem];
    if (isShellKey(key)) return [shellItem, { type: 'separator' }, closeShellItem];
    const issue = tabShell.issueOf(key);
    // #167: Pin / Unpin, for a lane's tab only (the shell says: not develop, which is always started at launch).
    const pinState = tabShell.pinMenu(key);
    const done = (r) => { if (r && r.ok === false) console.log(`[menu] pin: ${r.error}`); };
    const pinItem = { label: pinState.label, click: () => done(pinState.pinned ? tabShell.unpin(pinState.target) : tabShell.pin(pinState.target)) };
    return [
      markSubmenu(tabShell.branchOf(key)),
      { type: 'separator' },
      ...(pinState.show ? [pinItem] : []),
      // #119 A6: a lane started from a GitHub issue keeps its link.
      ...(issue ? [{ label: `Open issue #${issue.number}${issue.title ? ` ${menuText(issue.title).slice(0, 60)}` : ''}`, click: () => openIssue(key).catch(logShellError('open issue')) }] : []),
      sideItem,
      shellItem,
      { label: 'Allow a second session here', enabled: st.override, click: () => tabShell.override(key) },
      { label: 'Close tab', enabled: st.close, click: () => closeTabFlow(key) },
    ];
  }

  /**
   * The Lanes ▾ menu's template (BACKLOG #139): the tabs the strip page couldn't fit, then the lanes with no tab (a closed develop
   * first, #160; Not started; Merged, whose closed rows are the merged close's Undo). A row selects the lane, which starts its
   * session and gives it a tab, or reopens one closed. The strip's popup builds it, and so does the probe driver's `menu`, so the
   * item a probe clicks is the item a person clicks.
   */
  function lanesMenuFor(asked) {
    return lanesMenuTemplate(tabShell.lanesMenu(asked),
      (r) => (r.action === 'reopen' ? tabShell.reopen(r.key) : tabShell.select(r.key)).catch(logShellError('lanes')));
  }

  /** The + menu's template: a closed develop first (#160), New branch…, the selected lane's shell tab. Built the same two ways. */
  function plusMenuFor() {
    return plusMenuTemplate(tabShell.plusMenu(), {
      reopen: (key) => tabShell.reopen(key).catch(logShellError('reopen')),     // #160: a closed develop is the first row
      openCreate: () => tabShell.openCreate(),
      openShell: (target) => tabShell.openShell(target).catch(logShellError('open shell')),
    });
  }

  let win = null;
  let tabShell = null;
  // BACKLOG #119 A6: `gh issue list/view` for the + form's "From an issue" list, cached 60 s (host/issues.js). Made in whenReady.
  let issueService = null;
  let resHistoryView = null;         // the view the Resources service last re-sent the history to (#63 follow-up)
  let occupancyService = null;       // worktree occupancy (#44 + #47): the live claims, read from the claim folder
  let transcriptOccupancy = null;    // ...and the fallback producer: claims read off the subagent transcripts
  const liveViews = new Set();          // every WebContentsView that currently shows a tab

  const isStrip = (sender) => !!win && !win.isDestroyed() && !!sender && sender === win.webContents;
  const isTabView = (sender) => !!tabShell && tabShell.isTabView(sender);
  const forEachView = (fn) => { for (const v of liveViews) { if (!v.webContents.isDestroyed()) fn(v); } };

  // Focus mode (layout pass L1, #1): only the terminal shows. Per window and not
  // saved. The tab view covers the strip, and every view hides its own header
  // and zones when told.
  let focusMode = false;
  // Whether the indexing assistant's field has the keyboard (a publish must not take it, as for the branch form).
  let indexFieldFocused = false;
  // Layout pass L2 (#28): this window's frame, fixed at creation. A frameless
  // window keeps its strip in focus mode: it's the only title bar (Dexter L2 #3).
  let windowFrameless = false;

  function layoutView(view) {
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const top = viewTop({ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT });
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    canvasViews.relayout(view.webContents);     // its panel's offset moved with it (focus mode, a frameless toggle)
    previewViews.relayout(view.webContents);
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
    // "Start minimised to tray": the window is made but not shown; the tray icon brings it up. Never without the icon.
    const startHidden = TRAY_ON && startsHidden(readTraySettings(uiStore));
    win = new BrowserWindow(forProbe({
      width: 1200,
      height: 800,
      show: !startHidden,
      // Frameless: no OS title bar; the strip drags the window and draws its own
      // minimise and close (app/tab-strip.js windowChrome). The title still
      // feeds alt-tab and the taskbar.
      frame: !chrome.framelessWindow,
      // Room for the terminal's minimum and two side panels (app/dock-tree.js).
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
    }));
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
    // Hidden to the tray is minimised as far as the polling and the cue go: nobody is looking.
    win.on('hide', () => { focused = false; if (resources) resources.setMinimised(true); });
    win.on('show', () => { if (resources) resources.setMinimised(false); });
    // The Dev servers sampler follows what the window shows: minimise, restore, and hide/show (the tray) alike (#119 A4).
    for (const ev of ['minimize', 'restore', 'hide', 'show']) win.on(ev, syncDevServersSampling);
    // Windows asks to end the session (log off, shut down): a hidden-to-tray window must not stand in its way.
    win.on('session-end', () => { setQuitting(true); });
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
      if (leanBridge && leanBridge.view().on) win.webContents.send(LEAN_PUSH, leanBridge.view());
      if (leanBridge && leanBridge.faces().length) win.webContents.send(LEAN_FACES_PUSH, leanBridge.faces());
    });
    // A click on the strip takes the keyboard from the view (Dexter, PR #75 R2-4),
    // so the next selection -- even of the same tab -- focuses its view again.
    win.webContents.on('focus', () => { lastFocusedView = null; });
    // Closing the window (X, Alt+F4, app quit) ends every page, so unsaved text in a code reader (#50) is asked about
    // first: Save / Discard / Cancel (app/reader-unsaved.js guardWindowClose). Once answered, the close goes through.
    let closeGuarded = false;
    win.on('close', (e) => {
      // "Minimise to tray on close" (off by default): the window hides, the pages and their unsaved text stay alive, and the
      // tray reaches it again. Only with a tray icon up to reach it from, and never while the app is quitting.
      if (hidesOnClose({ settings: readTraySettings(uiStore), trayExists: !!trayController && trayController.state().exists, quitting: isQuitting() })) {
        e.preventDefault();
        win.hide();
        return;
      }
      if (closeGuarded || readerUnsaved.all().length === 0) return;
      e.preventDefault();
      if (closeAsking) return;
      closeAsking = true;
      guardWindowClose({
        list: () => readerUnsaved.all(),
        ask: askWindowClose,
        notify: (detail) => { if (!PROBE_PORT && win && !win.isDestroyed()) dialog.showMessageBox(win, { type: 'info', message: 'The window was not closed', detail }); },
        saveAll: () => { if (win && !win.isDestroyed()) win.webContents.send('reader-save'); forEachView((v) => v.webContents.send('reader-save')); },
        waitCleared: async () => {
          for (let i = 0; i < 80; i++) { if (readerUnsaved.all().length === 0) return true; await new Promise(r => setTimeout(r, 100)); }
          return false;
        },
      }).then((ok) => {
        if (ok && win && !win.isDestroyed()) { closeGuarded = true; win.close(); }
        // Cancel (or a save that didn't clear) also cancels a quit that started this close: Electron says nothing when a quit is
        // cancelled, so without this `quitting` stays true and close-to-tray is dead for the rest of the session.
        else {
          setQuitting(false);
          // before-quit already stopped the one-window claim; the window stays, so it is the project's owner again (PR #247 Dexter M1).
          if (win && !win.isDestroyed()) windowClaim.resume().catch(() => {});
        }
      }).catch(logShellError('window close guard')).finally(() => { closeAsking = false; });
    });
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
    const flash = cueFlash(cueOn, !!on, focused);
    cueOn = !!on;
    if (flash !== null && win && !win.isDestroyed()) win.flashFrame(flash);   // #117: the border is static, the taskbar button moves
    forEachView((v) => v.webContents.send('attention-cue', cueOn));
  }

  function selectedView() {
    if (!tabShell) return null;
    const sel = tabShell.snapshot().selectedKey;
    const tab = sel ? tabShell.tabByKey(sel) : null;
    return tab && tab.view ? tab.view : null;
  }

  // A tab's GitHub issue (#119 A6) in the browser: the link the tab has, else the one gh gives. Through openInBrowser, the
  // one gate a link leaves the app by.
  async function openIssue(key) {
    const issue = tabShell ? tabShell.issueOf(key) : null;
    if (!issue || !issueService) return false;
    const url = await resolveIssueUrl(issueService, HOST_PROJECT.dev, issue);
    if (!url) {
      console.log(`[main] issue: no link for #${issue.number}`);
      return false;
    }
    return openInBrowser(url, 'issue');
  }

  function createTabView(tab) {
    const view = new WebContentsView({ webPreferences: tabViewWebPreferences(path.join(__dirname, 'preload.js')) });
    win.contentView.addChildView(view);
    if (indexing) indexing.raise();    // #66: the toast and the list stay over every tab view
    layoutView(view);
    view.setVisible(false);       // shown by applySelection once it is the selected tab
    liveViews.add(view);

    const wc = view.webContents;
    registerShortcuts(wc);
    const leanOwnerId = wc.id;
    view.leanOwnerId = leanOwnerId;
    wc.once('destroyed', () => { if (leanBridge) leanBridge.dropOwner(leanOwnerId); });
    wc.on('did-finish-load', () => {
      if (wc.isDestroyed()) return;
      wc.send('window-focus', { focused, dim: readDim() });
      if (cueOn) wc.send('attention-cue', true);
      if (focusMode) wc.send('focus-mode', true);
      if (leanBridge && leanBridge.view().on) wc.send(LEAN_PUSH, leanBridge.view());
    });
    // A crashed renderer keeps its view but its page is gone: its night and its faces must not outlive it (the next morning's backgrounds would
    // stay frozen by a night nobody reports ending; PR #140 Dexter r3 #1). A reloaded page reports again from its hello.
    // Its unsaved reader text goes with it too (PR #155).
    wc.on('render-process-gone', (_e, d) => { readerUnsaved.clear(tab.key); if (leanBridge) leanBridge.dropOwner(leanOwnerId); console.error(`[main] ${tab.key}: renderer gone:`, d.reason); });
    // a fresh page (a reload, a crash recovery) starts with no unsaved text and never says so: forget the old entry
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) readerUnsaved.clear(tab.key); });
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
    // The tab page never navigates: it is loaded once, below. A link that reaches the DOM (PR #204: a Markdown diagram's
    // <a xlink:href>) must not replace the harness UI with a remote page, so every navigation is refused (app/nav-guard.js).
    guardNavigation(wc);

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

  // --- Claude's panel (BACKLOG #71) -------------------------------------------------------------
  // One sealed WebContentsView per tab, laid over the dock panel's body (app/canvas-views.js). The tab's page is the trusted
  // controller: it says when to show, where, and with which page, and relays the person's answer about a host.
  const canvasViews = createCanvasViews({
    WebContentsView, session,
    resolveHost: canvasProbeResolve,
    addChild: (v) => win.contentView.addChildView(v),
    removeChild: (v) => win.contentView.removeChildView(v),
    ownerBounds: (owner) => { for (const v of liveViews) { if (v.webContents === owner) return v.getBounds(); } return null; },
    preloadPath: path.join(__dirname, 'canvas-panel-preload.js'),
    // a panel made for a tab that is not the selected one must start hidden (a setOwnerVisible that came before it can't be replayed)
    isOwnerVisible: (owner) => { const sel = selectedView(); return !!sel && sel.webContents === owner; },
    ask: (owner, origin) => new Promise((resolve) => {
      if (owner.isDestroyed()) { resolve('deny'); return; }
      const id = nextCanvasAskId();
      const timer = setTimeout(() => { canvasAsks.delete(id); resolve('deny'); }, CANVAS_ASK_TIMEOUT_MS);
      canvasAsks.set(id, { owner, resolve: (answer) => { clearTimeout(timer); resolve(answer); } });
      owner.send('canvas:need-host', { id, origin });
    }),
    onMessage: (owner, msg) => { if (!owner.isDestroyed()) owner.send('canvas:message', msg); },
    // A shelf address the panel's page asked to open, after main checked it is exactly on the shelf and a real click came with it.
    openUrl: (url) => openInBrowser(url, "Claude's panel"),
    log: (line) => console.log(line),
  });

  // --- The Preview panel and the Dev servers chip (BACKLOG #119 A4) ------------------------------
  // One native view per tab (app/preview-views.js), on its own in-memory session, that shows a page a dev server of THIS worktree serves:
  // loopback http only, no preload, no Node, no new windows, no downloads (app/preview-guard.js). The tab's page is the trusted controller.
  // The worktree a tab's panel belongs to (what its last address is remembered by): the worktree folder, else the tab's own folder.
  const previewKeyOf = (owner) => {
    const tab = tabShell ? tabShell.tabForSender(owner) : null;
    return tab ? (worktreeRoot(tab.cwd) || tab.cwd) : null;
  };
  const previewViews = createPreviewViews({
    WebContentsView, session,
    addChild: (v) => win.contentView.addChildView(v),
    removeChild: (v) => win.contentView.removeChildView(v),
    ownerBounds: (owner) => { for (const v of liveViews) { if (v.webContents === owner) return v.getBounds(); } return null; },
    isOwnerVisible: (owner) => { const sel = selectedView(); return !!sel && sel.webContents === owner; },
    keyOf: previewKeyOf,
    onEvent: (owner, ev) => { if (!owner.isDestroyed()) owner.send('preview:event', ev); },
    openUrl: (url) => openInBrowser(url, 'Preview'),
    // The ports of this app that the page may never reach: the probe driver's, and the host's when it was named by CLAUDE_CUSTOM_PORT (besides the session hosts' range, app/preview-guard.js).
    denyPorts: [PROBE_PORT ? Number(PROBE_PORT) : null, Number.isInteger(EXPLICIT_PORT) ? EXPLICIT_PORT : null].filter(Number.isInteger),
    // PROBE SEAM, only when the probe driver's port AND token are set: a proxy the probe owns, to count what a session sends to it.
    proxyConfig: previewProbeProxy(),
    log: (line) => console.log(line),
  });
  // The listening ports of every tab's worktree, from ONE PowerShell call per sample (host/dev-servers.js SCRIPT) through a persistent shell of its
  // own, every 10 s while a window is in view (app/dev-servers-service.js). The block comes from the file host/port-blocks.js keeps (a read, never an
  // allocation); the session host each tab's join starts from is the one the Resources sampler proved.
  let devServers = null;
  let devServersExec = null;
  // Sampling follows what the window shows (host/dev-servers.js unseen): a window hidden to the tray, minimised, or not made yet samples nothing.
  function syncDevServersSampling() {
    if (!devServers) return;
    const gone = !win || win.isDestroyed();
    devServers.setMinimised(devServersHost.unseen({ visible: gone ? false : win.isVisible(), minimized: gone ? true : win.isMinimized() }));
  }

  function destroyTabView(tab) {
    const view = tab.view;
    if (!view) return;
    canvasViews.destroyFor(view.webContents);
    previewViews.destroyFor(view.webContents);
    liveViews.delete(view);
    // a closed tab's /bedtime night cannot keep the window lean for ever
    // by the id taken when the view was made: a view already destroyed (a teardown, a crash) must still drop its night (PR #140 Miguel M2)
    if (leanBridge && view.leanOwnerId !== undefined) leanBridge.dropOwner(view.leanOwnerId);
    readerUnsaved.clear(tab.key);      // its page is going: whatever it held unsaved goes with it, so no phantom question later
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
    const pickerOpen = !!(snapshot.create && snapshot.create.picker === true);
    for (const tab of snapshot.tabs) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        // #119 A6: while the form's issue list is open it is drawn by the strip page over the area under the strip,
        // and a tab's page is a native view that would cover it: the selected one steps aside until the list closes.
        const shows = tab.key === snapshot.selectedKey && !pickerOpen;
        tab.view.setVisible(shows);
        // A tab's panel is its own native view: it must leave with its tab, or it floats over whichever tab is selected.
        canvasViews.setOwnerVisible(tab.view.webContents, shows);
        previewViews.setOwnerVisible(tab.view.webContents, shows);
      }
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
    else if (step.focusStrip === true && win && !win.isDestroyed()) win.webContents.focus();     // the view with the keyboard went (PR #236 Miguel Y4)
    lastFocusedView = step.lastFocused;
    pushStripAccent();
    // The Resources panel runs its process-tree sample only for the SELECTED tab's page (#63).
    if (resources) resources.refresh();
    if (devServers) devServers.refresh();      // a tab that came or went changes whose ports are asked about
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
      else if (action === 'shortcuts') {
        // The page lives in the tab view (it opens over that window); with none selected the key's own contents take it.
        const v = selectedView();
        const target = v ? v.webContents : wc;
        if (target && !target.isDestroyed()) {
          target.executeJavaScript('window.toggleShortcutsPage && window.toggleShortcutsPage()').catch(() => {});
        }
      }
      else if (action === 'devtools') {
        const v = selectedView();
        if (v && !v.webContents.isDestroyed()) v.webContents.toggleDevTools();
      }
    });
  }

  function onShellChanged(snapshot) {
    if (!win || win.isDestroyed()) return;
    applySelection(snapshot);
    // `model` is the strip's tabs only (1B: a lane with no running session is a row in `lanes`, the Lanes menu's rows).
    lastStripPayload = {
      model: snapshot.strip, lanes: snapshot.lanes, selectedKey: snapshot.selectedKey, notice: snapshot.notice, closeNotice: snapshot.closeNotice, closeStuck: snapshot.closeStuck,
      mode: snapshot.mode, create: snapshot.create, devClosed: snapshot.devClosed === true, mergedNotice: snapshot.mergedNotice || null,
    };
    win.webContents.send('strip-model', lastStripPayload);
    if (trayController) trayController.sync();     // the count and the tooltip follow the cues
  }

  // Hand close (criterion 5): ask first, every time; then the reducer's stop +
  // close. Nothing on disk is touched.
  async function closeTabFlow(key, { ifSafe = false, stop = false } = {}) {
    if (!key || !tabShell) return null;
    return tabShell.closeTab(key, { ifSafe, stop });
  }

  let closeAsking = false;     // the window-close question is up: a second close gesture doesn't stack another
  // The window's own close with unsaved reader text (#50): 'save' | 'discard' | 'cancel'. The probe driver has nobody
  // to click: it discards, like a plain tab close is answered yes.
  async function askWindowClose(files) {
    if (PROBE_PORT) { probeConfirms.push({ label: 'window', reason: '', unsaved: files.join(', ') }); return 'discard'; }
    const list = files.length === 1 ? files[0] : `${files.length} files (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''})`;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Save and close', 'Discard and close', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Close with unsaved changes?',
      detail: `The file reader has unsaved edits to ${list}.`,
    });
    return ['save', 'discard', 'cancel'][r.response] || 'cancel';
  }

  // `reason` (a Ctrl+click close that wasn't safe, #77) is added to the detail so the person sees why it asked.
  async function confirmClose(tab, { reason = '' } = {}) {
    // The probe driver has nobody to click. It answers yes to a plain close, and no to a Ctrl+click close that had
    // to ask (#77), keeping what it was asked so the probe can read the reason back.
    // A branch tab's end takes its side tab with it (BACKLOG #132): that reader's unsaved file is named too.
    const unsaved = readerUnsaved.pathsForClose(tab.key);
    if (PROBE_PORT) {
      probeConfirms.push({ label: tab.branch || projectLabel(tab.cwd), reason, unsaved });
      return reason === '';
    }
    const label = tab.branch || projectLabel(tab.cwd);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['End session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `End the session in ${label}?`,
      detail: closeDetail({ reason, unsaved }),
    });
    if (r.response === 0) readerUnsaved.clear(tab.key);
    return r.response === 0;
  }

  function focusWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
    // A host of THIS project is shown in this window (one window per project): its tab is selected, a lane closed by hand is reopened.
    // Another project's host keeps the attach-only spawn below until a window can open one on a project's behalf.
    thisProject: (o) => {
      const p = projectOf(o.cwd);
      return !!p && samePath(p.root, PROJECT_ROOT);
    },
    laneFor: (o) => windowOwner.pickLane(tabShell.snapshot().tabs, { cwd: o.cwd, port: o.port }),
    reopenLane: async (o) => {
      const r = await tabShell.reopenFolder(o.cwd);
      return r && r.ok ? r.key : null;
    },
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

  /**
   * Probe only (#139 / #160): a picture of the Lanes ▾ or + menu for a look before merge. capturePage can't see a native popup, and a
   * screen capture would take whatever else is on the screen with it, so the probe DRAWS the items Electron built (`menu.items`:
   * labels, separators, disabled rows) as a box under the button in the strip page, captioned as the probe's drawing, captures the
   * strip page alone (capturePage: only this app's pixels), then removes the box. The OS draws the real popup's chrome.
   */
  async function photographMenu(menu, which, file) {
    const items = menu.items.map(i => ({ label: i.label, type: i.type, enabled: i.enabled }));
    const req = JSON.stringify(JSON.stringify({ id: which === 'plus' ? 'plus' : 'lanes', name: which === 'plus' ? '+' : 'Lanes ▾', items }));
    await win.webContents.executeJavaScript(`(() => {
      const r = JSON.parse(${req});
      const b = document.getElementById(r.id);
      const at = b ? b.getBoundingClientRect() : { left: 0, bottom: 0 };
      const box = document.createElement('div');
      box.id = 'probe-menu-shot';
      box.style.cssText = 'position:fixed;z-index:2147483647;top:' + Math.round(at.bottom + 2) + 'px;left:' + Math.max(4, Math.min(Math.round(at.left), innerWidth - 340)) + 'px;min-width:300px;background:#2b2b2b;color:#eee;font:13px "Segoe UI",sans-serif;border:1px solid #555;box-shadow:0 6px 16px rgba(0,0,0,.55);padding:4px 0';
      const cap = document.createElement('div');
      cap.textContent = 'probe drawing of the ' + r.name + ' menu, from the items Electron built';
      cap.style.cssText = 'font-size:10px;color:#8fa98f;padding:2px 12px 5px';
      box.appendChild(cap);
      for (const it of r.items) {
        const d = document.createElement('div');
        if (it.type === 'separator') d.style.cssText = 'border-top:1px solid #555;margin:4px 0';
        else { d.textContent = it.label; d.style.cssText = 'padding:5px 28px;white-space:pre;' + (it.enabled ? '' : 'color:#8a8a8a'); }
        box.appendChild(d);
      }
      document.body.appendChild(box);
      return true; })()`);
    try {
      await new Promise(r => setTimeout(r, 200));
      return await capture(win.webContents, file);
    } finally {
      await win.webContents.executeJavaScript("(() => { const b = document.getElementById('probe-menu-shot'); if (b) b.remove(); return true; })()").catch(() => {});
    }
  }

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
    // A real left click in the strip page on the tab labelled `label` (its x when `onX`): its position is read from the DOM and the
    // click is an input event, so the page's own handler decides what to ask main.
    const stripClick = async (label, onX, modifiers) => {
      const rect = JSON.parse(await win.webContents.executeJavaScript(
        `JSON.stringify((() => { const t = [...document.querySelectorAll('#tabs .tab')].find(n => (n.querySelector('.label') || {}).textContent === ${JSON.stringify(label)}); const n = t && ${onX ? "t.querySelector('.x')" : 't'}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())`));
      if (!rect) return { ok: false, error: onX ? `no close button on a tab labelled ${label}` : `no tab labelled ${label}` };
      const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...base });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...base });
      return { ok: true };
    };
    // #129: a real click on the Stop button in the strip's alert line (a tab kept because its host wouldn't end), read from the DOM.
    const stripStopClick = async () => {
      const rect = JSON.parse(await win.webContents.executeJavaScript(
        "JSON.stringify((() => { const n = document.querySelector('#strip-alert .stop'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())"));
      if (!rect) return { ok: false, error: 'no Stop button in the strip' };
      const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: [] };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...base });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...base });
      return { ok: true };
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
            "JSON.stringify([...document.querySelectorAll('.tab')].map(t => ({ label: (t.querySelector('.label') || {}).textContent, selected: t.classList.contains('selected'), dim: t.classList.contains('dim'), pulse: ['pulse-needs', 'pulse-done'].find(c => t.classList.contains(c)) || null, anim: getComputedStyle(t).animationName, bg: getComputedStyle(t).backgroundColor, hasClose: !!t.querySelector('.x'), side: t.classList.contains('side'), shell: t.classList.contains('shell'), dots: [...t.querySelectorAll('.dot')].map(d => d.className + '|' + d.title), title: t.title, resWarn: (t.querySelector('.res-warn') || {}).textContent || null, badge: (t.querySelector('.badge') || {}).textContent || null, mark: t.querySelector('.mark') ? { text: t.querySelector('.mark').textContent, title: t.querySelector('.mark').title, beforeLabel: t.querySelector('.mark').nextElementSibling === t.querySelector('.label'), width: Math.round(t.querySelector('.mark').getBoundingClientRect().width) } : null })))"));
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
            "JSON.stringify({ plus: !document.getElementById('plus').hidden, form: !document.getElementById('create').hidden, alert: document.getElementById('strip-alert').hidden ? null : document.getElementById('strip-alert').textContent, stop: !!document.querySelector('#strip-alert .stop'), stopInView: (() => { const b = document.querySelector('#strip-alert .stop'); if (!b) return null; const r = b.getBoundingClientRect(); const a = document.getElementById('strip-alert').getBoundingClientRect(); return r.width > 0 && r.left >= a.left - 1 && r.right <= a.right + 1; })(), textClipped: (() => { const n = document.querySelector('#strip-alert .alert-text'); return n ? n.scrollWidth > n.clientWidth : null; })(), pane: document.getElementById('pane').hidden ? null : document.getElementById('pane-text').textContent, "
            // #62: the lean button and chip as painted
            + "lean: { bodyLean: document.body.classList.contains('lean'), btnHidden: document.getElementById('lean-btn').hidden, chipHidden: document.getElementById('lean-chip').hidden, label: document.getElementById('lean-chip-label').textContent, night: document.getElementById('lean-chip-night').hidden ? null : document.getElementById('lean-chip-night').textContent, back: document.getElementById('lean-back').textContent, dotAnim: (() => { const d = document.querySelector('.dot.working'); return d ? getComputedStyle(d).animationName : null; })(), "
            + "faces: (() => { const b = document.getElementById('lean-faces'); const r = b.getBoundingClientRect(); const f = [...b.querySelectorAll('.lean-face')]; const m = b.querySelector('.lean-more'); return { hidden: b.hidden, count: f.length, titles: f.map(x => x.title), more: m ? m.textContent : null, size: f[0] ? Math.round(f[0].getBoundingClientRect().width) : null, round: f[0] ? getComputedStyle(f[0]).borderRadius : null, videos: b.querySelectorAll('video').length, stills: b.querySelectorAll('canvas').length, drawn: b.querySelectorAll('canvas[data-still-drawn]').length, failed: b.querySelectorAll('canvas[data-still-failed]').length, imgs: b.querySelectorAll('img').length, imgsLoaded: [...b.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length, placeholders: b.querySelectorAll('.face-placeholder').length, left: Math.round(r.left), right: Math.round(r.right), chipLeft: Math.round(document.getElementById('lean-chip').getBoundingClientRect().left) }; })() } })"));
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
        // #139 + #141 (verify/probe-tab-strip-lanes.js): where the strip PAINTED each tab and its Lanes button, so overflow is judged by geometry.
        let stripLayout = null;
        try {
          stripLayout = JSON.parse(await win.webContents.executeJavaScript(
            "JSON.stringify((() => { const r = (e) => { const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; }; const tabs = document.getElementById('tabs'); const lanes = document.getElementById('lanes');"
            + " return { stripWidth: Math.round(document.getElementById('strip').getBoundingClientRect().width), tabs: r(tabs), tabsScroll: tabs.scrollWidth, tabsScrollLeft: tabs.scrollLeft, beside: [...document.getElementById('strip').children].filter(c => c !== tabs && c.getBoundingClientRect().width > 0).map(c => [c.id || c.className, Math.round(c.getBoundingClientRect().width)]), lanes: { ...r(lanes), text: lanes.textContent, hidden: lanes.hidden, overflow: lanes.classList.contains('overflow'), title: lanes.title },"
            + " items: [...tabs.querySelectorAll('.tab')].map(t => ({ key: t.dataset.key, label: (t.querySelector('.label') || {}).textContent, selected: t.classList.contains('selected'), leaving: t.classList.contains('leaving'), draggable: t.draggable, dev: t.classList.contains('dev'), occupied: t.classList.contains('occupied'), pin: t.querySelector('.pin') ? { title: t.querySelector('.pin').title, width: Math.round(t.querySelector('.pin').getBoundingClientRect().width), height: Math.round(t.querySelector('.pin').getBoundingClientRect().height), beforeDot: (() => { const p = t.querySelector('.pin'); const d = t.querySelector('.dot'); return !d || p.getBoundingClientRect().left < d.getBoundingClientRect().left; })(), svg: !!t.querySelector('.pin svg path') } : null, ...r(t) })) }; })())"));
        } catch (err) { stripLayout = { error: err.message }; }
        const snap = tabShell.snapshot();
        return {
          // verify/probe-one-window.js: how many windows this Electron process has made (one window per project: it must stay 1)
          windows: BrowserWindow.getAllWindows().length,
          mode: MODE, selectedKey: snap.selectedKey, tabs: model, hosts, stripDom, stripOccupancy, stripChrome, stripLayout, viewDom, noMenuBar, windowFrame,
          // 1B: the keys main says have a tab, and the Lanes menu's rows (Not started / Merged, with the ones closed by hand)
          stripKeys: snap.strip.map(e => e.key), lanes: snap.lanes,
          // #139 / #160: the merged close's notice, and whether develop is closed (the pane's empty-window line)
          mergedNotice: snap.mergedNotice || null, devClosed: snap.devClosed === true,
          stripAlert: await win.webContents.executeJavaScript("(() => { const a = document.getElementById('strip-alert'); return a && !a.hidden ? { text: a.textContent, kind: a.className } : null; })()").catch(() => null),
          stripPane: await win.webContents.executeJavaScript("(() => { const p = document.getElementById('pane'); return p && !p.hidden ? (document.getElementById('pane-text') || {}).textContent || '' : null; })()").catch(() => null),
          create: snap.create, reopenable: tabShell.plusMenu().reopen, confirms: probeConfirms.slice(),
          // #119 A6: whether the selected tab's page is showing (it steps aside while the form's issue list is open); null if unreadable.
          selectedViewVisible: (() => { const v = selectedView(); try { return v && typeof v.getVisible === 'function' ? v.getVisible() : null; } catch { return null; } })(),
          readerUnsaved: snap.selectedKey ? readerUnsaved.pathFor(snap.selectedKey) : null,
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
      // The + menu's *New branch…* (and Ctrl+Alt+T): opens the strip's branch form, which a probe then drives through its page.
      async openCreate() { return { ok: tabShell.openCreate() }; },
      // #119 A6: the form's "From an issue" list, through the strip page's own elements. `action` is one of a fixed set
      // (tab-shell.js STRIP_ISSUE_ACTIONS) and the data goes in as JSON, never spliced into code. Answers what the page shows.
      async stripIssues(action, args) {
        const req = JSON.stringify(JSON.stringify({ action, args }));
        const out = await win.webContents.executeJavaScript(
          `(() => { const r = JSON.parse(${req}); const $ = (id) => document.getElementById(id);
            if (r.action === 'open') $('create-issues').click();
            else if (r.action === 'pick') { const b = [...$('issues-list').querySelectorAll('.issue-row')][r.args.index]; if (!b) return JSON.stringify({ ok: false, error: 'no such row' }); b.click(); }
            else if (r.action === 'filter') { const f = $('issues-filter'); f.value = r.args.text; f.dispatchEvent(new Event('input')); }
            else if (r.action === 'submit') $('create').requestSubmit();
            const btn = $('create-issues');
            return JSON.stringify({ ok: true, view: {
              row: { text: btn.textContent, disabled: btn.disabled, dim: btn.className === 'dim', title: btn.title },
              panelHidden: $('issues-panel').hidden, filterValue: $('issues-filter').value, branchValue: $('create-branch').value,
              note: $('issues-note').hidden ? null : $('issues-note').textContent,
              rows: [...$('issues-list').querySelectorAll('.issue-row')].map(b => ({ num: b.querySelector('.issue-num').textContent, title: b.querySelector('.issue-title').textContent, branch: b.querySelector('.issue-branch').textContent, labels: [...b.querySelectorAll('.issue-label')].map(x => x.textContent) })),
            } }); })()`);
        return JSON.parse(out);
      },
      // #119 A5: what the tab menu's Open shell here does, by the branch tab's label.
      async shellOpen(label) {
        const key = labelKey(label);
        if (!key) return { ok: false, error: `no tab labelled ${label}` };
        return tabShell.openShell(key);
      },
      // #81: what the tab menu's Open side session does, by the branch tab's label.
      async sideOpen(label) {
        const key = labelKey(label);
        if (!key) return { ok: false, error: `no tab labelled ${label}` };
        return tabShell.openSide(key);
      },
      // #141: a drag of one lane's tab onto another's, run through the strip page's own handlers (dragstart, dragover, drop, dragend)
      // with real DragEvents. `half` is which half of the target the pointer is over. Labels and the half go in as JSON.
      async dragTab(label, onLabel, half) {
        const req = JSON.stringify(JSON.stringify({ label, onLabel, half }));
        const out = await win.webContents.executeJavaScript(
          `(() => { const r = JSON.parse(${req});
            const tab = (l) => [...document.querySelectorAll('#tabs .tab')].find(t => !t.classList.contains('leaving') && (t.querySelector('.label') || {}).textContent === l);
            const from = tab(r.label); const to = tab(r.onLabel);
            if (!from || !to) return JSON.stringify({ ok: false, error: 'no such tab' });
            if (!from.draggable) return JSON.stringify({ ok: false, error: 'not draggable' });
            const dt = new DataTransfer(); const box = to.getBoundingClientRect();
            const x = r.half === 'right' ? box.left + box.width * 0.75 : box.left + box.width * 0.25;
            const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: box.top + 5, dataTransfer: dt }));
            fire(from, 'dragstart');
            const allowed = !fire(to, 'dragover');
            const indicator = to.classList.contains('drop-before') ? 'before' : (to.classList.contains('drop-after') ? 'after' : null);
            fire(to, 'drop'); fire(from, 'dragend');
            return JSON.stringify({ ok: true, allowed, indicator }); })()`);
        return JSON.parse(out);
      },
      // #139: the window's width, for the strip's overflow (the content size, so the strip is exactly this wide).
      async windowSize(width) {
        const [, h] = win.getContentSize();
        win.setContentSize(width, h);
        await new Promise(r => setTimeout(r, 300));
        return { ok: true, content: win.getContentSize() };
      },
      // The window's own `focus` handler, run as the OS would.
      async windowFocus() { win.emit('focus'); return { ok: true, osFocused: win.isFocused() }; },
      async windowBlur() { win.emit('blur'); return { ok: true, osFocused: win.isFocused() }; },
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
      // #77: a real Ctrl+click on a tab in the strip page: its position is read from the DOM, the click is an input
      // event with the control modifier, so the page's own handler decides what to ask main.
      async ctrlClick(label) { return stripClick(label, false, ['control']); },
      // Ricardo's look, 2026-10-26: a real plain click on the tab's own x, so the strip page's handler decides what to ask main.
      async xClick(label) { return stripClick(label, true, []); },
      async stopClick() { return stripStopClick(); },
      // The tab's right-click menu as ELECTRON built it, from the popup's own template, and given an item's label that item's own
      // click (Ricardo's look, 2026-10-26: a shell tab's menu had no close).
      async tabMenu(label, item) {
        const key = labelKey(label);
        if (!key) return { ok: false, error: `no tab labelled ${label}` };
        const built = Menu.buildFromTemplate(tabMenuTemplate(key)).items.filter(i => i.type !== 'separator');
        const items = built.map(i => ({ label: i.label, enabled: i.enabled }));
        if (item === undefined) return { ok: true, items };
        const hit = built.find(i => i.label === item);
        if (!hit) return { ok: false, error: `no item ${item}`, items };
        if (!hit.enabled) return { ok: false, error: `${item} is disabled`, items };
        hit.click();
        return { ok: true, items };
      },
      // #139 / #160: the Lanes ▾ or + menu as ELECTRON built it from the popup's own template; given an item's label, that item's own
      // click; given a .png `shot`, a picture of those items drawn under the button in the strip page (photographMenu).
      async menu(which, item, shot) {
        const template = which === 'plus' ? plusMenuFor() : lanesMenuFor([]);
        const built = Menu.buildFromTemplate(template);
        const items = built.items.map(i => ({ label: i.label, type: i.type, enabled: i.enabled }));
        let shotBytes = null;
        if (typeof shot === 'string') {
          try { shotBytes = await photographMenu(built, which === 'plus' ? 'plus' : 'lanes', shot); } catch (err) { return { ok: false, error: `photograph: ${err.message}`, items }; }
        }
        if (item === undefined) return { ok: true, items, shotBytes };
        const hit = built.items.find(i => i.type !== 'separator' && i.label === item);
        if (!hit) return { ok: false, error: `no item ${item}`, items };
        if (!hit.enabled) return { ok: false, error: `${item} is disabled`, items };
        hit.click();
        return { ok: true, items, shotBytes };
      },
      // #85: a real pointer move in the selected tab's view (x, y in the view's own pixels): the page's hit-testing and its own
      // pointer events decide what is hovered, as for a mouse.
      async mouseMove(x, y) {
        const sel = selectedView();
        if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
        sel.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        return { ok: true };
      },
      // A real left click in the selected tab's view (x, y in the view's own pixels): the press moves focus the way a mouse does, so
      // focus events and the page's own handlers run for real. The view is focused first (an unfocused probe window fires none).
      async mouseClick(x, y) {
        const sel = selectedView();
        if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
        if (win && !win.isDestroyed()) win.focus();
        sel.webContents.focus();
        const base = { x, y, button: 'left', clickCount: 1 };
        sel.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        sel.webContents.sendInputEvent({ type: 'mouseDown', ...base });
        sel.webContents.sendInputEvent({ type: 'mouseUp', ...base });
        return { ok: true };
      },
      // PR #233 F14: a real mouse wheel over the selected tab's view (x, y in its own pixels), with Ctrl held if asked. Answers the view's PAGE
      // zoom factor after it, which the chat's Ctrl+wheel must leave at 1.
      async mouseWheel(x, y, deltaY, ctrl) {
        const sel = selectedView();
        if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
        sel.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        sel.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, canScroll: true, modifiers: ctrl ? ['control'] : [] });
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, zoomFactor: sel.webContents.getZoomFactor() };
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
      // #71: the selected tab's Claude's panel, from the outside: where it is, whether it shows, and the title its page set.
      async canvas(action, args) {
        const sel = selectedView();
        if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
        if (action === 'inspect') return { ok: true, ...canvasViews.inspect(sel.webContents) };
        return { ok: canvasViews.click(sel.webContents, args.x, args.y) };
      },
      // #119 A4: the selected tab's Preview view, from the outside: where it is, whether it shows, its address and the title its page set.
      async preview(action, file) {
        const sel = selectedView();
        if (!sel || sel.webContents.isDestroyed()) return { ok: false, error: 'no selected view' };
        if (action === 'shot') {
          const wc = previewViews.shotTarget(sel.webContents);
          if (!wc || wc.isDestroyed()) return { ok: false, error: 'no preview view' };
          return { ok: true, bytes: await capture(wc, file) };
        }
        return { ok: true, ...previewViews.inspect(sel.webContents) };
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
      // PR #236 Miguel Y4: a key to the strip page itself. Says first whether the strip page held the keyboard (only meaningful while
      // the window is focused, which a probe can't make sure of while someone uses the machine).
      async stripKey(key, modifiers) {
        if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
        const stripFocused = win.webContents.isFocused();
        const windowFocused = win.isFocused();
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
        return { ok: true, stripFocused, windowFocused };
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
      // #62: press the strip's own Lean button / Back to normal (the click handler, not a shortcut around it).
      async stripLean(button) {
        const clicked = await win.webContents.executeJavaScript(
          `(() => { const b = document.getElementById(${JSON.stringify(button)}); if (!b || b.hidden || (b.offsetParent === null && !b.getClientRects().length)) return false; b.click(); return true; })()`);
        return { ok: clicked === true, clicked: clicked === true };
      },
      async quit(graceful) {
        // A probe's hard exit skips will-quit; graceful is the path a closed window takes (verify/probe-pause-panel.js needs it).
        setTimeout(() => (graceful === true ? app.quit() : app.exit(0)), 200);
        return { ok: true };
      },
      // BACKLOG #119 A8 (verify/probe-tray.js): the tray's own state, and its click and menu through the same functions the real
      // Tray events call. Only a window started with CLAUDE_CUSTOM_TRAY_PROBE=1 has a tray.
      async tray() {
        if (!trayController) return { ok: false, error: 'no tray in this window' };
        const snap = tabShell.snapshot();
        return { ok: true, tray: trayController.state(), visible: win.isVisible(), minimized: win.isMinimized(), selectedKey: snap.selectedKey,
          tabs: snap.tabs.map(t => ({ key: t.key, branch: t.branch || null, needsInput: !!(t.status && t.status.needsInput), finished: !!(t.status && t.status.finished) })),
          settings: readTraySettings(uiStore) };
      },
      // The Tray's current image as a PNG, so a person can look at what a probe measured (a Tray can't be screenshotted).
      async trayImage(file) {
        const img = trayController && trayController.image();
        if (!img) return { ok: false, error: 'no tray image' };
        fs.writeFileSync(file, img.toPNG());
        return { ok: true, bytes: fs.statSync(file).size };
      },
      async trayClick() {
        if (!trayController) return { ok: false, error: 'no tray in this window' };
        trayController.click();
        return { ok: true };
      },
      async trayMenu(clickLabel) {
        if (!trayController) return { ok: false, error: 'no tray in this window' };
        const t = await trayController.template();
        const rows = t.filter(x => x.type !== 'separator');
        if (clickLabel) {
          const row = rows.find(x => x.label === clickLabel);
          if (!row || !row.click) return { ok: false, error: 'no row ' + clickLabel };
          row.click({ checked: row.type === 'checkbox' ? !row.checked : undefined });
        }
        return { ok: true, rows: rows.map(x => ({ label: x.label, checked: x.checked, sub: x.submenu ? x.submenu.map(y => y.label) : null })) };
      },
      async traySetting(key, value) {
        const saved = writeTraySetting(uiStore, key, value);
        if (trayController) trayController.sync();
        return { ok: saved !== null, settings: saved };
      },
      // Close the window as the X does (the 'close' handler decides: hide to the tray, or really close).
      async winClose() { win.close(); return { ok: true, destroyed: win.isDestroyed(), visible: win.isDestroyed() ? false : win.isVisible() }; },
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

  // The owner side: a launch came in (and was already answered "accepted": it never waits for this window to start). Once the window is
  // ready, focus it (restoring a minimised or tray-hidden window) and select the lane the launch named, if this window has one.
  async function onLaunchFocus(msg) {
    focusWindow();
    const key = windowOwner.pickLane(tabShell.snapshot().tabs, msg);
    if (key) tabShell.select(key);
    console.log(`[main] a second launch asked for this window (${JSON.stringify(msg.cwd || null)}${msg.port ? `, port ${msg.port}` : ''}): ${key ? 'selected a lane' : 'focused'}`);
  }

  const windowClaim = createWindowClaim({
    enabled: ONE_WINDOW_ON, stateRoot: STATE_ROOT, pid: process.pid, ownStart: () => ownStartTime(), startTimes,
    project: PROJECT, launchCwd: LAUNCH_CWD, explicitPort: EXPLICIT_PORT,
    listen: windowFocus.listen, claim: windowOwner.claim, send: windowFocus.send, takeOver: windowOwner.takeOver,
    release: windowOwner.release, forwardedCwd: windowOwner.forwardedCwd,
    act: onLaunchFocus,
    onExit: (fn) => process.on('exit', fn),       // app.exit skips will-quit; a crash leaves a file the next launch proves dead
    log: (...a) => console.log(...a),
  });

  // --- the phases main.js calls, in the order whenReady runs them -----------------------

  /** The services this window runs on its own: occupancy, transcripts, issues, the tab strip's layout, and the tab shell. */
  function startServices({ seams, openPrsReader }) {
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
      // #81: a side host's session: its agents' claims are readers', whoever writes them
      readerSessions: () => readerSessionIds(ownIdentities() || []),
      projectsDir: seams.projectsDir || defaultProjectsDir(),
      roots: createRootsProvider({ cwd: STATE_ROOT, log: (...a) => console.log(...a) }),
      // The SAME store the hosts write to. The proof a reader checks is this window's own process: its claims
      // go dark with it, and close() removes the ones it still owns.
      writer: createClaimWriter({ stateRoot: STATE_ROOT, log: (...a) => console.log(...a) }),
      dir: occupancyDir(STATE_ROOT),
      ownPid: process.pid,
      ownStartedAt: ownStartTime,
      // one producer per agent: what the readers already show as live is left to whoever wrote it
      liveClaims: () => occupancyService.current(),
      log: (...a) => console.log(...a),
    });
    // The GitHub issues of this project's repo (#119 A6). host/probe-seams.js gives the probe a stand-in for gh.
    issueService = createIssueService();
    // Which issue each lane was made from, kept with the project's state so the link outlives a restart and the issue closing.
    let linksFile = null;
    try { linksFile = issueLinksFileFor(STATE_ROOT); } catch (err) { console.log('[main] issue links: kept in memory only:', err && err.message); }
    const issueLinks = createIssueLinks({ file: linksFile });
    // The strip's drag order and the lanes closed by hand (BACKLOG #141), kept with the project's state so both survive a restart.
    let layoutFile = null;
    try { layoutFile = stripLayoutFileFor(STATE_ROOT); } catch (err) { console.log('[main] tab strip layout: kept in memory only:', err && err.message); }
    const stripLayout = createStripLayout({ file: layoutFile });
    const briefOps = createOps({ dir: scriptsDir(process.env) });
    tabShell = createShell({
      layout: stripLayout,
      usage: (key) => { try { usageCounters.bump(key); } catch { /* counting never breaks a tab */ } },
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
      // `known`: whether "no claims" can be believed (#77: a Ctrl+click close treats an unreadable service as unknown).
      occupancy: { claims: () => occupancyService.current(), known: (folder) => occupancyService.known(folder) },
      // #77: a Ctrl+click close reads the folder's git facts (uncommitted, unpushed) before deciding to skip the confirm.
      safety: { facts: (folder) => readCloseFacts(folder), readerUnsaved: (tab) => readerUnsaved.pathFor(tab.key) },
      // Type /merged's own open-PR check (PR #93 Miguel I3): gh in that worktree, or the probe's fixture.
      prs: { openFor: (folder, branch) => openPrFor(folder, branch, { read: openPrsReader }) },
      // agent-creator's worktree scripts (Contracts A, C, E); the probe points
      // CLAUDE_CUSTOM_WORKTREE_SCRIPTS at stand-ins.
      ops: createOps({ dir: scriptsDir(process.env) }),
      // #119 A6: a lane started from an issue gets its brief (host/issue-lane.js); a tab keeps its issue (the picked one, else
      // the one its branch name says when the cached list has it).
      issues: {
        brief: createLaneBriefWriter({ cwd: HOST_PROJECT.dev, service: issueService, ops: briefOps }),
        forBranch: (branch, folder) => issueLinks.get(branch, folder) || issueForBranch(branch, issueService.cached(HOST_PROJECT.dev)),
        remember: (record) => issueLinks.set(record),
      },
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
        // #129: the retry of a stop that failed, by pid: the identity file names the host's pid and its OS start time, and the kill
        // proves both on a held handle (host/kill-tree.js). No file (or no start time) for the port: the host is gone, or can't be proved.
        stopByPid: (port, who) => stopHostByPid(port, who),
        // #81: the side hosts this build's identity files say are running: a window looks for them only where one serves a folder
        sideHosts: () => sideHostsOf(ownIdentities()),
        // PR #227 Dexter 4: the branch hosts the identity files say are running, so a lane whose first look missed its host is looked for again only where one serves it
        laneHosts: () => laneHostsOf(ownIdentities()),
        // #119 A5: ... and the shell hosts, the same way
        shellHosts: () => shellHostsOf(ownIdentities()),
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
  }

  /** The Dev servers chip (#119 A4): its own persistent PowerShell, sampled like the Resources panel (host/dev-servers.js INTERVAL_MS). */
  function startDevServers() {
    devServersExec = createPersistentExec();
    devServers = createDevServersService({
      exec: devServersExec,
      tabs: () => tabShell.snapshot().tabs.filter(t => t.view && !t.view.webContents.isDestroyed()),
      portBaseOf: (cwd) => { const root = worktreeRoot(cwd); return root ? lookupPortBlock(root) : null; },
      hostPidOf: (key) => (resources ? resources.hostPidOf(key) : null),
      send: (key, state) => {
        const tab = tabShell.snapshot().tabs.find(t => t.key === key);
        if (tab && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('devservers:state', state);
      },
      log: (...a) => console.log(...a),
    });
    devServers.start();
  }

  /** The first open: the marks, the occupancy watchers, then the tabs. Answers what tabShell.open() answers. */
  async function open() {
    reloadMarks();
    if (MODE === 'tabs') pruneGoneMarks();
    occupancyService.start();
    transcriptOccupancy.start();
    const first = await tabShell.open();
    return first;
  }

  /** The poll and the issue-list warm-up that follow a window which stayed up. */
  function startPoll() {
    if (MODE === 'tabs') setInterval(() => { reloadMarks(); tabShell.poll(); }, POLL_MS);
    // #119 A6: read the repo's open issues once, a little after the window is up, so a tab whose branch came from an
    // issue already shows its link. Fire and forget: no gh, no login or no network is one dim line later, never a dialog.
    // Not under the probe driver, whose fake gh counts its calls.
    if (MODE === 'tabs' && !PROBE_PORT) setTimeout(() => { issueService.list(HOST_PROJECT.dev).catch(() => {}); }, 20_000).unref();
  }

  // What the quit handlers ask of every window (main.js forEachProject), each safe to run twice: will-quit fires twice when a quit is held.
  function stopDevServers() { if (devServers) devServers.stop(); if (devServersExec) devServersExec.close(); }
  function closeOccupancy() { if (transcriptOccupancy) transcriptOccupancy.close(); if (occupancyService) occupancyService.close(); }

  /** Hand over an app-wide service the moment main has made it. An unknown key throws: a typo must not be a silent no-op. */
  function attach(parts) {
    for (const key of Object.keys(parts)) {
      if (key === 'resources') resources = parts.resources;
      else if (key === 'trayController') trayController = parts.trayController;
      else if (key === 'leanBridge') leanBridge = parts.leanBridge;
      else if (key === 'indexing') indexing = parts.indexing;
      else throw new Error(`attach: unknown service "${key}"`);
    }
  }

  // What the indexing assistant's overlay asks of this window (its bridge is registered once, in main.js).
  const currentViewTop = () => viewTop({ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT });
  function focusSelectedView() {
    const sel = selectedView();
    if (sel && !sel.webContents.isDestroyed()) { sel.webContents.focus(); lastFocusedView = sel; }
  }
  function setIndexFieldFocused(on) { indexFieldFocused = on; }

  return {
    launchCwd: LAUNCH_CWD,
    project: PROJECT,
    mode: MODE,
    hostProject: HOST_PROJECT,
    root: PROJECT_ROOT,
    stateRoot: STATE_ROOT,
    label: WINDOW_LABEL,
    // live state: read at the moment of use, never cached (`win` is null once the window has closed)
    get win() { return win; },
    get tabShell() { return tabShell; },
    get issueService() { return issueService; },
    get focused() { return focused; },
    get focusMode() { return focusMode; },
    get attachOnlyRefusal() { return attachOnlyRefusal; },
    get devServers() { return devServers; },
    canvasViews,
    previewViews,
    readerUnsaved,
    stripAccent,
    backgroundActions,
    claim: windowClaim,
    // gates and effects the handlers in main.js reach this window's state through
    isStrip,
    isTabView,
    forEachView,
    selectedView,
    setFocusMode,
    setCue,
    pushStripAccent,
    closeTabFlow,
    tabMenuTemplate,
    lanesMenuFor,
    plusMenuFor,
    backgroundModel,
    showBackgroundMenu,
    focusWindow,
    viewTop: currentViewTop,
    focusSelected: focusSelectedView,
    setIndexFieldFocused,
    // the phases of the launch, in the order whenReady runs them
    attach,
    startServices,
    startDevServers,
    createWindow,
    syncDevServersSampling,
    open,
    startPoll,
    runScreenshotPath,
    startProbeDriver,
    stopDevServers,
    closeOccupancy,
  };
}

module.exports = { createProjectWindow };
