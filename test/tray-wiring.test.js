'use strict';
/**
 * The tray icon's wiring (BACKLOG #119 A8), pinned as source text like test/main-shell-wiring.test.js: app/main.js requires
 * Electron and cannot be loaded here. The rules are tested in test/tray-model.test.js, the effects in
 * test/tray-controller.test.js; these pin that main hands them the real things and keeps the rules that cost something:
 *
 *   - the Tray is made ONCE (one controller), by startTray, and never in a probe window that isn't the tray's own probe
 *   - closing hides ONLY through hidesOnClose (off by default), and a quit always closes
 *   - "Start minimised" shows nothing only when startsHidden says so (the icon is on)
 *   - "Stop that session" is the ▾ menu's own Stop (it asks), never a direct stopHost
 *   - Quit is the app's own quit, with its watchdog
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mainProcessSource, bodyAt } = require('./main-source');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const MAIN = strip(mainProcessSource());

const bodyOf = (re) => {
  const at = MAIN.search(re);
  assert.ok(at !== -1, 'must exist: ' + re);
  return bodyAt(MAIN, at);   // brace-matched: some of these functions moved into app/project-window.js and are indented there
};

test('main makes the one Tray through the controller, in startTray, called once from whenReady', () => {
  assert.strictEqual((MAIN.match(/createTrayController\(/g) || []).length, 1);
  assert.strictEqual((MAIN.match(/new Tray\(/g) || []).length, 0, 'the Tray is made in app/tray-controller.js only');
  assert.strictEqual((MAIN.match(/^\s+startTray\(\);/gm) || []).length, 1);
  assert.match(MAIN, /Tray, Menu, nativeImage, renderIcon: renderTrayIcon/);
});

test('a probe window has no tray (a killed Electron leaves a ghost icon) unless it is the tray probe', () => {
  assert.match(MAIN, /const TRAY_ON = !PROBE_PORT \|\| process\.env\.CLAUDE_CUSTOM_TRAY_PROBE === '1';/);
  assert.match(bodyOf(/function startTray\(\)/), /if \(!TRAY_ON\) return;/);
  // PR 3 step 7: the start's word decides (startHiddenFor), and without TRAY_ON it is never hidden (test/project-window.test.js)
  assert.match(MAIN, /const startHidden = startHiddenFor\(\{ show, trayOn: TRAY_ON, settings: readTraySettings\(uiStore\) \}\);/);
});

test('close hides to the tray only through hidesOnClose, ahead of the unsaved-text guard, and a quit closes', () => {
  const close = MAIN.slice(MAIN.indexOf("win.on('close'"), MAIN.indexOf("win.on('closed'"));
  const hide = close.indexOf('hidesOnClose(');
  assert.ok(hide !== -1);
  assert.ok(hide < close.indexOf('closeGuarded ||'), 'the hide decision comes first: hiding loses nothing, so no question');
  assert.match(close, /const tray = getTray\(\);\s*if \(hidesOnClose\(\{ settings: readTraySettings\(uiStore\), trayExists: !!tray && tray\.state\(\)\.exists, quitting: isQuitting\(\) \}\)\)/);
  assert.match(close, /e\.preventDefault\(\);\s*win\.hide\(\);/);
  assert.match(MAIN, /app\.on\('before-quit', \(\) => \{ quitting = true; forEachProject\(\(p\) => p\.claim\.stop\(\)\); appClaim\.stop\(\); \}\);/);
  assert.match(MAIN, /win\.on\('session-end', \(\) => \{ setQuitting\(true\); \}\);/);
});

test('start minimised: the window is created without being shown, only when startsHidden says so', () => {
  assert.match(MAIN, /show: !startHidden,/);
  // the check is each window's own, made right after the window exists (single-instance PR 2: the lifecycle's afterStart; the tray itself is made before any window)
  assert.match(MAIN, /afterStart: \(pw\) => \{[\s\S]*?trayController && !trayController\.state\(\)\.exists && w && !w\.isDestroyed\(\) && !w\.isVisible\(\)\) pw\.focusWindow\(\);/,
    'no icon could be made: the hidden window is shown, never left unreachable');
});

test('the tray\'s "hidden" is any window hidden, as hideAll and showAll act on every window (PR #256 Dexter 6)', () => {
  assert.match(MAIN, /isHidden: \(\) => anyWindowHidden\(registry\.list\(\)\.map\(\(p\) => p\.win\)\),/);
});

test('the tray follows the shell and goes with the app', () => {
  assert.match(bodyOf(/function onShellChanged\(/), /const tray = getTray\(\);\s*if \(tray\) tray\.sync\(\);/);
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{ if \(trayController\) trayController\.destroy\(\);/);
  assert.match(MAIN, /registerTrayHandlers\(\{ ipcMain, store: uiStore, isSender: isTabView,/, 'the switches answer this window\'s views only');
});

test('the menu actions: Stop is the ▾ menu\'s own (it asks), Quit is app.quit, Hide hides, Show is focusWindow', () => {
  const actions = bodyOf(/function startTray\(\)/);
  // single-instance PR 3: one tray for every window. Stop's question sits on the session's project window when open, else the window used last
  assert.match(actions, /const w = \(p && registry\.get\(p\.root\)\) \|\| registry\.lastUsed\(\);\s*if \(!w\) return;\s*w\.focusWindow\(\);\s*w\.backgroundActions\.stop\(row\)/);
  assert.doesNotMatch(actions, /trayWindow\(\)/, 'no window is "the" tray\'s any more');
  assert.match(actions, /focusWindow: \(root, key\) => \{ const w = registry\.get\(root\); if \(!w\) return; if \(key && w\.tabShell\) w\.tabShell\.select\(key\); w\.focusWindow\(\); \}/);
  assert.match(actions, /windows: \(\) => registry\.list\(\)\.map\(/);
  assert.match(actions, /lastUsed: \(\) => \{ const w = registry\.lastUsed\(\);/);
  assert.match(actions, /background: \(\) => appBackgroundModel\(\),/);
  assert.doesNotMatch(actions, /stopHost\(/);
  assert.match(actions, /app\.quit\(\); \}/);
  assert.match(actions, /hideAll: \(\) => registry\.forEach\(\(p\) => \{ const w = p\.win; if \(w && !w\.isDestroyed\(\)\) w\.hide\(\); \}\)/);
  assert.match(actions, /showAll: \(\) => registry\.forEach\(\(p\) => p\.focusWindow\(\)\)/);
  // Open on a session with no window: a window in this process (DESIGN_TABS_SESSIONS.md 3.4), through main's one open
  assert.match(actions, /openBackground: \(o\) => \(o && typeof o\.cwd === 'string' \? openProject\(\{ cwd: o\.cwd, port: o\.port, show: 'shown' \}\) : undefined\),/);
  assert.match(actions, /setStartMinimised: on => \{ writeTraySetting\(uiStore, 'startMinimised', on === true\); \}/);
});

test('Quit from the tray brings a hidden window up first when there is unsaved reader text (Miguel Y1)', () => {
  assert.match(bodyOf(/function startTray\(\)/), /quit: \(\) => \{ const dirty = registry\.list\(\)\.find\(\(p\) => p\.readerUnsaved\.all\(\)\.length > 0\); if \(dirty\) dirty\.focusWindow\(\); app\.quit\(\); \}/);
});

test('a cancelled close puts quitting back, so close-to-tray keeps working (Miguel Y2)', () => {
  const close = MAIN.slice(MAIN.indexOf("win.on('close'"), MAIN.indexOf("win.on('closed'"));
  assert.match(close, /closeGuarded = true; win\.close\(\); \}\s*else \{\s*setQuitting\(false\);/);
});

test('will-quit destroys the tray FIRST, so a throwing sampler stop cannot leave a ghost icon (Miguel S1)', () => {
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{ if \(trayController\) trayController\.destroy\(\); if \(resourceSampler\) resourceSampler\.stop\(\);/);
});

test('the preload and the Style tab: the DESIRED state goes out, the saved answer comes back', () => {
  const preload = read('app/preload.js');
  assert.match(preload, /get: \(\) => ipcRenderer\.invoke\('tray:getSettings'\)/);
  assert.match(preload, /set: \(key, on\) => ipcRenderer\.invoke\('tray:setSetting', key, on\)/);
  const JS = read('app/renderer.js');
  assert.match(JS, /id="style-tray-icon"/);
  assert.match(JS, /id="style-tray-close"/);
  assert.match(JS, /tray\.set\('trayIcon', trayIconBox\.checked\)/);
  assert.match(JS, /tray\.set\('minimiseOnClose', trayCloseBox\.checked\)/);
  assert.match(JS, /^refreshTraySettings\(\);/m);
  const refresh = JS.slice(JS.indexOf('function refreshTraySettings'), JS.indexOf('function settledChrome'));
  assert.match(refresh, /setTimeout\(refreshTraySettings/, 'a null answer asks again, never reads as OFF');
});
