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
