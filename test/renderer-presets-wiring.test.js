'use strict';
/**
 * renderer.js's layout-presets wiring (BACKLOG #53, dockable panels D3). The rules live in the pure, tested
 * app/dock-presets.js; this pins that the page uses them where a mistake would cost the user's presets: every
 * write goes through one function that refuses while the stored list couldn't be read, the confirmations are
 * rows in the menu rather than dialogs, and Esc backs out of a field before it closes the menu.
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
  for (const name of ['appendPresetSection', 'presetRow', 'runPresetOp', 'applyPreset', 'loadPresets', 'sendPresetOp']) {
    assert.doesNotMatch(fnBody(name), /\b(prompt|confirm|alert)\(/, name);
  }
  assert.match(JS, /Delete '\$\{p\.name\}'\?/);
  assert.match(JS, /Replace '\$\{presetUi\.name\}'\?/);
});

test('rename and delete are real buttons with an accessible name', () => {
  const body = fnBody('presetRow');
  assert.match(body, /'aria-label': `Rename \$\{p\.name\}`/);
  assert.match(body, /'aria-label': `Delete \$\{p\.name\}`/);
  assert.match(body, /node\('button', \{\s*type: 'button'/);
});

test('applying a preset takes the one placement path, so Just this tab and an identical layout work as they do for any change', () => {
  assert.match(fnBody('applyPreset'), /commitPlacement\(p\.layout, \{ justThisTab \}\);/);
});

test('Esc backs out of an open field before it closes the menu', () => {
  assert.match(JS, /e\.key === 'Escape' && \(backOutOfPresetField\(\) \|\| closeLayoutMenu\(\)\)/);
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
