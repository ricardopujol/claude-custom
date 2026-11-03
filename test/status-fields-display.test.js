'use strict';
/**
 * BACKLOG #27: app/status-fields-display.js -- the tab header's copy of the
 * CLI status row, in warpaint's formats (warpaint\src\statusline.js), so moving
 * the row changes where it is, not what it says.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { statusFieldsText } = require('../app/status-fields-display');

const fields = (o) => ({ costUsd: null, durationMs: null, linesAdded: null, linesRemoved: null, over200k: null, ...o });

test('null or not an object -> nothing (unknown draws nothing, never "$0")', () => {
  assert.deepStrictEqual(statusFieldsText(null), []);
  assert.deepStrictEqual(statusFieldsText(undefined), []);
  assert.deepStrictEqual(statusFieldsText('x'), []);
  assert.deepStrictEqual(statusFieldsText(fields({})), []);
});

// Chrome grammar (Ricardo, 2026-10-26): on Max there is no extra spend, so the header never shows a dollar figure.
test('lines, duration, ctx>200k in that order, and no cost', () => {
  assert.deepStrictEqual(
    statusFieldsText(fields({ costUsd: 1.234, durationMs: 3_900_000, linesAdded: 10, linesRemoved: 2, over200k: true })),
    ['+10/-2', '1h05', 'ctx>200k']);
});

test('a cost alone says nothing; under a minute and zero lines are hidden', () => {
  assert.deepStrictEqual(statusFieldsText(fields({ costUsd: 0.004 })), []);
  assert.deepStrictEqual(
    statusFieldsText(fields({ costUsd: 3, durationMs: 59_000, linesAdded: 0, linesRemoved: 0, over200k: false })),
    []);
});

test('property: no segment ever carries a dollar sign', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), fc.anything(), (c, d, a) => {
    for (const s of statusFieldsText({ costUsd: c, durationMs: d, linesAdded: a, linesRemoved: a, over200k: true })) assert.ok(!s.includes('$'), s);
  }));
});

test('one side of the lines, minutes', () => {
  assert.deepStrictEqual(statusFieldsText(fields({ costUsd: 0, durationMs: 600_000, linesRemoved: 5 })), ['-5', '10m']);
  assert.deepStrictEqual(statusFieldsText(fields({ linesAdded: 7 })), ['+7']);
});

test('property: no segment is ever a zero ("$0", "$0.00", "0m", "+0", "-0")', () => {
  const v = fc.oneof(fc.constant(null), fc.constant(0), fc.double({ min: 0, max: 1e7, noNaN: true }), fc.nat());
  fc.assert(fc.property(v, v, v, v, fc.oneof(fc.constant(null), fc.boolean()), (c, d, a, r, o) => {
    const out = statusFieldsText({ costUsd: c, durationMs: d, linesAdded: a, linesRemoved: r, over200k: o });
    for (const s of out) assert.ok(!/^\$0(\.00)?$|^0m$|(^|\/)[+-]0$/.test(s), s);
  }));
});

test('property: junk never throws and never yields an empty or non-string segment', () => {
  const junk = fc.anything();
  fc.assert(fc.property(junk, junk, junk, junk, junk, (c, d, a, r, o) => {
    const out = statusFieldsText({ costUsd: c, durationMs: d, linesAdded: a, linesRemoved: r, over200k: o });
    assert.ok(Array.isArray(out));
    for (const s of out) assert.ok(typeof s === 'string' && s.length > 0);
  }));
});

// --- Miguel L2 G1: the show/hide rule, as behaviour (not a source regex) -------

const { statusFieldsView } = require('../app/status-fields-display');
const SOME = { costUsd: 1.5, durationMs: 600_000, linesAdded: null, linesRemoved: null, over200k: null };

test('shown only when the setting is exactly true AND there is something to say', () => {
  assert.deepStrictEqual(statusFieldsView(SOME, true), { chips: [{ key: 'time', icon: 'clock', text: '10m' }], shown: true });
  assert.deepStrictEqual(statusFieldsView(SOME, false), { chips: [{ key: 'time', icon: 'clock', text: '10m' }], shown: false });
  assert.deepStrictEqual(statusFieldsView(SOME, null), { chips: [{ key: 'time', icon: 'clock', text: '10m' }], shown: false }, 'unknown setting: the CLI row may still be showing');
  assert.deepStrictEqual(statusFieldsView(null, true), { chips: [], shown: false }, 'unknown fields draw nothing');
  assert.deepStrictEqual(statusFieldsView({ ...SOME, durationMs: 0 }, true), { chips: [], shown: false });
});

test('property: shown implies the setting is true and there are chips', () => {
  const v = fc.oneof(fc.constant(null), fc.constant(0), fc.double({ min: 0, max: 1e7, noNaN: true }));
  fc.assert(fc.property(v, v, fc.anything(), (c, d, setting) => {
    const out = statusFieldsView({ costUsd: c, durationMs: d, linesAdded: null, linesRemoved: null, over200k: null }, setting);
    if (out.shown) assert.ok(setting === true && out.chips.length > 0);
    else assert.ok(setting !== true || out.chips.length === 0);
  }));
});

test('chips: one per segment, each with an icon name and its text', () => {
  const { statusFieldsChips } = require('../app/status-fields-display');
  assert.deepStrictEqual(
    statusFieldsChips(fields({ costUsd: 9, durationMs: 3_900_000, linesAdded: 10, linesRemoved: 2, over200k: true })),
    [{ key: 'lines', icon: 'diff', text: '+10/-2' }, { key: 'time', icon: 'clock', text: '1h05' }, { key: 'ctx', icon: 'gauge', text: 'ctx>200k' }]);
  assert.deepStrictEqual(statusFieldsChips(null), []);
});

test('chip icons: every icon status-fields-display names has markup, and an unknown name draws nothing', () => {
  const icons = require('../app/chip-icons');
  const all = require('../app/status-fields-display').statusFieldsChips({ linesAdded: 1, durationMs: 120000, over200k: true });
  assert.strictEqual(all.length, 3);
  for (const c of all) assert.ok(icons.svgFor(c.icon).startsWith('<svg class="chip-icon"'), c.icon);
  assert.strictEqual(icons.svgFor('nope'), '');
  assert.strictEqual(icons.svgFor('__proto__'), '');
});
