'use strict';
/**
 * renderer.js's dock-zone wiring (layout pass L1, PR #82 review). The rules
 * live in pure, tested modules (app/dock-layout.js, app/dock-zones-display.js);
 * this pins that the page actually USES them where the reviewers found the
 * page going wrong. Source assertions, because renderer.js needs a real DOM;
 * verify/probe-dock-tree.js drives the same paths in a real window (check 6: a
 * real pointer drop; L1's probe-dock-zones.js, which also drove a redraw with a
 * secret half-typed, was deleted with the page it measured).
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
  const at = JS.search(/window\.addEventListener\('pointerup', \(\) => \{\r?\n\s+if \(!press\) return;/);
  assert.ok(at !== -1, 'the tab drag\'s pointerup handler must be findable');
  const handler = JS.slice(at, JS.indexOf('  });', at));
  const end = handler.indexOf('end();');
  const move = handler.indexOf('commitPlacement(');
  assert.ok(end !== -1 && move !== -1 && end < move, 'end() must run before commitPlacement()');
  assert.match(JS, /window\.addEventListener\('pointercancel', \(\) => \{ cancelTabDrag\(\); \}\);/);
  const close = JS.indexOf('ws.onclose = () => {');
  assert.ok(close !== -1 && /cancelTabDrag\(\);/.test(JS.slice(close, close + 400)), 'the socket closing drops a drag in flight');
});

test('Dexter F3 / Miguel I1: only a MISSING tree migrates and saves at load; unreadable keeps the default', () => {
  const body = fnBody('loadLayout');
  assert.match(body, /const what = window\.dockTreeView\.afterTreeGet\(answer, v1Answer\);/);
  // Every save at load sits in one of the two migrate branches, and nothing else saves.
  const sets = [...body.matchAll(/bridge\.set\(/g)];
  assert.strictEqual(sets.length, 2, 'the two migrations, no other save at load');
  for (const s of sets) {
    const before = body.slice(0, s.index);
    assert.match(before.slice(before.lastIndexOf('else if (what ===')), /^else if \(what === 'migrate-(v1|legacy)'\)/, 'a save outside a migrate branch');
  }
  // The L1 key is only ever read: nothing in the renderer writes it any more.
  assert.doesNotMatch(JS, /harness\.layout\.set\(/);
});

test('Dexter F4: the window seeds its own selection ONCE at load, and draws through it', () => {
  assert.match(fnBody('loadLayout'), /const seeded = localStorage\.getItem\('dockSelection2'\) !== null;/);
  assert.match(fnBody('loadLayout'), /if \(!seeded\) saveSelection\(\);/);
  assert.match(fnBody('renderLayout'), /treePlan\(placementLayout\(\), selection, TABS, dockViewport\(\)/);
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

test('D1: #dock changing size without a window resize (the header wrapping) re-fits the boxes', () => {
  // The boxes are absolute, so no flex layout absorbs a header that grows a line: the probe found the
  // bottom group 5 px past the area at launch. The observer feeds the same coalesced resize path.
  assert.match(JS, /new ResizeObserver\(\(\) => window\.dispatchEvent\(new Event\('resize'\)\)\)\.observe\(document\.getElementById\('dock'\)\);/);
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

test('PR #100 Dexter F6 / F3: a divider release is applied to the placement as it is NOW, and a drag that asks for nothing stores nothing', () => {
  const start = JS.search(/window\.addEventListener\('pointerup', \(\) => \{\r?\n\s+if \(!dividerDrag\) return;/);
  assert.ok(start !== -1, 'the divider\'s pointerup handler must be findable');
  const handler = JS.slice(start, JS.indexOf('\n  });', start));
  assert.match(handler, /rebaseDrag\(committedLayout\(\)/, 'rebased onto what is saved now');
  assert.match(handler, /setSplitSizes\(committedLayout\(\)/, 'and applied to it, not to the pointerdown snapshot');
  assert.doesNotMatch(handler, /commitPlacement\(l\)|d\.base/, 'the stale snapshot is never what is committed');
  assert.match(JS, /function committedLayout\(\) \{ return ownLayout \|\| globalLayout; \}/, 'what is saved, without the drawn-only drag layout');
});

test('PR #100 Miguel I2: both drags take pointer capture, and end themselves on a move with no button, a lost capture and a blur', () => {
  assert.strictEqual([...JS.matchAll(/\.setPointerCapture\(e\.pointerId\)/g)].length, 2, 'the tab drag and the divider drag');
  assert.strictEqual([...JS.matchAll(/if \(e\.buttons === 0\) \{ (end|cancelDividerDrag)\(\); return; \}/g)].length, 2);
  assert.match(JS, /window\.addEventListener\('lostpointercapture', \(\) => \{ cancelTabDrag\(\); \}\);/);
  assert.match(JS, /window\.addEventListener\('blur', \(\) => \{ cancelTabDrag\(\); \}\);/);
  assert.match(JS, /window\.addEventListener\('lostpointercapture', cancelDividerDrag\);/);
  assert.match(JS, /window\.addEventListener\('blur', cancelDividerDrag\);/);
  // A cancelled divider drag clears the drawn layout and redraws.
  const at = JS.indexOf('function cancelDividerDrag()');
  assert.ok(at !== -1);
  const body = JS.slice(at, JS.indexOf('\n  }', at));
  assert.match(body, /dragLayout = null;/);
  assert.match(body, /renderLayout\(\);/);
});
