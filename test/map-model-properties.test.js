'use strict';
/**
 * PROPERTIES of the Map panel's arithmetic (BACKLOG #120): what must hold for ANY view, node set or frame time, not just the examples.
 * Zoom round-trips and stays in range, fit contains every node it can, the budget stays in range, and a graph is always well formed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const M = require('../app/map-model');

const RUNS = { numRuns: Number(process.env.MAP_RUNS) || 300 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const coord = fc.double({ min: -2000, max: 2000, noNaN: true });
const viewArb = fc.record({ x: coord, y: coord, k: fc.double({ min: M.ZOOM_MIN, max: M.ZOOM_MAX, noNaN: true }) });
const nodeArb = fc.record({ x: coord, y: coord, r: fc.double({ min: 4, max: 30, noNaN: true }) });
const factorArb = fc.double({ min: 0.05, max: 20, noNaN: true });

test('P1: toWorld undoes toScreen for any view', () => {
  fc.assert(fc.property(viewArb, coord, coord, (v, x, y) => {
    const s = M.toScreen(v, x, y);
    const w = M.toWorld(v, s.x, s.y);
    assert.ok(near(w.x, x) && near(w.y, y));
  }), RUNS);
});

test('P2: zoom keeps k in 0.4..3 and the point under the pointer where it was', () => {
  fc.assert(fc.property(viewArb, factorArb, coord, coord, (v, f, sx, sy) => {
    const z = M.zoomAt(v, f, sx, sy);
    assert.ok(z.k >= M.ZOOM_MIN - 1e-12 && z.k <= M.ZOOM_MAX + 1e-12);
    const w = M.toWorld(v, sx, sy);
    const s = M.toScreen(z, w.x, w.y);
    assert.ok(near(s.x, sx, 1e-6) && near(s.y, sy, 1e-6), 'the pointer\'s world point has not moved');
  }), RUNS);
});

test('P3: zooming in then out by the same factor returns to the same view, unless the clamp bit', () => {
  fc.assert(fc.property(viewArb, fc.double({ min: 1, max: 1.6, noNaN: true }), coord, coord, (v, f, sx, sy) => {
    const up = M.zoomAt(v, f, sx, sy);
    fc.pre(up.k < M.ZOOM_MAX - 1e-9 && v.k > M.ZOOM_MIN + 1e-9);
    const back = M.zoomAt(up, 1 / f, sx, sy);
    assert.ok(near(back.k, v.k) && near(back.x, v.x, 1e-6) && near(back.y, v.y, 1e-6));
  }), RUNS);
});

test('P4: fit contains every node whenever the zoom it needs is within range, and always puts the middle in the middle', () => {
  fc.assert(fc.property(fc.array(nodeArb, { minLength: 1, maxLength: 60 }), fc.integer({ min: 200, max: 1600 }), fc.integer({ min: 150, max: 1200 }), fc.integer({ min: 0, max: 60 }), (nodes, w, h, pad) => {
    const v = M.fitView(nodes, w, h, pad);
    assert.ok(v.k >= M.ZOOM_MIN && v.k <= M.FIT_MAX);
    // the bounding box centre sits at the window's centre
    const x0 = Math.min(...nodes.map(n => n.x - n.r)); const x1 = Math.max(...nodes.map(n => n.x + n.r));
    const y0 = Math.min(...nodes.map(n => n.y - n.r)); const y1 = Math.max(...nodes.map(n => n.y + n.r));
    const c = M.toScreen(v, (x0 + x1) / 2, (y0 + y1) / 2);
    assert.ok(near(c.x, w / 2) && near(c.y, h / 2));
    if (v.k > M.ZOOM_MIN + 1e-9) {          // not pinned at the floor: then everything is inside, padding included
      for (const n of nodes) {
        const p = M.toScreen(v, n.x, n.y);
        assert.ok(p.x - n.r * v.k >= pad - 1e-6 && p.x + n.r * v.k <= w - pad + 1e-6, 'x');
        assert.ok(p.y - n.r * v.k >= pad - 1e-6 && p.y + n.r * v.k <= h - pad + 1e-6, 'y');
      }
    }
  }), RUNS);
});

test('P5: the particle budget never leaves BUDGET_MIN..1, and a slow frame never raises it', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 5, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }), (scale, ms) => {
    const next = M.adaptBudget(scale, ms);
    assert.ok(next >= M.BUDGET_MIN && next <= 1);
    const was = Math.min(1, Math.max(M.BUDGET_MIN, scale));
    if (ms > 40) assert.ok(next <= was);
  }), RUNS);
  // repeated slow frames reach the floor, and repeated good ones come back to full
  let s = 1;
  for (let i = 0; i < 20; i += 1) s = M.adaptBudget(s, 80);
  assert.strictEqual(s, M.BUDGET_MIN);
  for (let i = 0; i < 200; i += 1) s = M.adaptBudget(s, 8);
  assert.strictEqual(s, 1);
});

test('P6: the rate is always 1..12, whatever the number', () => {
  fc.assert(fc.property(fc.oneof(fc.double(), fc.constant(null), fc.constant(undefined), fc.string()), (v) => {
    const r = M.particleRate(v);
    assert.ok(r >= 1 && r <= 12);
  }), RUNS);
});

test('P7: particles stay on their edges, in 0..1, within the cap, whatever the flows and gaps', () => {
  const flowArb = fc.array(fc.record({ id: fc.constantFrom('a', 'b', 'c', 'd'), rate: fc.double({ min: -3, max: 30, noNaN: true }) }), { maxLength: 6 });
  fc.assert(fc.property(fc.array(fc.tuple(flowArb, fc.double({ min: 0, max: 5, noNaN: true })), { minLength: 1, maxLength: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 1e6 }), (steps, scale, seed) => {
    let s = seed >>> 0;
    const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    let st = M.newParticles();
    for (const [flows, dt] of steps) {
      st = M.stepParticles(st, flows, dt, scale, rng);
      assert.ok(st.list.length <= Math.ceil(M.MAX_PARTICLES * scale));
      for (const p of st.list) assert.ok(p.t >= 0 && p.t < 1 && ['a', 'b', 'c', 'd'].includes(p.e));
    }
  }), RUNS);
});

test('P8: a graph is always well formed: unique ids, every edge between real nodes, never more than 48 agents, counts add up', () => {
  const nameArb = fc.constantFrom('dexter', 'miguel', 'paris', 'mortimer', 'x', 'y', 'z', 'a1', 'a2', 'a3');
  const moodArb = fc.constantFrom({ state: 'working', detail: 'working' }, { state: 'working', detail: 'waiting' }, { state: 'happy', detail: 'happy' }, { state: 'stressed', detail: 'stressed' }, { state: 'sleeping', detail: 'sleeping' });
  const agentArb = fc.record({ name: nameArb, mood: moodArb, eventsPerMin: fc.oneof(fc.double({ min: -5, max: 500, noNaN: true }), fc.constant(null)), session: fc.constantFrom('s1', 's2', 'gone', undefined) })
    .map(({ name, mood, ...rest }) => ({ name, ...mood, ...rest }));
  const sessionArb = fc.record({ id: fc.constantFrom('s1', 's2', 's3'), label: fc.string({ maxLength: 12 }), folder: fc.constantFrom('C:\\p\\a', 'C:\\p\\b', 'C:\\p\\c'), state: fc.constantFrom('working', 'needs', 'idle', 'unknown'), self: fc.boolean() });
  const claimArb = fc.record({ agentId: fc.constantFrom('i1', 'i2', 'i3', 'i4'), agent: nameArb, worktree: fc.constantFrom('C:\\p\\a', 'C:\\p\\b', 'c:/p/a/'), also: fc.constantFrom([], ['C:\\p\\c']) });
  fc.assert(fc.property(fc.array(sessionArb, { maxLength: 8 }), fc.array(agentArb, { maxLength: 80 }), fc.array(claimArb, { maxLength: 8 }), (sessions, agents, claims) => {
    const g = M.buildGraph({ project: { name: 'p' }, sessions, agents, claims });
    const ids = g.nodes.map(n => n.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(g.nodes.filter(n => n.kind === 'project').length, 1);
    assert.ok(g.nodes.filter(n => n.kind === 'agent').length <= M.MAX_AGENTS);
    const edgeIds = g.edges.map(e => e.id);
    assert.strictEqual(new Set(edgeIds).size, edgeIds.length, 'edge ids are unique');
    for (const e of g.edges) assert.ok(ids.includes(e.from) && ids.includes(e.to) && e.from !== e.to, `edge ${e.id}`);
    for (const e of g.edges) assert.ok(e.flow >= 0 && e.flow <= 12);
    for (const e of g.edges.filter(x => x.flow > 0)) assert.ok(e.state === 'working', 'only working things stream');
    for (const c of g.conflicts) assert.ok(c.kind === 'conflict' && c.claims.length === 2);
    // every non-project node has a way home: follow tree edges to the project
    for (const n of g.nodes.filter(x => x.kind !== 'project')) {
      let at = n.id; let hops = 0;
      while (at !== 'project' && hops < 5) { const up = g.edges.find(e => e.kind === 'tree' && e.from === at); if (!up) break; at = up.to; hops += 1; }
      assert.strictEqual(at, 'project', `${n.id} reaches the project`);
    }
  }), RUNS);
});
