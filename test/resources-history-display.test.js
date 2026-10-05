'use strict';
/**
 * app/resources-history-display.js (BACKLOG #63 follow-up): the sparklines and the popover's graphs. Pure geometry and text.
 * A gap is a break in the line, never a drop to 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/resources-history-display');

const STEP = 10000;
const NOW = 100 * 60 * 1000;
const pt = (at, over = {}) => ({ at, cpu: 40, cpuOurs: 10, memUsed: 500, memOurs: 100, memTotal: 1000, ...over });
const nul = at => ({ at, cpu: null, cpuOurs: null, memUsed: null, memOurs: null, memTotal: null });
const run = (from, n, over) => Array.from({ length: n }, (_, i) => pt(from + i * STEP, over));

test('fractions: cpu is a percent, memory is used over total, an unmeasured one is null', () => {
  assert.deepStrictEqual(D.fractions(pt(1, { cpu: 50, cpuOurs: 20, memUsed: 250, memOurs: 100 })),
    { at: 1, brk: false, cpu: 0.5, cpuOurs: 0.2, mem: 0.25, memOurs: 0.1 });
  const f = D.fractions(nul(1));
  assert.deepStrictEqual([f.cpu, f.cpuOurs, f.mem, f.memOurs], [null, null, null, null]);
  assert.strictEqual(D.fractions(pt(1, { memTotal: 0 })).mem, null, 'no total, no fraction (never a divide to Infinity)');
  assert.strictEqual(D.fractions(pt(1, { cpu: 150 })).cpu, 1, 'clamped');
  assert.strictEqual(D.fractions(pt(1, { cpu: 0 })).cpu, 0, 'a real 0 is 0');
});

test('segments: a null splits the line in two, it is not a point at 0', () => {
  const pts = [...run(NOW - 60000, 3), nul(NOW - 30000), ...run(NOW - 20000, 3)];
  const segs = D.segments(pts, 'cpu');
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].length, 3);
  assert.strictEqual(segs[1].length, 3);
  assert.ok(segs.flat().every(p => p.v === 0.4));
});

test('segments: a point marked brk starts a new run; spacing alone never does (a slow sample is not a missed one)', () => {
  const pts = [...run(NOW - 600000, 3), { ...pt(NOW - 300000), brk: true }, pt(NOW - 290000)];
  const segs = D.segments(pts, 'cpu');
  assert.deepStrictEqual(segs.map(r => r.length), [3, 2]);
  assert.strictEqual(D.segments([pt(0), pt(26000), pt(26000 + 3600000 / 2)], 'cpu').length, 1, 'no break without a marker, however far apart');
});

test('segments: no points, no segments', () => {
  assert.deepStrictEqual(D.segments([], 'cpu'), []);
  assert.deepStrictEqual(D.segments(null, 'cpu'), []);
});

test('sparkline: one polyline per run, a lone point is a dot, and nothing at all draws an empty box', () => {
  const pts = [...run(NOW - 60000, 3), nul(NOW - 30000), pt(NOW - 20000)];
  const svg = D.sparkline(pts, 'cpu', NOW);
  assert.strictEqual((svg.match(/<polyline/g) || []).length, 1);
  assert.strictEqual((svg.match(/<circle/g) || []).length, 1);
  assert.ok(svg.startsWith('<svg'));
  const empty = D.sparkline([], 'cpu', NOW);
  assert.ok(!/<polyline|<circle/.test(empty));
});

test('sparkline: x runs 0 at 60 min ago to the full width at now, y puts 100% at the top and a real 0 on the floor', () => {
  const svg = D.sparkline([pt(NOW, { cpu: 100 }), pt(NOW - 10000, { cpu: 0 })].reverse(), 'cpu', NOW, { w: 56, h: 14 });
  const pts = /points="([^"]+)"/.exec(svg)[1].split(' ').map(s => s.split(',').map(Number));
  assert.strictEqual(pts.at(-1)[0], 56);
  assert.ok(pts.at(-1)[1] < pts[0][1], 'higher CPU is higher on the page (smaller y)');
  assert.ok(pts[0][1] <= 14 && pts.at(-1)[1] >= 0);
});

test('sparkline: points older than an hour are not drawn', () => {
  const svg = D.sparkline([pt(NOW - 3700000), pt(NOW - 3690000)], 'cpu', NOW);
  assert.ok(!/<polyline|<circle/.test(svg));
});

test('minutesAgo: the fraction across the graph is a whole minute, 0 to 60', () => {
  assert.strictEqual(D.minutesAgo(1), 0);
  assert.strictEqual(D.minutesAgo(0), 60);
  assert.strictEqual(D.minutesAgo(0.5), 30);
  assert.strictEqual(D.minutesAgo(-3), 60);
  assert.strictEqual(D.minutesAgo(9), 0);
  assert.strictEqual(D.minutesAgo(NaN), null);
});

test('readout: "12 min ago · CPU 54%, ours 41%" from the nearest point; memory in bytes', () => {
  const at = NOW - 12 * 60000;
  const pts = [pt(at, { cpu: 54, cpuOurs: 41, memUsed: 21.4 * 1073741824, memOurs: 3.2 * 1073741824, memTotal: 32 * 1073741824 })];
  assert.strictEqual(D.readout(pts, NOW, 12, 'cpu'), '12 min ago · CPU 54%, ours 41%');
  assert.strictEqual(D.readout(pts, NOW, 12, 'mem'), '12 min ago · memory 21.4 GB, ours 3.2 GB');
});

test('readout: now, and a minute with no sample says so, never 0', () => {
  assert.strictEqual(D.readout([pt(NOW, { cpu: 7.5, cpuOurs: 1.2 })], NOW, 0, 'cpu'), 'now · CPU 7.5%, ours 1.2%');
  assert.strictEqual(D.readout([pt(NOW)], NOW, 20, 'cpu'), '20 min ago · no data');
  assert.strictEqual(D.readout([nul(NOW - 5 * 60000)], NOW, 5, 'cpu'), '5 min ago · no data');
  assert.strictEqual(D.readout([], NOW, 5, 'mem'), '5 min ago · no data');
  assert.strictEqual(D.readout([pt(NOW - 60000, { cpuOurs: null })], NOW, 1, 'cpu'), '1 min ago · CPU 40%, ours —');
  assert.strictEqual(D.readout([pt(NOW)], NOW, null, 'cpu'), '');
});

test('graph: a stacked area per run (ours on the accent, everything else neutral), the latest point marked, the 60/30/now axis', () => {
  const pts = run(NOW - 120000, 13, { cpu: 50, cpuOurs: 20 });
  const html = D.graph(pts, 'cpu', NOW);
  assert.ok(/class="hg-rest"/.test(html) && /class="hg-ours"/.test(html));
  assert.strictEqual((html.match(/class="hg-latest"/g) || []).length, 1);
  for (const label of ['60 min', '30', 'now']) assert.ok(html.includes(`>${label}<`), label);
});

test('graph: with no "ours" figure only the total is drawn, no accent area at 0', () => {
  const html = D.graph(run(NOW - 120000, 5, { cpuOurs: null, memOurs: null }), 'cpu', NOW);
  assert.ok(/class="hg-rest"/.test(html));
  assert.ok(!/class="hg-ours"/.test(html));
});

test('graph: a gap leaves two areas and no point between them', () => {
  const pts = [...run(NOW - 300000, 5), nul(NOW - 250000), ...run(NOW - 240000, 5)];
  assert.strictEqual((D.graph(pts, 'cpu', NOW).match(/class="hg-rest"/g) || []).length, 2);
});

test('graph: empty says so instead of drawing a flat line', () => {
  const html = D.graph([], 'cpu', NOW);
  assert.ok(/collecting/i.test(html));
  assert.ok(!/hg-rest|hg-latest/.test(html));
});

test('property: every drawn coordinate is finite and inside the box, whatever the points are', () => {
  const val = fc.oneof(fc.constant(null), fc.double({ min: -50, max: 500, noNaN: true }));
  fc.assert(fc.property(
    fc.array(fc.record({ d: fc.integer({ min: 0, max: 4000000 }), cpu: val, cpuOurs: val, memUsed: val, memOurs: val, memTotal: val }), { maxLength: 60 }),
    (rows) => {
      const pts = [...new Map(rows.map(r => [r.d, r])).values()].sort((a, b) => a.d - b.d)
        .map(r => ({ at: NOW - r.d, ...r })).sort((a, b) => a.at - b.at);
      for (const html of [D.sparkline(pts, 'cpu', NOW, { w: 56, h: 14 }), D.sparkline(pts, 'mem', NOW, { w: 56, h: 14 }), D.graph(pts, 'cpu', NOW), D.graph(pts, 'mem', NOW)]) {
        assert.ok(!/NaN|Infinity|undefined|null/.test(html), html);
      }
      const svg = D.sparkline(pts, 'cpu', NOW, { w: 56, h: 14 });
      for (const m of svg.matchAll(/points="([^"]+)"/g)) {
        for (const pair of m[1].split(' ')) {
          const [x, y] = pair.split(',').map(Number);
          assert.ok(x >= 0 && x <= 56 && y >= 0 && y <= 14, pair);
        }
      }
    },
  ));
});

test('property: a null never becomes a point at 0 (the number of drawn points equals the number of measured ones in the window)', () => {
  const val = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 100, noNaN: true }));
  fc.assert(fc.property(fc.array(val, { maxLength: 100 }), (vals) => {
    const pts = vals.map((v, i) => ({ ...nul(NOW - (vals.length - i) * 5000), cpu: v }));
    const drawn = D.segments(pts, 'cpu').reduce((n, s) => n + s.length, 0);
    assert.strictEqual(drawn, vals.filter(v => v !== null).length);
  }));
});

test('chipHtml: each figure is followed by its own sparkline, and a figure is escaped text', () => {
  const html = D.chipHtml('CPU 71%', '21.4 GB / 32.0 GB', run(NOW - 60000, 4), NOW);
  assert.match(html, /^<span class="tbr-n">CPU 71%<\/span><svg class="hs"[\s\S]*<\/svg><span class="tbr-n">21\.4 GB \/ 32\.0 GB<\/span><svg class="hs"/);
  assert.match(D.chipHtml('<b>', '&', [], NOW), /<span class="tbr-n">&lt;b&gt;<\/span>[\s\S]*<span class="tbr-n">&amp;<\/span>/);
});

// ---- review fixes (Dexter, PR #114 D1 D2 D5 D6, Miguel S1) -----------------------------------------------------------------

test('D2: where the total is null, "ours" is null too: nothing orange is drawn across a break in the total', () => {
  const f = D.fractions(pt(1, { cpu: null, cpuOurs: 10 }));
  assert.strictEqual(f.cpuOurs, null);
  assert.strictEqual(D.fractions(pt(1, { memUsed: null, memOurs: 100 })).memOurs, null);
  const pts = [pt(NOW - 22000, { cpu: 50, cpuOurs: 10 }), pt(NOW - 11000, { cpu: null, cpuOurs: 10 }), pt(NOW, { cpu: 50, cpuOurs: 10 })];
  assert.deepStrictEqual(D.segments(pts, 'cpuOurs').map(r => r.length), [1, 1]);
  const html = D.graph(pts, 'cpu', NOW);
  assert.ok(!/<path class="hg-ours"/.test(html), 'no orange area spanning the null point');
});

test('D6: "ours" is clipped to the total in the figures, exactly as the graph does', () => {
  assert.strictEqual(D.fractions(pt(1, { cpu: 5, cpuOurs: 6 })).cpuOurs, 0.05);
  assert.strictEqual(D.readout([pt(NOW, { cpu: 5, cpuOurs: 6 })], NOW, 0, 'cpu'), 'now · CPU 5.0%, ours 5.0%');
  assert.strictEqual(D.readout([pt(NOW, { memUsed: 500, memOurs: 700, memTotal: 1000 })], NOW, 0, 'mem'), 'now · memory 0 MB, ours 0 MB');
});

test('D6: the readout takes the nearest MEASURED point near the minute, not a nearer failure', () => {
  const target = NOW - 12 * 60000;
  const pts = [pt(target - 9000, { cpu: 33, cpuOurs: 3 }), nul(target + 2000)];
  assert.strictEqual(D.readout(pts, NOW, 12, 'cpu'), '12 min ago · CPU 33%, ours 3.0%');
  assert.strictEqual(D.readout([nul(target)], NOW, 12, 'cpu'), '12 min ago · no data');
});

test('D5: a lone measured point is drawn in the graph (a dot, as in the sparkline); "Collecting data" only when nothing is drawable', () => {
  const lone = [pt(NOW - 600000, { memUsed: 8, memOurs: 2, memTotal: 16 }), nul(NOW - 300000), pt(NOW)];
  const html = D.graph(lone, 'mem', NOW);
  assert.strictEqual((html.match(/class="hg-dot-rest"/g) || []).length, 2);
  assert.ok(!/collecting/i.test(html));
  assert.ok(/collecting/i.test(D.graph([nul(NOW - 10000), nul(NOW)], 'mem', NOW)));
});

test('D1 (display): a point later than "now" is not drawn pinned at the right edge', () => {
  const svg = D.sparkline([pt(NOW + 60000)], 'cpu', NOW);
  assert.ok(!/<polyline|<circle/.test(svg));
});

test('S1: the readout is escaped where it enters the markup', () => {
  const html = D.graph([pt(NOW)], 'cpu', NOW);
  assert.match(html, /<div class="hg-readout">now · CPU 40%, ours 10%<\/div>/);
  assert.strictEqual(D.esc('<&>'), '&lt;&amp;&gt;');
});
