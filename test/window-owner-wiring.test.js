'use strict';
/**
 * app/main.js wiring of "one window per project" as source text. The BEHAVIOUR is tested on host/window-claim.js with its effects
 * handed in (test/window-claim.test.js); this file only pins that main hands them in and calls the life-cycle points: the claim in
 * whenReady before any window, ready after the tabs open, stop at before-quit / a dialog that ends the process / a failed start.
 * verify/probe-one-window.js runs the real thing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mainProcessSource } = require('./main-source');

const src = mainProcessSource();
const ready = src.slice(src.indexOf('app.whenReady().then('));

test('main requires the owner, focus and claim modules', () => {
  assert.match(src, /require\('\.\.\/host\/window-owner'\)/);
  assert.match(src, /require\('\.\.\/host\/window-focus'\)/);
  assert.match(src, /require\('\.\.\/host\/window-claim'\)/);
});

test('PR 3: no window exists at module load; the launch window\'s claim runs inside startProject (before it is registered); a launch handed over exits with app.exit(0)', () => {
  assert.doesNotMatch(src, /^registry\.add\(/m, 'registry.add is not at module load');
  assert.doesNotMatch(src, /^const launchWindow = makeWindow\(/m, 'the launch window is not made at module load');
  assert.ok(ready.indexOf('startProject(LAUNCH_CWD') > ready.indexOf('EXPLICIT_PORT.bad'), 'after the bad-port refusal');
  // the launch's project window is another process's: this process holds no window, and quitIfEmpty ends it (step 6: the app claim stops first)
  assert.match(ready, /const launched = await startProject\(LAUNCH_CWD, \{ launch: true, show: 'setting' \}\);[\s\S]{0,200}if \(launched\.elsewhere\) \{ quitIfEmpty\(\); return; \}/);
  // the order inside startProject (claim before registry.add) is behaviour: test/project-lifecycle.test.js
});

test('a probe window is outside the rule unless CLAUDE_CUSTOM_ONE_WINDOW_PROBE=1 (the tray precedent), and that flag is what enables the claim', () => {
  assert.match(src, /ONE_WINDOW_ON\s*=\s*!PROBE_PORT\s*\|\|\s*process\.env\.CLAUDE_CUSTOM_ONE_WINDOW_PROBE === '1'/);
  // PR 3: EVERY window holds it (the process has one routed window pipe), not only the launch window
  assert.match(src, /createWindowClaim\(\{[\s\S]{0,400}?enabled: ONE_WINDOW_ON,/);
});

test('the claim is handed the real effects: the router\'s register as its listen, and main\'s one exit hook', () => {
  const block = src.slice(src.indexOf('const windowClaim = createWindowClaim('));
  for (const dep of ['listen: (entry) => windowRouter.register(entry)', 'windowOwner.claim', 'windowFocus.send', 'windowOwner.takeOver', 'windowOwner.release', 'windowOwner.forwardedCwd', 'act: onLaunchFocus', 'root: PROJECT_ROOT']) {
    assert.ok(block.slice(0, 1400).includes(dep), dep);
  }
  assert.match(block.slice(0, 1400), /onExit: \(fn\) => onProcessExit\(self, fn\)/);
  // main: ONE process 'exit' listener over a Map per window, emptied when a window closes (dropExit)
  assert.strictEqual((src.match(/process\.on\('exit'/g) || []).length, 1, 'one exit listener for the process');
  assert.match(src, /const exitHooks = new Map\(\);/);
  assert.match(src, /dropExit: \(pw\) => exitHooks\.delete\(pw\),/);
  assert.match(src, /const windowRouter = createWindowRouter\(\{ listen: windowFocus\.listen, pid: process\.pid,/);
});

test('the window is ready for launches once its tabs are open, and not before (markReady is the lifecycle\'s, after start)', () => {
  const lc = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-lifecycle.js'), 'utf8');
  assert.ok(lc.indexOf('pw.claim.markReady()') > lc.indexOf('await pw.start(getAppStart())'));
  assert.doesNotMatch(ready, /launchWindow\.claim\.markReady\(\)/, 'whenReady does not mark it a second time');
});

test('the owner stops being one at before-quit, before a dialog that ends the process, and when startup throws', () => {
  assert.match(src, /if \(quitGate\.onBeforeQuit\(e\)\) return;[\s\S]{0,400}?quitting = true; forEachProject\(\(p\) => p\.claim\.stop\(\)\);/);
  assert.match(ready, /if \(launchWindow\.attachOnlyRefusal\) \{\s*\n\s*launchWindow\.claim\.stop\(\);/);
  assert.match(ready, /\}\)\.catch\(\(err\) => \{[\s\S]{0,260}forEachProject\(\(p\) => p\.claim\.stop\(\)\);[\s\S]{0,260}app\.exit\(1\)/);
});

test('a cancelled quit (the unsaved-text prompt answered Cancel) puts the window back as the project\'s owner (M1)', () => {
  // PR 3: through main's quitCancelled(), which resumes every open window's claim and the app claim
  assert.match(src, /else quitCancelled\(\);/);
  assert.match(src, /function quitCancelled\(\) \{[\s\S]{0,300}p\.claim\.resume\(\)/);
});

test('every app.exit after markReady() in whenReady is preceded by windowClaim.stop(): a held launch must hear no, not ok (PR #248 Dexter 1)', () => {
  const from = ready.indexOf('launchWindow = launched.pw;');
  const to = ready.indexOf('}).catch((err) => {');
  assert.ok(from > 0 && to > from);
  const seg = ready.slice(from, to);
  const exits = [...seg.matchAll(/app\.exit\(/g)].map(m => m.index);
  assert.ok(exits.length >= 2, 'the attach-only and the single-mode exits');
  const stops = [...seg.matchAll(/launchWindow\.claim\.stop\(\)/g)].length;
  assert.ok(stops >= exits.length, `${exits.length} exits, ${stops} stops`);
  assert.match(seg, /NO_PORT_ERROR[\s\S]{0,300}launchWindow\.claim\.stop\(\);[\s\S]{0,200}app\.exit\(1\)/, 'the single-mode no-port exit');
});

test('a window that already exists is left running when a late step throws (only the ownership is dropped)', () => {
  assert.match(ready, /forEachProject\(\(p\) => p\.claim\.stop\(\)\);[\s\S]{0,160}\n\s*if \(!registry\.list\(\)\.some\(\(p\) => p\.win && !p\.win\.isDestroyed\(\)\)\) app\.exit\(1\);/);
});

test('the owner acts on a launch by focusing and selecting the lane it named', () => {
  const fn = src.slice(src.indexOf('async function onLaunchFocus'), src.indexOf('const windowClaim = createWindowClaim('));
  assert.ok(fn.indexOf('focusWindow()') > 0);
  assert.match(fn, /windowOwner\.pickLane\(tabShell\.snapshot\(\)\.tabs, msg\)/);
  assert.match(fn, /tabShell\.select\(key\)/);
});

test('a launch\'s folder is logged as JSON (a newline in it cannot forge a log line)', () => {
  const fn = src.slice(src.indexOf('async function onLaunchFocus'), src.indexOf('const windowClaim = createWindowClaim('));
  assert.match(fn, /JSON\.stringify\(msg\.cwd \|\| null\)/);
});

test('the menu\'s Open hands main\'s project check, lane lookup and reopen to the actions', () => {
  const block = src.slice(src.indexOf('createBackgroundActions({'));
  assert.match(block, /thisProject:\s*\(o\)\s*=>\s*\{[\s\S]{0,200}samePath\(p\.root, PROJECT_ROOT\)/);
  assert.match(block, /laneFor:\s*\(o\)\s*=>\s*windowOwner\.pickLane\(tabShell\.snapshot\(\)\.tabs/);
  assert.match(block, /reopenLane:\s*async \(o\)\s*=>[\s\S]{0,160}tabShell\.reopenFolder\(o\.cwd\)/);
});
