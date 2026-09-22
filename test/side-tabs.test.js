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

test('every tab in TABS has a button in the real markup, and vice versa', () => {
  // FOUND BY RENDERING, not by the suite. The tab strip in app/renderer.html is
  // hardcoded HTML that duplicates TABS, and nothing checked the two against
  // each other -- so adding 'projects' to TABS added a panel that was REACHABLE
  // ONLY by CLAUDE_CUSTOM_SIDE_TAB. The full suite was green and the feature
  // had no way in.
  //
  // The mirror of test/renderer-scope.test.js's lesson: that one checks what
  // leaks OUT of a module, this checks that what the markup offers and what the
  // data declares are the same set. Drift in either direction is a bug --
  // a button with no tab blanks the sidebar, a tab with no button is unreachable.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const nav = html.slice(html.indexOf('<nav id="side-tabs">'), html.indexOf('</nav>'));
  assert.ok(nav.length > 20, 'the tab strip must be findable for this check to mean anything');

  const inMarkup = [...nav.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  const declared = TABS.map(t => t.id);
  assert.deepStrictEqual(inMarkup, declared,
    'app/renderer.html\'s tab strip and side-tabs.js TABS have drifted apart');
});
