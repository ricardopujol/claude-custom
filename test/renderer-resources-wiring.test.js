'use strict';
/**
 * The wiring of the Resources panel (BACKLOG #63): source assertions in the style of
 * test/renderer-wand-wiring.test.js, because renderer.js needs a real DOM. The rules live in
 * app/resources-display.js, app/resources-service.js and host/resource-*.js (tested directly);
 * verify/probe-resource-panel.js drives the same paths in a real window.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const PRELOAD = strip(fs.readFileSync(path.join(APP, 'preload.js'), 'utf8'));
const MAIN = strip(fs.readFileSync(path.join(APP, 'main.js'), 'utf8'));
const { TABS } = require('../app/side-tabs');

const START = RAW.indexOf('// RESOURCES-BEGIN');
const BLOCK = strip(RAW.slice(START, RAW.indexOf('// RESOURCES-END')));

test('the Resources panel is an ordinary module: one TABS entry, one panel, one script before renderer.js', () => {
  assert.ok(TABS.some(t => t.id === 'resources' && t.label === 'Resources' && t.title), 'side-tabs TABS lists it');
  assert.match(HTML, /<div class="panel" data-panel="resources" id="resources-body">\s*<div id="resources-root"/);
  const at = HTML.indexOf('<script src="./resources-display.js"></script>');
  assert.ok(at !== -1 && at < HTML.indexOf('<script src="./renderer.js"></script>'));
});

test('the chip is in the top bar, and says what it is before the first sample', () => {
  assert.match(HTML, /<span id="top-bar">\s*(?:<!--[\s\S]*?-->\s*)?<button type="button" id="tb-resources" class="tb-chip" title="Machine total\. Open the Resources panel for who's using it\.">CPU —  — \/ —<\/button>/);
});

test('the glue is findable, and reads nothing from the OS', () => {
  assert.ok(START !== -1 && BLOCK.length > 500);
  assert.doesNotMatch(BLOCK, /require\(|child_process|taskkill|process\./);
});

test('the page reports "showing" on a change only, from the layout and from visibility', () => {
  assert.match(BLOCK, /const want = shownModules\.has\('resources'\) && document\.visibilityState === 'visible';\s*if \(want === resReportedShown\) return;/);
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange', syncResourcesShown\)/);
  const layout = RAW.slice(RAW.indexOf('function renderLayout('), RAW.indexOf('// A selection change (tab click, Ctrl+B)'));
  assert.match(layout, /for \(const id of fx\.newlyShown\) onModuleShown\(id\);\s*syncResourcesShown\(\);/);
});

test('Stop sends the pid and the start time the row was drawn with, and nothing that names a process', () => {
  assert.match(BLOCK, /resBridge\.stop\(\{ pid: req\.pid, startTime: req\.start \}\)/);
  assert.doesNotMatch(BLOCK, /stop\([^)]*name/);
  // Only a confirmed request is sent: the confirm is state, set by the Stop button and cleared by Cancel or a result.
  assert.match(BLOCK, /else if \(a\.act === 'confirm-stop'\) \{\s*const req = resState\.confirm;\s*if \(!req \|\| !resBridge \|\| resState\.pending\) return;\s*resState = D\.beginStop\(resState\);/);
});

test('a click is read through actionOf, so a hand-edited attribute is refused', () => {
  assert.match(BLOCK, /window\.resourcesDisplay\.actionOf\(el\.dataset\)/);
});

test('the chip opens and focuses the panel: shows it when hidden, selects it otherwise', () => {
  assert.match(BLOCK, /placementLayout\(\)\.hidden\.includes\('resources'\)\) commitPlacement\(DTm\.show\(placementLayout\(\), 'resources'\), \{ select: 'resources' \}\);\s*else selectModule\('resources'\);/);
  assert.match(BLOCK, /resRoot\.focus\(\)/);
});

test('the bridge exposes what the page calls, and main answers it behind the tab-view gate', () => {
  for (const m of ['setShown', 'get', 'stop', 'onState']) assert.match(PRELOAD, new RegExp(`resources: \\{[\\s\\S]*?\\b${m}:`), m);
  assert.match(PRELOAD, /ipcRenderer\.send\('resources:shown'/);
  assert.match(PRELOAD, /ipcRenderer\.invoke\('resources:stop', req\)/);
  assert.match(MAIN, /ipcMain\.on\('resources:shown', \(e, on\) => \{\s*if \(!isTabView\(e\.sender\) \|\| !resources\) return;/);
  assert.match(MAIN, /ipcMain\.handle\('resources:get', \(e\) => \(isTabView\(e\.sender\)/);
  // S5: only the SELECTED page gets the process model (command lines); every other page gets the machine figures alone
  assert.match(MAIN, /v\.webContents\.send\('resources:state', v === sel \? full : light\)/);
  assert.match(MAIN, /ipcMain\.handle\('resources:stop', \(e, req\) => \(isTabView\(e\.sender\)/);
});

test('main kills by pid through the vetted path, and the strip learns of a warning through the shell\'s refresh', () => {
  assert.match(MAIN, /kill: \(targets\) => killVerified\(targets, \{ exec: createPowerShellExec\(20000\) \}\)/);
  assert.match(MAIN, /refreshStrip: \(\) => \{ if \(tabShell\) tabShell\.refresh\(\); \}/);
  assert.match(MAIN, /resources: \{ warnFor: \(key\) => \(resources \? resources\.warnFor\(key\) : null\) \}/);
  assert.doesNotMatch(MAIN, /taskkill|killPidTree/);
});

test('the sampler follows the SELECTED tab: a selection change refreshes the policy, a destroyed view is forgotten', () => {
  assert.match(MAIN, /if \(resources\) resources\.refresh\(\);/);
  assert.match(MAIN, /wc\.once\('destroyed', \(\) => \{ if \(resources\) resources\.forget\(viewId\); \}\);/);
  assert.match(MAIN, /win\.on\('minimize', \(\) => \{ focused = false; if \(resources\) resources\.setMinimised\(true\); \}\);/);
});

test('the probe may read and click the Resources panel, by name only', () => {
  const { VIEW_PROBE_ACTIONS } = require('../app/tab-shell');
  for (const a of ['resourcesState', 'resourcesClick']) assert.ok(VIEW_PROBE_ACTIONS.has(a), a);
});
