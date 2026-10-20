'use strict';
/**
 * app/map-model.js (BACKLOG #120): the Map panel's pure half. What is a node, what is an edge, which agents conflict, how fast a
 * stream flows, when the panel may animate, and the pan/zoom arithmetic. The drawing is app/map-display.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const M = require('../app/map-model');

const sess = (id, o = {}) => ({ id, label: id, state: 'idle', self: false, folder: `C:\\p\\${id}`, ...o });
const ag = (name, o = {}) => ({ name, state: 'working', detail: 'working', ...o });

// --- states ---------------------------------------------------------------------------------------------------------------

test('an agent card maps to one of six states; a sleeping card is not active', () => {
  assert.deepStrictEqual(M.agentLook({ state: 'working', detail: 'reading' }), { state: 'working', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'working', detail: 'waiting' }), { state: 'needs', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'working', detail: 'stuck' }), { state: 'needs', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'stressed', detail: 'stressed' }), { state: 'error', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'happy', detail: 'happy' }), { state: 'done', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'sleeping', detail: 'sleeping' }), { state: 'idle', active: false });
  assert.deepStrictEqual(M.agentLook(null), { state: 'unknown', active: false });
  assert.deepStrictEqual(M.agentLook({ state: 'dancing' }), { state: 'unknown', active: false });
});

test('a session tab maps to working / needs / idle / unknown, and unknown is never idle', () => {
  assert.strictEqual(M.tabState({ open: true, known: true, working: true, needsInput: false }), 'working');
  assert.strictEqual(M.tabState({ open: true, known: true, working: true, needsInput: true }), 'needs');
  assert.strictEqual(M.tabState({ open: true, known: true, working: false, needsInput: false }), 'idle');
  assert.strictEqual(M.tabState({ open: true, known: false, working: null, needsInput: null }), 'unknown');
  assert.strictEqual(M.tabState(null), 'unknown');
  assert.strictEqual(M.turnState('turn'), 'working');
  assert.strictEqual(M.turnState('prompt'), 'needs');
  assert.strictEqual(M.turnState('idle'), 'idle');
  assert.strictEqual(M.turnState(null), 'unknown');
  assert.strictEqual(M.turnState(undefined), 'unknown');
});

// --- the stream's rate ----------------------------------------------------------------------------------------------------

test('particle rate follows events per minute, clamped to 1..12 a second', () => {
  assert.strictEqual(M.particleRate(0), 1);
  assert.strictEqual(M.particleRate(5), 1);
  assert.strictEqual(M.particleRate(30), 6);
  assert.strictEqual(M.particleRate(60), 12);
  assert.strictEqual(M.particleRate(100000), 12);
  assert.strictEqual(M.particleRate(-4), 1);
});

test('an unknown event rate is the slowest stream, never a fast one and never none (Number(null) is 0)', () => {
  for (const v of [null, undefined, NaN, Infinity, '30', {}]) assert.strictEqual(M.particleRate(v), 1, String(v));
});

// --- the graph ------------------------------------------------------------------------------------------------------------

test('the project is the centre; each session hangs off it; each active agent off its session', () => {
  const g = M.buildGraph({
    project: { name: 'demo' },
    sessions: [sess('a', { self: true, state: 'working' }), sess('b')],
    agents: [ag('dexter', { session: 'a' }), ag('miguel', { session: 'a', state: 'sleeping', detail: 'sleeping' })],
  });
  const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.deepStrictEqual(g.nodes.map(n => n.kind).sort(), ['agent', 'project', 'session', 'session']);
  assert.strictEqual(byId.project.label, 'demo');
  assert.ok(byId['agent:dexter'], 'the working agent is drawn');
  assert.ok(!byId['agent:miguel'], 'a sleeping one is not (the roster has it)');
  const edge = (from, to) => g.edges.find(e => e.from === from && e.to === to);
  assert.ok(edge('session:a', 'project') && edge('session:b', 'project'));
  assert.ok(edge('agent:dexter', 'session:a'));
});

test('the project node says how many sessions and how many run', () => {
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a', { state: 'working' }), sess('b', { state: 'needs' }), sess('c')], agents: [] });
  assert.strictEqual(g.nodes.find(n => n.kind === 'project').sub, '3 sessions · 1 running');
  const one = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a')], agents: [] });
  assert.strictEqual(one.nodes.find(n => n.kind === 'project').sub, '1 session · 0 running');
});

test('only a WORKING agent streams, from the agent to its session, at the rate its events set', () => {
  const g = M.buildGraph({
    project: { name: 'p' }, sessions: [sess('a', { self: true })],
    agents: [ag('w', { eventsPerMin: 30 }), ag('n', { detail: 'waiting' }), ag('d', { state: 'happy', detail: 'happy' }), ag('x', { state: 'stressed', detail: 'stressed' })],
  });
  const flow = id => g.edges.find(e => e.from === 'agent:' + id).flow;
  assert.strictEqual(flow('w'), 6);
  assert.strictEqual(flow('n'), 0);
  assert.strictEqual(flow('d'), 0);
  assert.strictEqual(flow('x'), 0);
  assert.strictEqual(g.edges.find(e => e.from === 'agent:n').state, 'needs');
});

test('a working session with no active subagent streams from itself to the project; one with an agent working does not', () => {
  const lone = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a', { state: 'working' })], agents: [] });
  assert.ok(lone.edges.find(e => e.from === 'session:a').flow >= 1);
  const busy = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a', { state: 'working' })], agents: [ag('w', { session: 'a' })] });
  assert.strictEqual(busy.edges.find(e => e.from === 'session:a').flow, 0);
  const idle = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a')], agents: [] });
  assert.strictEqual(idle.edges.find(e => e.from === 'session:a').flow, 0);
});

test('an agent with no (or an unknown) session hangs off the self session, else the project', () => {
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [sess('a'), sess('s', { self: true })], agents: [ag('x'), ag('y', { session: 'gone' })] });
  assert.ok(g.edges.find(e => e.from === 'agent:x' && e.to === 'session:s'));
  assert.ok(g.edges.find(e => e.from === 'agent:y' && e.to === 'session:s'));
  const bare = M.buildGraph({ project: { name: 'p' }, sessions: [], agents: [ag('x')] });
  assert.ok(bare.edges.find(e => e.from === 'agent:x' && e.to === 'project'));
});

test('more than 48 active agents: the busiest 48 are drawn and one "+n" node counts the rest', () => {
  const agents = [];
  for (let i = 0; i < 60; i += 1) agents.push(ag('a' + String(i).padStart(2, '0'), { state: i < 5 ? 'working' : 'happy', detail: i < 5 ? 'working' : 'happy' }));
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [sess('s', { self: true })], agents });
  assert.strictEqual(g.nodes.filter(n => n.kind === 'agent').length, 48);
  const more = g.nodes.find(n => n.kind === 'more');
  assert.strictEqual(more.label, '+12');
  for (let i = 0; i < 5; i += 1) assert.ok(g.nodes.some(n => n.id === 'agent:a0' + i), 'a working agent is never the one left out');
  assert.ok(g.edges.some(e => e.from === more.id));
  const exactly = M.buildGraph({ project: { name: 'p' }, sessions: [], agents: agents.slice(0, 48) });
  assert.ok(!exactly.nodes.some(n => n.kind === 'more'));
});

test('an agent is drawn under its persona when the roster has one, under its role otherwise; its id is always the role', () => {
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [], agents: [ag('logic-reviewer', { label: 'Dexter' }), ag('plain'), ag('bad', { label: 7 })] });
  const by = Object.fromEntries(g.nodes.map(n => [n.id, n.label]));
  assert.strictEqual(by['agent:logic-reviewer'], 'Dexter');
  assert.strictEqual(by['agent:plain'], 'plain');
  assert.strictEqual(by['agent:bad'], 'bad');
});

test('the header numbers: active of total agents', () => {
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [], agents: [ag('a'), ag('b', { state: 'sleeping', detail: 'sleeping' })], totalAgents: 9 });
  assert.deepStrictEqual({ active: g.counts.activeAgents, total: g.counts.totalAgents }, { active: 1, total: 9 });
  const noTotal = M.buildGraph({ project: { name: 'p' }, sessions: [], agents: [ag('a'), ag('b', { state: 'sleeping', detail: 'sleeping' })] });
  assert.strictEqual(noTotal.counts.totalAgents, 2);
});

test('hostile input does not throw and draws nothing it should not', () => {
  for (const bad of [undefined, null, {}, { sessions: 'x', agents: 7 }, { sessions: [null, {}, 3], agents: [null, {}, { name: 5 }] }]) {
    const g = M.buildGraph(bad);
    assert.ok(g.nodes.some(n => n.kind === 'project'));
    assert.ok(g.nodes.every(n => typeof n.id === 'string' && n.id));
  }
  const dup = M.buildGraph({ sessions: [sess('a'), sess('a')], agents: [ag('x'), ag('x')] });
  assert.strictEqual(new Set(dup.nodes.map(n => n.id)).size, dup.nodes.length, 'ids are unique');
});

// --- conflicts ------------------------------------------------------------------------------------------------------------

const claim = (agentId, agent, worktree, also = []) => ({ agentId, agent, worktree, also, lastAt: 1 });

test('two agents claiming the same worktree get a red dashed edge named for it', () => {
  const g = M.buildGraph({
    project: { name: 'p' }, sessions: [sess('s', { self: true })], agents: [ag('dexter'), ag('miguel')],
    claims: [claim('i1', 'dexter', 'C:\\p\\feat-x'), claim('i2', 'miguel', 'c:/p/feat-x/')],
  });
  assert.strictEqual(g.conflicts.length, 1);
  const c = g.conflicts[0];
  assert.strictEqual(c.kind, 'conflict');
  assert.deepStrictEqual([c.from, c.to].sort(), ['agent:dexter', 'agent:miguel']);
  assert.strictEqual(c.label, 'feat-x');
  assert.strictEqual(c.claims.length, 2);
  assert.ok(g.edges.includes(c));
});

test('a claim an agent also made counts: touching a second worktree is a second place to collide', () => {
  const g = M.buildGraph({
    project: { name: 'p' }, sessions: [], agents: [ag('a'), ag('b')],
    claims: [claim('1', 'a', 'C:\\p\\one', ['C:\\p\\two']), claim('2', 'b', 'C:\\p\\two')],
  });
  assert.strictEqual(g.conflicts.length, 1);
  assert.strictEqual(g.conflicts[0].label, 'two');
});

test('no conflict for one agent alone, the same agent twice, different worktrees', () => {
  const none = c => M.buildGraph({ project: { name: 'p' }, sessions: [], agents: [ag('a'), ag('b')], claims: c }).conflicts.length;
  assert.strictEqual(none([claim('1', 'a', 'C:\\p\\x')]), 0);
  assert.strictEqual(none([claim('1', 'a', 'C:\\p\\x'), claim('2', 'a', 'C:\\p\\x')]), 0, 'two instances of one name are one node');
  assert.strictEqual(none([claim('1', 'a', 'C:\\p\\x'), claim('2', 'b', 'C:\\p\\y')]), 0);
  assert.strictEqual(none([claim('1', 'a', 'C:\\p\\x'), claim('2', 'ghost', 'C:\\p\\x')]), 1, 'a claim-only agent is drawn, so it can collide');
  assert.strictEqual(none(null), 0);
  assert.strictEqual(none([null, {}, claim('', 'a', 'C:\\p\\x')]), 0);
});

test('an agent only a claim knows (another session\'s) is drawn, working, on the session whose folder it writes in', () => {
  const g = M.buildGraph({
    project: { name: 'p' }, sessions: [sess('s', { self: true, folder: 'C:\\p\\dev' }), sess('l', { folder: 'C:\\p\\feat-l' })], agents: [],
    claims: [claim('9', 'builder', 'C:\\p\\feat-l')],
  });
  const n = g.nodes.find(x => x.id === 'agent:builder');
  assert.ok(n);
  assert.strictEqual(n.state, 'working');
  assert.ok(g.edges.find(e => e.from === 'agent:builder' && e.to === 'session:l'));
});

// --- lanes and sessions from the git tree ---------------------------------------------------------------------------------

test('lanes: the worktrees of the project, and how many have a pull request', () => {
  const tree = { ok: true, branches: [
    { name: 'feat/a', folder: 'C:\\p\\feat-a', pr: 12 }, { name: 'feat/b', folder: 'C:\\p\\feat-b', pr: null },
    { name: 'old', folder: null, pr: 3 }, { name: 'feat/c', folder: 'C:\\p\\feat-c', pr: { number: 4 } },
  ] };
  assert.deepStrictEqual(M.lanesOf(tree), { open: 3, withPr: 2 });
  assert.strictEqual(M.lanesOf(null), null);
  assert.strictEqual(M.lanesOf({ ok: false }), null);
  assert.strictEqual(M.lanesOf({ ok: true, branches: 'x' }), null);
});

test('sessions: this window\'s own, then every other worktree whose tab is open; a closed tab is no session', () => {
  const tree = { ok: true, branches: [{ name: 'feat/a', folder: 'C:\\p\\feat-a' }, { name: 'feat/b', folder: 'C:\\p\\feat-b' }, { name: 'feat/self', folder: 'C:\\p\\dev' }] };
  const tabs = [
    { folder: 'C:\\p\\feat-a', open: true, known: true, working: true, needsInput: false },
    { folder: 'C:\\p\\feat-b', open: false, known: false, working: null, needsInput: null },
    { folder: 'C:\\p\\dev', open: true, known: true, working: false, needsInput: false },
  ];
  const s = M.sessionsFrom({ tree, tabs, self: { folder: 'C:\\p\\dev', branch: 'develop', state: 'needs' } });
  assert.deepStrictEqual(s.map(x => [x.label, x.state, x.self]), [['develop', 'needs', true], ['feat/a', 'working', false]]);
  assert.strictEqual(s[1].folder, 'C:\\p\\feat-a');
});

test('sessions: with no tree and no tabs there is still this window\'s own session', () => {
  const s = M.sessionsFrom({ tree: null, tabs: null, self: { folder: 'C:\\p\\dev', branch: null, state: 'unknown' } });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].self, true);
  assert.strictEqual(s[0].label, 'dev');
  assert.strictEqual(M.sessionsFrom({ tree: null, tabs: null, self: null }).length, 0);
});

// --- when to animate ------------------------------------------------------------------------------------------------------

test('it animates only while shown, focused and not lean; anything unknown holds still', () => {
  const t = { shown: true, focused: true, lean: false };
  assert.strictEqual(M.shouldAnimate(t), true);
  for (const k of ['shown', 'focused']) assert.strictEqual(M.shouldAnimate({ ...t, [k]: false }), false, k);
  assert.strictEqual(M.shouldAnimate({ ...t, lean: true }), false);
  assert.strictEqual(M.shouldAnimate({ shown: true, focused: null, lean: false }), false, 'unknown focus holds still');
  assert.strictEqual(M.shouldAnimate({ shown: true, focused: true }), false, 'unknown lean holds still');
  assert.strictEqual(M.shouldAnimate(null), false);
});

test('it draws at all only while shown and not lean (focus only stops the motion)', () => {
  assert.strictEqual(M.shouldDraw({ shown: true, focused: false, lean: false }), true);
  assert.strictEqual(M.shouldDraw({ shown: false, focused: true, lean: false }), false);
  assert.strictEqual(M.shouldDraw({ shown: true, focused: true, lean: true }), false);
  assert.strictEqual(M.shouldDraw(null), false);
});

test('particles need motion allowed: prefers-reduced-motion turns them off', () => {
  const v = { shown: true, focused: true, lean: false };
  assert.strictEqual(M.particlesOn(v, false), true);
  assert.strictEqual(M.particlesOn(v, true), false);
  assert.strictEqual(M.particlesOn({ ...v, focused: false }, false), false);
});

// --- the frame budget -----------------------------------------------------------------------------------------------------

test('the particle budget halves when a frame takes over 40 ms, recovers slowly, and stays in range', () => {
  assert.strictEqual(M.adaptBudget(1, 41), 0.5);
  assert.strictEqual(M.adaptBudget(0.5, 60), 0.25);
  assert.strictEqual(M.adaptBudget(M.BUDGET_MIN, 500), M.BUDGET_MIN);
  assert.strictEqual(M.adaptBudget(1, 10), 1);
  assert.ok(M.adaptBudget(0.5, 10) > 0.5 && M.adaptBudget(0.5, 10) < 0.6, 'a good frame wins back a little');
  assert.strictEqual(M.adaptBudget(0.5, 30), 0.5, 'a middling frame changes nothing');
  assert.strictEqual(M.adaptBudget(0.5, NaN), 0.5);
  assert.strictEqual(M.adaptBudget(NaN, 10), 1);
});

// --- particles ------------------------------------------------------------------------------------------------------------

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

test('particles are born at the edge\'s rate, travel from 0 to 1, and are gone at the end', () => {
  let st = M.newParticles();
  const flows = [{ id: 'e', rate: 10 }];
  for (let i = 0; i < 10; i += 1) st = M.stepParticles(st, flows, 0.1, 1, lcg(1));
  assert.ok(st.list.length >= 8 && st.list.length <= 12, `~10 born in a second, got ${st.list.length}`);
  assert.ok(st.list.every(p => p.e === 'e' && p.t >= 0 && p.t < 1));
  for (let i = 0; i < 40; i += 1) st = M.stepParticles(st, [], 0.1, 1, lcg(2));
  assert.strictEqual(st.list.length, 0, 'with no flow they all arrive and vanish');
});

test('a smaller budget makes fewer particles, and the total is capped', () => {
  const run = (scale, rate, edges) => {
    let st = M.newParticles();
    const flows = Array.from({ length: edges }, (_, i) => ({ id: 'e' + i, rate }));
    for (let i = 0; i < 100; i += 1) st = M.stepParticles(st, flows, 0.05, scale, lcg(3));
    return st.list.length;
  };
  assert.ok(run(0.25, 12, 1) < run(1, 12, 1));
  assert.ok(run(1, 12, 200) <= M.MAX_PARTICLES);
  assert.ok(run(0.125, 12, 200) <= Math.ceil(M.MAX_PARTICLES * 0.125));
});

test('one edge never holds more than eight particles, however fast its rate', () => {
  let st = M.newParticles();
  for (let i = 0; i < 60; i += 1) st = M.stepParticles(st, [{ id: 'e', rate: 12 }], 0.05, 1, lcg(i + 1));
  assert.strictEqual(M.EDGE_PARTICLES_MAX, 8);
  assert.ok(st.list.length > 0 && st.list.length <= 8, `held ${st.list.length}`);
});

test('a huge dt (the tab was asleep) does not flood the screen', () => {
  const st = M.stepParticles(M.newParticles(), [{ id: 'e', rate: 12 }], 3600, 1, lcg(4));
  assert.ok(st.list.length <= 12 * 3, `got ${st.list.length}`);
});

// --- pan and zoom ---------------------------------------------------------------------------------------------------------

test('zoom is clamped to 0.4..3 and keeps the point under the pointer still', () => {
  const v = { x: 10, y: 20, k: 1 };
  const z = M.zoomAt(v, 2, 100, 100);
  assert.strictEqual(z.k, 2);
  const w = M.toWorld(v, 100, 100);
  const s = M.toScreen(z, w.x, w.y);
  assert.ok(Math.abs(s.x - 100) < 1e-9 && Math.abs(s.y - 100) < 1e-9);
  assert.strictEqual(M.zoomAt(v, 100, 0, 0).k, 3);
  assert.strictEqual(M.zoomAt(v, 0.0001, 0, 0).k, 0.4);
  assert.deepStrictEqual(M.zoomAt(v, NaN, 0, 0), v);
});

test('fit centres the nodes and contains every one of them', () => {
  const nodes = [{ x: -100, y: -50, r: 20 }, { x: 300, y: 80, r: 14 }, { x: 0, y: 200, r: 26 }];
  const v = M.fitView(nodes, 520, 400, 24);
  for (const n of nodes) {
    const p = M.toScreen(v, n.x, n.y);
    assert.ok(p.x - n.r * v.k >= -1e-6 && p.x + n.r * v.k <= 520 + 1e-6, 'x inside');
    assert.ok(p.y - n.r * v.k >= -1e-6 && p.y + n.r * v.k <= 400 + 1e-6, 'y inside');
  }
});

test('fit of nothing, or of a zero-size window, is a sane view', () => {
  assert.deepStrictEqual(M.fitView([], 520, 400, 24), { x: 260, y: 200, k: 1 });
  const v = M.fitView([{ x: 0, y: 0, r: 10 }], 0, 0, 24);
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && v.k >= 0.4 && v.k <= 3);
});

test('hit test picks the node under a world point (the nearest, then the one drawn last)', () => {
  const nodes = [{ id: 'a', x: 0, y: 0, r: 10 }, { id: 'b', x: 25, y: 0, r: 10 }];
  assert.strictEqual(M.hitTest(nodes, 2, 1, 0).id, 'a');
  assert.strictEqual(M.hitTest(nodes, 24, 0, 0).id, 'b');
  assert.strictEqual(M.hitTest(nodes, 100, 100, 0), null);
  assert.strictEqual(M.hitTest(nodes, 14, 0, 0), null, 'in the gap between them');
  assert.strictEqual(M.hitTest(nodes, 14, 0, 4).id, 'b', 'slack widens the target, and the nearer centre wins');
  assert.strictEqual(M.hitTest([], 0, 0, 0), null);
});

test('a curve between two nodes starts and ends on them', () => {
  const a = { x: 0, y: 0 }; const b = { x: 100, y: 40 };
  assert.deepStrictEqual(M.curvePoint(a, b, 0, 12), { x: 0, y: 0 });
  assert.deepStrictEqual(M.curvePoint(a, b, 1, 12), { x: 100, y: 40 });
  assert.deepStrictEqual(M.curvePoint(a, b, 0.5, 0), { x: 50, y: 20 });
});

test('a label shortens to fit, never to nothing', () => {
  assert.strictEqual(M.shorten('feat/activity-map', 10), 'feat/acti…');
  assert.strictEqual(M.shorten('abc', 10), 'abc');
  assert.strictEqual(M.shorten('', 10), '');
  assert.strictEqual(M.shorten(null, 10), '');
  assert.strictEqual(M.shorten('abcdef', 1), '…');
});

test('compact numbers and durations for the strip', () => {
  assert.strictEqual(M.compact(0), '0');
  assert.strictEqual(M.compact(999), '999');
  assert.strictEqual(M.compact(1500), '1.5k');
  assert.strictEqual(M.compact(2_000_000), '2M');
  assert.strictEqual(M.compact(null), '—');
  assert.strictEqual(M.duration(5000), '5s');
  assert.strictEqual(M.duration(125000), '2m 05s');
  assert.strictEqual(M.duration(3 * 3600000 + 4 * 60000), '3h 04m');
  assert.strictEqual(M.duration(null), '—');
  assert.strictEqual(M.duration(-1), '—');
});
