'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DIALOG_VECTORS, vectorsFor } = require('../verify/probe71/vector-modes');

const ALL = ['fetch-approved (control)', 'dialog-loop', 'print-loop', 'file-picker-with-click', 'color-picker-with-click', 'send-with-click'];

test('SEALED runs every vector, dialogs included', () => {
  assert.deepStrictEqual(vectorsFor('sealed', ALL), ALL);
});

test('NAIVE never runs dialog-loop: a message box nothing in the probe can close (PR #122 Dexter R2-2)', () => {
  assert.ok(!vectorsFor('naive', ALL, { watched: true }).includes('dialog-loop'));
  assert.ok(!vectorsFor('naive', ALL, { watched: false }).includes('dialog-loop'));
});

test('NAIVE runs the other dialog vectors only as a watched control, one the watcher cancels by handle', () => {
  const unwatched = vectorsFor('naive', ALL, { watched: false });
  for (const n of DIALOG_VECTORS) assert.ok(!unwatched.includes(n), `${n} must not run naive without a watcher`);
  assert.ok(unwatched.includes('send-with-click') && unwatched.includes('fetch-approved (control)'), 'the non-dialog vectors still run');
  const watched = vectorsFor('naive', ALL, { watched: true });
  assert.deepStrictEqual(watched, ALL.filter((n) => n !== 'dialog-loop' && n !== 'print-loop'));
});

test('the PROBE_ONLY filter narrows what the mode lets through, it never widens it', () => {
  assert.deepStrictEqual(vectorsFor('naive', ALL, { watched: false, only: 'dialog-loop|send-with-click' }), ['send-with-click']);
  assert.deepStrictEqual(vectorsFor('sealed', ALL, { only: 'dialog-loop' }), ['dialog-loop']);
});

test('print-loop and spin-loop wedge a panel and have no naive control: sealed only', () => {
  const all = [...ALL, 'spin-loop'];
  for (const watched of [true, false]) {
    const naive = vectorsFor('naive', all, { watched });
    assert.ok(!naive.includes('print-loop') && !naive.includes('spin-loop'));
  }
  assert.ok(vectorsFor('sealed', all).includes('print-loop') && vectorsFor('sealed', all).includes('spin-loop'));
});
