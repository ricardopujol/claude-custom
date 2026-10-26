'use strict';
/**
 * The Map's force layout (BACKLOG #120): about eighty lines of physics, no d3. Pure: positions in, positions out, a seeded generator
 * for the little randomness a new node needs, so the same graph and seed always draw the same picture (and a test can say so).
 *
 *   createLayout({ seed })      -> layout { pos: Map id -> { x, y, vx, vy }, alpha }
 *   sync(layout, graph)         add new nodes (at their parent, so they ease out), forget gone ones. -> true when anything changed
 *   step(layout, graph)         one tick of the simulation. -> false when it was already at rest (nothing moved)
 *   settled(layout)             true once the picture has cooled: THE LOOP MAY STOP. A layout that never rests keeps a frame loop alive.
 *   apply(layout, graph)        copies positions onto graph.nodes (x, y)
 *   snapshot(layout) / restore(layout, snap)   the picture as { id: [x, y] }, for keeping per project
 *
 * The project is pinned at the origin. Sessions are pulled to a ring round it, agents to a ring round their session (wider when the
 * session has many, so 48 of them don't pile up). Every node repels every other; a collision rule keeps their discs apart.
 */
(function (root) {

const ALPHA_START = 1;
const ALPHA_WAKE = 0.5;          // a new node: warm enough to ease out, not enough to shuffle the whole picture
const ALPHA_GONE = 0.3;
const ALPHA_MIN = 0.02;
const DECAY = 0.98;              // alpha *= DECAY a step: 1 -> 0.02 in about 195 steps
const MAX_STEPS = 300;           // the bound the tests hold settling to
const VELOCITY_KEEP = 0.6;
const CHARGE = 90;
const LINK_K = 0.5;
const GRAVITY = 0.02;
const SESSION_REST = 150;
const AGENT_REST_MIN = 80;
const PAD = 10;                  // clear space between two discs
const MAX_NODES = 100;
const COORD_MAX = 2500;

const isNum = n => typeof n === 'number' && Number.isFinite(n);

function createLayout({ seed } = {}) {
  let s = (isNum(seed) ? seed : 1) >>> 0;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { pos: new Map(), alpha: 0, rng, placed: 0 };
}

const settled = (layout) => layout.alpha < ALPHA_MIN;

const treeEdges = graph => graph.edges.filter(e => e.kind === 'tree');

function sync(layout, graph) {
  const ids = new Set(graph.nodes.map(n => n.id));
  let added = 0; let removed = 0;
  for (const id of [...layout.pos.keys()]) if (!ids.has(id)) { layout.pos.delete(id); removed += 1; }
  const up = new Map();
  for (const e of treeEdges(graph)) if (!up.has(e.from)) up.set(e.from, e.to);
  for (const n of graph.nodes) {
    if (n.kind === 'project') {
      const p = layout.pos.get(n.id);
      if (!p) layout.pos.set(n.id, { x: 0, y: 0, vx: 0, vy: 0 });
      else { p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; }
      continue;
    }
    if (layout.pos.has(n.id)) continue;
    const parent = layout.pos.get(up.get(n.id)) || { x: 0, y: 0 };
    let x = parent.x; let y = parent.y;
    if (n.kind === 'session') {                      // the ring round the project, spread by the golden angle
      const a = layout.placed * 2.399963 + layout.rng() * 0.2;
      x += Math.cos(a) * 20; y += Math.sin(a) * 20;
    } else {
      x += (layout.rng() - 0.5) * 4; y += (layout.rng() - 0.5) * 4;
    }
    layout.placed += 1;
    layout.pos.set(n.id, { x, y, vx: 0, vy: 0 });
    added += 1;
  }
  if (added > 0) layout.alpha = Math.max(layout.alpha, added === layout.pos.size ? ALPHA_START : ALPHA_WAKE);
  else if (removed > 0) layout.alpha = Math.max(layout.alpha, ALPHA_GONE);
  return added > 0 || removed > 0;
}

function step(layout, graph) {
  if (settled(layout)) return false;
  const alpha = layout.alpha;
  const nodes = graph.nodes;
  const P = id => layout.pos.get(id);
  const fixed = n => n.kind === 'project';

  // springs along the tree edges
  const kids = new Map();
  for (const e of treeEdges(graph)) kids.set(e.to, (kids.get(e.to) || 0) + 1);
  for (const e of treeEdges(graph)) {
    const a = P(e.from); const b = P(e.to);
    if (!a || !b) continue;
    const toProject = e.to === 'project';
    const crowd = kids.get(e.to) || 1;
    const rest = toProject ? SESSION_REST + Math.max(0, crowd - 4) * 6 : Math.max(AGENT_REST_MIN, (crowd * 38) / (2 * Math.PI));
    let dx = b.x - a.x; let dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const f = ((d - rest) / d) * alpha * LINK_K;
    dx *= f; dy *= f;
    const fromNode = nodes.find(n => n.id === e.from);
    const toNode = nodes.find(n => n.id === e.to);
    if (!(fromNode && fixed(fromNode))) { a.vx += dx * (toNode && fixed(toNode) ? 1 : 0.5); a.vy += dy * (toNode && fixed(toNode) ? 1 : 0.5); }
    if (!(toNode && fixed(toNode))) { b.vx -= dx * 0.5; b.vy -= dy * 0.5; }
  }

  // every node pushes every other away
  for (let i = 0; i < nodes.length; i += 1) {
    const a = P(nodes[i].id);
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = P(nodes[j].id);
      if (!b) continue;
      let dx = b.x - a.x; let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (layout.rng() - 0.5); dy = (layout.rng() - 0.5); d2 = dx * dx + dy * dy + 0.01; }
      const f = (CHARGE * alpha) / d2;
      if (!fixed(nodes[i])) { a.vx -= dx * f; a.vy -= dy * f; }
      if (!fixed(nodes[j])) { b.vx += dx * f; b.vy += dy * f; }
    }
  }

  // a weak pull to the middle, then move
  for (const n of nodes) {
    const p = P(n.id);
    if (!p || fixed(n)) continue;
    p.vx -= p.x * GRAVITY * alpha; p.vy -= p.y * GRAVITY * alpha;
    p.vx *= VELOCITY_KEEP; p.vy *= VELOCITY_KEEP;
    p.x += p.vx; p.y += p.vy;
  }

  // discs never overlap: pushed apart in position, not in force, so it still holds at the end
  for (let i = 0; i < nodes.length; i += 1) {
    const a = P(nodes[i].id);
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = P(nodes[j].id);
      if (!b) continue;
      const min = nodes[i].r + nodes[j].r + PAD;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= min) continue;
      const push = ((min - d) / (d || 1)) * 0.5;
      const ux = d === 0 ? 1 : dx; const uy = d === 0 ? 0 : dy;
      if (!fixed(nodes[i]) && !fixed(nodes[j])) { a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; }
      else if (fixed(nodes[i])) { b.x += ux * push * 2; b.y += uy * push * 2; }
      else { a.x -= ux * push * 2; a.y -= uy * push * 2; }
    }
  }

  layout.alpha *= DECAY;
  return true;
}

function apply(layout, graph) {
  for (const n of graph.nodes) {
    const p = layout.pos.get(n.id);
    if (p) { n.x = p.x; n.y = p.y; }
  }
}

function snapshot(layout) {
  return Object.fromEntries([...layout.pos].map(([id, p]) => [id, [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]]));
}

/** Takes back a kept picture: only { id: [x, y] } with two finite numbers in range, at most MAX_NODES of them; the rest is ignored. */
function restore(layout, snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return;
  let kept = 0;
  for (const [id, v] of Object.entries(snap)) {
    if (kept >= MAX_NODES) break;
    if (id.length === 0 || id.length > 120) continue;
    if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) continue;
    if (Math.abs(v[0]) > COORD_MAX || Math.abs(v[1]) > COORD_MAX) continue;
    layout.pos.set(id, { x: v[0], y: v[1], vx: 0, vy: 0 });
    kept += 1;
  }
}

const API = { createLayout, sync, step, settled, apply, snapshot, restore, MAX_STEPS, MAX_NODES, ALPHA_MIN };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.mapLayout = API;

})(typeof window !== 'undefined' ? window : globalThis);
