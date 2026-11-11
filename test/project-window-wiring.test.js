'use strict';
/**
 * The seam between app/main.js and app/project-window.js (single-instance PR 1), pinned as source text, because main.js needs
 * Electron and can't be loaded here. The point of the split is that a SECOND project window can be added without touching the
 * handlers again, so what must hold is structural:
 *
 *   - the window module never touches ipcMain or requires 'electron' (ipcMain.handle throws on a second registration, and the
 *     module must load under plain node so test/project-window.test.js can build one)
 *   - main.js keeps no per-project state of its own: its top-level `let`s are an ALLOW-LIST, so a new one has to be argued for
 *   - every ipcMain handler in main reaches a window's state only through stripOwner(e) / viewOwner(sender), never by a bare
 *     `win` / `tabShell` / ... nor through `launchWindow.` (that is "the" window, which is the thing a second window breaks)
 *   - the window's own units (lean, indexing overlay) are attached before it starts; the Resources service and the tray are read live
 *   - `registry` (app/project-registry.js) is the one registry; whenReady runs the launch in a fixed order and the window's own phases
 *     are its start() (single-instance PR 2: several windows in one process, so "the" window is named only where it must be)
 *   - `launchWindow` (the process's own launch window) is named only where the launch is the point: an allow-list of functions below
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
// The ONLY top-level `let`s main may have: app-wide, one per process. A new one fails here until someone says why it isn't a window's.
const APP_LETS = ['repoDragIcon', 'resources', 'resourceSampler', 'indexingApp', 'playback', 'appStart', 'trayController', 'quitting', 'canvasAskSeq', 'pausedWoken'];
// The late app-wide services a window is handed by attach(), and the statement in main that makes each. (A window's OWN lean unit and
// indexing overlay are made by makeWindowUnits and attached together: pinned in the next test.)
const LATE = [['trayController', 'trayController = createTrayController({'], ['resources', 'resources = createResourcesService({']];

// The end of the call whose `(` is the first one at or after `at`: string-aware.
function callEnd(src, at) {
  const open = src.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced call');
}

test('the window module touches no ipcMain and requires no electron', () => {
  assert.doesNotMatch(WINDOW, /\bipcMain\b/, 'a window never registers a channel: main does, once');
  assert.doesNotMatch(WINDOW, /require\(\s*['"]electron['"]\s*\)/, 'electron is handed in, so the module loads under plain node');
  assert.doesNotMatch(WINDOW, /\bregisterCanvasIpc\b|\bcreateIndexingBridge\b|\bregister\w+Handlers\b/, 'no bridge registers from inside a window');
  assert.match(WINDOW, /function createProjectWindow\(\{ launchCwd, electron, config, services, launch \}\)/);
});

test('main keeps no per-project binding: its top-level lets are exactly the app-wide allow-list', () => {
  const lets = [...MAIN.matchAll(/^let (\w+)/gm)].map((m) => m[1]);
  assert.deepStrictEqual([...lets].sort(), [...APP_LETS].sort(), 'main\'s top-level `let`s must be the app-wide ones; a window\'s binding belongs in the factory');
  for (const name of PROJECT_CONSTS) {
    assert.doesNotMatch(MAIN, new RegExp(`^const ${name}\\b`, 'm'), `main must not own \`const ${name}\`: it is the window's`);
  }
  for (const name of ['PROJECT', 'MODE', 'HOST_PROJECT', 'PROJECT_ROOT', 'STATE_ROOT', 'WINDOW_LABEL']) {
    assert.doesNotMatch(MAIN, new RegExp(`^const ${name}\\b`, 'm'), `${name} is worked out by the window`);
  }
});

test('the window owns each of those bindings, as a closure variable', () => {
  for (const name of PROJECT_LETS) assert.match(WINDOW, new RegExp(`^  let ${name}\\b`, 'm'), `the window declares \`let ${name}\``);
  for (const name of PROJECT_CONSTS) assert.match(WINDOW, new RegExp(`^  const ${name}\\b`, 'm'), `the window declares \`const ${name}\``);
});

test('the window is handed its two own units by attach(), and reads the Resources service and the tray LIVE through getters', () => {
  assert.match(WINDOW, /function attach\(parts\) \{/);
  assert.match(WINDOW, /else throw new Error\(`attach: unknown service "\$\{key\}"`\);/, 'a typo in an attach key must not be a silent no-op');
  assert.match(WINDOW, /key === 'leanBridge'\) leanBridge = parts\.leanBridge;/);
  assert.match(WINDOW, /else if \(key === 'indexing'\) indexing = parts\.indexing;/);
  assert.doesNotMatch(WINDOW, /key === 'resources'|key === 'trayController'|^  let resources\b|^  let trayController\b/m, 'a later window sees them with no extra call');
  // main's two lets are what the getters read: a window sees each become non-null at the same moment main does
  assert.match(MAIN, /getResources: \(\) => resources,/);
  assert.match(MAIN, /getTray: \(\) => trayController,/);
  for (const [name, assignment] of LATE) assert.ok(MAIN.includes(assignment), `main makes ${name}`);
});

test('a window\'s own lean unit and indexing overlay are made per window and attached together, before the window opens', () => {
  const body = bodyAt(MAIN, MAIN.indexOf('function makeWindowUnits('));
  assert.match(body, /const lean = createLeanUnit\(\{/);
  assert.match(body, /const overlay = makeIndexingOverlay\(pw\);/);
  assert.match(body, /windowUnits\.set\(pw, \{ lean, overlay \}\);\s*pw\.attach\(\{ leanBridge: lean, indexing: overlay \}\);/, 'the window sees both the moment main has them');
  const ready = MAIN.slice(MAIN.indexOf('app.whenReady().then('));
  assert.match(ready, /startIndexing\(seams\);\s*startTray\(\);\s*const \{ first \} = await startProject\(LAUNCH_CWD/, 'the service exists before the first window (and so its overlay)');
  const sp = bodyAt(MAIN, MAIN.search(/async function startProject\(/));
  assert.ok(sp.search(/makeWindowUnits\(pw\)/) < sp.search(/await pw\.start\(appStart\)/), 'attached before the window starts');
  assert.match(MAIN, /onWindowCreated: \(pw\) => windowCreated\(pw\),/);
});

test('main hands the window its quit state as live callbacks, never as a copy', () => {
  assert.match(MAIN, /isQuitting: \(\) => quitting,/);
  assert.match(MAIN, /setQuitting: \(v\) => \{ quitting = v; \},/);
});

test('every ipcMain handler in main reaches window state through stripOwner(e) / viewOwner(sender), never a bare name or launchWindow', () => {
  const bare = new RegExp(`(?<![\\w$.'])(${[...PROJECT_LETS, ...PROJECT_CONSTS, 'closeTabFlow', 'setFocusMode', 'pushStripAccent', 'setCue', 'selectedView', 'forEachView', 'MODE', 'HOST_PROJECT'].join('|')})(?![\\w$'])`);
  const registerIpc = bodyAt(MAIN, MAIN.indexOf('function registerIpc('));
  const handlers = [...registerIpc.matchAll(/ipcMain\.(on|handle)\(\s*'([^']+)'/g)];
  assert.ok(handlers.length >= 60, `the scan finds the handlers (${handlers.length})`);
  const leaks = [];
  for (const h of handlers) {
    // the attention handler's log line spells the word `focused=` as text (its value is owner.focused)
    const text = registerIpc.slice(h.index, callEnd(registerIpc, h.index)).replace('(focused=${', '(focus-state=${');
    const m = bare.exec(text);
    if (m) leaks.push(`${h[2]}: bare ${m[1]}`);
    if (/\blaunchWindow\b/.test(text)) leaks.push(`${h[2]}: launchWindow`);
  }
  assert.deepStrictEqual(leaks, [], 'a handler that names the window directly is a handler a second window breaks');
  // and the two resolvers exist, with gates that stay boolean (every bridge requires isSender(...) === true)
  assert.match(MAIN, /function stripOwner\(event\) \{ return registry\.stripOwner\(event\); \}/);
  assert.match(MAIN, /function viewOwner\(sender\) \{ return registry\.viewOwner\(sender\); \}/);
  assert.match(MAIN, /const fromStrip = \(event\) => stripOwner\(event\) !== null;/);
  assert.match(MAIN, /const isTabView = \(sender\) => viewOwner\(sender\) !== null;/);
});

test('registry is the one registry of project windows (app/project-registry.js), with the launch window added to it', () => {
  assert.strictEqual((MAIN.match(/\bconst registry = createProjectRegistry\(\);/g) || []).length, 1);
  assert.strictEqual((MAIN.match(/^registry\.add\(launchWindow\);/gm) || []).length, 1);
  assert.doesNotMatch(MAIN, /\bprojectWindows\b/, 'the old Map is gone');
  assert.strictEqual((MAIN.match(/\bcreateProjectWindow\(/g) || []).length, 1, 'main makes one window from the launch (startProject makes the rest in step 6)');
  // every place main walks the windows goes through the registry
  assert.match(MAIN, /function forEachProject\(fn\) \{ registry\.forEach\(fn\); \}/);
  assert.doesNotMatch(MAIN, /\blaunchWindow\b[^;\n]*=\s*null/, 'launchWindow is a const');
});

test('whenReady runs the launch in this order (single-instance PR 2: the window\'s own phases are its start())', () => {
  const ready = MAIN.slice(MAIN.indexOf('app.whenReady().then('));
  const order = ['launchWindow.claim.run()', 'await startResources(seams)', 'Menu.setApplicationMenu(null)', 'registerIpc()', 'startIndexing(seams)', 'startTray()',
    'await startProject(LAUNCH_CWD, { launch: true })', 'launchWindow.claim.markReady()', 'launchWindow.attachOnlyRefusal',
    'launchWindow.startPoll()', 'launchWindow.runScreenshotPath()', 'startProbeServer({'];
  let from = -1;
  for (const step of order) {
    const at = ready.indexOf(step);
    assert.ok(at !== -1, `whenReady must call ${step}`);
    assert.ok(at > from, `${step} must come after the step before it`);
    from = at;
  }
  // The window's own phases, in the one order they can run (win.on('focus') calls the shell, so the services come first; the dev servers'
  // sampling is read after the window exists): they are start() in the window, not main's interleaving.
  const startBody = bodyAt(WINDOW, WINDOW.indexOf('async function start('));
  let p = -1;
  for (const step of ['startServices({ seams, openPrsReader })', 'startDevServers()', 'createWindow()', 'syncDevServersSampling()', 'return open()']) {
    const at = startBody.indexOf(step);
    assert.ok(at !== -1 && at > p, `start() must run ${step} after the one before it`);
    p = at;
  }
  // The quit listeners keep their REGISTRATION order in the source (at runtime before-quit fires ahead of every will-quit):
  // dev servers, the paused hold, before-quit, then the tray / sampler / occupancy close, then the watchdog.
  const quit = ['p.stopDevServers()', 'resources.resumeAll(', 'forEachProject((p) => p.claim.stop())', 'trayController.destroy()', 'resourceSampler.stop()', 'p.closeOccupancy()', 'armQuitWatchdog('];
  let q = MAIN.indexOf("app.on('window-all-closed'");
  for (const step of quit) {
    const at = MAIN.indexOf(step, q);
    assert.ok(at !== -1 && at >= q, `the quit handlers must run ${step} after the one before it`);
    q = at;
  }
});

test('startProject: the launch window is the process\'s own; any other project is a window with no port and no claim of its own, or the open one brought forward', () => {
  const make = bodyAt(MAIN, MAIN.search(/function makeWindow\(/));
  assert.match(make, /EXPLICIT_PORT: launch \? EXPLICIT_PORT : null,/, 'a port-named launch is its own process: no second window inherits its port (CLAUDE_CUSTOM_PORT)');
  assert.match(make, /launch,/, 'the window is told whether it is the launch window (it alone holds the claim)');
  const sp = bodyAt(MAIN, MAIN.search(/async function startProject\(/));
  assert.match(sp, /const pw = launch \? launchWindow : makeWindow\(cwd, false\);/);
  assert.match(sp, /registry\.get\(pw\.root\);\s*if \(open !== null\) \{ open\.focusWindow\(\); return \{ pw: open, existing: true, first: null \}; \}\s*registry\.add\(pw\);/,
    'a project that already has a window is brought forward, not opened twice');
  assert.match(sp, /projectRecords\.make\(pw\);\s*makeWindowUnits\(pw\);\s*let first;\s*try \{\s*first = await pw\.start\(appStart\);/, 'its record and units exist before its window starts');
  assert.match(sp, /if \(!launch\) pw\.startPoll\(\);/, 'the launch window\'s poll starts after the claim\'s ready and the launch exits (whenReady)');
  assert.strictEqual((MAIN.match(/\bcreateProjectWindow\(/g) || []).length, 1, 'one maker');
  // per-launch env (plan risk 6): the token and the side-tab switch are only a port-named launch's, and that launch never gets a second window
  assert.match(WINDOW, /process\.env\.CLAUDE_CUSTOM_TOKEN/);
});

test('seam guard: `launchWindow` is named only where the launch itself is the point (an allow-list of constructs)', () => {
  // The construct that encloses each mention: the last top-level `function name(` / `async function name(` / `app.whenReady` / `const launchWindow` before it.
  const owners = new Map();
  const marks = [...MAIN.matchAll(/^(?:async )?function (\w+)\(|^(app\.whenReady)\(|^(const launchWindow) =|^(const windowServices) =/gm)]
    .map((m) => ({ at: m.index, name: m[1] || m[2] || m[3] || m[4] }));
  for (const m of MAIN.matchAll(/\blaunchWindow\b/g)) {
    let owner = '(top level)';
    for (const mk of marks) if (mk.at < m.index) owner = mk.name;
    owners.set(owner, (owners.get(owner) || 0) + 1);
  }
  const allowed = {
    'const launchWindow': 'its construction',
    'app.whenReady': 'the launch order: claim, markReady, the refusals, the poll, the screenshot and the probe driver',
    startProject: 'launch ? launchWindow : makeWindow(...)',
    startTray: 'the label the tray names before any window exists',
    startIndexing: 'warming the chip\'s list for the launch project',
    registerIpc: 'the vault probe, which uses the launch window\'s service',
  };
  const names = [...owners.keys()].filter((k) => k !== '(top level)').sort();
  assert.deepStrictEqual(names, Object.keys(allowed).sort(), 'a new place that names the launch window is a place a second window breaks: argue for it here');
  // ...and registerIpc names it ONLY in the vault probe
  const ipc = bodyAt(MAIN, MAIN.search(/function registerIpc\(/));
  assert.strictEqual((ipc.match(/\blaunchWindow\b/g) || []).length, 1);
  assert.match(ipc, /projectRecords\.secretsOf\(launchWindow\);\s*\/\/ the launch window's service|projectRecords\.secretsOf\(launchWindow\)/);
});

test('seam guard: no handler reaches a per-project record except through the owner (secretsOf(viewOwner(..)) / scopeFor(viewOwner, ..) / windowUnits via the resolvers)', () => {
  const ipc = bodyAt(MAIN, MAIN.search(/function registerIpc\(/));
  const used = [...ipc.matchAll(/projectRecords\.(\w+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(used)].sort(), ['scopeFor', 'secretsOf']);
  for (const m of ipc.matchAll(/projectRecords\.secretsOf\(([^)]*\))?/g)) assert.match(m[0], /viewOwner\(event\.sender\)|launchWindow/, 'secrets are reached through the sender\'s window');
  assert.match(ipc, /scopeFor\(viewOwner, 'layoutSync'\)/);
  assert.match(ipc, /scopeFor\(viewOwner, 'treeSync'\)/);
  // windowUnits: only the two unit resolvers (lean here; the indexing overlay's are in startIndexing) read it, always from an owner found by sender
  const reads = [...ipc.matchAll(/windowUnits\.get\((\w+)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(reads, ['v', 'st']);
  assert.match(ipc, /const v = viewOwner\(sender\);/);
  assert.match(ipc, /const st = registry\.stripOwner\(\{ sender \}\);/);
});

test('close vs quit (P3 at the wiring level): a closed window tells main; main disposes it only when another stays, and drops everything it holds for it', () => {
  assert.match(WINDOW, /win\.on\('closed', \(\) => \{ win = null; if \(tabShell\) tabShell\.destroy\(\); onClosed\(self\); \}\);/);
  assert.match(MAIN, /onClosed: \(pw\) => projectClosed\(pw\),/);
  const closed = bodyAt(MAIN, MAIN.search(/function projectClosed\(/));
  assert.match(closed, /if \(registry\.closed\(pw\)\) \{\s*projectRecords\.stop\(pw\);\s*windowUnits\.delete\(pw\);/, 'the registry decides (it keeps the last window); main drops the record and units only for a disposed one');
  assert.match(closed, /unwatch\(\);/, 'its playback watch goes');
  assert.match(closed, /trayController\.sync\(\)/);
  assert.match(closed, /windowServices\.seenChanged\(\)/, 'the Resources sampler asks again who is looking');
  assert.doesNotMatch(closed, /quitting/, 'a quit cancelled by one window\'s prompt has already closed another: it must not stay registered with no window');
  // the quit path is the last window\'s and is unchanged: window-all-closed quits, the quit handlers stop each window
  assert.match(MAIN, /app\.on\('window-all-closed', \(\) => \{\s*app\.quit\(\);\s*\}\);/);
});

test('dispose() stops what a window runs on its own, and the poll and the issue warm-up are guarded timers', () => {
  const dispose = bodyAt(WINDOW, WINDOW.search(/function dispose\(\)/));
  for (const piece of ['timers.dispose();', 'stopDevServers();', 'closeOccupancy();', 'windowClaim.stop();']) assert.ok(dispose.includes(piece), `dispose runs ${piece}`);
  assert.match(WINDOW, /timers\.startPoll\(POLL_MS, \(\) => \{ reloadMarks\(\); tabShell\.poll\(\); \}\);/);
  assert.match(WINDOW, /timers\.later\('issue list warm-up', 20_000,/);
  assert.match(WINDOW, /win\.on\(ev, timers\.guard\('dev-servers sampling', syncDevServersSampling\)\);/);
  assert.doesNotMatch(WINDOW, /\bsetInterval\(/, 'no bare interval: a timer that outlives its window ticks a dead shell');
});

test('the crash guard: a non-launch project that fails to start costs its own window only; the launch window\'s failure is whenReady\'s', () => {
  const sp = bodyAt(MAIN, MAIN.search(/async function startProject\(/));
  assert.match(sp, /\} catch \(err\) \{[\s\S]*?if \(launch\) throw err;[\s\S]*?registry\.remove\(pw\);\s*projectRecords\.stop\(pw\);\s*windowUnits\.delete\(pw\);\s*pw\.dispose\(\);/);
  assert.match(sp, /return \{ pw: null, existing: false, first: null, error:/);
});

test('the project window is made after every app-wide constant it is handed (a const read before its line is a TDZ error)', () => {
  const made = MAIN.indexOf('const windowServices = {');
  assert.ok(made !== -1);
  assert.ok(MAIN.indexOf('const launchWindow = makeWindow(LAUNCH_CWD, true);') > made, 'the launch window is made after the services it is handed');
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
