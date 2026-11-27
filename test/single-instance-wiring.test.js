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
const { mainOnly, stripComments } = require('./main-source');

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
  const fn = MAIN.slice(MAIN.indexOf('function quitIfEmpty('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /registry\.size\(\) > 0 \|\| openQueue\.busy\(\)/);
  assert.ok(body.indexOf('appClaim.stop()') < body.indexOf('app.quit()'), 'the claim stops first: launches held on it hear no');
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

test('step 11: ONE before-quit handler, the gate first; only when it passes, quitting = true and the app claim and every window claim stop', () => {
  assert.strictEqual((MAIN.match(/app\.on\('before-quit'/g) || []).length, 1);
  const h = MAIN.slice(MAIN.indexOf("app.on('before-quit'"));
  const body = h.slice(0, h.indexOf('\n});') + 4);
  assert.match(body, /if \(quitGate\.onBeforeQuit\(e\)\) return;\s*quitting = true; forEachProject\(\(p\) => p\.claim\.stop\(\)\); appClaim\.stop\(\);/);
});

test('step 11: quitCancelled puts quitting back, resets the gate, resumes the app claim and every open window\'s claim; the tray\'s quit is app.quit alone', () => {
  const fn = MAIN.slice(MAIN.indexOf('function quitCancelled('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const piece of ['quitting = false;', 'quitGate.reset();', 'appClaim.resume()', 'p.claim.resume()', 'p.allowClose(false)']) assert.ok(body.includes(piece), piece);
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
  assert.match(ask, /probe: !!PROBE_PORT,\s*record: \(entry\) => probeConfirms\.push\(entry\),/);
  assert.match(MAIN, /return dirty\.includes\(last\) \? last : \(dirty\[0\] \|\| null\);/);
});
