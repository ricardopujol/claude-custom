'use strict';
/**
 * Kill tests for app/resources-history-display.js (BACKLOG #70, Mortimer's release-#117 survivor 7, display half): points
 * that sit EXACTLY on the one-hour window's edges, an exact SVG path and marker for known points, and ties in the readout
 * and the description. The loose assertions in resources-history-display.test.js let `>=`/`>` flips and the y formula through.
 */
const test = require('node:test');
const assert = require('node:assert');

const D = require('../app/resources-history-display');

const HOUR = 60 * 60 * 1000;
const STEP = 10000;
const NOW = 100 * 60 * 1000;
const pt = (at, over = {}) => ({ at, cpu: 40, cpuOurs: 10, memUsed: 500, memOurs: 100, memTotal: 1000, ...over });
const SVG = body => `<svg class="hs" width="56" height="14" viewBox="0 0 56 14" aria-hidden="true">${body}</svg>`;

test('kills: the sparkline window holds a point exactly an hour old and one exactly a step ahead, and nothing past either', () => {
  assert.strictEqual(D.sparkline([pt(NOW - HOUR, { cpu: 50 })], 'cpu', NOW), SVG('<circle cx="0.0" cy="7.0" r="1.2"/>'));
  assert.strictEqual(D.sparkline([pt(NOW - HOUR - 1, { cpu: 50 })], 'cpu', NOW), SVG(''));
  assert.strictEqual(D.sparkline([pt(NOW + STEP, { cpu: 50 })], 'cpu', NOW), SVG('<circle cx="56.0" cy="7.0" r="1.2"/>'), 'clamped to the right edge');
  assert.strictEqual(D.sparkline([pt(NOW + STEP + 1, { cpu: 50 })], 'cpu', NOW), SVG(''));
});

test('kills: the sparkline polyline coordinates are exact', () => {
  const svg = D.sparkline([pt(NOW - HOUR / 2, { cpu: 0 }), pt(NOW, { cpu: 100 })], 'cpu', NOW);
  assert.strictEqual(svg, SVG('<polyline points="28.0,13.0 56.0,1.0" fill="none"/>'));
});

test('kills: the graph draws the exact stacked-area paths and latest mark for two known points', () => {
  const html = D.graph([pt(NOW - HOUR / 2, { cpu: 50, cpuOurs: 25 }), pt(NOW, { cpu: 100, cpuOurs: 50 })], 'cpu', NOW, { w: 300, h: 64 });
  assert.ok(html.includes('<svg width="300" height="64" viewBox="0 0 300 64">'
    + '<path class="hg-rest" d="M150.0,63 L150.0,33.0 L300.0,3.0 L300.0,63 Z"/>'
    + '<path class="hg-ours" d="M150.0,63 L150.0,48.0 L300.0,33.0 L300.0,63 Z"/>'
    + '<circle class="hg-latest" cx="300.0" cy="3.0" r="2.5"/></svg>'), html);
});

test('kills: a lone point is a dot at its exact place, and the latest mark is clamped to the right edge', () => {
  const html = D.graph([pt(NOW - HOUR / 2, { cpu: 50 }), pt(NOW + 2 * STEP, { cpu: 100 })], 'cpu', NOW, { w: 300, h: 64 });
  assert.ok(html.includes('<circle class="hg-dot-rest" cx="150.0" cy="33.0" r="1.6"/><circle class="hg-dot-ours" cx="150.0" cy="57.0" r="1.6"/>'
    + '<circle class="hg-latest" cx="300.0" cy="3.0" r="2.5"/>'), html);
});

test('kills: the latest mark is drawn for a last point exactly an hour old, and not one a millisecond older', () => {
  const at = D.graph([pt(NOW - HOUR - 1, { cpu: 80 }), pt(NOW - HOUR, { cpu: 50 })], 'cpu', NOW, { w: 300, h: 64 });
  assert.ok(at.includes('<circle class="hg-latest" cx="0.0" cy="33.0" r="2.5"/>'), at);
  const older = D.graph([pt(NOW - HOUR, { cpu: 50 }), pt(NOW - HOUR - 1, { cpu: 80 })], 'cpu', NOW, { w: 300, h: 64 });
  assert.ok(!older.includes('hg-latest'), older);
});

test('kills: the hover cursor sits at the exact fraction across', () => {
  assert.ok(D.graph([pt(NOW - HOUR / 2)], 'cpu', NOW, { hover: 15 }).includes('<div class="hg-cursor" style="left:75.0%"></div>'));
});

test('kills: the readout takes a point exactly half a minute off the hovered minute, not one a millisecond further', () => {
  const target = NOW - 12 * 60000;
  assert.strictEqual(D.readout([pt(target - 30000, { cpu: 33 })], NOW, 12, 'cpu'), '12 min ago · CPU 33%, ours 10%');
  assert.strictEqual(D.readout([pt(target - 30001, { cpu: 33 })], NOW, 12, 'cpu'), '12 min ago · no data');
});

test('kills: of two points equally near the hovered minute, the readout keeps the first', () => {
  const target = NOW - 12 * 60000;
  assert.strictEqual(D.readout([pt(target - 10000, { cpu: 11 }), pt(target + 10000, { cpu: 22 })], NOW, 12, 'cpu'), '12 min ago · CPU 11%, ours 10%');
});

test('kills: describe names the most RECENT of two equal peaks, and the later of two points at the same moment', () => {
  const peaks = [pt(NOW - 23 * 60000, { cpu: 71 }), pt(NOW - 5 * 60000, { cpu: 71 }), pt(NOW, { cpu: 30 })];
  assert.strictEqual(D.describe(peaks, NOW, 'cpu'), 'CPU, last hour: now 30%, peak 71% 5 min ago');
  const same = [pt(NOW - 2 * 60000, { cpu: 10 }), pt(NOW - 2 * 60000, { cpu: 20 })];
  assert.strictEqual(D.describe(same, NOW, 'cpu'), 'CPU, last hour: 20% 2 min ago, peak 20% 2 min ago');
});

test('kills: describe counts a point exactly an hour old or exactly a step ahead, and nothing past either', () => {
  assert.strictEqual(D.describe([pt(NOW - HOUR, { cpu: 10 })], NOW, 'cpu'), 'CPU, last hour: 10% 60 min ago, peak 10% 60 min ago');
  assert.strictEqual(D.describe([pt(NOW - HOUR - 1, { cpu: 10 })], NOW, 'cpu'), 'CPU, last hour: collecting data');
  assert.strictEqual(D.describe([pt(NOW + STEP, { cpu: 10 })], NOW, 'cpu'), 'CPU, last hour: now 10%, peak 10% now');
  assert.strictEqual(D.describe([pt(NOW + STEP + 1, { cpu: 10 })], NOW, 'cpu'), 'CPU, last hour: collecting data');
});

test('kills: `leave` changes nothing while closed, or while open with nothing hovered (the same state object back)', () => {
  const closed = D.popoverInit();
  assert.strictEqual(D.popoverStep(closed, { type: 'leave' }).state, closed);
  const stale = { open: false, hover: { cpu: 5, mem: null } };
  assert.strictEqual(D.popoverStep(stale, { type: 'leave' }).state, stale, 'leaving never opens a closed popover');
  const open = D.popoverStep(closed, { type: 'chip-click' }).state;
  assert.strictEqual(D.popoverStep(open, { type: 'leave' }).state, open);
  const hovered = D.popoverStep(open, { type: 'hover', kind: 'cpu', minutes: 5 }).state;
  assert.deepStrictEqual(D.popoverStep(hovered, { type: 'leave' }).state, { open: true, hover: { cpu: null, mem: null } });
});
