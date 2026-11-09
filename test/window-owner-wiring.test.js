'use strict';
/**
 * app/main.js wiring of "one window per project" as source text (no unit test can start Electron; verify/probe-one-window.js runs the
 * real thing). What must hold: the claim runs inside whenReady BEFORE the first window is made, a refused launch exits without
 * a window, the owner file goes away on exit, and the pipe answers only once the window is ready.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const ready = src.slice(src.indexOf('app.whenReady().then('));

test('main requires the owner and focus modules', () => {
  assert.match(src, /require\('\.\.\/host\/window-owner'\)/);
  assert.match(src, /require\('\.\.\/host\/window-focus'\)/);
});

test('the claim runs in whenReady, after the bad-port refusal and before createWindow()', () => {
  const claim = ready.indexOf('claimProjectWindow()');
  assert.ok(claim > 0, 'whenReady calls claimProjectWindow()');
  assert.ok(claim > ready.indexOf('EXPLICIT_PORT.bad'), 'after the bad-port refusal');
  assert.ok(claim < ready.indexOf('createWindow();'), 'before the first window exists');
});

test('a launch that handed its lane to the owner exits with app.exit(0) and never reaches a window', () => {
  assert.match(ready, /claimProjectWindow\(\)[\s\S]{0,200}app\.exit\(0\)/);
});

test('a probe window is outside the rule unless CLAUDE_CUSTOM_ONE_WINDOW_PROBE=1 (the tray precedent)', () => {
  assert.match(src, /ONE_WINDOW_ON\s*=\s*!PROBE_PORT\s*\|\|\s*process\.env\.CLAUDE_CUSTOM_ONE_WINDOW_PROBE === '1'/);
  assert.match(src, /if \(!ONE_WINDOW_ON\) return 'proceed'/);
});

test('the pipe is listening before the owner file names this window, and the file is removed on exit', () => {
  const fn = src.slice(src.indexOf('async function claimProjectWindow'));
  assert.ok(fn.indexOf('listenForLaunches(') > 0);
  assert.ok(fn.indexOf('listenForLaunches(') < fn.indexOf('claimOwner('), 'listen first, claim second');
  assert.match(fn, /process\.on\('exit'[\s\S]{0,200}releaseOwner\(/);
});

test('the owner answers a launch only once its window is ready, focuses it, and selects the lane the launch named', () => {
  const fn = src.slice(src.indexOf('async function onLaunchFocus'));
  assert.ok(fn.indexOf('await windowReady.promise') > 0);
  assert.ok(fn.indexOf('focusWindow()') > fn.indexOf('await windowReady.promise'));
  assert.match(fn, /pickLane\(tabShell\.snapshot\(\)\.tabs/);
  assert.match(fn, /tabShell\.select\(key\)/);
  assert.match(ready, /await tabShell\.open\(\);\s*\n\s*windowReady\.resolve\(\)/);
});

test('the menu\'s Open hands main\'s project check to the actions: this project selects here, another project spawns', () => {
  const block = src.slice(src.indexOf('createBackgroundActions({'));
  assert.match(block, /laneFor:\s*\(o\)\s*=>\s*\{[\s\S]{0,300}samePath\(p\.root, PROJECT_ROOT\)\) return undefined;[\s\S]{0,120}pickLane\(tabShell\.snapshot\(\)\.tabs/);
});

test('a launch forwards its folder only when it is a lane\'s own folder, and the explicit port of an attach-only launch', () => {
  assert.match(src, /forwardedCwd\(LAUNCH_CWD, PROJECT\)/);
  assert.match(src, /Number\.isInteger\(EXPLICIT_PORT\)/);
});
