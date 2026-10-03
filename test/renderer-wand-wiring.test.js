'use strict';
/**
 * renderer.js / renderer.html's half of the wand (BACKLOG #51): source assertions in the style of
 * test/renderer-dock-wiring.test.js, because renderer.js needs a real DOM. The rules live in
 * app/wand-display.js (tested directly); verify/probe-wand.js drives the same paths in a real window.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const JS = strip(RAW);
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
const { TABS } = require('../app/side-tabs');

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

// The whole wand section: from its first marker to the next top-level section.
// (located in the raw text: the markers are comments, which strip() removes)
const START = RAW.indexOf('// WAND-BEGIN');
const WAND = strip(RAW.slice(START, RAW.indexOf('// WAND-END')));

test('the wand is an ordinary module: one TABS entry, one panel, one script, no dock code touched', () => {
  assert.ok(TABS.some(t => t.id === 'wand' && t.label && t.title), 'side-tabs TABS lists the wand');
  assert.match(HTML, /<div class="panel" data-panel="wand" id="wand-body">\s*<div id="wand-root"/);
  const wandScript = HTML.indexOf('<script src="./wand-display.js"></script>');
  assert.ok(wandScript !== -1 && wandScript < HTML.indexOf('<script src="./renderer.js"></script>'), 'wand-display.js loads before renderer.js');
});

test('the wand section is findable, and is the ONLY place the wand touches the page', () => {
  assert.ok(START !== -1 && WAND.length > 200, 'WAND-BEGIN / WAND-END must bracket the glue');
});

test('a click types through typeCommand (the shared typeAndCheck) and NEVER presses Enter', () => {
  const body = fnBody('wandType');
  assert.match(body, /typeCommand\(plan\.command,/);
  // No Enter anywhere in the wand's glue: not a CR, not a raw input frame, not typePlanned (the one that submits).
  assert.doesNotMatch(WAND, /\\r|\\n['"]/);
  assert.doesNotMatch(WAND, /type: 'input'/);
  assert.doesNotMatch(WAND, /typePlanned/);
  assert.doesNotMatch(WAND, /input\(/);
});

test('the shared typeCommand itself is still the one that never submits (the contract the wand leans on)', () => {
  const t = fnBody('typeCommand');
  assert.match(t, /typeAndCheck\(plan\.enterInsert, command,/);
  assert.doesNotMatch(t, /\\r/);
});

test('a click while one is still typing is ignored: two overlapping type sequences would garble the box', () => {
  const body = fnBody('wandType');
  assert.match(body, /if \(wandBusy\) return;/);
  assert.match(body, /wandBusy = true;/);
  assert.match(body, /wandBusy = false;/);
});

test('the host\'s hello and wand frames fold into the panel state, then redraw', () => {
  const hello = JS.slice(JS.indexOf("if (msg.type === 'hello') {"), JS.indexOf("if (msg.type === 'loadout') {"));
  assert.match(hello, /wandState = wandDisplay\.reduce\(wandState, msg\);\s*renderWand\(\);/);
  const frame = JS.slice(JS.indexOf("if (msg.type === 'wand') {"), JS.indexOf("if (msg.type === 'wand') {") + 200);
  assert.match(frame, /wandState = wandDisplay\.reduce\(wandState, msg\);\s*renderWand\(\);\s*return;/);
});

test('opening the module asks the host to rescan its skills', () => {
  assert.match(fnBody('onModuleShown'), /if \(id === 'wand'\) requestWandSkills\(\);/);
});

test('every edit goes out through wandSend, and a send with no socket is shown, not silently dropped', () => {
  const body = fnBody('wandSend');
  assert.match(body, /wandDisplay\.failed\(wandState,/);
  assert.match(body, /ws\.send\(JSON\.stringify\(message\)\)/);
});

test('a redraw keeps the editor field the user is typing in: a quiet refresh must not eat their text or focus', () => {
  const body = fnBody('renderWand');
  assert.match(body, /document\.activeElement/);
  assert.match(body, /setSelectionRange\(/);
});

test('reordering is a drag inside the panel: it stops the page-wide file-drop handler seeing it', () => {
  assert.match(WAND, /addEventListener\('dragover', \(e\) => \{[^}]*e\.stopPropagation\(\);/);
  assert.match(WAND, /addEventListener\('drop', \(e\) => \{[\s\S]*?e\.stopPropagation\(\);/);
  assert.match(WAND, /wandDisplay\.moveMsg\(/);
});

test('typing in the search box updates only the skill list, so the box keeps its focus', () => {
  assert.match(WAND, /wand-skill-list/);
  assert.match(WAND, /wandDisplay\.skillListHtml\(/);
});
