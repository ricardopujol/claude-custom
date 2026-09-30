'use strict';
/**
 * app/main.js as the tab shell (PR 2), pinned as source text -- main.js
 * requires Electron and cannot be loaded here. The decisions it delegates are
 * tested in test/tab-shell.test.js; these pin that the wiring keeps the rules
 * that cost something:
 *
 *   - EVERY ipcMain channel is gated. Tab-page channels on "one of this
 *     window's tab views"; the strip's on the window's own webContents. A
 *     handler that answers anyone is not a boundary.
 *   - The host is spawned through hostEnv, never an inline env: one tab's
 *     token or port must not reach another's host.
 *   - The bridges that used to compare with `win.webContents` are handed the
 *     tab-view predicate (the window's own webContents is now the strip).
 *   - git is run with LC_ALL=C and a 5 s timeout, and the probe driver does
 *     nothing without its env var.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const MAIN = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8'));

const channels = [...MAIN.matchAll(/ipcMain\.(on|handle)\(\s*'([^']+)'/g)]
  .map(m => ({ kind: m[1], name: m[2], at: m.index }));

test('the scan finds the channels this file registers', () => {
  const names = channels.map(c => c.name);
  for (const n of ['strip:select', 'strip:close', 'strip:contextMenu', 'tab:status', 'tab:close', 'tab:goTo',
    'tab:raise', 'attention', 'secrets:list', 'secrets:melt', 'look:setDim']) {
    assert.ok(names.includes(n), `${n} must be registered`);
  }
});

test('every strip channel is gated on the window\'s own page, and only they', () => {
  for (const c of channels) {
    const body = MAIN.slice(c.at, c.at + 260);
    if (c.name.startsWith('strip:')) {
      assert.match(body, /fromStrip\(e\)/, `${c.name} must check fromStrip`);
    } else {
      assert.doesNotMatch(body, /fromStrip\(/, `${c.name} is a tab channel and must not be gated on the strip`);
    }
  }
});

test('every other channel is gated on "one of this window\'s tab views"', () => {
  for (const c of channels.filter(x => !x.name.startsWith('strip:'))) {
    const body = MAIN.slice(c.at, c.at + 260);
    assert.match(body, /isTabView\(|fromWindow\(/, `${c.name} must be gated on a tab view`);
  }
});

test('nothing compares a sender to the window\'s own webContents except the strip gate', () => {
  const uses = [...MAIN.matchAll(/sender\s*===\s*[^;\n]*webContents/g)].map(m => m[0]);
  assert.strictEqual(uses.length, 1, `only fromStrip may: ${uses.join(' | ')}`);
  assert.match(MAIN, /const fromStrip = \(event\) => [^\n]*event\.sender === win\.webContents/);
});

test('the bridges that took `win` are handed the tab-view predicate', () => {
  assert.match(MAIN, /registerClipboardHandlers\(\{[^}]*isSender: isTabView[^}]*\}\)/);
  assert.match(MAIN, /registerFavouriteHandlers\(\{[^}]*isSender: isTabView[^}]*\}\)/);
  assert.match(MAIN, /registerAvatarHandlers\(\{[^}]*isSender: isTabView[^}]*send: pushToViews[^}]*\}\)/);
  assert.match(MAIN, /watchImagesEnabled\(\{[\s\S]*?send: pushToViews/);
});

test('the window-wide broadcasts reach EVERY tab view', () => {
  assert.match(MAIN, /forEachView\(\(v\) => v\.webContents\.send\('window-focus'/);
  assert.match(MAIN, /forEachView\(\(v\) => v\.webContents\.send\('attention-cue'/);
  assert.match(MAIN, /const pushToViews = \(channel, value\) => forEachView/);
});

test('the per-window constants are gone: the port, token and cwd belong to a tab', () => {
  assert.doesNotMatch(MAIN, /\bPROJECT_CWD\b/);
  assert.doesNotMatch(MAIN, /\bSESSION_TOKEN\b/);
  assert.doesNotMatch(MAIN, /^let PORT\b/m);
  assert.match(MAIN, /function tokenForRunningHost\(port\)/);
  assert.match(MAIN, /async function chooseHostPort\(tab\)/);
  assert.match(MAIN, /function spawnHost\(tab, port, token\)/);
});

test('a host is spawned through hostEnv, never an inline environment', () => {
  const at = MAIN.indexOf('function spawnHost(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /env: hostEnv\(process\.env, \{ cwd: tab\.cwd, port, token, project: HOST_PROJECT \}\)/);
  assert.doesNotMatch(body, /\.\.\.process\.env/);
  assert.doesNotMatch(body, /ELECTRON_RUN_AS_NODE/);
  assert.match(body, /detached: true/);
});

test('explicitPort, occupantAt, isHostListening and waitForHost survive', () => {
  for (const f of ['function explicitPort()', 'async function occupantAt(port)', 'function isHostListening(port)',
    'async function waitForHost(port']) assert.ok(MAIN.includes(f), f);
});

test('CLAUDE_CUSTOM_PORT keeps a window single-tab, so every existing probe works unchanged', () => {
  assert.match(MAIN, /const MODE = \(PROJECT && PROJECT\.kind === 'container' && EXPLICIT_PORT === null\) \? 'tabs' : 'single'/);
  assert.match(MAIN, /if \(MODE === 'tabs'\) setInterval\(/);
});

test('the worktree list runs with LC_ALL=C and a 5 s timeout, from dev', () => {
  const at = MAIN.indexOf('function listWorktrees()');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /'worktree', 'list', '--porcelain'/);
  assert.match(body, /LC_ALL: 'C'/);
  assert.match(body, /timeout: 5000/);
  assert.match(body, /'-C', HOST_PROJECT\.dev/);
});

test('the poller runs every 3 s', () => {
  assert.match(MAIN, /const POLL_MS = 3000/);
  assert.match(MAIN, /setInterval\(\(\) => \{ tabShell\.poll\(\); \}, POLL_MS\)/);
});

test('the probe driver does nothing without its env var, and only listens locally', () => {
  assert.match(MAIN, /const PROBE_PORT = Number\(process\.env\.CLAUDE_CUSTOM_TABS_PROBE\) \|\| 0/);
  assert.match(MAIN, /if \(PROBE_PORT\) startProbeDriver\(PROBE_PORT\)/);
  assert.match(MAIN, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.match(MAIN, /if \(PROBE_PORT\) return true;/, 'the confirm is auto-yes only under the driver');
});

test('a hand close asks first, every time', () => {
  assert.match(MAIN, /dialog\.showMessageBox\(win, \{/);
  assert.match(MAIN, /message: `End the session in \$\{label\}\?`/);
  assert.match(MAIN, /detail: 'The folder stays\.'/);
});

test('the Session menu carries the override, close, next and previous', () => {
  assert.match(MAIN, /label: 'Allow a second session here'/);
  assert.match(MAIN, /label: 'Close tab'/);
  assert.match(MAIN, /accelerator: 'Ctrl\+Tab'/);
  assert.match(MAIN, /accelerator: 'Ctrl\+Shift\+Tab'/);
  assert.match(MAIN, /Menu\.setApplicationMenu\(/);
});

test('the raise flashes the frame as well as focusing (Windows may refuse to hand focus over)', () => {
  const at = MAIN.indexOf("ipcMain.on('tab:raise'");
  const body = MAIN.slice(at, at + 260);
  assert.match(body, /tabShell\.raise\(e\.sender\)/);
  assert.match(body, /flashFrame\(true\)/);
});

test('the screenshot path captures the SELECTED view and the strip beside it', () => {
  assert.match(MAIN, /capture\(sel\.webContents, outFile\)/);
  assert.match(MAIN, /capture\(win\.webContents, stripFileFor\(outFile\)\)/);
  assert.match(MAIN, /const stripFileFor = \(file\) => file\.replace\(/);
});

test('the notification click goes to the tab that raised it', () => {
  assert.match(MAIN, /n\.on\('click', \(\) => \{ tabShell\.attentionClick\(event\.sender\); \}\)/);
});

test('each tab view is shown only when selected and laid out below the strip', () => {
  assert.match(MAIN, /const STRIP_HEIGHT = 34/);
  assert.match(MAIN, /tab\.view\.setVisible\(tab\.key === snapshot\.selectedKey\)/);
  assert.match(MAIN, /y: STRIP_HEIGHT/);
  assert.match(MAIN, /for \(const ev of \['resize'/);
});

test('every tab view is created with context isolation on and node integration off', () => {
  const at = MAIN.indexOf('function createTabView(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /contextIsolation: true/);
  assert.match(body, /nodeIntegration: false/);
  assert.match(body, /preload: path\.join\(__dirname, 'preload\.js'\)/);
  const win = MAIN.slice(MAIN.indexOf('function createWindow('), MAIN.indexOf('function createWindow(') + 700);
  assert.match(win, /preload: path\.join\(__dirname, 'preload-strip\.js'\)/);
  assert.match(win, /contextIsolation: true/);
  assert.match(win, /nodeIntegration: false/);
});

test('the tab view learns its mode from the shell', () => {
  assert.match(MAIN, /tabmode: tabShell\.tabmodeOf\(tab\)/);
});

test('only the headless paths switch native occlusion tracking off (an occluded window captures EMPTY)', () => {
  assert.match(MAIN, /if \(process\.env\.CLAUDE_CUSTOM_SCREENSHOT \|\| PROBE_PORT\) \{\s*app\.commandLine\.appendSwitch\('disable-features', 'CalculateNativeWinOcclusion'\);/);
  assert.strictEqual((MAIN.match(/CalculateNativeWinOcclusion/g) || []).length, 1);
});
