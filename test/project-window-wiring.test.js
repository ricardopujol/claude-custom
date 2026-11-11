'use strict';
/**
 * The seam between app/main.js and app/project-window.js (single-instance PR 1), pinned as source text, because main.js needs
 * Electron and can't be loaded here. The point of the split is that a SECOND project window can be added without touching the
 * handlers again, so what must hold is structural:
 *
 *   - the window module never touches ipcMain or requires 'electron' (ipcMain.handle throws on a second registration, and the
 *     module must load under plain node so test/project-window.test.js can build one)
 *   - main.js keeps no per-project state of its own: none of the window's bindings is a top-level `let`/`const` there
 *   - every ipcMain handler in main reaches a window's state only through stripOwner(e) / viewOwner(sender), never by a bare
 *     `win` / `tabShell` / ... (a bare name would be "the" window, which is the thing a second window breaks)
 *   - projectWindows is the one registry, and whenReady runs the window's phases in the order they ran before the move
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mainOnly, windowOnly, mainProcessSource, bodyAt, stripComments } = require('./main-source');

const MAIN = stripComments(mainOnly());
const WINDOW = stripComments(windowOnly());

// What was a module-level binding of app/main.js and is one project window's now (the plan's inventory, "Project" rows).
const PROJECT_LETS = ['attachOnlyRefusal', 'marks', 'win', 'tabShell', 'issueService', 'resHistoryView', 'occupancyService', 'transcriptOccupancy',
  'focusMode', 'indexFieldFocused', 'windowFrameless', 'cueOn', 'focused', 'devServers', 'devServersExec', 'lastStripPayload', 'lastFocusedView',
  'stripWasBusy', 'lastStripAccent', 'closeAsking'];
const PROJECT_CONSTS = ['readerUnsaved', 'liveViews', 'canvasViews', 'previewViews', 'previewKeyOf', 'stripAccent', 'backgroundActions', 'windowClaim'];
// what stays app-wide, one per process
const APP_LETS = ['resources', 'resourceSampler', 'trayController', 'quitting', 'leanBridge', 'indexing', 'canvasAskSeq', 'pausedWoken', 'repoDragIcon'];

test('the window module touches no ipcMain and requires no electron', () => {
  assert.doesNotMatch(WINDOW, /\bipcMain\b/, 'a window never registers a channel: main does, once');
  assert.doesNotMatch(WINDOW, /require\(\s*['"]electron['"]\s*\)/, 'electron is handed in, so the module loads under plain node');
  assert.doesNotMatch(WINDOW, /\bregisterCanvasIpc\b|\bcreateIndexingBridge\b|\bregister\w+Handlers\b/, 'no bridge registers from inside a window');
  assert.match(WINDOW, /function createProjectWindow\(\{ launchCwd, electron = \{\}, config = \{\}, services = \{\} \}\)/);
});

test('main keeps no per-project binding of its own', () => {
  for (const name of PROJECT_LETS) {
    assert.doesNotMatch(MAIN, new RegExp(`^let ${name}\\b`, 'm'), `main must not own \`let ${name}\`: it is the window's`);
  }
  for (const name of PROJECT_CONSTS) {
    assert.doesNotMatch(MAIN, new RegExp(`^const ${name}\\b`, 'm'), `main must not own \`const ${name}\`: it is the window's`);
  }
  for (const name of ['PROJECT', 'MODE', 'HOST_PROJECT', 'PROJECT_ROOT', 'STATE_ROOT', 'WINDOW_LABEL']) {
    assert.doesNotMatch(MAIN, new RegExp(`^const ${name}\\b`, 'm'), `${name} is worked out by the window`);
  }
});

test('the window owns each of those bindings, as a closure variable', () => {
  for (const name of PROJECT_LETS.filter((n) => n !== 'attachOnlyRefusal')) {
    assert.match(WINDOW, new RegExp(`^  let ${name}\\b`, 'm'), `the window declares \`let ${name}\``);
  }
  assert.match(WINDOW, /^  let attachOnlyRefusal\b/m);
  for (const name of PROJECT_CONSTS) assert.match(WINDOW, new RegExp(`^  const ${name}\\b`, 'm'), `the window declares \`const ${name}\``);
});

test('what is app-wide stays in main', () => {
  for (const name of APP_LETS) assert.match(MAIN, new RegExp(`^let ${name}\\b`, 'm'), `main keeps \`let ${name}\` (one per process)`);
  // the window sees the app-wide services that come later only through attach()
  assert.match(WINDOW, /function attach\(parts\) \{/);
  for (const name of ['resources', 'trayController', 'leanBridge', 'indexing']) {
    assert.match(WINDOW, new RegExp(`if \\('${name}' in parts\\) ${name} = parts\\.${name};`), `attach hands the window ${name}`);
  }
  for (const [name, after] of [['trayController', 'trayController = createTrayController({'], ['leanBridge', 'leanBridge = registerLeanHandlers({'],
    ['indexing', 'indexing = createIndexingBridge({'], ['resources', 'resources = createResourcesService({']]) {
    const at = MAIN.indexOf(after);
    assert.ok(at !== -1, `main assigns ${name}`);
    assert.ok(MAIN.indexOf(`launchWindow.attach({ ${name} });`, at) !== -1, `...and attaches it right after`);
  }
});

test('every ipcMain handler in main reaches window state through stripOwner(e) / viewOwner(sender), never a bare name', () => {
  const bare = new RegExp(`(?<![\\w$.'])(${[...PROJECT_LETS, ...PROJECT_CONSTS, 'closeTabFlow', 'setFocusMode', 'pushStripAccent', 'setCue', 'selectedView', 'forEachView', 'MODE', 'HOST_PROJECT'].join('|')})(?![\\w$'])`);
  const registerIpc = bodyAt(MAIN, MAIN.indexOf('function registerIpc('));
  const handlers = [...registerIpc.matchAll(/ipcMain\.(on|handle)\(\s*'([^']+)'/g)];
  assert.ok(handlers.length >= 60, `the scan finds the handlers (${handlers.length})`);
  const callEnd = (src, at) => {
    const open = src.indexOf('(', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') { for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i + 1;
    }
    throw new Error('unbalanced call');
  };
  const leaks = [];
  for (const h of handlers) {
    // the attention handler's log line spells the word `focused=` as text (its value is owner.focused)
    const text = registerIpc.slice(h.index, callEnd(registerIpc, h.index)).replace('(focused=${', '(focus-state=${');
    const m = bare.exec(text);
    if (m) leaks.push(`${h[2]}: ${m[1]}`);
  }
  assert.deepStrictEqual(leaks, [], 'a handler that names the window directly is a handler a second window breaks');
  // and the two resolvers exist, with gates that stay boolean (every bridge requires isSender(...) === true)
  assert.match(MAIN, /function stripOwner\(event\) \{/);
  assert.match(MAIN, /function viewOwner\(sender\) \{/);
  assert.match(MAIN, /const fromStrip = \(event\) => stripOwner\(event\) !== null;/);
  assert.match(MAIN, /const isTabView = \(sender\) => viewOwner\(sender\) !== null;/);
});

test('projectWindows is the one registry of project windows, with one window made from the launch', () => {
  assert.strictEqual((MAIN.match(/\bnew Map\(\[\[launchWindow\.root, launchWindow\]\]\)/g) || []).length, 1);
  assert.strictEqual((MAIN.match(/\bconst projectWindows = /g) || []).length, 1);
  assert.strictEqual((MAIN.match(/\bcreateProjectWindow\(/g) || []).length, 1, 'main makes one window from the launch');
  // every place main walks the windows goes through the Map
  assert.match(MAIN, /function forEachProject\(fn\) \{ for \(const p of projectWindows\.values\(\)\) fn\(p\); \}/);
  assert.doesNotMatch(MAIN, /\blaunchWindow\b[^;\n]*=\s*null/, 'launchWindow is a const');
});

test('whenReady runs the window\'s phases in the order they ran when this was one file', () => {
  const ready = MAIN.slice(MAIN.indexOf('app.whenReady().then('));
  const order = ['launchWindow.claim.run()', 'launchWindow.startServices(', 'resources = createResourcesService(', 'launchWindow.attach({ resources })',
    'launchWindow.startDevServers()', 'Menu.setApplicationMenu(null)', 'launchWindow.createWindow()', 'launchWindow.syncDevServersSampling()',
    'registerIpc()', 'startIndexing(seams)', 'startTray()', 'await launchWindow.open()', 'launchWindow.claim.markReady()',
    'launchWindow.startPoll()', 'launchWindow.runScreenshotPath()', 'launchWindow.startProbeDriver('];
  let from = -1;
  for (const step of order) {
    const at = ready.indexOf(step);
    assert.ok(at !== -1, `whenReady must call ${step}`);
    assert.ok(at > from, `${step} must come after the step before it`);
    from = at;
  }
  // the quit handlers keep their order: dev servers, the paused hold, before-quit, then the tray / sampler / occupancy close, then the watchdog
  const quit = ['p.stopDevServers()', 'resources.resumeAll(', 'forEachProject((p) => p.claim.stop())', 'trayController.destroy()', 'resourceSampler.stop()', 'p.closeOccupancy()', 'armQuitWatchdog('];
  let q = MAIN.indexOf("app.on('window-all-closed'");
  for (const step of quit) {
    const at = MAIN.indexOf(step, q);
    assert.ok(at !== -1 && at >= q, `the quit handlers must run ${step} after the one before it`);
    q = at;
  }
});

test('the project window is made after every app-wide constant it is handed (a const read before its line is a TDZ error)', () => {
  const made = MAIN.indexOf('const launchWindow = createProjectWindow({');
  assert.ok(made !== -1);
  for (const dep of ['const stopHostByPid = ', 'const toasts = ', 'const canvasAsks = ', 'const canvasProbeResolve = ', 'const probeConfirms = ', 'const logShellError = ',
    'const stripFileFor = ', 'const ownStartTime = ', 'const INSTALL_DIR = ', 'const uiStore = ', 'const usageCounters = ']) {
    const at = MAIN.indexOf(dep);
    assert.ok(at !== -1 && at < made, `${dep.trim()} must be declared before the window is made`);
  }
});

test('the two files together still hold what each pin above reads (the combined source is the main process)', () => {
  const both = mainProcessSource();
  assert.ok(both.length > MAIN.length && both.length > WINDOW.length);
  assert.match(both, /function createProjectWindow\(/);
  assert.match(both, /function registerIpc\(/);
});
