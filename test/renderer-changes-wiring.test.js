'use strict';
/**
 * The wiring of the Changes panel (BACKLOG #119 A3): source assertions in the style of test/renderer-games-wiring.test.js, because
 * renderer.js needs a real DOM. The parts are tested directly (changes-*.test.js); verify/probe-changes-panel.js drives the same paths
 * in a real window.
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
const BROWSER = strip(fs.readFileSync(path.join(APP, 'repo-browser.js'), 'utf8'));
const { TABS } = require('../app/side-tabs');
const { ICONS } = require('../app/rail-icons');
const { PANEL_IDS, isValidKey } = require('../host/usage-counters');
const { VIEW_PROBE_ACTIONS } = (() => { try { return require('../app/tab-shell'); } catch { return {}; } })();

const START = RAW.indexOf('// CHANGES-BEGIN');
const BLOCK = strip(RAW.slice(START, RAW.indexOf('// CHANGES-END')));
const RENDERER = strip(RAW);

test('the Changes panel is an ordinary module: one TABS entry, an icon, a usage id, one panel, scripts in order before renderer.js', () => {
  assert.ok(TABS.some(t => t.id === 'changes' && t.label === 'Changes' && t.title), 'side-tabs TABS lists it');
  assert.ok(ICONS.changes && ICONS.changes[0] === 'git-compare', 'it has its rail icon');
  assert.ok(PANEL_IDS.includes('changes'));
  assert.match(HTML, /<div class="panel" data-panel="changes" id="changes-body">\s*<div id="changes-root"/);
  const at = n => HTML.indexOf(`<script src="./${n}.js"></script>`);
  assert.ok(at('repo-linediff') < at('changes-compare') && at('changes-compare') < at('repo-reader'), 'the compare model loads before the reader that uses it');
  assert.ok(at('repo-browser') < at('changes-display') && at('changes-display') < at('renderer'));
});

test('the usage keys the panel reports are ones the host counts', () => {
  for (const k of ['changes:file-opened', 'changes:scope', 'changes:comment-typed', 'panel:changes']) assert.ok(isValidKey(k), k);
});

test('the glue is findable, and the page hands the panel only what it alone knows', () => {
  assert.ok(START !== -1 && BLOCK.length > 400);
  assert.match(BLOCK, /repoBrowser\.changes\.request\(action, body\)/);
  assert.match(BLOCK, /action === 'list' \? repoBrowser\.refreshTouched\(\)/, 'the dots are refreshed with each list');
  assert.match(BLOCK, /isTouched: \(p\) => repoBrowser\.isTouched\(p\)/);
  assert.match(BLOCK, /openChange: \(info\) => \{ repoBrowser\.openChange\(info\)/);
  assert.doesNotMatch(BLOCK, /require\(|child_process|process\./);
});

test('the host\'s changed push reaches the panel, which acts on it only while it shows', () => {
  assert.match(BLOCK, /repoBrowser\.changes\.onChanged\(\(\) => \{ if \(changesPanel\) changesPanel\.onChanged\(\); \}\)/);
  assert.match(BLOCK, /shownModules\.has\('changes'\) && document\.visibilityState === 'visible'/);
  assert.match(BLOCK, /if \(now\) changesPanel\.show\(\); else changesPanel\.hide\(\)/);
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange', changesView\)/);
});

test('the panel is told whether it is on screen after every layout, and asks again when the hello arrives', () => {
  assert.match(RENDERER, /shownModules = now;\s*gamesView\(\);[^\n]*\s*askView\(\);[^\n]*\s*changesView\(\);/);
  assert.match(RENDERER, /repoBrowser\.setControls\(msg\.controls\);\s*if \(changesPanel && shownModules\.has\('changes'\)\) changesPanel\.refresh\(\);/);
});

test('a review comment is typed through the page\'s ONE typing path, as kind `comment`, and counted only when it was typed', () => {
  assert.match(RENDERER, /typeComment: \(text, done\) => typeCommand\(text, r => \{ if \(r\.ok\) usage\('changes:comment-typed'\); done\(r\.ok \? \{ ok: true \} : \{ ok: false, reason: r\.reason \}\); \}, 'comment'\)/);
  // typeCommand without `opts.submit` never presses Enter: the call passes none
  const at = RENDERER.indexOf("'comment')");
  assert.ok(at !== -1);
  assert.doesNotMatch(RENDERER.slice(at - 260, at + 12), /submit\s*:/);
});

test('both control conversations of the browser are gated on the host\'s hello and cleared when the socket drops', () => {
  assert.match(BROWSER, /requester\.setControls\(list\); changes\.setControls\(list\)/);
  assert.match(BROWSER, /requester\.onMessage\(msg\) \|\| changes\.onMessage\(msg\)/);
  assert.match(BROWSER, /requester\.failAll\(reason\); changes\.failAll\(reason\)/);
  assert.match(BROWSER, /type: 'changes'/);
});

test('the probe may read and operate the panel through the tab shell\'s whitelist', () => {
  const shell = fs.readFileSync(path.join(APP, 'tab-shell.js'), 'utf8');
  assert.match(shell, /'changesProbe'/);
  assert.match(RENDERER, /case 'changesProbe':/);
  void VIEW_PROBE_ACTIONS;
});
