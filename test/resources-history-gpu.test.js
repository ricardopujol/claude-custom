'use strict';
/**
 * app/resources-history-display.js, the GPU's two graphs and sparkline (BACKLOG #82): busy % and dedicated memory used of the
 * total. A GPU figure that was not measured is a break in the line, never a drop to 0; a machine with no GPU figures gets no
 * GPU graphs at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/resources-history-display');

const STEP = 10000;
const NOW = 100 * 60 * 1000;
const pt = (at, over = {}) => ({ at, cpu: 40, cpuOurs: 10, memUsed: 500, memOurs: 100, memTotal: 1000, gpu: 30, gpuMemUsed: 2e9, gpuMemTotal: 8e9, ...over });
const bare = at => ({ at, cpu: 40, cpuOurs: 10, memUsed: 500, memOurs: 100, memTotal: 1000 });
const run = (from, n, over) => Array.from({ length: n }, (_, i) => pt(from + i * STEP, over));

test('figuresOf / fractions: GPU busy is a percent, GPU memory is used over total, an unknown total leaves memory unmeasured', () => {
  const f = D.figuresOf(pt(1, { gpu: 150, gpuMemUsed: 9e9 }));
  assert.strictEqual(f.gpu, 100, 'clipped to the scale');
  assert.strictEqual(f.gpuMemUsed, 8e9, 'never more than the total');
  const fr = D.fractions(pt(1, { gpu: 25, gpuMemUsed: 2e9 }));
  assert.strictEqual(fr.gpu, 0.25);
  assert.strictEqual(fr.gpumem, 0.25);
  const noTotal = D.fractions(pt(1, { gpuMemTotal: null }));
  assert.strictEqual(noTotal.gpumem, null);
  assert.strictEqual(D.fractions(pt(1, { gpuMemTotal: 0 })).gpumem, null);
  const gone = D.fractions(bare(1));
  assert.deepStrictEqual([gone.gpu, gone.gpumem], [null, null]);
  assert.strictEqual(D.fractions(pt(1, { gpu: 0 })).gpu, 0, 'a real 0 stays 0');
});

test('segments: a point with no GPU figure breaks the GPU line; the CPU line is untouched', () => {
  const pts = [pt(NOW - 3 * STEP), pt(NOW - 2 * STEP, { gpu: null }), pt(NOW - STEP)];
  assert.deepStrictEqual(D.segments(pts, 'gpu').map(r => r.length), [1, 1]);
  assert.deepStrictEqual(D.segments(pts, 'cpu').map(r => r.length), [3]);
});

test('readout: "GPU 54%" and "GPU memory 4.0 GB of 8.0 GB" from the nearest measured point; "no data" otherwise', () => {
  const pts = [pt(NOW, { gpu: 12 }), pt(NOW - 12 * 60000, { gpu: 54, gpuMemUsed: 4e9 })];
  assert.strictEqual(D.readout(pts, NOW, 12, 'gpu'), '12 min ago · GPU 54%');
  assert.strictEqual(D.readout(pts, NOW, 12, 'gpumem'), '12 min ago · GPU memory 3.7 GB of 7.5 GB');
  assert.strictEqual(D.readout(pts, NOW, 0, 'gpu'), 'now · GPU 12%');
  assert.strictEqual(D.readout(pts, NOW, 30, 'gpu'), '30 min ago · no data');
  assert.strictEqual(D.readout([bare(NOW)], NOW, 0, 'gpu'), 'now · no data');
  assert.strictEqual(D.readout(pts, NOW, 0, 'nope'), '');
});

test('describe: names the graph for a screen reader', () => {
  const pts = [pt(NOW, { gpu: 12 }), pt(NOW - 5 * 60000, { gpu: 70 })];
  assert.strictEqual(D.describe(pts, NOW, 'gpu'), 'GPU, last hour: now 12%, peak 70% 5 min ago');
  assert.match(D.describe(pts, NOW, 'gpumem'), /^GPU memory, last hour: now 1\.9 GB, peak 1\.9 GB/);
  assert.strictEqual(D.describe([bare(NOW)], NOW, 'gpu'), 'GPU, last hour: collecting data');
});

test('the popover has the GPU graphs only when some point has a GPU figure', () => {
  const withGpu = D.popover(run(NOW - 5 * STEP, 6), NOW);
  assert.deepStrictEqual([...withGpu.matchAll(/data-hist-graph="(\w+)"/g)].map(m => m[1]), ['cpu', 'mem', 'gpu', 'gpumem']);
  assert.match(withGpu, /aria-label="GPU, last hour: now 30%/);
  const without = D.popover([bare(NOW)], NOW);
  assert.deepStrictEqual([...without.matchAll(/data-hist-graph="(\w+)"/g)].map(m => m[1]), ['cpu', 'mem']);
  assert.strictEqual(D.hasGpu([]), false);
  assert.strictEqual(D.hasGpu(null), false);
  assert.strictEqual(D.hasGpu([pt(NOW, { gpu: null, gpuMemUsed: 5 })]), true, 'memory alone is enough');
  assert.strictEqual(D.hasGpu([pt(NOW, { gpu: null, gpuMemUsed: null })]), false);
});

test('the memory graph with no known total says it is collecting instead of drawing a guess, while the busy one draws', () => {
  const g = D.popover([pt(NOW, { gpuMemTotal: null })], NOW);
  assert.strictEqual((g.match(/hg-empty/g) || []).length, 1);
  assert.match(g.slice(g.indexOf('data-hist-graph="gpumem"')), /hg-empty/);
  assert.strictEqual(D.popover([pt(NOW, { gpu: null, gpuMemTotal: null })], NOW).includes('data-hist-graph="gpu"'), false, 'nothing measured at all: no GPU graphs');
});

test('PR #152 D4: a total that never arrives says "unknown" on the GPU memory graph, not "Collecting data…" forever', () => {
  const pts = run(NOW - 5 * STEP, 6, { gpuMemTotal: null });
  for (const html of [D.popover(pts, NOW), D.gpuGraphs(pts, NOW)]) {
    const mem = html.slice(html.indexOf('data-hist-graph="gpumem"'));
    assert.match(mem, /Unknown: this GPU does not report its total memory/);
    assert.doesNotMatch(mem, /Collecting data/);
  }
  // before any GPU memory figure exists, and for the busy graph, "collecting" is still the honest word
  const early = D.popover([pt(NOW, { gpuMemUsed: null, gpuMemTotal: null })], NOW);
  assert.match(early.slice(early.indexOf('data-hist-graph="gpumem"')), /Collecting data/);
  assert.doesNotMatch(D.gpuGraphs(pts, NOW).slice(0, D.gpuGraphs(pts, NOW).indexOf('data-hist-graph="gpumem"')), /Unknown/);
});

test('gpuGraphs: the two graphs for the Resources tab, none without GPU figures', () => {
  const html = D.gpuGraphs(run(NOW - 5 * STEP, 6), NOW);
  assert.deepStrictEqual([...html.matchAll(/data-hist-graph="(\w+)"/g)].map(m => m[1]), ['gpu', 'gpumem']);
  assert.strictEqual(D.gpuGraphs([bare(NOW)], NOW), '');
  assert.strictEqual(D.gpuGraphs(undefined, NOW), '');
});

test('the GPU graph draws one neutral area and no "ours" (claude-custom has no GPU share of its own here)', () => {
  const html = D.popover(run(NOW - 5 * STEP, 6), NOW);
  const gpu = html.slice(html.indexOf('data-hist-graph="gpu"'), html.indexOf('data-hist-graph="gpumem"'));
  assert.match(gpu, /class="hg-rest"/);
  assert.doesNotMatch(gpu, /hg-ours/);
});

test('chipHtml: a GPU figure and its sparkline follow the memory one, only when asked for', () => {
  const pts = run(NOW - 60000, 4);
  const html = D.chipHtml('CPU 71%', '21.4 GB / 32.0 GB', pts, NOW, 'GPU 12%');
  assert.deepStrictEqual([...html.matchAll(/<span class="tbr-n">([^<]*)<\/span>/g)].map(m => m[1]), ['CPU 71%', '21.4 GB / 32.0 GB', 'GPU 12%']);
  assert.strictEqual((html.match(/<svg/g) || []).length, 3);
  assert.strictEqual((D.chipHtml('a', 'b', pts, NOW).match(/<svg/g) || []).length, 2);
  assert.strictEqual((D.chipHtml('a', 'b', pts, NOW, null).match(/<svg/g) || []).length, 2);
  assert.match(D.chipHtml('a', 'b', [], NOW, '<i>'), /&lt;i&gt;/);
});

test('hover: any of the four graphs can be hovered, one at a time, and the view has all four', () => {
  let s = D.popoverStep(D.popoverInit(), { type: 'chip-click' }).state;
  for (const kind of ['cpu', 'mem', 'gpu', 'gpumem']) {
    s = D.popoverStep(s, { type: 'hover', kind, minutes: 7 }).state;
    assert.deepStrictEqual(Object.entries(s.hover).filter(([, v]) => v !== null), [[kind, 7]]);
  }
  const v = D.hoverView([pt(NOW), pt(NOW - 7 * 60000, { gpu: 44 })], NOW, s.hover);
  assert.strictEqual(v.gpumem.cursor, (1 - 7 / 60) * 100);
  assert.match(v.gpumem.readout, /^7 min ago · GPU memory /);
  assert.strictEqual(v.gpu.cursor, null);
  assert.match(v.gpu.readout, /^now · GPU 30%/);
});

test('property: a point with no GPU figures never contributes a GPU value to any run, readout or graph', () => {
  fc.assert(fc.property(fc.array(fc.record({ gap: fc.boolean(), v: fc.integer({ min: 0, max: 100 }) }), { minLength: 1, maxLength: 15 }), (rows) => {
    const pts = rows.map((r, i) => (r.gap ? bare(NOW - (rows.length - i) * STEP) : pt(NOW - (rows.length - i) * STEP, { gpu: r.v })));
    const measured = rows.filter(r => !r.gap).length;
    assert.strictEqual(D.segments(pts, 'gpu').reduce((n, run2) => n + run2.length, 0), measured);
    for (const run2 of D.segments(pts, 'gpu')) for (const p of run2) assert.ok(p.v >= 0 && p.v <= 1);
    assert.strictEqual(D.popover(pts, NOW).includes('data-hist-graph="gpu"'), measured > 0);
  }), { numRuns: 100 });
});
