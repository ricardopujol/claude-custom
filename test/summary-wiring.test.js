'use strict';
/**
 * The where-are-we summary's page wiring (backlog #39 job 1, documentation/DESIGN_SLAVE_MODE_SUMMARY.md): source
 * assertions in the style of test/terminal-bar-wiring.test.js, because renderer.js can't be loaded by a unit test.
 * The behaviour runs in a real window in verify/probe-where-summary.js (a fake Ollama, a switch to an idle tab).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const STRIP_HTML = fs.readFileSync(path.join(APP, 'tab-strip.html'), 'utf8');
const rule = (selector) => {
  const at = HTML.indexOf(selector + ' {');
  return at === -1 ? null : HTML.slice(at, HTML.indexOf('}', at));
};
const scripts = (html) => [...html.matchAll(/<script\s+src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);

test('the page loads summary-display.js after terminal-bar.js (it uses its age label), before renderer.js; the strip page stays script-free of it', () => {
  const r = scripts(HTML);
  assert.ok(r.indexOf('summary-display.js') > r.indexOf('terminal-bar.js'));
  assert.ok(r.indexOf('summary-display.js') < r.indexOf('renderer.js'));
  assert.deepStrictEqual(scripts(STRIP_HTML), ['tab-strip.js'], 'the shell works the hover lines out; the strip only draws them');
});

test('the summary sits at the left of the bar, before the prompt part and the chips, with its card under the bar', () => {
  const bar = HTML.slice(HTML.indexOf('<div id="terminal-bar"'), HTML.indexOf('<div id="occupancy-confirm"'));
  for (const id of ['bar-summary', 'bar-summary-label', 'bar-summary-card', 'bar-summary-lines', 'bar-summary-note']) assert.match(bar, new RegExp(`id="${id}"`), id);
  assert.ok(bar.indexOf('id="bar-summary"') < bar.indexOf('id="bar-prompt"'));
  assert.match(bar, /<button type="button" id="bar-summary" hidden aria-expanded="false" aria-controls="bar-summary-card"/);
  assert.match(bar, /<div id="bar-summary-card" hidden/);
});

test('it never animates and is hidden with focus mode (the bar\'s own rules)', () => {
  assert.doesNotMatch(rule('#bar-summary') + rule('#bar-summary-card'), /animation|transition/);
  assert.match(HTML, /#bar-summary\[hidden\], #bar-summary-card\[hidden\]/);
});

test('the page paints from summaryDisplay.panelModel through the bar\'s own model, and only ever sets text', () => {
  assert.match(RENDERER, /summaryDisplay\.panelModel\(\{/);
  assert.match(RENDERER, /summary: panel,/, 'the panel goes into terminalBar.barModel');
  const paint = RENDERER.slice(RENDERER.indexOf('function paintBarNow'), RENDERER.indexOf('function paintBarNow') + 5500);
  assert.doesNotMatch(paint, /innerHTML/);
  assert.match(paint, /barEls\.summaryLabel/);
});

test('the control message and hello both feed it, and hello (a window that attached) can open it', () => {
  assert.match(RENDERER, /msg\.type === 'summary'/);
  assert.match(RENDERER, /applySummary\(msg, false\)/);
  assert.match(RENDERER, /applySummary\(\{ summary: msg\.summary, off: msg\.summaryOff \}, true\)/);
});

test('it opens on switching to a tab (selected or shown), and a live push of a new summary never pops it open', () => {
  assert.match(RENDERER, /function summaryOpenIfIdle\(\)/);
  assert.match(RENDERER, /window\.harness\.onTabSelected\(\(\) => \{[^}]*summaryOpenIfIdle\(\)/);
  assert.match(RENDERER, /document\.addEventListener\('visibilitychange'/);
  const apply = RENDERER.slice(RENDERER.indexOf('function applySummary'), RENDERER.indexOf('function applySummary') + 900);
  assert.match(apply, /if \(opening && !document\.hidden\) summaryOpenIfIdle\(\)/);
});

test('"untouched" is the newest of the last real keystroke and the host\'s last prompt', () => {
  assert.match(RENDERER, /summaryDisplay\.lastTouchedAt\(sum\.lastInputAt, bar\.prompt && bar\.prompt\.at\)/);
  assert.match(RENDERER, /summaryDisplay\.openOnSelect\(\{ summary: sum\.summary, off: sum\.off, lastInputAt: last, now \}\)/);
});

test('a keystroke hides it, from onKey (a focus or mouse report arriving through onData is not typing)', () => {
  assert.match(RENDERER, /term\.onKey\(\(\) => \{ summaryTyped\(\); \}\);/);
  const typed = RENDERER.slice(RENDERER.indexOf('function summaryTyped'), RENDERER.indexOf('function summaryTyped') + 400);
  assert.match(typed, /sum\.lastInputAt = Date\.now\(\)/);
  assert.match(typed, /sum\.typed = true/);
  assert.doesNotMatch(RENDERER.slice(RENDERER.indexOf('term.onData((data) =>'), RENDERER.indexOf('term.onData((data) =>') + 300), /summaryTyped/);
});

test('a click pins it open (and unpins it), and Escape inside the bar closes it, without taking the terminal\'s Escape', () => {
  assert.match(RENDERER, /barEls\.summary\.addEventListener\('click'/);
  const esc = RENDERER.slice(RENDERER.indexOf("barEls.bar.addEventListener('keydown'"), RENDERER.indexOf("barEls.bar.addEventListener('keydown'") + 700);
  assert.match(esc, /sum\.openedAt = null/);
  assert.match(esc, /sum\.pinned = false/);
});

test('the tab status carries the summary (and why it may be out of date) to the strip\'s hover card', () => {
  assert.match(RENDERER, /summary: sum\.summary \? \{ \.\.\.sum\.summary, note: summaryDisplay\.offNote\(sum\.off\) \} : null,/);
});

test('the page never types the summary into the session', () => {
  const block = RENDERER.slice(RENDERER.indexOf('// --- the where-are-we summary'), RENDERER.indexOf('// --- end of the where-are-we summary ---'));
  assert.ok(block.length > 500, 'the block exists');
  assert.doesNotMatch(block, /\bsend\(|userInput\(|term\.paste|term\.write\(/);
});
