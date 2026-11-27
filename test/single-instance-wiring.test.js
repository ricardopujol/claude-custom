'use strict';
/**
 * app/main.js wiring of the app lock (single-instance PR 3) as source text: main needs Electron and cannot load here. The behaviour is
 * tested on host/app-claim.js, app/open-project.js, app/open-queue.js, app/quit-gate.js and host/open-windows.js; this pins the order main
 * calls them in, and the seams (step 14). verify/probe-single-instance.js runs the real thing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mainOnly, stripComments, bodyAt } = require('./main-source');

const MAIN = stripComments(mainOnly());
const ready = MAIN.slice(MAIN.indexOf('app.whenReady().then('));
const readyBody = ready.slice(0, ready.indexOf('}).catch((err) => {'));
const catchBody = ready.slice(ready.indexOf('}).catch((err) => {'), ready.indexOf('});', ready.indexOf('}).catch((err) => {')));

const inOrder = (src, steps) => {
  let from = -1;
  for (const step of steps) {
    const at = src.indexOf(step, from + 1);
    assert.ok(at !== -1, `missing (after the step before it): ${step}`);
    from = at;
  }
};

test('whenReady: the bad-port exit, then the app claim, and a launch handed over leaves before any service or window', () => {
  inOrder(readyBody, ['EXPLICIT_PORT.bad', "if (await appClaim.run() === 'exit') {", 'removeOwnCache();', 'app.exit(0);', 'return;', 'const seams = readSeams(process.env);']);
  assert.ok(readyBody.indexOf('appClaim.run()') < readyBody.indexOf('await startResources(seams)'));
});

test('whenReady: services, menu, IPC, indexing, tray, then the launch window, its refusals, quitIfEmpty, and only then the app claim is ready', () => {
  inOrder(readyBody, ['await startResources(seams)', 'Menu.setApplicationMenu(null)', 'registerIpc()', 'startIndexing(seams)', 'startTray()',
    "await startProject(LAUNCH_CWD, { launch: true, show: 'setting' })", 'launchWindow.attachOnlyRefusal', "launchWindow.mode === 'single'",
    'if (quitIfEmpty()) return;', 'appClaim.markReady()', 'launchWindow.startPoll()', 'runScreenshotPath()', 'startProbeServer({']);
});

test('a launch whose project is another process\'s window, or whose start ended with no window, goes through quitIfEmpty (never a swallowed launch)', () => {
  assert.match(readyBody, /if \(launched\.elsewhere\) \{ quitIfEmpty\(\); return; \}/);
  // PR #258 Miguel I4: the decision is app/app-lifecycle.js's (test/app-lifecycle.test.js: a window or an open in flight keeps the process,
  // the app claim stops before the quit); main only wires it
  assert.match(MAIN, /const quitIfEmpty = \(\) => appLifecycle\.quitIfEmpty\(\);/);
});

test('every app.exit in whenReady after the app claim ran stops the app claim first (a held launch hears no)', () => {
  const seg = readyBody.slice(readyBody.indexOf('const seams = readSeams'));
  const exits = [...seg.matchAll(/app\.exit\(/g)].length;
  const stops = [...seg.matchAll(/appClaim\.stop\(\)/g)].length;
  assert.ok(exits >= 2 && stops >= exits, `${exits} exits, ${stops} stops`);
});

test('the .catch stops the app claim; before-quit stops it', () => {
  assert.match(catchBody, /appClaim\.stop\(\);/);
  assert.match(MAIN, /app\.on\('before-quit'[\s\S]{0,600}appClaim\.stop\(\)/);
});

test('the app claim is made from the config table, acts through openProject (shown), and is the only open entry besides the tray/menu/probe/restore', () => {
  assert.match(MAIN, /const APP_LOCK = appLockConfig\(\{ env: process\.env, installDir: INSTALL_DIR, explicitPort: EXPLICIT_PORT, seams: readSeams\(process\.env\) \}\);/);
  assert.match(MAIN, /const appClaim = createAppClaim\(\{[\s\S]{0,800}enabled: APP_LOCK\.on,[\s\S]{0,800}act: \(msg\) => openProject\(\{ cwd: msg\.cwd, env: msg\.env, show: 'shown' \}\)/);
  assert.match(MAIN, /function openProject\(o\) \{ return openQueue\.push\(o\); \}/);
  assert.match(MAIN, /const openQueue = createOpenQueue\(\{ open: \(o\) => opener\.openProject\(o\)/);
});

test('cache-dirs exports removeOwn and main calls it only on the handed-over exit', () => {
  // removeOwn's behaviour is test/cache-dirs.test.js's (this file scans source text and requires no mutated module)
  assert.match(MAIN, /require\('\.\/cache-dirs'\)\.removeOwn\(\)/);
  assert.strictEqual((MAIN.match(/removeOwnCache\(\);/g) || []).length, 1, 'one call');
  assert.ok(readyBody.indexOf('removeOwnCache();') > readyBody.indexOf("appClaim.run() === 'exit'"));
});

// (one test for this handler: PR #258 Miguel S6 merged the probe-found duplicate here. The record is written clean BEFORE the app claim
// stops, because stop releases app.json and the writer writes only while this process owns it: verify/probe-single-instance.js case 7.)
test('step 11: ONE before-quit handler, the gate first; only when it passes, the record clean, quitting = true and the app claim and every window claim stop', () => {
  assert.strictEqual((MAIN.match(/app\.on\('before-quit'/g) || []).length, 1);
  const body = (MAIN.match(/app\.on\('before-quit', \(e\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  assert.match(body, /if \(quitGate\.onBeforeQuit\(e\)\) return;\s*markRecordClean\(\);\s*quitting = true; forEachProject\(\(p\) => p\.claim\.stop\(\)\); appClaim\.stop\(\);/);
});

test('step 11: quitCancelled puts quitting back, resets the gate, resumes the app claim and every open window\'s claim; the tray\'s quit is app.quit alone', () => {
  // the pieces (quitting back, the gate reset, every claim resumed, the record reopened) are app/app-lifecycle.js's, behaviour-tested
  assert.match(MAIN, /const quitCancelled = \(\) => appLifecycle\.quitCancelled\(\);/);
  assert.match(MAIN, /setQuitting: \(v\) => \{ quitting = v; \},\s*isQuitting: \(\) => quitting,/);
  assert.match(MAIN, /quitCancelled: \(\) => quitCancelled\(\),/);
  assert.match(MAIN, /quit: \(\) => app\.quit\(\),/);
  const win = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'project-window.js'), 'utf8');
  assert.match(win, /else quitCancelled\(\);/, 'the window\'s own Cancel goes through main');
  assert.doesNotMatch(win, /windowClaim\.resume\(\)/, 'the window no longer resumes only its own claim');
  assert.match(win, /if \(closeGuarded \|\| quitAllowed \|\| readerUnsaved\.all\(\)\.length === 0\) return;/);
});

test('step 11: the question sits on the dirty window used last, shown first; the probe answers discard and records it', () => {
  const ask = MAIN.slice(MAIN.indexOf('const quitGate = createQuitGate({'));
  assert.match(ask, /const parent = dirtyParent\(\);\s*if \(parent\) parent\.focusWindow\(\);/);
  assert.match(ask, /probe: !!PROBE_PORT,[\s\S]{0,200}record: \(entry\) => \{ probeConfirms\.push\(entry\); console\.log\(/);
  // which windows are asked about, and which one the question sits on: app/app-lifecycle.js (gateWindows, dirtyParent; PR #258 Dexter 6)
  assert.match(ask, /windows: \(\) => appLifecycle\.gateWindows\(\),/);
  assert.match(MAIN, /const dirtyParent = \(\) => appLifecycle\.dirtyParent\(\);/);
});

test('step 12: the restore decision after the tray and before the launch window; the restores after markReady; the record follows windowsChanged and is clean on will-quit and session-end', () => {
  // PR #258 Dexter 8 / Miguel I1: decided before the launch window, WRITTEN (beginRecord) only once this process stays
  inOrder(readyBody, ['startTray()', 'const restorePlan = await appLifecycle.decideRestore(', "await startProject(LAUNCH_CWD, { launch: true, show: 'setting' })",
    'if (quitIfEmpty()) return;', 'appLifecycle.beginRecord();', 'appClaim.markReady();', 'appLifecycle.runRestores(restorePlan)']);
  assert.match(MAIN, /function windowsChanged\(\) \{[\s\S]{0,200}appLifecycle\.syncRecord\(\);/);
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{ markRecordClean\(\); \}\);/);
  assert.match(MAIN, /sessionEnded: \(\) => markRecordClean\(\),/);
  assert.match(MAIN, /makeWriter: \(\{ owner, owns \}\) => createOpenWindowsWriter\(\{ file: OPEN_WINDOWS_FILE, owner, owns \}\),/);
});

test('PR #258 Dexter 7 / Miguel I2: window-all-closed goes through the app lifecycle (an open in flight is waited for)', () => {
  assert.match(MAIN, /app\.on\('window-all-closed', \(\) => \{\s*appLifecycle\.onWindowAllClosed\(\);\s*\}\);/);
});

test('PR #258 Dexter 2 / 13: the reclaim tick runs every 30 s; the app claim refuses launches while the quit question is up', () => {
  assert.match(MAIN, /setInterval\(\(\) => \{ appLifecycle\.reclaimTick\(\)\.catch\(\(\) => \{\}\); \}, 30_000\)\.unref\(\);/);
  assert.match(MAIN, /refuse: \(\) => appLifecycle\.refuseLaunches\(\),/);
});

test('step 12: the record is written only through its writer (no other write of open-windows.json)', () => {
  // declared, read by the restore decision and by the probe's openWindows, handed to the writer: nothing else
  const uses = [...MAIN.matchAll(/OPEN_WINDOWS_FILE/g)].map((m) => MAIN.slice(m.index - 30, m.index + 40));
  assert.strictEqual(uses.length, 4, uses.join('\n'));
  assert.strictEqual(uses.filter((u) => /readRecord\(OPEN_WINDOWS_FILE\)/.test(u)).length, 2);
  assert.strictEqual(uses.filter((u) => /file: OPEN_WINDOWS_FILE/.test(u)).length, 1);
  assert.doesNotMatch(MAIN, /writeFileAtomic\(OPEN_WINDOWS_FILE|writeFileSync\(OPEN_WINDOWS_FILE/);
});

// ---- step 14: seam guards ---------------------------------------------------------------------------------------------------------

test('main never calls requestSingleInstanceLock: Electron\'s lock is per user-data folder, which every build shares, so it would hand a test build\'s launch to the daily app (design §3.1, pick S2)', () => {
  // the code, comments stripped (the header names the API to say why it is not used)
  assert.doesNotMatch(MAIN, /requestSingleInstanceLock|hasSingleInstanceLock|'second-instance'/);
});

test('startProject is called only by openProject (app/open-project.js, behind the queue) and by whenReady for the launch window', () => {
  const calls = [...MAIN.matchAll(/\bstartProject\(/g)].map((m) => MAIN.slice(Math.max(0, m.index - 60), m.index + 60));
  assert.strictEqual(calls.length, 2, calls.join('\n---\n'));
  assert.ok(calls.some((c) => /startProject: \(cwd, opts\) => startProject\(cwd, opts\)/.test(c)), 'the opener');
  assert.ok(calls.some((c) => /await startProject\(LAUNCH_CWD, \{ launch: true/.test(c)), 'the launch');
  const opener = MAIN.slice(MAIN.indexOf('const opener = createOpenProject({'), MAIN.indexOf('const openQueue = createOpenQueue('));
  assert.match(opener, /startProject: \(cwd, opts\) => startProject\(cwd, opts\)/);
});

test('the new single-instance modules require no Electron (they load under plain node and are tested there)', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  for (const f of ['host/app-lock-config.js', 'host/app-owner.js', 'host/app-claim.js', 'host/window-router.js', 'host/open-windows.js',
    'host/owner-file.js', 'app/quit-gate.js', 'app/open-queue.js', 'app/open-project.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/, f);
  }
});

test('PR #258 Miguel S4: the process\'s window pipe is closed at will-quit (windowRouter.stop is called, not dead API)', () => {
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{ windowRouter\.stop\(\)\.catch\(\(\) => \{\}\); \}\);/);
});
