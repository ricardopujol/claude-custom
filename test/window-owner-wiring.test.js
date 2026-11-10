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

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const ready = src.slice(src.indexOf('app.whenReady().then('));

test('main requires the owner, focus and claim modules', () => {
  assert.match(src, /require\('\.\.\/host\/window-owner'\)/);
  assert.match(src, /require\('\.\.\/host\/window-focus'\)/);
  assert.match(src, /require\('\.\.\/host\/window-claim'\)/);
});

test('the claim runs in whenReady, after the bad-port refusal and before createWindow(); a launch that handed over exits with app.exit(0)', () => {
  const claim = ready.indexOf('windowClaim.run()');
  assert.ok(claim > 0);
  assert.ok(claim > ready.indexOf('EXPLICIT_PORT.bad'), 'after the bad-port refusal');
  assert.ok(claim < ready.indexOf('createWindow();'), 'before the first window exists');
  assert.match(ready, /windowClaim\.run\(\) === 'exit'\) \{ app\.exit\(0\); return; \}/);
});

test('a probe window is outside the rule unless CLAUDE_CUSTOM_ONE_WINDOW_PROBE=1 (the tray precedent), and that flag is what enables the claim', () => {
  assert.match(src, /ONE_WINDOW_ON\s*=\s*!PROBE_PORT\s*\|\|\s*process\.env\.CLAUDE_CUSTOM_ONE_WINDOW_PROBE === '1'/);
  assert.match(src, /createWindowClaim\(\{\s*\n\s*enabled: ONE_WINDOW_ON/);
});

test('the claim is handed the real effects, and the exit hook is the process\'s own exit event', () => {
  const block = src.slice(src.indexOf('const windowClaim = createWindowClaim('));
  for (const dep of ['windowFocus.listen', 'windowOwner.claim', 'windowFocus.send', 'windowOwner.takeOver', 'windowOwner.release', 'windowOwner.forwardedCwd', 'act: onLaunchFocus']) {
    assert.ok(block.slice(0, 900).includes(dep), dep);
  }
  assert.match(block.slice(0, 900), /onExit: \(fn\) => process\.on\('exit', fn\)/);
});

test('the window is ready for launches once its tabs are open, and not before', () => {
  assert.match(ready, /await tabShell\.open\(\);\s*\n\s*windowClaim\.markReady\(\)/);
});

test('the owner stops being one at before-quit, before a dialog that ends the process, and when startup throws', () => {
  assert.match(src, /app\.on\('before-quit', \(\) => \{ quitting = true; windowClaim\.stop\(\);/);
  assert.match(ready, /if \(attachOnlyRefusal\) \{\s*\n\s*windowClaim\.stop\(\);/);
  assert.match(ready, /\}\)\.catch\(\(err\) => \{[\s\S]{0,260}windowClaim\.stop\(\);[\s\S]{0,120}app\.exit\(1\)/);
});

test('a window that already exists is left running when a late step throws (only the ownership is dropped)', () => {
  assert.match(ready, /windowClaim\.stop\(\);\s*\n\s*if \(!win \|\| win\.isDestroyed\(\)\) app\.exit\(1\);/);
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
