'use strict';
/**
 * The wiring of the Schedules panel (BACKLOG #119 A7): source assertions in the style of test/renderer-games-wiring.test.js, because
 * renderer.js needs a real DOM. The markup and rules are tested directly (schedules-display.test.js); verify/probe-schedules.js drives the
 * same paths in a real window.
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
const RENDERER = strip(RAW);
const START = RAW.indexOf('// SCHEDULES-BEGIN');
const BLOCK = strip(RAW.slice(START, RAW.indexOf('// SCHEDULES-END')));
const { TABS } = require('../app/side-tabs');
const R = require('../app/rail-icons');

test('the Schedules panel is an ordinary module: one TABS entry, one icon, one panel, the script before renderer.js', () => {
  assert.strictEqual(TABS.filter(t => t.id === 'schedules').length, 1);
  const tab = TABS.find(t => t.id === 'schedules');
  assert.strictEqual(tab.label, 'Schedules');
  assert.ok(tab.title && tab.title.length > 10);
  assert.strictEqual(R.ICONS.schedules[0], 'calendar-clock');
  assert.match(HTML, /<div class="panel" data-panel="schedules" id="schedules-body">\s*<div id="schedules-root"/);
  const at = HTML.indexOf('<script src="./schedules-display.js"></script>');
  assert.ok(at !== -1 && at < HTML.indexOf('<script src="./renderer.js"></script>'));
});

test('the glue is findable and touches nothing but the page', () => {
  assert.ok(START !== -1 && BLOCK.length > 300);
  assert.doesNotMatch(BLOCK, /require\(|child_process|process\./);
  assert.match(BLOCK, /var schedState = window\.schedulesDisplay\.emptyState\(\);/);
});

test('the hello and every schedules frame feed the reducer, then redraw and repaint the badge', () => {
  assert.match(RENDERER, /schedState = window\.schedulesDisplay\.reduce\(schedState, msg\);\s*renderSchedules\(\);/, 'the hello');
  const at = RENDERER.indexOf("msg.type === 'schedules'");
  assert.ok(at !== -1, 'a frame branch');
  assert.match(RENDERER.slice(at, at + 200), /schedState = window\.schedulesDisplay\.reduce\(schedState, msg\);\s*renderSchedules\(\);\s*return;/);
  assert.match(BLOCK, /function renderSchedules\(\) \{[\s\S]*?paintSchedulesBadge\(\);[\s\S]*?\}/);
});

test('the panel draws only while it is on screen, and asks the host for a fresh list when it opens', () => {
  assert.match(BLOCK, /function renderSchedules\(\) \{\s*paintSchedulesBadge\(\);\s*if \(!schedRoot \|\| !shownModules\.has\('schedules'\)\) return;/);
  assert.match(RENDERER, /if \(id === 'schedules'\) \{ requestSchedules\(\); renderSchedules\(\); \}/);
  assert.match(BLOCK, /function requestSchedules\(\) \{\s*const msg = window\.schedulesDisplay\.requestMsg\(hostControls\);\s*if \(!msg \|\| !ws \|\| ws\.readyState !== WebSocket\.OPEN\) return;\s*try \{ ws\.send\(JSON\.stringify\(msg\)\);/);
  assert.doesNotMatch(BLOCK, /JSON\.stringify\(\{ type: 'schedules'/, 'no ungated literal frame anywhere in the glue');
});

test('a click selects the session\'s tab (the Git panel\'s own jump) or opens the one Routines link; nothing else', () => {
  assert.match(BLOCK, /window\.schedulesDisplay\.clickTarget\(e\.target\)/);
  assert.match(BLOCK, /t\.kind === 'select'\) \{ jumpToFolder\(t\.folder\)/);
  assert.match(BLOCK, /t\.kind === 'link'\)[\s\S]*?window\.harness\.openExternal\(t\.url\)/);
  assert.match(BLOCK, /e\.preventDefault\(\)/);
});

test('the rail badge is repainted after every layout (the rail rebuilds its buttons) and after every frame', () => {
  assert.match(RENDERER, /syncCanvasView\(\);[^\n]*\n(?:\s*syncPreviewView\(\);[^\n]*\n)?\s*paintSchedulesBadge\(\);/);
  assert.match(BLOCK, /document\.querySelectorAll\('button\[data-module="schedules"\]'\)/);
  assert.match(BLOCK, /b\.dataset\.badge = text/);
  assert.match(BLOCK, /delete b\.dataset\.badge/);
  assert.match(HTML, /button\[data-badge\]::after/);
});

test('the probe page answers every schedules action the shell lets through, and the shell lets exactly those through', () => {
  const SHELL = fs.readFileSync(path.join(APP, 'tab-shell.js'), 'utf8');
  for (const a of ['schedulesState', 'schedulesClick']) {
    assert.ok(RAW.includes(`case '${a}':`), `renderer.js must answer ${a}`);
    assert.ok(SHELL.includes(`'${a}'`), `tab-shell.js must let ${a} through (an unlisted action is refused as "view needs a known action")`);
  }
});
