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
  assert.ok(!scripts(STRIP_HTML).includes('summary-display.js'), 'the shell works the hover lines out; the strip only draws them');
  assert.ok(scripts(STRIP_HTML).includes('tab-strip.js'));
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

test('aria-expanded follows the panel closing too (a hidden panel is never left "true")', () => {
  const paint = RENDERER.slice(RENDERER.indexOf('function paintBarNow'), RENDERER.indexOf('function paintBarNow') + 5500);
  assert.match(paint, /\r?\n    barEls\.summary\.setAttribute\('aria-expanded', String\(!!m\.summary\)\);\r?\n/, 'outside the if (m.summary) block, and it means "the card is showing" (Miguel S3)');
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
  assert.match(RENDERER, /summaryDisplay\.openOnSelect\(\{ summary: sum\.summary, lastInputAt: last, now \}\)/, 'a summary opens it; Ollama off alone does not (Miguel I1)');
});

test('a keystroke hides it, from onKey (a focus or mouse report arriving through onData is not typing)', () => {
  assert.match(RENDERER, /term\.onKey\(\(\) => \{ summaryTyped\(\); \}\);/);
  const typed = RENDERER.slice(RENDERER.indexOf('function summaryTyped'), RENDERER.indexOf('function summaryTyped') + 400);
  assert.match(typed, /sum\.lastInputAt = Date\.now\(\)/);
  assert.match(typed, /sum\.typed = true/);
  assert.doesNotMatch(RENDERER.slice(RENDERER.indexOf('term.onData((data) =>'), RENDERER.indexOf('term.onData((data) =>') + 300), /summaryTyped/);
});

test('a click pins it open (and a second click closes it)', () => {
  const click = RENDERER.slice(RENDERER.indexOf("barEls.summary.addEventListener('click'"), RENDERER.indexOf("barEls.summary.addEventListener('click'") + 300);
  assert.match(click, /if \(sum\.pinned\) \{ sum\.pinned = false; sum\.openedAt = null; \} else \{ sum\.pinned = true; \}/);
});

test('the tab status carries the summary (and why it may be out of date) to the strip\'s hover card', () => {
  assert.match(RENDERER, /summary: sum\.summary \? \{ \.\.\.sum\.summary, note: summaryDisplay\.offNote\(sum\.off\) \} : null,/);
});

test('the page never types the summary into the session', () => {
  const block = RENDERER.slice(RENDERER.indexOf('// --- the where-are-we summary'), RENDERER.indexOf('// --- end of the where-are-we summary ---'));
  assert.ok(block.length > 500, 'the block exists');
  assert.doesNotMatch(block, /\bsend\(|userInput\(|term\.paste|term\.write\(/);
});

// Miguel S4 / Dexter F7 / Miguel I1 (PR #105)
// Escape is Claude's interrupt, and the panel opens by itself on a switch: the terminal's Escape is never taken.
test('Escape with the focus on the bar closes the panel and goes no further; with the focus in the terminal the bar handler never runs', () => {
  const src = RENDERER.replace(/\r\n/g, '\n');
  const at = src.indexOf("barEls.bar.addEventListener('keydown', (e) => {");
  const body = src.slice(at, src.indexOf('\n});', at));
  assert.match(body, /if \(bar\.summaryShown\) \{\s*sum\.openedAt = null;\s*sum\.pinned = false;\s*paintBarNow\(\);\s*e\.stopPropagation\(\);/);
  assert.ok(src.slice(0, src.indexOf('// --- end of the where-are-we summary ---')).lastIndexOf("barEls.bar.addEventListener('keydown'") === at, 'one handler, on the bar');
  assert.doesNotMatch(src, /window\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape' \|\| !bar\.summaryShown\)/);
  assert.doesNotMatch(src, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape' \|\| !bar\.summaryShown\)/);
});

test('a keystroke typed into the terminal closes the panel by observing it: summaryTyped never prevents, stops or swallows the key', () => {
  const src = RENDERER.replace(/\r\n/g, '\n');
  const typed = src.slice(src.indexOf('function summaryTyped'), src.indexOf('function summaryTyped') + 400);
  assert.doesNotMatch(typed, /preventDefault|stopPropagation|stopImmediatePropagation|return false/);
  assert.match(src, /term\.onKey\(\(\) => \{ summaryTyped\(\); \}\);/, 'onKey observes; it cannot consume');
  assert.match(typed, /sum\.typed = true/);
  // and the key still takes its normal road to the pty
  const data = src.slice(src.indexOf('term.onData((data) =>'), src.indexOf('term.onData((data) =>') + 400);
  assert.match(data, /userInput\(data\);/);
  assert.doesNotMatch(data, /summaryTyped|preventDefault/);
});

test('a push releases a pin whose summary went away or is another session\'s', () => {
  const apply = RENDERER.slice(RENDERER.indexOf('function applySummary'), RENDERER.indexOf('function applySummary') + 1200);
  assert.match(apply, /Object\.assign\(sum, summaryDisplay\.afterPush\(sum, sum\.summary\)\)/);
  assert.ok(apply.indexOf('afterPush') < apply.indexOf('summaryOpenIfIdle()'), 'before anything can open it');
});

test('with no summary the note goes to the hover card only, in its own status field', () => {
  assert.match(RENDERER, /summaryNote: sum\.summary \? null : summaryDisplay\.offNote\(sum\.off\),/);
});
