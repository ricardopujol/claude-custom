'use strict';
/**
 * The window's and host's halves of the first-run checks (host/first-run.js). renderer.js needs a real DOM, so the painting
 * function is cut out of the source and run against a small fake; the rest is source assertions in the style of
 * test/renderer-canvas-wiring.test.js. Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const RENDERER = read('app', 'renderer.js');
const HTML = read('app', 'renderer.html');
const HOST = read('host', 'host.js');

function fakeDom() {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: false, textContent: '', innerHTML: '', listeners: {},
    addEventListener(t, f) { this.listeners[t] = f; } });
  return { els, document: { getElementById: el } };
}

function load() {
  const a = RENDERER.indexOf('let dismissedFirstRun');
  const b = RENDERER.indexOf('renderFirstRun(null);', a);
  assert.ok(a !== -1 && b > a, 'renderer.js must define renderFirstRun before calling it');
  const dom = fakeDom();
  const ctx = vm.createContext({
    document: dom.document,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  });
  vm.runInContext(RENDERER.slice(a, b) + '\nthis.renderFirstRun = renderFirstRun;', ctx);
  return { dom, render: ctx.renderFirstRun };
}

test('a failing required check shows ONE banner line and every row in Diagnostics', () => {
  const { dom, render } = load();
  render({ done: true, banner: 'Hooks are off: run `npm run build:helper`', checks: [
    { id: 'claude', label: 'Claude Code CLI', status: 'ok', detail: '2.1.304' },
    { id: 'helper', label: 'Hook helper', status: 'fail', detail: 'not found at <x>' },
  ] });
  assert.equal(dom.els['first-run-banner'].hidden, false);
  assert.equal(dom.els['first-run-banner-text'].textContent, 'Hooks are off: run `npm run build:helper`');
  const html = dom.els['first-run'].innerHTML;
  assert.match(html, /Claude Code CLI/);
  assert.match(html, /class="fail"/);
  assert.ok(!html.includes('<x>'), 'a detail is escaped, never injected');
});

test('no banner when nothing required fails, and none from an older host', () => {
  const { dom, render } = load();
  render({ done: true, banner: null, checks: [{ id: 'claude', label: 'C', status: 'ok', detail: '2.1.304' }] });
  assert.equal(dom.els['first-run-banner'].hidden, true);
  render(undefined);
  assert.equal(dom.els['first-run-banner'].hidden, true);
  assert.match(dom.els['first-run'].innerHTML, /not available from this host/);
});

test('before the host has finished, Diagnostics says it is running, not that all is well', () => {
  const { dom, render } = load();
  render({ done: false, banner: null, checks: [] });
  assert.match(dom.els['first-run'].innerHTML, /running/);
  assert.ok(!dom.els['first-run'].innerHTML.includes('✓'));
});

test('dismissing hides this line only; a different failure shows again', () => {
  const { dom, render } = load();
  render({ done: true, banner: 'A', checks: [{ id: 'x', label: 'X', status: 'fail', detail: '' }] });
  dom.els['first-run-banner-dismiss'].listeners.click();
  assert.equal(dom.els['first-run-banner'].hidden, true);
  render({ done: true, banner: 'A', checks: [{ id: 'x', label: 'X', status: 'fail', detail: '' }] });
  assert.equal(dom.els['first-run-banner'].hidden, true);
  render({ done: true, banner: 'B', checks: [{ id: 'x', label: 'X', status: 'fail', detail: '' }] });
  assert.equal(dom.els['first-run-banner'].hidden, false);
});

test('the window paints the hello handshake and a first-run frame', () => {
  assert.match(RENDERER, /renderFirstRun\(msg\.firstRun\);\s*\n\s*renderCooldowns/);
  assert.match(RENDERER, /msg\.type === 'first-run'\)\s*\{\s*renderFirstRun\(msg\.firstRun\);\s*return;/);
});

test('the page has the banner (not a modal) and the Diagnostics list', () => {
  assert.match(HTML, /<div id="first-run-banner" role="status" hidden>/);
  assert.match(HTML, /<aside id="diag">[\s\S]*<div id="first-run"><\/div>[\s\S]*<div id="checks"><\/div>/);
  assert.ok(!/first-run[^"]*"\s+role="dialog"/.test(HTML));
});

test('the host runs the checks at listen, skips a side session, and sends them in the handshake and as a frame', () => {
  assert.match(HOST, /const firstRun = require\('\.\/first-run'\);/);
  assert.match(HOST, /function startFirstRun\(\) \{\s*if \(SIDE\) \{/);
  assert.match(HOST, /boundPort = PORT;\s*startFirstRun\(\);/);
  assert.match(HOST, /firstRun: firstRunState,/);
  assert.match(HOST, /broadcastControl\(\{ type: 'first-run', firstRun: firstRunState \}\)/);
});

test('a side session reads as "not run in a side session", never as running', () => {
  const { dom, render } = load();
  render({ done: true, skipped: true, banner: null, checks: [] });
  assert.match(dom.els['first-run'].innerHTML, /not run in a side session/);
  assert.ok(!/running/.test(dom.els['first-run'].innerHTML));
});

test('the banner sits in the terminal-banner slot at the TOP, never at the foot over the prompt, and clears #terminal-banner when both show', () => {
  const css = HTML.slice(HTML.indexOf('#first-run-banner {'), HTML.indexOf('#first-run-banner-text'));
  assert.match(css, /top: 6px;/);
  assert.ok(!/bottom:/.test(css));
  assert.match(HTML, /body\.bar-open #first-run-banner \{ top: 46px; \}/);
  assert.match(HTML, /#terminal-banner:not\(\[hidden\]\) ~ #first-run-banner \{ top: 50px; \}/);
  assert.ok(HTML.indexOf('id="terminal-banner"') < HTML.indexOf('id="first-run-banner"'), 'it follows #terminal-banner, which the sibling rule needs');
});
