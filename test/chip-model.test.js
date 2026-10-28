'use strict';
/**
 * Chrome grammar A (2026-10-26): app/chip-model.js, the pure decisions behind the header chips: the 28 px micro-bar and the one
 * warnings chip with a count.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { BAR_PX, microBar, warningsChip } = require('../app/chip-model');

test('the micro-bar is 28 px wide', () => assert.strictEqual(BAR_PX, 28));

test('microBar: a fraction becomes whole pixels of fill, clamped to the bar', () => {
  assert.deepStrictEqual(microBar(0), { known: true, px: 0 });
  assert.deepStrictEqual(microBar(0.5), { known: true, px: 14 });
  assert.deepStrictEqual(microBar(1), { known: true, px: 28 });
  assert.deepStrictEqual(microBar(1.7), { known: true, px: 28 }, 'over full is full');
  assert.deepStrictEqual(microBar(-0.2), { known: true, px: 0 });
});

test('microBar: no value is UNKNOWN, never an empty bar (Number(null) is 0)', () => {
  for (const v of [null, undefined, NaN, Infinity, '0.5', {}, [], true]) {
    assert.deepStrictEqual(microBar(v), { known: false, px: 0 }, String(v));
  }
});

test('property: px is an integer in [0, 28] for any number', () => {
  fc.assert(fc.property(fc.double(), (f) => {
    const b = microBar(f);
    assert.ok(Number.isInteger(b.px) && b.px >= 0 && b.px <= BAR_PX);
    assert.strictEqual(b.known, Number.isFinite(f));
  }));
});

test('warningsChip: nothing to say hides the chip', () => {
  assert.deepStrictEqual(warningsChip([]), { shown: false, count: 0, label: '', title: '' });
  assert.deepStrictEqual(warningsChip(null), { shown: false, count: 0, label: '', title: '' });
  assert.deepStrictEqual(warningsChip([null, {}, { text: '' }, { text: 3 }]), { shown: false, count: 0, label: '', title: '' });
});

test('warningsChip: one chip with a count, the detail one line each in the hover text', () => {
  const w = warningsChip([{ text: 'behind develop', title: 'Behind develop by 3 commits' }, { text: 'lock', title: 'Second session' }]);
  assert.deepStrictEqual(w, { shown: true, count: 2, label: '2', title: 'Behind develop by 3 commits\nSecond session' });
});

test('warningsChip: a warning with no title falls back to its text; the count is never a sentence', () => {
  const w = warningsChip([{ text: 'behind develop' }]);
  assert.strictEqual(w.title, 'behind develop');
  assert.strictEqual(w.label, '1');
});

test('property: label is the count as digits, and shown means count > 0', () => {
  const item = fc.record({ text: fc.string(), title: fc.option(fc.string(), { nil: undefined }) });
  fc.assert(fc.property(fc.array(fc.oneof(item, fc.anything())), (items) => {
    const w = warningsChip(items);
    assert.strictEqual(w.shown, w.count > 0);
    assert.strictEqual(w.label, w.count > 0 ? String(w.count) : '');
  }));
});

// ---- Miguel, PR #215 round 1, finding 2: while the suite runs the chip keeps its last known value, dimmed ----------------------

const { healthChip } = require('../app/chip-model');

test('healthChip: a finished run shows passed/total and a bar, and hands back what to remember', () => {
  const c = healthChip({ state: 'healthy', fraction: 0.5, passed: 7, total: 14, running: false }, null);
  assert.strictEqual(c.label, '7/14');
  assert.deepStrictEqual(c.bar, { known: true, px: 14 });
  assert.strictEqual(c.running, false);
  assert.strictEqual(c.stale, false);
  assert.deepStrictEqual(c.known, { label: '7/14', fraction: 0.5 });
});

test('healthChip: while running it keeps the last known value and bar, both stale (dimmed), and remembers nothing new', () => {
  const last = { label: '7/14', fraction: 0.5 };
  const c = healthChip({ state: 'unknown', fraction: null, running: true }, last);
  assert.strictEqual(c.label, '7/14');
  assert.deepStrictEqual(c.bar, { known: true, px: 14 });
  assert.strictEqual(c.running, true);
  assert.strictEqual(c.stale, true);
  assert.strictEqual(c.known, null);
});

test('healthChip: running with nothing known yet is a dash and no bar, not stale', () => {
  const c = healthChip({ state: 'unknown', fraction: null, running: true }, null);
  assert.strictEqual(c.label, '—');
  assert.deepStrictEqual(c.bar, { known: false, px: 0 });
  assert.strictEqual(c.running, true);
  assert.strictEqual(c.stale, false);
});

test('healthChip: unknown and not running is a dash, never shimmering, and keeps nothing', () => {
  const c = healthChip({ state: 'unknown', fraction: null, running: false }, { label: '7/14', fraction: 0.5 });
  assert.strictEqual(c.label, '—');
  assert.strictEqual(c.running, false);
  assert.strictEqual(c.stale, false);
  assert.strictEqual(c.known, null);
});

test('healthChip: a run that finishes replaces the old value', () => {
  const c = healthChip({ state: 'hurt', fraction: 0.9, passed: 9, total: 10, running: false }, { label: '7/14', fraction: 0.5 });
  assert.strictEqual(c.label, '9/10');
  assert.deepStrictEqual(c.known, { label: '9/10', fraction: 0.9 });
});

// ---- Ricardo's pick (option A) for the resources chip: `CPU 23% · RAM 52% · GPU 8%`, only the number changes colour ---------------

const { resourcesChip, resourcesChipHtml, levelOfPct, RES_AMBER_PCT, RES_RED_PCT } = require('../app/chip-model');
const GB = 1024 ** 3;
const machine = (over = {}) => ({ machine: { cpu: 23, mem: { usedBytes: 16.2 * GB, totalBytes: 31.2 * GB }, gpu: { busy: 8, mem: { usedBytes: 4.2 * GB, totalBytes: 8 * GB } }, ...over }, status: {} });

test('levelOfPct: amber from 75, red from 90, on the figure as shown; absence has no level', () => {
  assert.strictEqual(RES_AMBER_PCT, 75);
  assert.strictEqual(RES_RED_PCT, 90);
  assert.strictEqual(levelOfPct(74), null);
  assert.strictEqual(levelOfPct(75), 'amber');
  assert.strictEqual(levelOfPct(89), 'amber');
  assert.strictEqual(levelOfPct(90), 'red');
  assert.strictEqual(levelOfPct(100), 'red');
  assert.strictEqual(levelOfPct(null), null);
  assert.strictEqual(levelOfPct(undefined), null);
  assert.strictEqual(levelOfPct(NaN), null);
});

test('resourcesChip: CPU, RAM as used/total %, GPU utilisation; the full figures are in the title', () => {
  const c = resourcesChip(machine());
  assert.deepStrictEqual(c.segments.map(s => [s.key, s.label, s.value, s.short, s.level]),
    [['cpu', 'CPU', '23%', '23', null], ['ram', 'RAM', '52%', '52', null], ['gpu', 'GPU', '8%', '8', null]]);
  assert.strictEqual(c.aria, 'CPU 23%, RAM 52%, GPU 8%');
  assert.match(c.title, /RAM 16\.2 of 31\.2 GB \(52%\)/);
  assert.match(c.title, /GPU 8% \(4\.2 of 8\.0 GB\)/);
  assert.match(c.title, /^CPU 23%\n/);
});

test('resourcesChip: each metric has its own level', () => {
  const c = resourcesChip(machine({ cpu: 80, mem: { usedBytes: 29 * GB, totalBytes: 30 * GB }, gpu: { busy: 74.6, mem: null } }));
  assert.deepStrictEqual(c.segments.map(s => s.level), ['amber', 'red', 'amber']);   // 74.6 shows as 75, so it is amber
});

test('resourcesChip: a missing metric is a dash and no level, never 0%', () => {
  const c = resourcesChip(machine({ cpu: null, mem: null, gpu: { busy: null, mem: null } }));
  assert.deepStrictEqual(c.segments.map(s => [s.value, s.short, s.level]), [['—', '—', null], ['—', '—', null], ['—', '—', null]]);
  assert.strictEqual(c.aria, 'CPU —, RAM —, GPU —');
  const zero = resourcesChip(machine({ cpu: 0 }));
  assert.strictEqual(zero.segments[0].value, '0%', 'a real zero is a zero');
  assert.strictEqual(resourcesChip(machine({ mem: { usedBytes: 1, totalBytes: 0 } })).segments[1].value, '—');
});

test('resourcesChip: no GPU part, no GPU segment; an expired or absent payload is dashes (the GPU segment stays when it existed)', () => {
  const noGpu = machine(); delete noGpu.machine.gpu;
  assert.deepStrictEqual(resourcesChip(noGpu).segments.map(s => s.key), ['cpu', 'ram']);
  const none = resourcesChip(null);
  assert.deepStrictEqual(none.segments.map(s => [s.key, s.value]), [['cpu', '—'], ['ram', '—']]);
  const expired = machine(); expired.status = { expired: true };
  assert.deepStrictEqual(resourcesChip(expired).segments.map(s => [s.key, s.value]), [['cpu', '—'], ['ram', '—'], ['gpu', '—']]);
});

test('resourcesChipHtml: label, value (the % apart so narrow can drop it), the level on the number only, dots between', () => {
  const html = resourcesChipHtml(resourcesChip(machine({ cpu: 91 })));
  assert.match(html, /<span class="tbr-n"><span class="tbr-l">CPU<\/span> <span class="tbr-v lv-red">91<span class="tbr-pc">%<\/span><\/span><\/span>/);
  assert.match(html, /<span class="tbr-n"><span class="tbr-l">RAM<\/span> <span class="tbr-v">52<span class="tbr-pc">%<\/span><\/span><\/span>/);
  assert.strictEqual((html.match(/<span class="tbr-sep">·<\/span>/g) || []).length, 2);
  assert.ok(!/class="tbr-l"[^>]*lv-/.test(html), 'the label never takes the level');
  assert.match(resourcesChipHtml(resourcesChip(null)), /<span class="tbr-v">—<\/span>/);
});

test('property: any numbers give whole-percent figures in 0..100 or a dash, and a level only for a figure', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), fc.anything(), (cpu, used, busy) => {
    const c = resourcesChip({ machine: { cpu, mem: { usedBytes: used, totalBytes: 100 }, gpu: { busy } }, status: {} });
    for (const s of c.segments) {
      assert.ok(s.value === '—' || /^(\d|[1-9]\d|100)%$/.test(s.value));
      if (s.value === '—') assert.strictEqual(s.level, null);
    }
  }));
});
