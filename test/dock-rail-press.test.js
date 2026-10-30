'use strict';
/**
 * PR #225, Ricardo round 2: ONLY a press in the terminal (or the keyboard going into it) closes an open side panel. A press on the
 * header, the tab strip, the rail's empty strip, another dock panel, Claude's panel or the Preview leaves it open.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../app/dock-tree-display');

// A stand-in element: closest() answers for the selectors it is "inside" of.
const el = (...inside) => ({ closest: (sel) => (sel.split(',').map(s => s.trim()).some(s => inside.includes(s)) ? {} : null) });

test('a press or focus whose target is inside the terminal closes the panel', () => {
  assert.strictEqual(V.inTerminal(el('#termwrap')), true);
});

test('a press or focus anywhere else leaves it open: header, tab strip, rail strip, another panel, a rail icon, the popover', () => {
  for (const where of ['#tb', '.tab-strip', '.drail', '.dgroup', '.dpeek', 'body']) assert.strictEqual(V.inTerminal(el(where)), false, where);
});

test('junk targets are not the terminal', () => {
  for (const t of [null, undefined, {}, 7, 'x', { closest: 5 }]) assert.strictEqual(V.inTerminal(t), false, String(t));
});

// Miguel B1/I1/I3: the app's own term.focus() (a click on another group's tab, typeCommand, a window regaining focus) must not close
// the panel. Only the keyboard going INTO the terminal FROM the popover or its rail does.
test('focus closes the panel only when it moves into the terminal from the popover or the rail', () => {
  assert.strictEqual(V.focusClosesPeek(el('#termwrap'), el('.dpeek')), true);
  assert.strictEqual(V.focusClosesPeek(el('#termwrap'), el('.drail')), true);
});

test('focus into the terminal from anywhere else leaves it open: the app\'s own term.focus() from another tab, a window refocus (null), junk', () => {
  for (const from of [el('.dgroup'), el('.zone-tabs'), el('#tb'), el('body'), null, undefined, {}, 7]) assert.strictEqual(V.focusClosesPeek(el('#termwrap'), from), false, String(from));
});

test('focus landing outside the terminal never closes it, even from the popover', () => {
  for (const to of [el('.dpeek'), el('#tb'), el('.dgroup'), null, {}]) assert.strictEqual(V.focusClosesPeek(to, el('.dpeek')), false, String(to));
});
