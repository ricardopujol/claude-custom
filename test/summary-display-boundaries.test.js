'use strict';
/**
 * Boundary kill tests for app/summary-display.js, from Mortimer's gate on release PR #109 (survivor 16): the panel that
 * opens on a tab switch is shown from the very moment it opened until strictly less than SHOW_MS later.
 */
const test = require('node:test');
const assert = require('node:assert');

const D = require('../app/summary-display');

const NOW = 10_000_000;
const SUMMARY = { text: 'Working on: the drawer', model: 'llama3.2:3b', at: NOW - 60_000, stale: false };
const panel = (openedAt, now) => D.panelModel({ summary: SUMMARY, off: null, now, openedAt, pinned: false, typed: false });

test('the opened panel is shown at the very moment it opened, and not before', () => {
  assert.notStrictEqual(panel(NOW, NOW), null, 'now === openedAt');
  assert.strictEqual(panel(NOW + 1, NOW), null, 'a clock behind the open time is not "shown"');
});

test('the opened panel is shown until SHOW_MS has passed: the last ms inside is shown, SHOW_MS exactly is not', () => {
  assert.notStrictEqual(panel(NOW - D.SHOW_MS + 1, NOW), null);
  assert.strictEqual(panel(NOW - D.SHOW_MS, NOW), null);
});
