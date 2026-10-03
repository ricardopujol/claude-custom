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
  for (const n of ['strip:select', 'strip:close', 'strip:contextMenu', 'strip:background', 'tab:status', 'tab:close', 'tab:goTo', 'tab:selectFolder',
    'tab:raise', 'attention', 'secrets:list', 'secrets:melt', 'look:setDim',
    // the Git drawer (Enhancement #46)
    'tab:states', 'tab:runMerged']) {
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
  // Layout pass L2: the window-chrome settings, the same shape.
  assert.match(MAIN, /registerChromeHandlers\(\{[^}]*isSender: isTabView[^}]*send: pushToViews[^}]*\}\)/);
  assert.match(MAIN, /watchChromeSettings\(\{[\s\S]*?send: pushToViews[\s\S]*?`\$\{CHROME_KEY\}\.json`/);
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

test('Open from the ▾ menu spawns a window through attachEnv, detached, never an inline environment', () => {
  const at = MAIN.indexOf('spawnWindow: ({ cwd, port }) => {');
  assert.ok(at !== -1, 'the ▾ actions must get a spawnWindow');
  const body = MAIN.slice(at, MAIN.indexOf('confirmStop:', at));
  assert.match(body, /env: attachEnv\(process\.env, \{ cwd, port \}\)/);
  assert.match(body, /spawn\(process\.execPath, \[INSTALL_DIR\]/);
  assert.match(body, /detached: true/);
  assert.doesNotMatch(body, /\.\.\.process\.env|ELECTRON_RUN_AS_NODE/);
});

test('an attach-only window (Open from ▾) never spawns: it refuses and says why (Dexter, PR 2 F2)', () => {
  const at = MAIN.indexOf('async function chooseHostPort(');
  const body = MAIN.slice(at, MAIN.indexOf('function spawnHost(', at));
  assert.match(body, /attachOnlyDecision\(decideAttach\(\{/);
  assert.match(body, /attachOnlyRefusal = decision/);
  const start = MAIN.indexOf('const first = await tabShell.open();');
  const after = MAIN.slice(start, start + 1500);
  assert.match(after, /if \(attachOnlyRefusal\)/);
  assert.match(after, /attachOnlyText\(attachOnlyRefusal\)/);
  assert.match(after, /app\.exit\(1\)/);
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
  // #40: each poll re-reads the tab marks first, so another window's mark shows by the next one.
  assert.match(MAIN, /setInterval\(\(\) => \{ reloadMarks\(\); tabShell\.poll\(\); \}, POLL_MS\)/);
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
  assert.match(body, /if \(!action \|\| !shortcutWillAct\(action, tabShell\)\) return;\s*event\.preventDefault\(\)/);
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
  // Below the strip -- unless focus mode lifts it over the strip (layout pass L1, #1),
  // which a frameless window doesn't (Dexter L2 #3; the rule is viewTop's, unit-tested).
  assert.match(MAIN, /const top = viewTop\(\{ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT \}\);/);
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

test('L2 #28: the window-button channels exist and are the strip page’s alone', () => {
  for (const name of ['strip:winMinimize', 'strip:winClose']) {
    const c = channels.find(x => x.name === name);
    assert.ok(c, name);
    assert.match(callText(MAIN, c.at), /fromStrip\(e\)/, name);
  }
});

test('Dexter L2 #3: the view\'s top comes from viewTop, with this window\'s frameless flag', () => {
  assert.match(MAIN, /const top = viewTop\(\{ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT \}\);/);
  assert.match(MAIN, /windowFrameless = chrome\.framelessWindow === true;/);
});

test('L2 #28: createWindow reads the frameless setting for THIS window and tells the strip', () => {
  const body = MAIN.slice(MAIN.indexOf('function createWindow()'), MAIN.indexOf('registerShortcuts(win.webContents)'));
  assert.match(body, /readChromeSettings\(uiStore\)/);
  assert.match(body, /frame: !\w+\.framelessWindow/);
  assert.match(body, /loadFile\([^)]*tab-strip\.html'\),\s*\{\s*query:/);
});

test('PR #80 Miguel Y2: every fire-and-forget create / reopen has a catch, so nothing rejects unhandled in main', () => {
  // A call that is returned or awaited hands its rejection to its caller.
  const calls = [...MAIN.matchAll(/tabShell\.(createWorktree|reopen)\(/g)]
    .filter(m => !/(return|await)\s+$/.test(MAIN.slice(Math.max(0, m.index - 8), m.index)));
  assert.ok(calls.length >= 4, `found ${calls.length}`);
  for (const m of calls) {
    const rest = MAIN.slice(m.index, MAIN.indexOf('\n', m.index));
    assert.match(rest, /\)\.catch\(/, rest.trim());
  }
});

test('PR #80 Miguel G3: a branch name in a native menu label goes through menuText', () => {
  assert.match(MAIN, /`Reopen \$\{menuText\(r\.label\)\}/);
});

test('PR #80 Miguel G5: strip:create refuses a non-string or a branch longer than 200 characters', () => {
  const c = channels.find(x => x.name === 'strip:create');
  assert.match(callText(MAIN, c.at), /typeof branch !== 'string' \|\| branch\.length > 200\) return/);
});

test('#35: Ctrl+Alt+T opens the branch form through the shell, which applies the rule of the + menu item', () => {
  assert.match(MAIN, /action === 'new-branch'\) openBranchForm\(\)/);
  assert.doesNotMatch(MAIN, /accelerator:/);
});

test('#35 (Dexter F2): a key that will not act is not swallowed -- the decision comes BEFORE preventDefault', () => {
  const at = MAIN.indexOf('function registerShortcuts');
  const body = MAIN.slice(at, at + 900);
  assert.match(body, /if \(!action \|\| !shortcutWillAct\(action, tabShell\)\) return;\s*event\.preventDefault\(\)/);
});

test('#35 (Dexter F3): Ctrl+Alt+T on a form that is already open hands the keyboard to its field', () => {
  const at = MAIN.indexOf('function openBranchForm');
  assert.ok(at !== -1, 'main has openBranchForm');
  const body = MAIN.slice(at, at + 700);
  assert.match(body, /const wasOpen = !!tabShell\.snapshot\(\)\.create/);
  assert.match(body, /if \(!tabShell\.openCreate\(\)\) return false/);
  assert.match(body, /if \(wasOpen[^]*win\.webContents\.focus\(\)/);
  assert.match(body, /getElementById\('create-branch'\)\.focus\(\)/);
});

test('#31 (Dexter F1): the window regaining focus is a look at the selected tab', () => {
  const at = MAIN.indexOf("win.on('focus'");
  const body = MAIN.slice(at, at + 400);
  assert.match(body, /tabShell.looked()/);
});

test('PR 3: Ctrl+Shift+T reopens, and the branch form keeps the keyboard while open', () => {
  assert.match(MAIN, /action === 'reopen-tab'\) tabShell\.reopen\(\)/);
  assert.match(MAIN, /focusStep\(lastFocusedView, \{ windowFocused: focused, selectedView: live, stripBusy \}\)/);
  // Dexter F7 (PR #80): only while the field takes typing -- not during Contract A's fetch.
  assert.match(MAIN, /const stripBusy = !!snapshot\.create && snapshot\.create\.phase !== 'running';/);
  assert.match(MAIN, /create: snapshot\.create/);
});

// --- fix/terminal-links (2026-10-01) ------------------------------------------------

test('a link from a tab page opens only through openInBrowser, on a channel gated FIRST', () => {
  const c = channels.find(x => x.name === 'tab:openExternal');
  assert.ok(c, 'tab:openExternal is registered');
  const body = callText(MAIN, c.at);
  // Miguel #7: the gate is the handler's first statement, not merely present.
  assert.match(body, /^ipcMain\.handle\(\s*'tab:openExternal',\s*\(e, url\) => \{\s*if \(!isTabView\(e\.sender\)\) return false;/);
  // It answers whether the link was opened, so the page can say when it wasn't (Dexter F5).
  assert.match(body, /return openInBrowser\(url, /);
});

test('nothing reaches shell.openExternal unchecked -- above all the about:blank of a blank window.open', () => {
  // Miguel #3: ONE call, inside openInBrowser, fed by externalUrl and caught.
  const calls = [...MAIN.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map(m => m[1]);
  assert.deepStrictEqual(calls, ['target']);
  const at = MAIN.indexOf('function openInBrowser(');
  assert.ok(at !== -1, 'openInBrowser exists');
  const fn = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(fn, /const target = externalUrl\(url\);/);
  assert.match(fn, /shell\.openExternal\(target\)\.catch\(/);
  const handler = MAIN.slice(MAIN.indexOf('wc.setWindowOpenHandler('), MAIN.indexOf('});', MAIN.indexOf('wc.setWindowOpenHandler(')));
  assert.match(handler, /openInBrowser\(url, /);
});

test('Miguel #4: the tab:raise handler keeps its own comment', () => {
  const at = MAIN.indexOf("ipcMain.on('tab:raise'");
  const before = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const raw = before.slice(0, before.indexOf("ipcMain.on('tab:raise'"));
  assert.ok(at !== -1);
  assert.match(raw.slice(-300), /The receiving side of a host `raise`/);
});

// --- layout pass L1 ----------------------------------------------------------

test('L1: the global layout is served to this window\'s tab views and pushed to all of them', () => {
  assert.match(MAIN, /const \{ registerLayoutHandlers, watchLayout, LAYOUT_KEY \} = require\('\.\/layout-bridge'\);/);
  const at = MAIN.indexOf('registerLayoutHandlers({');
  assert.ok(at !== -1, 'registerLayoutHandlers is called');
  const call = callText(MAIN, at);
  assert.match(call, /isSender: isTabView/);
  assert.match(call, /send: pushToViews/);
  assert.match(call, /store: uiStore/);
  assert.match(call, /sync: layoutSync/);
});

test('L1: another project window\'s layout change reaches this one through the store file', () => {
  const at = MAIN.indexOf('watchLayout({');
  assert.ok(at !== -1, 'watchLayout is started');
  const call = callText(MAIN, at);
  assert.match(call, /sync: layoutSync/);
  assert.match(call, /send: pushToViews/);
  assert.match(call, /`\$\{LAYOUT_KEY\}\.json`/);
});

test('L1: the preload exposes the layout bridge with one listener at a time', () => {
  const PRELOAD = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8'));
  assert.match(PRELOAD, /get: \(\) => ipcRenderer\.invoke\('layout:get'\)/);
  assert.match(PRELOAD, /set: \(layout\) => ipcRenderer\.invoke\('layout:set', layout\)/);
  assert.match(PRELOAD, /ipcRenderer\.removeAllListeners\('layout-global'\), ipcRenderer\.on\('layout-global'/);
});

test('L1 #1: focus mode lifts the tab view over the strip, and every view is told', () => {
  assert.match(MAIN, /\nlet focusMode = false;/);
  const lv = MAIN.slice(MAIN.indexOf('function layoutView('), MAIN.indexOf('\n}', MAIN.indexOf('function layoutView(')));
  assert.match(lv, /const top = viewTop\(\{ focusMode, frameless: windowFrameless, stripHeight: STRIP_HEIGHT \}\);/);
  assert.match(lv, /y: top,/);
  const set = MAIN.slice(MAIN.indexOf('function setFocusMode('), MAIN.indexOf('\n}', MAIN.indexOf('function setFocusMode(')));
  assert.match(set, /forEachView\(layoutView\)/);
  assert.match(set, /send\('focus-mode', focusMode\)/);
});

test('L1 #1: Ctrl+Shift+F toggles it, and only a tab view may ask through IPC', () => {
  assert.match(MAIN, /action === 'focus-mode'\) setFocusMode\(!focusMode\)/);
  for (const name of ['focus:toggle', 'focus:set']) {
    const c = channels.find(x => x.name === name);
    assert.ok(c, name);
    assert.match(callText(MAIN, c.at), /if \(!isTabView\(e\.sender\)/, name);
  }
  assert.match(callText(MAIN, channels.find(x => x.name === 'focus:set').at), /typeof on !== 'boolean'/);
});

test('L1 #1: a tab view that loads while focus mode is on hears it too', () => {
  const at = MAIN.indexOf("wc.on('did-finish-load', () => {");
  assert.ok(at !== -1);
  assert.match(MAIN.slice(at, MAIN.indexOf('\n  });', at)), /if \(focusMode\) wc\.send\('focus-mode', true\);/);
});

test('L1 S7: the window keeps room for the terminal and two side zones', () => {
  const at = MAIN.indexOf('win = new BrowserWindow({');
  const opts = MAIN.slice(at, MAIN.indexOf('});', at));
  assert.match(opts, /minWidth: 640,/);
  assert.match(opts, /minHeight: 480,/);
});

// Dexter, PR #83 F6: a window on a folder in no project (C:\Users\ricar) has
// no project to stop all of; its launch folder would cover every project.
test('Stop all gets a project root only when the window is in a project', () => {
  assert.match(MAIN, /projectRoot: PROJECT \? PROJECT_ROOT : null/);
});

// --- #40 tab marks ---------------------------------------------------------------

test('the tab menu offers Mark first, for the branch the tab is on NOW (Dexter #87 F1)', () => {
  assert.match(MAIN, /Menu\.buildFromTemplate\(\[\s*markSubmenu\(tabShell\.branchOf\(key\)\),/);
});

test('the shell reads marks from the loaded store; the window prunes once, in tabs mode', () => {
  assert.match(MAIN, /marks: \{ markFor: \(branch\) => tabMarks\.markFor\(marks\.store, branch\) \}/);
  assert.match(MAIN, /reloadMarks\(\);\s*if \(MODE === 'tabs'\) pruneGoneMarks\(\);/);
});

test('a mark is never saved over a file that could not be read', () => {
  const body = MAIN.slice(MAIN.indexOf('function chooseMark('), MAIN.indexOf('function pruneGoneMarks('));
  assert.match(body, /const cur = reloadMarks\(\);\s*if \(cur\.store === null\) return false;/);
  const prune = MAIN.slice(MAIN.indexOf('function pruneGoneMarks('), MAIN.indexOf('function markSubmenu('));
  assert.match(prune, /if \(live === null \|\| cur\.state !== 'ok'\) return;/);
  assert.match(prune, /'--format=%\(refname\)', 'refs\/heads'/);
});

test('the Mark rows are checkboxes: a radio group gets a default tick from Electron (Dexter #87 F2)', () => {
  const body = MAIN.slice(MAIN.indexOf('function markSubmenu('), MAIN.indexOf('let win = null;'));
  assert.match(body, /type: 'checkbox', checked: r.checked/);
  assert.doesNotMatch(body, /'radio'/);
});

test('a Mark row does what its model row says: the ticked one clears (Dexter #87 r2)', () => {
  assert.match(MAIN, /click: \(\) => chooseMark\(branch, r\.choose\) \}\)\),/);
});
