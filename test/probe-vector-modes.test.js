'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DIALOG_VECTORS, KNOWN_GAPS, vectorsFor } = require('../verify/probe71/vector-modes');

const ALL = ['fetch-approved (control)', 'dialog-loop', 'print-loop', 'file-picker-with-click', 'color-picker-with-click', 'send-with-click'];

const DEFAULT = ALL.filter((n) => n !== 'print-loop');       // the known gap is out of the default run

test('SEALED runs every vector but the known gaps, dialogs included', () => {
  assert.deepStrictEqual(vectorsFor('sealed', ALL), DEFAULT);
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
  assert.deepStrictEqual(watched, DEFAULT.filter((n) => n !== 'dialog-loop'));
});

test('the PROBE_ONLY filter narrows what the mode lets through, it never widens it', () => {
  assert.deepStrictEqual(vectorsFor('naive', ALL, { watched: false, only: 'dialog-loop|send-with-click' }), ['send-with-click']);
  assert.deepStrictEqual(vectorsFor('sealed', ALL, { only: 'dialog-loop' }), ['dialog-loop']);
});

test('a KNOWN GAP vector (print-loop wedges the panel renderer and the process cannot exit) runs only when asked for by name or by the gaps switch', () => {
  assert.ok(KNOWN_GAPS.has('print-loop'));
  assert.ok(!vectorsFor('sealed', ALL).includes('print-loop'), 'not in the default run');
  assert.ok(!vectorsFor('naive', ALL, { watched: true }).includes('print-loop'));
  assert.ok(vectorsFor('sealed', ALL, { only: 'print-loop' }).includes('print-loop'), 'named in PROBE_ONLY');
  assert.ok(vectorsFor('sealed', ALL, { gaps: true }).includes('print-loop'), 'PROBE_KNOWN_GAPS=1');
  assert.ok(vectorsFor('naive', ALL, { watched: true, gaps: true }).includes('print-loop'));
});
