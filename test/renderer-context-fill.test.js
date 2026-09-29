'use strict';
/**
 * BACKLOG #6's wiring in app/renderer.js and app/renderer.html. The decisions
 * are pure and tested in test/context-fill-display.test.js; these pin that the
 * browser script USES them. Source assertions in the style of
 * test/renderer-top-bar.test.js -- renderer.js cannot be required.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');


// Loaded the way the renderer loads it (a plain script in a fresh global scope),
// not require()d: this file repo-scans, so it stays out of Stryker's command.
const vm = require('vm');
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'context-fill-display.js'), 'utf8'), sandbox);
const STEP_CLASSES = [...sandbox.CONTEXT_STEP_CLASSES];
const UNKNOWN_CLASS = sandbox.CONTEXT_UNKNOWN_CLASS;
// One fill per step (fractions .1 .3 .5 .7 .9), read back through the module.
const PALETTE = [0, 1, 2, 3, 4].map(i => sandbox.contextFill({ used: i + 0.5, size: 5 }).colour);

const JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

function branch(type) {
  const start = JS.indexOf(`if (msg.type === '${type}')`);
  assert.ok(start !== -1, `renderer.js must handle ${type}`);
  const next = JS.indexOf('if (msg.type ===', start + 10);
  return JS.slice(start, next === -1 ? undefined : next);
}

test('the circle sits in the top bar beside the model chip', () => {
  const bar = HTML.slice(HTML.indexOf('<span id="top-bar">'), HTML.indexOf('</span>', HTML.indexOf('<span id="top-bar">') + 20));
  assert.match(bar, /id="tb-context"/);
  assert.ok(bar.indexOf('id="tb-model"') < bar.indexOf('id="tb-context"'));
  assert.match(bar, /id="tb-context"[^>]*title="context: unknown"/, 'markup starts as unknown, not as a colour');
});

test('renderer.html loads the module before renderer.js', () => {
  const a = HTML.indexOf('<script src="./context-fill-display.js"></script>');
  const b = HTML.indexOf('<script src="./renderer.js"></script>');
  assert.ok(a !== -1 && b !== -1 && a < b);
});

test('the CSS has one class per step and its own unknown class, and no colour is hardcoded in renderer.js', () => {
  for (const c of [...STEP_CLASSES, UNKNOWN_CLASS]) assert.ok(HTML.includes(`.${c}`), `${c} must be styled`);
  assert.match(HTML, new RegExp(`\\.${UNKNOWN_CLASS}[^{]*\\{[^}]*dashed`), 'unknown is a dashed/hollow circle');
  for (const colour of PALETTE) assert.ok(!JS.includes(colour), `renderer.js must not hardcode ${colour}`);
  assert.ok(!/\b200000\b|\b1000000\b|200_000/.test(JS.replace(/\/\/.*$/gm, '')), 'no window size in renderer.js');
});

test('renderer.js renders through applyContextFill, and a live "context" message repaints', () => {
  assert.match(fnBody('renderContextFill'), /applyContextFill\(tbContextEl, ctx\)/);
  assert.match(branch('context'), /renderContextFill\(/);
});

test('hello sets the context from the handshake; a doc without one is unknown', () => {
  const hello = branch('hello');
  assert.match(hello, /msg\.context/);
  assert.match(hello, /renderContextFill\(/);
});

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('renderContextFill hands the element and the host value to applyContextFill (behaviour is tested on a fake element)', () => {
  assert.match(fnBody('renderContextFill'), /applyContextFill\(tbContextEl, ctx\)/);
});

test('the circle has an accessible name from the start: role="img" and an aria-label', () => {
  assert.match(HTML, /id="tb-context"[^>]*role="img"[^>]*aria-label="context: unknown"/);
});

test('each step class paints exactly its PALETTE colour (CSS and module cannot drift apart)', () => {
  STEP_CLASSES.forEach((c, i) => {
    const m = HTML.match(new RegExp(String.raw`\.${c}\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6})`));
    assert.ok(m, `.${c} must set a background`);
    assert.strictEqual(m[1].toLowerCase(), PALETTE[i]);
  });
  const unknown = HTML.match(new RegExp(String.raw`\.${UNKNOWN_CLASS}\s*\{[^}]*\}`))[0];
  for (const colour of PALETTE) assert.ok(!unknown.includes(colour), 'unknown is never one of the five colours');
});
