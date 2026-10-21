'use strict';
/**
 * app/map-layout.js (BACKLOG #120): the Map's force layout. Pure and deterministic given a seed; it must settle and then STOP
 * (a layout that never rests keeps the animation loop alive, which is the cost this project refuses).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const M = require('../app/map-model');
const L = require('../app/map-layout');

const sess = (id, o = {}) => ({ id, label: id, state: 'idle', self: false, folder: `C:\\p\\${id}`, ...o });
const ag = (name, o = {}) => ({ name, state: 'working', detail: 'working', ...o });

function graphOf(nSessions, nAgents) {
  const sessions = Array.from({ length: nSessions }, (_, i) => sess('s' + i, { self: i === 0 }));
  const agents = Array.from({ length: nAgents }, (_, i) => ag('a' + String(i).padStart(2, '0'), { session: sessions.length ? 's' + (i % nSessions) : undefined }));
  return M.buildGraph({ project: { name: 'p' }, sessions, agents });
}

const run = (layout, graph, steps) => { for (let i = 0; i < steps; i += 1) L.step(layout, graph); };
const pos = (layout, graph) => graph.nodes.map(n => [n.id, layout.pos.get(n.id).x, layout.pos.get(n.id).y]);

test('the same seed and graph give the same picture; another seed gives another', () => {
  const g = graphOf(3, 8);
  const a = L.createLayout({ seed: 7 }); L.sync(a, g); run(a, g, 120);
  const b = L.createLayout({ seed: 7 }); L.sync(b, g); run(b, g, 120);
  const c = L.createLayout({ seed: 8 }); L.sync(c, g); run(c, g, 120);
  assert.deepStrictEqual(pos(a, g), pos(b, g));
  assert.notDeepStrictEqual(pos(a, g), pos(c, g));
});

test('the project stays at the centre', () => {
  const g = graphOf(3, 8);
  const l = L.createLayout({ seed: 1 }); L.sync(l, g); run(l, g, 200);
  const p = l.pos.get('project');
  assert.deepStrictEqual([p.x, p.y], [0, 0]);
});

test('a new node enters at its parent and eases out, not from the corner', () => {
  const g1 = graphOf(2, 2);
  const l = L.createLayout({ seed: 3 }); L.sync(l, g1); run(l, g1, 300);
  const g2 = M.buildGraph({ project: { name: 'p' }, sessions: [sess('s0', { self: true }), sess('s1')], agents: [ag('a00', { session: 's0' }), ag('a01', { session: 's1' }), ag('newcomer', { session: 's1' })] });
  L.sync(l, g2);
  const n = l.pos.get('agent:newcomer'); const parent = l.pos.get('session:s1');
  assert.ok(Math.hypot(n.x - parent.x, n.y - parent.y) < 6, 'born on its parent');
  run(l, g2, 120);
  const after = l.pos.get('agent:newcomer');
  assert.ok(Math.hypot(after.x - parent.x, after.y - parent.y) > 20, 'and moved out to its own place');
});

test('syncing the same graph again changes nothing and does not wake a settled layout', () => {
  const g = graphOf(2, 4);
  const l = L.createLayout({ seed: 5 }); L.sync(l, g); run(l, g, 400);
  assert.strictEqual(L.settled(l), true);
  const before = JSON.stringify(pos(l, g));
  assert.strictEqual(L.sync(l, g), false, 'nothing changed');
  assert.strictEqual(L.settled(l), true);
  assert.strictEqual(JSON.stringify(pos(l, g)), before);
});

test('a gone node is forgotten; a new one wakes the layout', () => {
  const g = graphOf(2, 4);
  const l = L.createLayout({ seed: 5 }); L.sync(l, g); run(l, g, 400);
  const smaller = graphOf(2, 3);
  assert.strictEqual(L.sync(l, smaller), true);
  assert.ok(!l.pos.has('agent:a03'));
  run(l, smaller, 400);
  assert.strictEqual(L.settled(l), true);
  assert.strictEqual(L.sync(l, graphOf(2, 5)), true);
  assert.strictEqual(L.settled(l), false);
});

test('it settles, and once settled step() does nothing (the loop can stop)', () => {
  const g = graphOf(4, 30);
  const l = L.createLayout({ seed: 2 }); L.sync(l, g);
  let n = 0;
  while (!L.settled(l) && n < 1000) { L.step(l, g); n += 1; }
  assert.ok(n <= L.MAX_STEPS, `settled in ${n} steps`);
  const before = JSON.stringify(pos(l, g));
  assert.strictEqual(L.step(l, g), false, 'a step on a settled layout reports no movement');
  assert.strictEqual(JSON.stringify(pos(l, g)), before);
});

test('settled nodes do not sit on top of each other', () => {
  const g = graphOf(3, 18);
  const l = L.createLayout({ seed: 11 }); L.sync(l, g);
  while (!L.settled(l)) L.step(l, g);
  let worst = Infinity;
  for (const a of g.nodes) for (const b of g.nodes) {
    if (a.id >= b.id) continue;
    const pa = l.pos.get(a.id); const pb = l.pos.get(b.id);
    worst = Math.min(worst, Math.hypot(pa.x - pb.x, pa.y - pb.y) / (a.r + b.r));
  }
  assert.ok(worst >= 1, `closest pair is ${worst.toFixed(2)} of its two radii apart`);
});

test('the whole picture stays within a sane box even with 48 agents', () => {
  const g = graphOf(5, 48);
  const l = L.createLayout({ seed: 4 }); L.sync(l, g);
  while (!L.settled(l)) L.step(l, g);
  for (const [, x, y] of pos(l, g)) assert.ok(Math.abs(x) < 1500 && Math.abs(y) < 1500);
});

test('snapshot and restore bring the same picture back, already at rest', () => {
  const g = graphOf(3, 6);
  const a = L.createLayout({ seed: 9 }); L.sync(a, g);
  while (!L.settled(a)) L.step(a, g);
  const snap = L.snapshot(a);
  const b = L.createLayout({ seed: 100 });
  L.restore(b, snap);
  L.sync(b, g);
  assert.deepStrictEqual(L.snapshot(b), snap, 'to the tenth of a pixel, which is what is kept');
  assert.strictEqual(L.settled(b), true, 'nothing new, so nothing moves');
});

test('restore ignores junk: non-finite numbers, wild distances, wrong shapes', () => {
  const l = L.createLayout({ seed: 1 });
  L.restore(l, { a: [1, 2], b: [NaN, 3], c: [1e9, 0], d: 'x', e: [1], f: null, g: [0, -1e9], h: [4, 5, 6] });
  assert.deepStrictEqual([...l.pos.keys()], ['a']);
  L.restore(l, null);
  L.restore(l, 'nope');
  L.restore(l, [1, 2]);
  assert.ok(l.pos.size <= 2);
  assert.ok(Object.keys(L.snapshot(l)).length <= 2);
});

test('a snapshot holds at most as many nodes as a graph can have', () => {
  const l = L.createLayout({ seed: 1 });
  const snap = {};
  for (let i = 0; i < 500; i += 1) snap['n' + i] = [i, i];
  L.restore(l, snap);
  assert.ok(l.pos.size <= L.MAX_NODES);
});

test('P: any graph size is finite, bounded and settles', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 1e6 }), (ns, na, seed) => {
    const g = graphOf(ns, na);
    const l = L.createLayout({ seed });
    L.sync(l, g);
    let n = 0;
    while (!L.settled(l) && n < 1000) { L.step(l, g); n += 1; }
    assert.ok(n <= L.MAX_STEPS);
    for (const [, x, y] of pos(l, g)) assert.ok(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 2500 && Math.abs(y) < 2500);
  }), { numRuns: Number(process.env.MAP_RUNS) || 60 });
});
