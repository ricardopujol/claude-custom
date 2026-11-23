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

test('the claim runs in whenReady, after the bad-port refusal and before createWindow(); a launch that handed over exits with app.exit(0)', () => {
  const claim = ready.indexOf('launchWindow.claim.run()');
  assert.ok(claim > 0);
  assert.ok(claim > ready.indexOf('EXPLICIT_PORT.bad'), 'after the bad-port refusal');
  assert.ok(claim < ready.indexOf('startProject(LAUNCH_CWD'), 'before the first window exists (start() makes it)');
  assert.match(ready, /launchWindow\.claim\.run\(\) === 'exit'\) \{ app\.exit\(0\); return; \}/);
});

test('a probe window is outside the rule unless CLAUDE_CUSTOM_ONE_WINDOW_PROBE=1 (the tray precedent), and that flag is what enables the claim', () => {
  assert.match(src, /ONE_WINDOW_ON\s*=\s*!PROBE_PORT\s*\|\|\s*process\.env\.CLAUDE_CUSTOM_ONE_WINDOW_PROBE === '1'/);
  // ...and only the process's own launch window holds it: the pipe is per pid, so a second window in this process must not (single-instance PR 2)
  assert.match(src, /createWindowClaim\(\{[\s\S]{0,400}?enabled: ONE_WINDOW_ON && launch,/);
});

test('the claim is handed the real effects, and the exit hook is the process\'s own exit event', () => {
  const block = src.slice(src.indexOf('const windowClaim = createWindowClaim('));
  for (const dep of ['windowFocus.listen', 'windowOwner.claim', 'windowFocus.send', 'windowOwner.takeOver', 'windowOwner.release', 'windowOwner.forwardedCwd', 'act: onLaunchFocus']) {
    assert.ok(block.slice(0, 900).includes(dep), dep);
  }
  assert.match(block.slice(0, 900), /onExit: \(fn\) => process\.on\('exit', fn\)/);
});

test('the window is ready for launches once its tabs are open, and not before', () => {
  assert.match(ready, /await startProject\(LAUNCH_CWD, \{ launch: true \}\);\s*\n\s*launchWindow\.claim\.markReady\(\)/);
});

test('the owner stops being one at before-quit, before a dialog that ends the process, and when startup throws', () => {
  assert.match(src, /app\.on\('before-quit', \(\) => \{ quitting = true; forEachProject\(\(p\) => p\.claim\.stop\(\)\);/);
  assert.match(ready, /if \(launchWindow\.attachOnlyRefusal\) \{\s*\n\s*launchWindow\.claim\.stop\(\);/);
  assert.match(ready, /\}\)\.catch\(\(err\) => \{[\s\S]{0,260}launchWindow\.claim\.stop\(\);[\s\S]{0,120}app\.exit\(1\)/);
});

test('a cancelled quit (the unsaved-text prompt answered Cancel) puts the window back as the project\'s owner (M1)', () => {
  assert.match(src, /else \{\s*\n\s*setQuitting\(false\);[\s\S]{0,260}windowClaim\.resume\(\)/);
});

test('every app.exit after markReady() in whenReady is preceded by windowClaim.stop(): a held launch must hear no, not ok (PR #248 Dexter 1)', () => {
  const from = ready.indexOf('launchWindow.claim.markReady()');
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
  assert.match(ready, /launchWindow\.claim\.stop\(\);\s*\n\s*const w = launchWindow\.win;\s*\n\s*if \(!w \|\| w\.isDestroyed\(\)\) app\.exit\(1\);/);
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
