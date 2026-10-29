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
