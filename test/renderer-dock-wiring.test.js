'use strict';
/**
 * renderer.js's dock-zone wiring (layout pass L1, PR #82 review). The rules
 * live in pure, tested modules (app/dock-layout.js, app/dock-zones-display.js);
 * this pins that the page actually USES them where the reviewers found the
 * page going wrong. Source assertions, because renderer.js needs a real DOM;
 * verify/probe-dock-zones.js drives the same paths in a real window
 * (check 8: a real drop, and a redraw with a secret half-typed).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const JS = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8'));

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('Dexter F2 / Miguel B1: a redraw moves focus only as renderEffects says -- never unconditionally', () => {
  // renderLayout called term.focus() on every redraw with the vault showing: a
  // resize mid-secret typed the rest of the secret into the session.
  const body = fnBody('renderLayout');
  assert.match(body, /const fx = window\.dockZones\.renderEffects\(shownModules, now, \{ userAction \}\);/);
  const focusCalls = [...body.matchAll(/term\.focus\(\)/g)];
  assert.strictEqual(focusCalls.length, 1, 'exactly one, and it is gated');
  assert.match(body, /if \(fx\.focus === 'term'\) term\.focus\(\);/);
  // Passive redraws pass no userAction: the resize listener and a pushed layout.
  assert.doesNotMatch(fnBody('applyLayoutOverride'), /userAction/);
});

test('Dexter F1 / Miguel I2: a drop ends the drag BEFORE the move redraws away its source', () => {
  const at = JS.indexOf("s.addEventListener('drop', (e) => {");
  assert.ok(at !== -1, 'the strip drop handler must be findable');
  const handler = JS.slice(at, JS.indexOf('\n  });', at));
  const end = handler.indexOf('endModuleDrag();');
  const move = handler.indexOf('commitPlacement(');
  assert.ok(end !== -1 && move !== -1 && end < move, 'endModuleDrag() must run before commitPlacement()');
  assert.match(JS, /window\.addEventListener\('dragend', endModuleDrag, true\);/);
});

test('Dexter F3 / Miguel I1: only afterLayoutGet\'s "migrate" saves over the stored layout at load', () => {
  const body = fnBody('loadLayout');
  assert.match(body, /const what = window\.dockZones\.afterLayoutGet\(answer\);/);
  assert.match(body, /if \(what === 'migrate'\) bridge\.set\(globalLayout\)/);
  assert.strictEqual([...body.matchAll(/bridge\.set\(/g)].length, 1, 'no other save at load');
});

test('Dexter F4: the window seeds its own selection at load, and draws through mergeSelection', () => {
  assert.match(fnBody('loadLayout'), /if \(!selection\) \{\s+selection = DL\.selectionOf\(effectiveLayout\(\)\);\s+saveSelection\(\);/);
  assert.match(fnBody('effectiveLayout'), /DL\.mergeSelection\(placementLayout\(\), selection, MODULE_IDS\)/);
});

test('Dexter F8: a tab\'s own layout goes through sendOverride, and the host\'s word through overrideOnHello', () => {
  assert.match(fnBody('applyLayoutOverride'), /window\.dockZones\.overrideOnHello\(pendingOverride, incoming\)/);
  assert.match(fnBody('sendOverride'), /pendingOverride = \{ layout \};/);
  const direct = [...JS.matchAll(/type: 'layout-override'/g)].length;
  assert.strictEqual(direct, 2, 'sent from sendOverride and the resend in applyLayoutOverride only');
});

test('Dexter F6: opening the diagnostics pane re-fits the zones', () => {
  const at = JS.indexOf("document.getElementById('diag').classList.toggle('show');");
  assert.ok(at !== -1);
  assert.match(JS.slice(at, at + 400), /renderLayout\(\);/);
});

test('entering focus mode gives the terminal the keyboard, never an invisible panel field', () => {
  // Found by verify/probe-dock-zones.js: focus left in #vault-secret stayed in a
  // hidden input -- typing went into it and Ctrl+B never reached the terminal.
  assert.match(fnBody('applyFocusMode'), /if \(on\) term\.focus\(\);/);
});

test('#36: the socket opening focuses the terminal only as focusOnOpen says -- never unconditionally', () => {
  // ws.onopen runs on every reattach: an unconditional term.focus() there sent
  // the rest of a half-typed vault secret into the session.
  const at = JS.indexOf('ws.onopen = () => {');
  assert.ok(at !== -1, 'ws.onopen must be findable');
  const handler = JS.slice(at, JS.indexOf('\n  };', at));
  const focusCalls = [...handler.matchAll(/term\.focus\(\)/g)];
  assert.match(handler, /sendResize\(\);/, 'the slice reaches past the focus line');
  assert.match(handler, /const first = !socketOpened;\s+socketOpened = true;/, '"first" is a flag, not read from focus');
  assert.strictEqual(focusCalls.length, 1, 'exactly one, and it is gated');
  assert.match(handler, /if \(window\.dockZones\.focusOnOpen\(first, window\.dockZones\.describeFocus\(document\.activeElement, term\.element\)\)\) term\.focus\(\);/);
});
