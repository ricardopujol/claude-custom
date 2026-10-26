'use strict';
/**
 * app/resources-display.js, the GPU part (BACKLOG #82): the chip's GPU figure and the Resources tab's GPU section. A GPU figure
 * that was not measured reads "—" (or "measuring…" before the second sample), never 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/resources-display');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const base = {
  measuring: false,
  machine: { cpu: 71, mem: { usedBytes: 21.4 * GB, totalBytes: 32 * GB }, ours: { cpu: 12, bytes: 3 * GB } },
  project: { cpu: 0, bytes: 0, rows: [], self: { cpu: 0, bytes: 0, parts: [] } },
  windows: [], background: null,
};
const gpu = (over = {}) => ({ busy: 37, mem: { usedBytes: 4.2 * GB, totalBytes: 8 * GB }, ...over });
const procs = { rows: [{ pid: 110892, name: 'llama-server.exe', bytes: 2.7 * GB, busy: 31 }, { pid: 29044, name: 'dwm.exe', bytes: 500 * MB, busy: 0 }, { pid: 7, name: 'x.exe', bytes: 10 * MB, busy: null }], more: 4 };
const NONE = Symbol('no gpu part');
const payload = (over = {}, g = gpu()) => ({
  model: { ...base, ...(over.model || {}) }, status: { stale: false, expired: false, ageMs: 0 },
  machine: { cpu: 71, mem: { usedBytes: 21.4 * GB, totalBytes: 32 * GB }, ...(g === NONE ? {} : { gpu: g }) }, gpuProcs: procs, ...over, model: { ...base, ...(over.model || {}) },
});
const viewOf = p => D.view(D.withPayload(D.emptyState(), p));

test('chipView: GPU busy follows the memory figure; the text carries it; it never lights the chip', () => {
  const c = D.chipView(payload());
  assert.strictEqual(c.gpuText, 'GPU 37%');
  assert.strictEqual(c.text, 'CPU 71%  21.4 GB / 32.0 GB  GPU 37%');
  assert.strictEqual(c.level, 'amber', 'the CPU alone decides the colour');
  const idle = D.chipView(payload({ machine: { cpu: 5, mem: null, gpu: gpu({ busy: 99 }) } }));
  assert.strictEqual(idle.level, null);
});

test('chipView: an unread GPU is "GPU —", a payload with no GPU part has none, and a real 0 is 0%', () => {
  assert.strictEqual(D.chipView(payload({}, gpu({ busy: null }))).gpuText, 'GPU —');
  assert.strictEqual(D.chipView(payload({}, gpu({ busy: 0 }))).gpuText, 'GPU 0%');
  const without = D.chipView(payload({}, NONE));
  assert.strictEqual(without.gpuText, null);
  assert.strictEqual(without.text, 'CPU 71%  21.4 GB / 32.0 GB');
  assert.strictEqual(D.chipView(null).gpuText, null);
  assert.strictEqual(D.chipView(payload({ status: { expired: true } })).gpuText, 'GPU —', 'expired: unknown, not absent (PR #152 D5)');
  assert.strictEqual(D.chipView(payload({ status: { expired: true } })).text, 'CPU —  — / —  GPU —');
  assert.strictEqual(D.chipView(payload({ status: { expired: true } }, NONE)).gpuText, null, 'expired with no GPU part stays without one');
});

test('view: the GPU section has busy %, memory used of total as bars, and the processes with their figures', () => {
  const g = viewOf(payload()).gpu;
  assert.strictEqual(g.busyFig, '37%');
  assert.deepStrictEqual(g.busyBar, { ours: 0, rest: 37 });
  assert.strictEqual(g.memFig, '4.2 GB / 8.0 GB');
  assert.ok(Math.abs(g.memBar.rest - 52.5) < 1e-9);
  assert.deepStrictEqual(g.procs.map(x => [x.label, x.pid, x.cpuFig, x.memFig]), [
    ['llama-server.exe', 110892, '31%', '2.7 GB'], ['dwm.exe', 29044, '0%', '500 MB'], ['x.exe', 7, '—', '10 MB']]);
  assert.strictEqual(g.procs[2].meter, null, 'an unmeasured busy % has an empty meter');
  assert.strictEqual(g.more, 4);
});

test('view: no GPU part in the payload means no GPU section', () => {
  assert.strictEqual(viewOf(payload({}, NONE)).gpu, null);
  assert.doesNotMatch(D.html(viewOf(payload({}, NONE))), /res-gpu/);
});

test('view: what was not measured is a dash and an empty bar, never 0', () => {
  const g = viewOf(payload({}, { busy: null, mem: null })).gpu;
  assert.strictEqual(g.busyFig, '—');
  assert.strictEqual(g.busyBar, null);
  assert.strictEqual(g.memFig, '—');
  assert.strictEqual(g.memBar, null);
  const noTotal = viewOf(payload({}, gpu({ mem: { usedBytes: 4 * GB, totalBytes: null } }))).gpu;
  assert.strictEqual(noTotal.memFig, '4.0 GB / —');
  assert.strictEqual(noTotal.memBar, null, 'no total, no bar');
  assert.strictEqual(viewOf(payload({}, gpu({ mem: { usedBytes: 4 * GB, totalBytes: 0 } }))).gpu.memBar, null);
});

test('view: before the second sample the busy figure reads "measuring…", like the CPU', () => {
  const g = viewOf(payload({ model: { measuring: true } }, gpu({ busy: null }))).gpu;
  assert.strictEqual(g.busyFig, 'measuring…');
});

test('view: an expired sample turns every GPU figure into a dash and drops the list', () => {
  const g = viewOf(payload({ status: { stale: true, expired: true, ageMs: 99000 } })).gpu;
  assert.deepStrictEqual([g.busyFig, g.memFig, g.busyBar, g.memBar, g.procs.length, g.more], ['—', '—', null, null, 0, 0]);
});

test('view: a missing process list is an empty one', () => {
  assert.deepStrictEqual(viewOf(payload({ gpuProcs: null })).gpu.procs, []);
  assert.deepStrictEqual(viewOf(payload({ gpuProcs: { rows: 'x' } })).gpu.procs, []);
  assert.strictEqual(viewOf(payload({ gpuProcs: { rows: [], more: -2 } })).gpu.more, 0);
  assert.strictEqual(viewOf(payload({ gpuProcs: { rows: [{ pid: 9, name: '', bytes: 5, busy: 1 }], more: 0 } })).gpu.procs[0].label, 'PID 9');
});

test('html: the GPU section follows Machine, shows the bars, the graphs it is handed, and the processes; a name is escaped', () => {
  const p = payload();
  p.gpuProcs = { rows: [{ pid: 5, name: '<img src=x onerror=1>.exe', bytes: GB, busy: 2 }], more: 0 };
  const out = D.html(viewOf(p), { gpuGraphs: '<div class="hg" data-hist-graph="gpu"></div>' });
  assert.ok(out.indexOf('<h3>Machine</h3>') < out.indexOf('res-gpu'));
  assert.ok(out.indexOf('res-gpu') < out.indexOf('This project'));
  assert.match(out, /<h3>GPU <span class="res-sum">37% · 4\.2 GB \/ 8\.0 GB<\/span><\/h3>/);
  assert.match(out, /<span class="res-bl">Busy<\/span>/);
  assert.match(out, /<span class="res-bl">Memory<\/span>/);
  assert.ok(out.includes('data-hist-graph="gpu"'));
  assert.ok(!out.includes('<img'), 'a process name is somebody else\'s string');
  assert.ok(out.includes('&lt;img'));
  assert.match(out, /Holding GPU memory/);
  assert.match(out, /title="PID 5"/);
});

test('html: with nothing listed it says so; graphs are optional and only a string is taken', () => {
  const p = payload();
  p.gpuProcs = { rows: [], more: 0 };
  assert.match(D.html(viewOf(p)), /none listed/);
  assert.doesNotMatch(D.html(viewOf(p)), /hg-name|data-hist-graph/);
  assert.doesNotMatch(D.html(viewOf(p), { gpuGraphs: { toString: () => 'EVIL' } }), /EVIL/);
  assert.match(D.html(viewOf(payload())), /\+4 more/);
});

test('property: an unmeasured GPU figure is never drawn as a number', () => {
  const junk = fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant('12'), fc.constant(NaN), fc.constant({}), fc.constant(Infinity));
  fc.assert(fc.property(junk, junk, junk, (busy, used, total) => {
    const v = viewOf(payload({}, { busy, mem: { usedBytes: used, totalBytes: total } }));
    assert.strictEqual(v.gpu.busyFig, '—');
    assert.strictEqual(v.gpu.busyBar, null);
    assert.strictEqual(v.gpu.memFig, '—');
    assert.strictEqual(v.gpu.memBar, null);
    assert.strictEqual(D.chipView(payload({}, { busy, mem: null })).gpuText, 'GPU —');
  }), { numRuns: 100 });
});
