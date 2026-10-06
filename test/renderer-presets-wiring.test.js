'use strict';
/**
 * renderer.js's layout-presets wiring (BACKLOG #53, dockable panels D3). The rules live in the pure, tested
 * app/dock-presets.js (its reducer and its answers are tested there as behaviour); this pins only the few decisions
 * a refactor could silently reverse: the page changes the list only by sending main an op, never computes it, asks
 * again for an unreadable list, goes through the reducer, applies through presetLayout, the confirmations are rows
 * rather than dialogs, and Esc backs out of a field before it closes the menu.
 * verify/probe-dock-tree.js measures the same paths in a real window.
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

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('the page loads dock-presets.js before renderer.js, after dock-tree.js', () => {
  const at = (src) => HTML.indexOf(`<script src="./${src}"></script>`);
  assert.ok(at('dock-presets.js') !== -1, 'a script tag for dock-presets.js');
  assert.ok(at('dock-presets.js') > at('dock-tree.js'));
  assert.ok(at('dock-presets.js') < at('renderer.js'));
});

test('the Presets section is drawn by the Window menu, between the panels and the rest', () => {
  const body = fnBody('openLayoutMenu');
  assert.match(body, /appendPresetSection\(check\);/);
  assert.ok(body.indexOf('menuRows') < body.indexOf('appendPresetSection'), 'after the panel rows');
  assert.ok(body.indexOf('appendPresetSection') < body.indexOf('Reset layout'), 'before Reset layout');
});

test('the list changes only by sending main an op, and only while the stored list is usable and no op is in flight', () => {
  assert.strictEqual([...JS.matchAll(/\bpresetBridge\.op\(/g)].length, 1, 'one op call in the renderer');
  assert.doesNotMatch(JS, /presetBridge\.set\(|layoutPresets\.set\(/, 'the page has no whole-list write');
  const body = fnBody('sendPresetOp');
  assert.match(body, /!presetsState\.usable \|\| presetsState\.busy/);
  assert.ok(body.indexOf('presetsState.usable') < body.indexOf('presetBridge.op('), 'the check comes first');
  assert.match(body, /window\.dockPresets\.afterOp\(answer\)/);
});

test('the page never computes the list: it asks main, which owns the fresh read', () => {
  assert.doesNotMatch(JS, /dockPresets\.(savePreset|renamePreset|deletePreset|applyOp)\(/);
});

test('an unreadable list is shown as such and offers no way to save, rename or delete', () => {
  const body = fnBody('appendPresetSection');
  assert.match(body, /!presetsState\.usable/);
  assert.match(body, /refusalText\('unreadable'\)/);
  const unreadable = body.indexOf('refusalText(\'unreadable\')');
  assert.ok(body.indexOf('return;', unreadable) !== -1 && body.indexOf('return;', unreadable) < body.indexOf('Save this layout'), 'returns before the save row');
});

test('the name field and both confirmations are rows in the menu: no prompt() or confirm()', () => {
  for (const name of ['appendPresetSection', 'presetRow', 'presetFieldRow', 'presetAskRow', 'runPresetOp', 'applyPreset', 'loadPresets', 'sendPresetOp', 'retryPresets']) {
    assert.doesNotMatch(fnBody(name), /\b(prompt|confirm|alert)\(/, name);
  }
});

test('every preset control is named by the tested labelFor, and the section\'s state moves only through the reducer', () => {
  assert.match(fnBody('presetRow'), /window\.dockPresets\.labelFor\(/);
  assert.match(fnBody('appendPresetSection'), /window\.dockPresets\.labelFor\(/);
  assert.match(fnBody('dispatchPreset'), /window\.dockPresets\.reduceMenu\(presetUi, event\)/);
  // presetUi is assigned in exactly three places: its declaration, the menu closing, and a redraw keeping it
  assert.strictEqual([...JS.matchAll(/\bpresetUi = /g)].length, 4, 'declaration, closeLayoutMenu, openLayoutMenu x1, dispatchPreset');
});

test('Enter does not commit while an IME composition is active', () => {
  assert.match(fnBody('presetFieldRow'), /e\.key === 'Enter' && !e\.isComposing/);
});

test('an unreadable list is asked for again when the Window button opens the menu', () => {
  assert.match(JS, /\{ openLayoutMenu\(\); retryPresets\(\); \}/);
  assert.match(fnBody('retryPresets'), /window\.dockPresets\.needsRetry\(presetsState\)/);
});

test('applying a preset takes the one placement path, so Just this tab and an identical layout work as they do for any change', () => {
  const body = fnBody('applyPreset');
  assert.match(body, /commitPlacement\(r\.layout, \{ justThisTab \}\);/);
  assert.ok(body.indexOf('presetLayout(') < body.indexOf('commitPlacement('), 'a layout this version can\'t read is judged first');
  assert.match(fnBody('presetThumb'), /presetLayout\(layout, MODULE_IDS, DTm\.readAny\)\.ok/);
});

test('Esc backs out of an open field before it closes the menu', () => {
  assert.match(JS, /backOutOfPresetField\(\) \|\| closeLayoutMenu\(\)/);
  const body = fnBody('backOutOfPresetField');
  assert.match(body, /presetUi\.mode === 'idle'/);
});

test('closing the menu forgets a half-typed field, but a redraw in place keeps it', () => {
  assert.match(fnBody('closeLayoutMenu'), /presetUi = \{ mode: 'idle' \};/);
  const open = fnBody('openLayoutMenu');
  assert.match(open, /const keepField = presetUi;/);
  assert.match(open, /presetUi = keepField;/);
});

test('the list is loaded once the layout is, and a push from another window replaces it', () => {
  const body = fnBody('loadPresets');
  assert.match(body, /harness\.layoutPresets/);
  assert.match(body, /window\.dockPresets\.afterGet\(answer\)/);
  assert.match(body, /bridge\.onChange\(/);
  assert.match(JS, /loadLayout\(\)\.then\([\s\S]*?\n  \}\);\r?\n  loadPresets\(\);/);
});

// --- which preset a question is about (BACKLOG #59, PR #127) ----------------------------------------------------
// The rule is tested as behaviour in dock-presets-identity.test.js; these pin the plumbing that makes it real. Drop
// one `id` below and main sees a request with none, which it refuses as `changed`: every action would say "changed".

test('PR #127 Miguel I1: every preset question is opened with the id of its preset, and every confirm sends it back', () => {
  const row = fnBody('presetRow');
  assert.match(row, /type: 'open', mode: 'rename', name: p\.name, id: presetId\(p\)/);
  assert.match(row, /type: 'open', mode: 'delete', name: p\.name, id: presetId\(p\)/);
  assert.match(row, /runPresetOp\(\{ op: 'rename', name: p\.name, to: text, id: presetUi\.id \}\)/);
  assert.match(row, /runPresetOp\(\{ op: 'delete', name: p\.name, id: presetUi\.id \}\)/);
  assert.match(fnBody('appendPresetSection'), /runPresetOp\(\{ op: 'save', name: presetUi\.name, layout: committedLayout\(\), replace: true, id: presetUi\.id \}\)/);
  // a stored preset with no (usable) id is asked about as null, never as undefined, which would drop off the wire
  assert.match(JS, /const presetId = p => \(typeof p\.id === 'string' \? p\.id : null\);/);
});

test('PR #127 Miguel I1: no rename, delete or replace goes out without an id', () => {
  const sends = [...JS.matchAll(/runPresetOp\(\{[^}]*\}\)/g)].map(m => m[0]);
  const acting = sends.filter(t => /op: 'rename'|op: 'delete'|replace: true/.test(t));
  assert.strictEqual(acting.length, 3, 'rename, delete and replace are the only three');
  for (const t of acting) assert.match(t, /\bid: presetUi\.id\b/, t);
  assert.strictEqual(sends.length, 4, 'and the one plain save');
});

test('PR #127 Dexter F2: a refusal that means the list is out of date reads the list again, after the answer is shown', () => {
  const send = fnBody('sendPresetOp');
  assert.match(send, /!r\.ok && window\.dockPresets\.needsResync\(r\.reason\)\) resyncPresets\(\);/);
  assert.ok(send.indexOf('onAnswer(r)') < send.indexOf('resyncPresets()'), 'the refusal is shown first');
  const body = fnBody('resyncPresets');
  assert.match(body, /bridge\.get\(\)/);
  assert.match(body, /window\.dockPresets\.afterGet\(answer\)/);
  assert.match(body, /if \(!next\.usable\) return;/);
  assert.match(body, /dispatchPreset\(\{ type: 'list', list: presetsState\.list \}\);/);
  assert.match(body, /refreshPresetMenu\(\);/);
});
