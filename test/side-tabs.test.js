'use strict';
/**
 * Which side panel is showing.
 *
 * A tab, not a keyboard shortcut: the sidebar is a place you can SEE, with
 * named tabs you click. Clicking the tab you are already on collapses the
 * sidebar, which is how "it can be hidden" works without a second control.
 */
const test = require('node:test');
const assert = require('node:assert');

const { nextTab, TABS, DEFAULT_TAB } = require('../app/side-tabs');

test('clicking another tab switches to it', () => {
  assert.strictEqual(nextTab('agents', 'vault'), 'vault');
  assert.strictEqual(nextTab('vault', 'agents'), 'agents');
});

test('clicking the tab you are on hides the sidebar', () => {
  // The collapse affordance IS the active tab. A separate close button in a
  // panel this small costs more room than it saves.
  assert.strictEqual(nextTab('vault', 'vault'), null);
  assert.strictEqual(nextTab('agents', 'agents'), null);
});

test('clicking a tab while hidden opens that tab', () => {
  assert.strictEqual(nextTab(null, 'vault'), 'vault');
  assert.strictEqual(nextTab(null, 'agents'), 'agents');
});

test('an unknown tab is ignored rather than blanking the sidebar', () => {
  // A typo in a data-tab attribute should not make the sidebar vanish.
  assert.strictEqual(nextTab('agents', 'nonsense'), 'agents');
  assert.strictEqual(nextTab(null, 'nonsense'), null);
});

test('agents is the default, because it is the one that changes on its own', () => {
  // The roster reacts to the session; the vault only reacts to you. Opening on
  // the reactive one means the sidebar is useful without being touched.
  assert.strictEqual(DEFAULT_TAB, 'agents');
});

test('every tab has a label for the tab strip', () => {
  for (const tab of TABS) {
    assert.ok(tab.id && tab.label, JSON.stringify(tab));
  }
});

test('the tab ids are exactly the ones nextTab accepts', () => {
  for (const tab of TABS) {
    assert.strictEqual(nextTab(null, tab.id), tab.id, tab.id);
  }
});

// --- the escape hatch from a collapsed sidebar ---------------------------------

const { isPanelToggle } = require('../host/../app/side-tabs');

test('Ctrl+B is recognised as the panel toggle', () => {
  // It was not, in practice. `attachCustomKeyEventHandler` returned true for
  // it, so xterm sent \x02 to the pty -- readline's backward-char -- and the
  // document-level listener never saw the event because the terminal always
  // has focus. Combined with a collapsed sidebar hiding its own tab bar, the
  // panel became unreachable: no tabs to click, and the keybinding typed into
  // the shell instead.
  assert.strictEqual(isPanelToggle({ type: 'keydown', ctrlKey: true, code: 'KeyB' }), true);
});

test('the toggle does not fire on the modifier combinations that mean other things', () => {
  assert.strictEqual(isPanelToggle({ type: 'keydown', ctrlKey: true, shiftKey: true, code: 'KeyB' }), false);
  assert.strictEqual(isPanelToggle({ type: 'keydown', ctrlKey: true, altKey: true, code: 'KeyB' }), false);
  assert.strictEqual(isPanelToggle({ type: 'keydown', code: 'KeyB' }), false, 'plain b must reach the terminal');
  assert.strictEqual(isPanelToggle({ type: 'keyup', ctrlKey: true, code: 'KeyB' }), false);
  assert.strictEqual(isPanelToggle({ type: 'keydown', ctrlKey: true, code: 'KeyC' }), false);
});

test('a null event is not a toggle', () => {
  assert.strictEqual(isPanelToggle(null), false);
  assert.strictEqual(isPanelToggle(undefined), false);
});

test('every module in TABS has a panel in the real markup, and vice versa', () => {
  // Layout pass L1: the tab buttons are built FROM TABS now (one per module in
  // each group, app/dock-tree-display.js), so the old drift -- a button with no
  // tab, a tab with no button -- can no longer happen in the markup. The drift
  // that still can: a module in TABS with no `.panel` (its tab opens a blank
  // zone), or a panel no module names (unreachable, like 'projects' once was:
  // added to TABS with no way in, the full suite green).
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const inMarkup = [...html.matchAll(/class="panel" data-panel="([^"]+)"/g)].map(m => m[1]);
  assert.ok(inMarkup.length > 0, 'the panels must be findable for this check to mean anything');
  // As SETS: the markup's order is irrelevant now (zones order their tabs by
  // the layout), and the panels never were in TABS order (Models before Map).
  assert.deepStrictEqual([...inMarkup].sort(), TABS.map(t => t.id).sort(),
    'app/renderer.html\'s panels and side-tabs.js TABS have drifted apart');
});
