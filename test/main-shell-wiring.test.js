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

const channelsIn = (src) => [...src.matchAll(/ipcMain\.(on|handle)\(\s*'([^']+)'/g)]
  .map(m => ({ kind: m[1], name: m[2], at: m.index }));
const channels = channelsIn(MAIN);

// The text of ONE registration's call, so the gate check reads only that
// handler. Miguel, PR #75 M3: a fixed window after each registration let an
// ungated handler pass whenever the NEXT one was gated.
function callText(src, at) {
  const open = src.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      // Skip the string, so a ')' inside one doesn't end the call early.
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced ipcMain call at ${at}`);
}

/** The channels in `src` whose own call text lacks `gate`. */
function ungated(src, gate, filter = () => true) {
  return channelsIn(src).filter(filter).filter(c => !gate.test(callText(src, c.at))).map(c => c.name);
}

test('the gate check reads each handler alone: an ungated handler right before a gated one is caught', () => {
  const src = [
    "ipcMain.handle('a:open', (e) => doIt());",
    "ipcMain.handle('a:shut', (e) => (fromWindow(e) ? done() : null));",
    "ipcMain.on('a:str', (e, s) => say(')' + s));",
    "ipcMain.on('a:ok', (e) => { if (!isTabView(e.sender)) return; go(); });",
  ].join('\n');
  assert.deepStrictEqual(ungated(src, /isTabView\(|fromWindow\(/), ['a:open', 'a:str']);
});

test('the scan finds the channels this file registers', () => {
  const names = channels.map(c => c.name);
  for (const n of ['strip:select', 'strip:close', 'strip:contextMenu', 'tab:status', 'tab:close', 'tab:goTo',
    'tab:raise', 'attention', 'secrets:list', 'secrets:melt', 'look:setDim']) {
    assert.ok(names.includes(n), `${n} must be registered`);
  }
});

test('every strip channel is gated on the window\'s own page, and only they', () => {
  assert.deepStrictEqual(ungated(MAIN, /fromStrip\(e\)/, c => c.name.startsWith('strip:')), []);
  for (const c of channels.filter(x => !x.name.startsWith('strip:'))) {
    assert.doesNotMatch(callText(MAIN, c.at), /fromStrip\(/, `${c.name} is a tab channel and must not be gated on the strip`);
  }
});

test('every other channel is gated on "one of this window\'s tab views"', () => {
  assert.deepStrictEqual(ungated(MAIN, /isTabView\(|fromWindow\(/, c => !c.name.startsWith('strip:')), []);
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

test('there is NO application menu bar: it is nulled once, before the window, and never set', () => {
  const calls = MAIN.match(/Menu\.setApplicationMenu\([^)]*\)/g) || [];
  assert.deepStrictEqual(calls, ['Menu.setApplicationMenu(null)']);
  assert.ok(MAIN.indexOf('Menu.setApplicationMenu(null)') < MAIN.indexOf('  createWindow();'),
    'the bar is removed before the window is created');
  assert.doesNotMatch(MAIN, /buildAppMenu|accelerator:/);
});

test('override and close live in the right-click popup only', () => {
  const at = MAIN.indexOf("ipcMain.on('strip:contextMenu'");
  const body = MAIN.slice(at, at + 600);
  assert.match(body, /label: 'Allow a second session here'/);
  assert.match(body, /label: 'Close tab'/);
  assert.match(body, /\.popup\(/);
});

test('the shortcuts are registered on the strip AND on every tab view, and only shortcutFor decides', () => {
  assert.match(MAIN, /registerShortcuts\(win\.webContents\)/);
  assert.match(MAIN, /const wc = view\.webContents;\s*registerShortcuts\(wc\);/);
  const at = MAIN.indexOf('function registerShortcuts');
  const body = MAIN.slice(at, at + 900);
  assert.match(body, /shortcutFor\(input\)/);
  assert.match(body, /if \(!action\) return;\s*event\.preventDefault\(\)/);
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

test('F4 (Dexter, PR #75): applySelection focuses by view IDENTITY via focusStep, not by a changed selection key', () => {
  const start = MAIN.indexOf('function applySelection(');
  assert.ok(start !== -1);
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start));
  assert.ok(/focusStep\(\s*lastFocusedView\s*,/.test(body), 'applySelection must ask focusStep');
  assert.ok(/lastFocusedView\s*=\s*\w+\.lastFocused/.test(body),
    'and keep what focusStep says holds the keyboard, including null (R2-4)');
  assert.ok(!/selectedKey\s*!==\s*lastSelectedKey/.test(body),
    'a key that has not changed says nothing about whether its NEW view has the keyboard');
  assert.ok(/\.webContents\.focus\(\)/.test(body), 'and it must actually focus the view');
});

test('R2-4 (Dexter, PR #75): the strip page taking focus means no view has the keyboard', () => {
  assert.match(MAIN, /win\.webContents\.on\('focus',\s*\(\)\s*=>\s*\{?\s*lastFocusedView\s*=\s*null/);
});

test('F4: the window-focus path records which view it focused, so applySelection does not repeat it', () => {
  const i = MAIN.indexOf('const focusSelected = ()');
  assert.ok(i !== -1);
  const body = MAIN.slice(i, MAIN.indexOf('};', i));
  assert.ok(/lastFocusedView\s*=/.test(body));
});

// --- PR 3 -------------------------------------------------------------------------

test('PR 3: the shell gets the marker reader, the three-answer probe and the contract scripts', () => {
  const at = MAIN.indexOf('tabShell = createShell({');
  const call = MAIN.slice(at, MAIN.indexOf('\n  });', at));
  assert.match(call, /marker: readMergedMarker/);
  assert.match(call, /probe: \(port\) => probePort\(port\)/);
  assert.match(call, /ops: createOps\(\{ dir: scriptsDir\(process\.env\) \}\)/);
  assert.doesNotMatch(call, /isListening/);
});

test('PR 3: the + channels exist and are the strip page’s alone', () => {
  for (const name of ['strip:plus', 'strip:create', 'strip:cancelCreate']) {
    const c = channels.find(x => x.name === name);
    assert.ok(c, name);
    assert.match(callText(MAIN, c.at), /fromStrip\(e\)/, name);
  }
});

test('PR 3: Ctrl+Shift+T reopens, and the branch form keeps the keyboard while open', () => {
  assert.match(MAIN, /action === 'reopen-tab'\) tabShell\.reopen\(\)/);
  assert.match(MAIN, /focusStep\(lastFocusedView, \{ windowFocused: focused, selectedView: live, stripBusy \}\)/);
  assert.match(MAIN, /create: snapshot\.create/);
});
