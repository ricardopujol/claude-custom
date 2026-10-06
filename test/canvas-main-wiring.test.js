'use strict';
/**
 * app/main.js's half of Claude's panel (BACKLOG #71): source assertions, because main.js needs Electron. The panel logic
 * is tested in test/canvas-views.test.js; verify/probe-canvas-sandbox.js runs the same module in a real window, and
 * verify/probe-canvas-panel.js drives the whole thing in the real app.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const CODE = strip(MAIN);

test('the process-wide resolver rule is set before the app is ready (a switch set later does nothing)', () => {
  const at = CODE.indexOf("app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);");
  assert.ok(at !== -1);
  assert.ok(at < CODE.indexOf('app.whenReady()'));
  assert.match(CODE, /HOST_RESOLVER_RULES[^;]*\} = require\('\.\/canvas-views'\);/);
});

test('every tab-page channel is gated on the sender being a tab view', () => {
  for (const ch of ['canvas:bounds', 'canvas:cover', 'canvas:hosts', 'canvas:set-shelf', 'canvas:hide']) {
    const m = new RegExp(`ipcMain\\.on\\('${ch}', \\(e(?:, [a-z]+)?\\) => \\{ if \\(isTabView\\(e\\.sender\\)\\)`).exec(CODE);
    assert.ok(m, `${ch} must check isTabView(e.sender)`);
  }
  assert.match(CODE, /ipcMain\.handle\('canvas:show', \(e, req\) => \(isTabView\(e\.sender\) && req && typeof req === 'object'/);
});

test('the panel page talks only on the two channels registerCanvasIpc owns', () => {
  assert.match(CODE, /registerCanvasIpc\(ipcMain, canvasViews\);/);
  assert.doesNotMatch(CODE, /ipcMain\.(on|handle)\('canvas:(fetch|send)'/, 'main.js must not answer the panel by hand');
});

test('only the tab that was asked about a host can answer', () => {
  const at = CODE.indexOf("ipcMain.on('canvas:host-answer'");
  assert.ok(at !== -1);
  const block = CODE.slice(at, CODE.indexOf('\n  });', at));
  assert.match(block, /pending\.owner !== e\.sender\) return;/);
  assert.match(block, /a\.answer === 'allow' \? 'allow' : 'deny'/);
});

test('a host question that nobody answers ends as a deny, not a hang', () => {
  assert.match(CODE, /setTimeout\(\(\) => \{ canvasAsks\.delete\(id\); resolve\('deny'\); \}, CANVAS_ASK_TIMEOUT_MS\);/);
});

test("a tab's panel follows its tab: destroyed with it, hidden when it is not selected, moved when it is laid out again", () => {
  const destroy = CODE.slice(CODE.indexOf('function destroyTabView('), CODE.indexOf('// --- pushing the model out'));
  assert.match(destroy, /canvasViews\.destroyFor\(view\.webContents\);/);
  const sel = CODE.slice(CODE.indexOf('function applySelection('), CODE.indexOf('function applySelection(') + 900);
  assert.match(sel, /canvasViews\.setOwnerVisible\(tab\.view\.webContents, tab\.key === snapshot\.selectedKey\);/);
  const lay = CODE.slice(CODE.indexOf('function layoutView('), CODE.indexOf('function setFocusMode('));
  assert.match(lay, /canvasViews\.relayout\(view\.webContents\);/);
});

test("the panel's views are made from main with its own preload, never the app's", () => {
  assert.match(CODE, /preloadPath: path\.join\(__dirname, 'canvas-panel-preload\.js'\)/);
});

test('the tab preload and main agree on every canvas channel, in both directions', () => {
  const pre = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8'));
  const sent = [...pre.matchAll(/ipcRenderer\.(?:send|invoke)\('(canvas:[a-z-]+)'/g)].map(m => m[1]).sort();
  const handled = [...CODE.matchAll(/ipcMain\.(?:on|handle)\('(canvas:[a-z-]+)'/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(sent, handled);
  const heard = [...pre.matchAll(/ipcRenderer\.on\('(canvas:[a-z-]+)'/g)].map(m => m[1]).sort();
  const pushed = [...CODE.matchAll(/owner\.send\('(canvas:[a-z-]+)'/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(heard, pushed);
});

test('an address the panel asks to open goes to the real browser through openInBrowser, so only http(s) ever leaves the app', () => {
  assert.match(CODE, /openUrl: \(url\) => openInBrowser\(url, "Claude's panel"\),/);
});
