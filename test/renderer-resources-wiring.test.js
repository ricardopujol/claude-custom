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
  assert.match(HTML, /<span id="top-bar">\s*(?:<!--[\s\S]*?-->\s*)?<button type="button" id="tb-resources" class="tb-chip" aria-controls="res-popover" aria-expanded="false" title="Machine total and the last hour\. Click for the graphs\.">CPU —  — \/ —<\/button>/);
});

test('the glue is findable, and reads nothing from the OS', () => {
  assert.ok(START !== -1 && BLOCK.length > 500);
  assert.doesNotMatch(BLOCK, /require\(|child_process|taskkill|process\./);
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

test('the chip opens a popover with the graphs (it no longer opens the panel); every event goes through the state machine', () => {
  // the chip's own click only toggles the popover (the one-liner below); the panel is reached through the popover's button
  assert.match(BLOCK, /tbResourcesEl\.addEventListener\('click', \(\) => \{ resPopStep\(\{ type: 'chip-click' \}\); \}\)/);
  assert.match(BLOCK, /document\.addEventListener\('keydown'[\s\S]*?resPopStep\(\{ type: 'key', key: e\.key \}\)[\s\S]*?e\.preventDefault\(\); e\.stopPropagation\(\)/);
  assert.match(BLOCK, /document\.addEventListener\('pointerdown'[\s\S]*?resPopStep\(\{ type: 'pointerdown', inside:/);
  assert.match(BLOCK, /window\.addEventListener\('blur', \(\) => \{ resPopStep\(\{ type: 'blur' \}\); \}\)/);
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange'[\s\S]*?resPopStep\(\{ type: 'hidden' \}\)/);
  assert.match(BLOCK, /resPopoverEl\.addEventListener\('mouseleave'/);
  assert.match(BLOCK, /resourcesHistoryDisplay\.popoverStep\(/);
  assert.match(BLOCK, /resourcesHistoryDisplay\.popover\(/);
  assert.match(BLOCK, /resourcesHistoryDisplay\.chipHtml\(/);
});

test('the popover is closed with the chip (the Window menu toggle), is a labelled region, and the markup and script are in the page', () => {
  assert.match(BLOCK, /if \(!resChipOn\) resPopStep\(\{ type: 'chip-off' \}\)/);
  assert.match(HTML, /<div id="res-popover" hidden role="region" aria-label=/);
  assert.doesNotMatch(HTML, /aria-haspopup/);
  const at = HTML.indexOf('<script src="./resources-history-display.js"></script>');
  assert.ok(at > HTML.indexOf('<script src="./resources-display.js"></script>') && at < HTML.indexOf('<script src="./renderer.js"></script>'), 'after resources-display.js, before renderer.js');
});

test('the bridge exposes what the page calls, and main answers it behind the tab-view gate', () => {
  for (const m of ['get', 'stop', 'onState']) assert.match(PRELOAD, new RegExp(`resources: \\{[\\s\\S]*?\\b${m}:`), m);
  assert.match(PRELOAD, /ipcRenderer\.invoke\('resources:stop', req\)/);
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

test('the sampler always runs, and only a minimised window pauses it', () => {
  assert.match(MAIN, /if \(resources\) resources\.refresh\(\);/);
  assert.match(MAIN, /win\.on\('minimize', \(\) => \{ focused = false; if \(resources\) resources\.setMinimised\(true\); \}\);/);
});

test('the probe may read and click the Resources panel, by name only', () => {
  const { VIEW_PROBE_ACTIONS } = require('../app/tab-shell');
  for (const a of ['resourcesState', 'resourcesClick', 'resourcesHistoryDo']) assert.ok(VIEW_PROBE_ACTIONS.has(a), a);
});

test('Q2: the Window menu has the chip toggle, the page hides the chip on a payload that says off, and main answers it gated', () => {
  assert.match(RAW, /function resourceChipRow\(\)/);
  assert.match(RAW, /node\('span', \{ text: 'Show CPU and memory in the top bar' \}\)/);
  assert.match(RAW, /layoutMenu\.appendChild\(resourceChipRow\(\)\);\s*appendPresetSection\(check\);/);
  assert.match(BLOCK, /tbResourcesEl\.hidden = !resChipOn;/);
  assert.match(BLOCK, /let resChipOn = !\(resBridge && typeof resBridge\.chipOn === 'function' && resBridge\.chipOn\(\) === false\);/);
  assert.match(PRELOAD, /chipOn: \(\) => ipcRenderer\.sendSync\('resources:chipOn'\) !== false/);
  assert.match(MAIN, /ipcMain\.on\('resources:chipOn'/);
  assert.match(PRELOAD, /setChip: \(on\) => ipcRenderer\.invoke\('resources:setChip', on === true\)/);
  assert.match(MAIN, /ipcMain\.handle\('resources:setChip', \(e, on\) => \(isTabView\(e\.sender\) && resources \? resources\.setChip\(on\) : null\)\);/);
});

test('the history goes to the selected page only: a newly selected page is re-sent the last payloads at once', () => {
  assert.match(MAIN, /if \(resources && live !== resHistoryView\) \{ resHistoryView = live; resources\.resend\(\); \}/);
});

test('the popover Open Resources panel button closes it, shows the panel when hidden, selects and focuses it', () => {
  assert.match(BLOCK, /closest\('\[data-hist-act="open-panel"\]'\)[\s\S]*?resPopStep\(\{ type: 'panel-link' \}\);\s*revealModule\('resources'\);[\s\S]*?resRoot\.focus\(\)/);
});

test('Leftovers Stop (B): the bridge, the gated IPC handler and the page\'s click all line up, and the page names rows, never processes', () => {
  assert.match(PRELOAD, /ipcRenderer\.invoke\('resources:stopLeftovers', req\)/);
  assert.match(MAIN, /ipcMain\.handle\('resources:stopLeftovers', \(e, req\) => \(isTabView\(e\.sender\)/);
  assert.match(MAIN, /resources\.stopLeftovers\(req\)/);
  assert.match(BLOCK, /resBridge\.stopLeftovers\(a\.act === 'left-stop' \? \{ rows: \[\{ pid: a\.pid, start: a\.start \}\] \} : a\.act === 'left-delete' \? \{ taskLog: a\.key \} : \{ group: a\.group \}\)/);
  assert.match(BLOCK, /if \(!resBridge \|\| resState\.leftBusy\) return;/);
});

test('Leftovers task logs (#74 F(3)): main hands the service the stat-only scan of %TEMP%\\claude, the CLI registry, and the one guarded delete', () => {
  assert.match(MAIN, /taskLogsRoot = path\.join\(require\('os'\)\.tmpdir\(\), 'claude'\)/);
  assert.match(MAIN, /scan: \(\) => taskLogsFs\.scanTaskFiles\(taskLogsRoot\)/);
  assert.match(MAIN, /registry: \(\) => taskLogsFs\.readRegistries\(taskLogsFs\.registryDirs\(tabShell\.snapshot\(\)\.tabs\.map\(t => t\.cwd\), claudeConfigDir, profiles\.stateFor\(null\)\.profiles\.map\(p => p\.configDir\)\)\)/);
  assert.match(MAIN, /remove: \(row\) => taskLogsFs\.deleteTaskLog\(taskLogsRoot, row\)/);
  assert.doesNotMatch(MAIN, /\bunlink|rmSync|\.rm\(/, 'main never deletes a file itself');
});

test('Leftovers (F2): the stop is the async killProven, the launcher is re-asked through the seams, and main never calls the sync one', () => {
  assert.match(MAIN, /kill: \(pid, start\) => killProvenAsync\(pid, start\)/);
  assert.match(MAIN, /createLeftoverSeams\(\{/);
  assert.doesNotMatch(MAIN, /\bkillProven\(/);
});

test('#82: the chip is handed the GPU figure, and the Resources tab the GPU graphs from the history display', () => {
  assert.match(BLOCK, /resourcesHistoryDisplay\.chipHtml\(c\.cpuText, c\.memText, resHistory\(\), resHistoryNow\(\), c\.gpuText\)/);
  assert.match(BLOCK, /resourcesDisplay\.html\(window\.resourcesDisplay\.view\(resState\), \{ gpuGraphs: window\.resourcesHistoryDisplay\.gpuGraphs\(resHistory\(\), resHistoryNow\(\)\) \}\)/);
  assert.match(HTML, /aria-label="CPU, memory and GPU over the last hour"/);
  assert.match(HTML, /\.res-gpu \.hg-plot \{ width: 100% !important;/);
});
