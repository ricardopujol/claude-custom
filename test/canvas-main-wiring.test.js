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
  for (const ch of ['canvas:bounds', 'canvas:cover', 'canvas:hosts', 'canvas:hide']) {
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

test("a panel made for a tab asks main whether that tab is the selected one, so it never starts visible over another tab (PR #122 Dexter F4)", () => {
  assert.match(CODE, /isOwnerVisible: \(owner\) => \{ const sel = selectedView\(\); return !!sel && sel\.webContents === owner; \},/);
});

test("the broker's transport is its own pinned one, never the engine's: main must not hand it net.fetch, session.fetch or the global fetch (PR #122 Dexter F6 / F10)", () => {
  const block = CODE.slice(CODE.indexOf('const canvasViews = createCanvasViews({'), CODE.indexOf('function destroyTabView('));
  assert.doesNotMatch(block, /fetchImpl/, "main takes the broker's pinned transport (app/canvas-fetch.js)");
  assert.deepStrictEqual([...block.matchAll(/resolveHost: (\w+)/g)].map(m => m[1]), ['canvasProbeResolve'], "the only resolver main may pass is the probe seam's, which is undefined in a normal run");
  assert.doesNotMatch(CODE, /\bnet\.fetch\b|\bsession\.fetch\b|\bdefaultSession\.fetch\b/, 'Chromium networking resolves for itself, under host-resolver-rules, and cannot be pinned');
  const views = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'canvas-views.js'), 'utf8'));
  const fetchSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'canvas-fetch.js'), 'utf8'));
  assert.doesNotMatch(views, /fetchImpl\s*=\s*fetch\b/);
  assert.match(fetchSrc, /fetchImpl = createPinnedFetch\(\)/);
});

test("the probe's name map exists only behind the probe driver's port AND token, and never marks anything it did not map as vouched (PR #122 Dexter F10)", () => {
  const at = CODE.indexOf('const CANVAS_PROBE_HOSTS = (() => {');
  assert.ok(at !== -1);
  const seam = CODE.slice(at, CODE.indexOf('const canvasViews = createCanvasViews({'));
  assert.match(seam, /if \(!PROBE_PORT \|\| !PROBE_TOKEN\) return null;/);
  assert.match(seam, /CANVAS_PROBE_HOSTS === null \? undefined/);
  assert.match(seam, /typeof CANVAS_PROBE_HOSTS\[name\] === 'string' \? \[\{ address: CANVAS_PROBE_HOSTS\[name\], family: 4, trusted: true \}\] : require\('dns'\)\.promises\.lookup\(name, \{ all: true \}\)/);
});
