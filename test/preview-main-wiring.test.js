'use strict';
/**
 * app/main.js's half of the Preview panel and the Dev servers chip (BACKLOG #119 A4): source assertions, because main.js needs Electron.
 * The panel's rules are tested in test/preview-views.test.js and test/preview-guard.test.js; verify/probe-preview-panel.js runs the whole
 * thing in a real window.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const CODE = strip(read('app/main.js'));
const VIEWS = strip(read('app/preview-views.js'));
const PRELOAD = strip(read('app/preload.js'));

test('every Preview channel from the tab page is gated on the sender being a tab view', () => {
  for (const ch of ['preview:bounds', 'preview:cover', 'preview:hide', 'preview:reload', 'preview:devtools', 'preview:open-external', 'preview:open-port']) {
    const m = new RegExp(`ipcMain\\.on\\('${ch}', \\(e(?:, [a-z]+)?\\) => \\{ if \\(isTabView\\(e\\.sender\\)\\)`).exec(CODE);
    assert.ok(m, `${ch} must check isTabView(e.sender)`);
  }
  assert.match(CODE, /ipcMain\.handle\('preview:show', \(e, req\) => \(isTabView\(e\.sender\) && req && typeof req === 'object'/);
  assert.match(CODE, /ipcMain\.handle\('devservers:get', \(e\) => \{\s*const tab = isTabView\(e\.sender\) \? tabShell\.tabForSender\(e\.sender\) : null;/);
});

test('the dev server\'s page has no channel to main at all: nothing in main answers a sender that is not a tab view', () => {
  const handlers = [...CODE.matchAll(/ipcMain\.(?:on|handle)\('(preview|devservers):[a-z-]+'/g)];
  assert.ok(handlers.length >= 9);
  for (const h of handlers) {
    const at = h.index;
    const line = CODE.slice(at, CODE.indexOf('\n', at + 40));
    const block = CODE.slice(at, at + 400);
    assert.match(block, /isTabView\(e\.sender\)/, `${h[0]} is gated: ${line.slice(0, 80)}`);
  }
});

test('the panel\'s view gets NO preload, no Node, a sandbox, and no webview', () => {
  const prefs = VIEWS.slice(VIEWS.indexOf('webPreferences: {'), VIEWS.indexOf('} });', VIEWS.indexOf('webPreferences: {')));
  assert.doesNotMatch(prefs, /preload/);
  assert.match(prefs, /sandbox: true/);
  assert.match(prefs, /contextIsolation: true/);
  assert.match(prefs, /nodeIntegration: false/);
  assert.doesNotMatch(prefs, /webviewTag|nodeIntegrationInSubFrames|nodeIntegrationInWorker|webSecurity: false|allowRunningInsecureContent: true/);
  assert.doesNotMatch(CODE.slice(CODE.indexOf('const previewViews = createPreviewViews'), CODE.indexOf('let devServers = null')), /preload/);
});

test('the view is made from the module, with the Electron classes handed in, and never reads the app\'s own preload', () => {
  assert.match(CODE, /const previewViews = createPreviewViews\(\{\s*WebContentsView, session,/);
});

test('a tab\'s Preview follows its tab: destroyed with it, hidden when it is not selected, moved when it is laid out again', () => {
  const destroy = CODE.slice(CODE.indexOf('function destroyTabView('), CODE.indexOf('// --- pushing the model out'));
  assert.match(destroy, /previewViews\.destroyFor\(view\.webContents\);/);
  const sel = CODE.slice(CODE.indexOf('function applySelection('), CODE.indexOf('function applySelection(') + 1000);
  assert.match(sel, /previewViews\.setOwnerVisible\(tab\.view\.webContents, shows\);/);
  const lay = CODE.slice(CODE.indexOf('function layoutView('), CODE.indexOf('function setFocusMode('));
  assert.match(lay, /previewViews\.relayout\(view\.webContents\);/);
});

test('open in the browser goes through the one rule links follow (openInBrowser -> externalUrl)', () => {
  assert.match(CODE, /openUrl: \(url\) => openInBrowser\(url, 'Preview'\),/);
});

test('the listener sampler is started minimised-aware, stopped and its shell closed at quit', () => {
  assert.match(CODE, /devServers = createDevServersService\(\{\s*exec: devServersExec,/);
  // What the window shows decides it: minimise, restore AND hide/show (the tray), through the pure rule in host/dev-servers.js.
  assert.match(CODE, /for \(const ev of \['minimize', 'restore', 'hide', 'show'\]\) win\.on\(ev, syncDevServersSampling\);/);
  assert.match(CODE, /devServers\.setMinimised\(devServersHost\.unseen\(\{ visible: gone \? false : win\.isVisible\(\), minimized: gone \? true : win\.isMinimized\(\) \}\)\);/);
  assert.match(CODE, /createWindow\(\);\s*syncDevServersSampling\(\);/, 'the first read is AFTER the window exists');
  assert.doesNotMatch(CODE, /devServers\.setMinimised\(!!\(win/, 'no read before the window exists');
  // What the window shows decides it: minimise, restore AND hide/show (the tray), through the pure rule in host/dev-servers.js.
  assert.match(CODE, /app\.on\('will-quit', \(\) => \{ if \(devServers\) devServers\.stop\(\); if \(devServersExec\) devServersExec\.close\(\); \}\);/);
});

test('the block is READ for a tab (lookup), never allocated by the sampler', () => {
  assert.match(CODE, /portBaseOf: \(cwd\) => \{ const root = worktreeRoot\(cwd\); return root \? lookupPortBlock\(root\) : null; \}/);
  assert.doesNotMatch(CODE, /allocatePortBlock|require\('\.\.\/host\/port-blocks'\)\.allocate/);
});

test('each tab page is told only its own tab\'s ports', () => {
  assert.match(CODE, /tab\.view\.webContents\.send\('devservers:state', state\)/);
});

test('the preload bridge carries exactly the Preview channels main answers', () => {
  const invoked = [...PRELOAD.matchAll(/ipcRenderer\.(?:invoke|send)\('((?:preview|devservers):[a-z-]+)'/g)].map(m => m[1]);
  for (const ch of invoked) assert.match(CODE, new RegExp(`ipcMain\\.(?:on|handle)\\('${ch}'`), `${ch} has a handler in main`);
  for (const ch of ['preview:show', 'preview:bounds', 'preview:cover', 'preview:hide', 'preview:reload', 'preview:devtools', 'preview:open-external', 'preview:open-port', 'devservers:get']) {
    assert.ok(invoked.includes(ch), `${ch} is in the bridge`);
  }
  // The page never supplies an address for these three:
  assert.match(PRELOAD, /reload: \(\) => ipcRenderer\.send\('preview:reload'\)/);
  assert.match(PRELOAD, /devtools: \(\) => ipcRenderer\.send\('preview:devtools'\)/);
  assert.match(PRELOAD, /openExternal: \(\) => ipcRenderer\.send\('preview:open-external'\)/);
});

test('the deny set holds the probe driver port and the host port named by CLAUDE_CUSTOM_PORT (Dexter r2 N4)', () => {
  assert.ok(CODE.includes('Number.isInteger(EXPLICIT_PORT) ? EXPLICIT_PORT : null'));
  assert.ok(CODE.includes('denyPorts: [PROBE_PORT ? Number(PROBE_PORT) : null'));
});

test('another proxy for the session exists only behind the probe driver port AND token', () => {
  const at = CODE.indexOf('function previewProbeProxy()');
  assert.ok(at !== -1);
  const body = CODE.slice(at, CODE.indexOf('\n}', at));
  assert.ok(body.includes('if (!PROBE_PORT || !PROBE_TOKEN) return undefined;'));
  assert.ok(CODE.includes('proxyConfig: previewProbeProxy(),'));
});
