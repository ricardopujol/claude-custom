'use strict';
/**
 * The Map panel's pure half (BACKLOG #120): this project's sessions and agents as a graph. No DOM, no clock, no randomness of its own:
 * app/map-display.js draws what this says, app/map-layout.js places it.
 *
 *   buildGraph({ project, sessions, agents, claims, totalAgents })  -> { nodes, edges, conflicts, counts }
 *   sessionsFrom({ tree, tabs, self }) / lanesOf(tree)               the sessions and the lane count, from what the Git panel already asks for
 *   agentLook(mood) / tabState(tab) / turnState(turn)                the six states: working needs done error idle unknown
 *   particleRate / adaptBudget / newParticles / stepParticles        the streams, and the frame budget that thins them
 *   shouldAnimate / shouldDraw / particlesOn                         WHEN it may move (the frame-budget rule, see below)
 *   toScreen / toWorld / zoomAt / fitView / hitTest / curvePoint     pan and zoom
 *
 * THE FRAME-BUDGET RULE (BACKLOG #99/#100/#192 paid for it: a breathing border cost 12-20% of a core). The map animates ONLY while it
 * is shown, the window is focused and lean mode is off. Anything unknown (focus not yet reported, lean not given) holds still.
 * Otherwise it draws one static frame and its loop stops.
 *
 * TRUTH RULES. An unknown is never a number: an agent with no known event rate streams at the slowest rate, a tab nobody has heard
 * from is `unknown` (not `idle`), a count nobody gave is a dash. `Number(null)` is 0, so every numeric check here is `typeof`.
 *
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing ONE global scope (test/renderer-scope.test.js). One name
 * leaves it: `mapModel`.
 */
(function (root) {

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const FIT_MAX = 1.25;           // fitting one node must not blow it up to the wheel's maximum
const MAX_AGENTS = 48;
const MAX_SESSIONS = 24;
const RATE_MIN = 1;
const RATE_MAX = 12;
const EVENTS_PER_PARTICLE_MIN = 5;   // events a minute that make one particle a second
const BUDGET_MIN = 0.125;
const SLOW_FRAME_MS = 40;
const GOOD_FRAME_MS = 24;
const MAX_PARTICLES = 160;       // on the whole map: the cost of a frame grows with these, and more than this is not a clearer picture
const EDGE_PARTICLES_MAX = 8;    // on one edge: a short edge with eight in flight already reads as a stream
const TRAVEL_S = 1.6;           // seconds a particle takes from one end of an edge to the other
const MAX_STEP_S = 0.25;        // a longer gap (the page was asleep) is taken as this long: no flood on waking
const PAIRS_PER_PLACE = 6;

const R = { project: 26, session: 15, agent: 14, more: 14 };

const isStr = s => typeof s === 'string' && s !== '';
const isNum = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const list = a => (Array.isArray(a) ? a : []);

// --- states ---------------------------------------------------------------------------------------------------------------

/** A roster card ({ state, detail }) -> the map's state, and whether the agent is drawn at all (a sleeping card is not). */
function agentLook(mood) {
  const state = mood && typeof mood === 'object' ? mood.state : null;
  const detail = mood && typeof mood === 'object' ? mood.detail : null;
  const asks = detail === 'waiting' || detail === 'stuck';
  if (state === 'working') return { state: asks ? 'needs' : 'working', active: true };
  if (state === 'stressed') return { state: asks ? 'needs' : 'error', active: true };
  if (state === 'happy') return { state: 'done', active: true };
  if (state === 'sleeping') return { state: 'idle', active: false };
  return { state: 'unknown', active: false };
}

/** What the shell knows of a worktree's tab ({ open, known, working, needsInput }) -> a session's state. Unknown is never idle. */
function tabState(tab) {
  if (!tab || typeof tab !== 'object' || tab.known !== true) return 'unknown';
  if (tab.needsInput === true) return 'needs';
  if (tab.working === true) return 'working';
  if (tab.working === false) return 'idle';
  return 'unknown';
}

/** The host's measure of this session's turn (host/turn-state.js: 'idle' | 'turn' | 'prompt') -> a state. */
function turnState(turn) {
  if (turn === 'turn') return 'working';
  if (turn === 'prompt') return 'needs';
  if (turn === 'idle') return 'idle';
  return 'unknown';
}

// --- paths ----------------------------------------------------------------------------------------------------------------

const keyOfPath = p => (isStr(p) ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '');
const baseOfPath = p => {
  if (!isStr(p)) return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

// --- the stream's rate ----------------------------------------------------------------------------------------------------

/** Events a minute -> particles a second, 1..12. An unknown rate is the slowest, never none and never fast. */
function particleRate(eventsPerMin) {
  if (!isNum(eventsPerMin)) return RATE_MIN;
  return clamp(eventsPerMin / EVENTS_PER_PARTICLE_MIN, RATE_MIN, RATE_MAX);
}

// --- sessions and lanes ---------------------------------------------------------------------------------------------------

/** The worktrees of the project and how many of them have a pull request; null when the tree isn't known. */
function lanesOf(tree) {
  if (!tree || tree.ok !== true || !Array.isArray(tree.branches)) return null;
  const lanes = tree.branches.filter(b => b && isStr(b.folder));
  return { open: lanes.length, withPr: lanes.filter(b => b.pr !== null && b.pr !== undefined && b.pr !== false && b.pr !== 0).length };
}

/**
 * This window's own session first, then every other worktree whose tab is open in this window.
 *   self { folder, branch, state }   tabs: tab:states' answer for the tree's folders
 */
function sessionsFrom({ tree, tabs, self } = {}) {
  const out = [];
  const seen = new Set();
  if (self && isStr(self.folder)) {
    const key = keyOfPath(self.folder);
    seen.add(key);
    out.push({ id: key, label: isStr(self.branch) ? self.branch : baseOfPath(self.folder), folder: self.folder, state: isStr(self.state) ? self.state : 'unknown', self: true });
  }
  if (tree && tree.ok === true && Array.isArray(tree.branches) && Array.isArray(tabs)) {
    for (const b of tree.branches) {
      if (out.length >= MAX_SESSIONS) break;
      if (!b || !isStr(b.folder) || !isStr(b.name)) continue;
      const key = keyOfPath(b.folder);
      if (seen.has(key)) continue;
      const tab = tabs.find(t => t && keyOfPath(t.folder) === key);
      if (!tab || tab.open !== true) continue;
      seen.add(key);
      out.push({ id: key, label: b.name, folder: b.folder, state: tabState(tab), self: false });
    }
  }
  return out;
}

// --- the graph ------------------------------------------------------------------------------------------------------------

const RANK = { working: 0, needs: 1, error: 2, done: 3, unknown: 4, idle: 5 };

function buildGraph(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const nodes = [];
  const edges = [];
  const ids = new Set();
  const push = (n) => { if (ids.has(n.id)) return false; ids.add(n.id); nodes.push(n); return true; };

  const projectName = inp.project && isStr(inp.project.name) ? inp.project.name : 'project';
  const sessions = [];
  for (const s of list(inp.sessions)) {
    if (!s || typeof s !== 'object' || !isStr(s.id)) continue;
    if (sessions.some(x => x.id === s.id)) continue;
    sessions.push(s);
  }
  const running = sessions.filter(s => s.state === 'working').length;
  const n = sessions.length;
  push({ id: 'project', kind: 'project', label: projectName, sub: `${n} session${n === 1 ? '' : 's'} · ${running} running`, state: running > 0 ? 'working' : 'idle', r: R.project, data: inp.project || null });

  const selfSession = sessions.find(s => s.self === true) || null;
  const sessionById = new Map(sessions.map(s => [s.id, s]));

  // the agents: the roster's active ones, then those only a claim knows (another session's)
  const agents = [];
  const names = new Set();
  const rosterNames = new Set();
  for (const a of list(inp.agents)) {
    if (!a || typeof a !== 'object' || !isStr(a.name)) continue;
    rosterNames.add(a.name);
    if (names.has(a.name)) continue;
    const look = agentLook(a);
    if (!look.active) continue;
    names.add(a.name);
    agents.push({ name: a.name, state: look.state, session: a.session, data: a });
  }
  const placeOf = (worktree) => {
    const key = keyOfPath(worktree);
    return sessions.find(s => keyOfPath(s.folder) === key) || null;
  };
  const claims = list(inp.claims).filter(c => c && typeof c === 'object' && isStr(c.agentId) && isStr(c.worktree));
  for (const c of claims) {
    const name = isStr(c.agent) ? c.agent : c.agentId;
    if (names.has(name) || rosterNames.has(name)) continue;
    names.add(name);
    const home = placeOf(c.worktree);
    agents.push({ name, state: 'working', session: home ? home.id : undefined, data: { name, state: 'working', detail: 'working', worktree: c.worktree, fromClaim: true } });
  }
  agents.sort((a, b) => (RANK[a.state] - RANK[b.state]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shown = agents.slice(0, MAX_AGENTS);
  const leftOut = agents.length - shown.length;

  const workingBy = new Map();      // session id -> does an agent of it work
  const parentOf = (a) => {
    const s = (isStr(a.session) && sessionById.get(a.session)) || selfSession;
    return s || null;
  };
  for (const a of shown) { const p = parentOf(a); if (p && a.state === 'working') workingBy.set(p.id, true); }

  for (const s of sessions) {
    push({ id: 'session:' + s.id, kind: 'session', label: isStr(s.label) ? s.label : s.id, state: isStr(s.state) ? s.state : 'unknown', r: R.session, self: s.self === true, data: s });
    const streams = s.state === 'working' && !workingBy.get(s.id);
    edges.push({ id: `session:${s.id}>project`, from: 'session:' + s.id, to: 'project', kind: 'tree', state: s.state, flow: streams ? particleRate(null) : 0 });
  }
  for (const a of shown) {
    const p = parentOf(a);
    const id = 'agent:' + a.name;
    if (!push({ id, kind: 'agent', label: isStr(a.data.label) ? a.data.label : a.name, state: a.state, r: R.agent, data: a.data })) continue;
    const to = p ? 'session:' + p.id : 'project';
    const rate = a.state === 'working' ? particleRate(a.data.eventsPerMin) : 0;
    edges.push({ id: `${id}>${to}`, from: id, to, kind: 'tree', state: a.state, flow: rate });
  }
  if (leftOut > 0) {
    const to = selfSession ? 'session:' + selfSession.id : 'project';
    push({ id: 'more', kind: 'more', label: `+${leftOut}`, state: 'idle', r: R.more, data: null });
    edges.push({ id: `more>${to}`, from: 'more', to, kind: 'tree', state: 'idle', flow: 0 });
  }

  // two agents claiming one worktree (its own or an `also`) are about to collide
  const conflicts = [];
  const byPlace = new Map();
  for (const c of claims) {
    const name = isStr(c.agent) ? c.agent : c.agentId;
    const nodeId = 'agent:' + name;
    if (!ids.has(nodeId)) continue;
    for (const w of [c.worktree, ...list(c.also).filter(isStr)]) {
      const key = keyOfPath(w);
      if (!byPlace.has(key)) byPlace.set(key, { label: baseOfPath(w) || w, who: new Map() });
      const place = byPlace.get(key);
      if (!place.who.has(nodeId)) place.who.set(nodeId, c);
    }
  }
  for (const [key, place] of byPlace) {
    const who = [...place.who];
    let pairs = 0;
    for (let i = 0; i < who.length; i += 1) {
      for (let j = i + 1; j < who.length && pairs < PAIRS_PER_PLACE; j += 1, pairs += 1) {
        const [a, ca] = who[i];
        const [b, cb] = who[j];
        const e = { id: `conflict:${a}|${b}|${key}`, from: a, to: b, kind: 'conflict', state: 'error', flow: 0, label: place.label, claims: [ca, cb] };
        conflicts.push(e);
        edges.push(e);
      }
    }
  }

  const active = agents.length;
  const total = isNum(inp.totalAgents) ? Math.max(inp.totalAgents, active) : list(inp.agents).length || active;
  return { nodes, edges, conflicts, counts: { sessions: n, running, activeAgents: active, totalAgents: total } };
}

// --- when to animate ------------------------------------------------------------------------------------------------------

/** Motion needs all three to be exactly right: shown, focused, not lean. Unknown (null / missing) holds still. */
function shouldAnimate(view) {
  return !!view && view.shown === true && view.focused === true && view.lean === false;
}

/** A frame is drawn at all only while the panel is on screen and the window is not lean; focus only stops the motion. */
function shouldDraw(view) {
  return !!view && view.shown === true && view.lean !== true;
}

/** Particles are motion: they also need the person not to have asked for less of it. */
function particlesOn(view, reducedMotion) {
  return shouldAnimate(view) && reducedMotion !== true;
}

// --- the frame budget -----------------------------------------------------------------------------------------------------

/** The share of particles allowed (BUDGET_MIN..1): halved by a slow frame (over 40 ms), won back a little by a good one. */
function adaptBudget(scale, frameMs) {
  const s = isNum(scale) ? clamp(scale, BUDGET_MIN, 1) : 1;
  if (!isNum(frameMs)) return s;
  if (frameMs > SLOW_FRAME_MS) return Math.max(BUDGET_MIN, s / 2);
  if (frameMs < GOOD_FRAME_MS) return Math.min(1, s * 1.05);
  return s;
}

// --- particles ------------------------------------------------------------------------------------------------------------

const newParticles = () => ({ list: [], acc: {} });

/**
 * One step of every stream. state { list: [{ e: edge id, t: 0..1, s: speed }], acc }, flows [{ id, rate }] (particles a second),
 * dt seconds, scale the budget (0..1), rng() -> [0,1). Returns a new state; nothing is mutated.
 */
function stepParticles(state, flows, dt, scale, rng) {
  const step = isNum(dt) ? clamp(dt, 0, MAX_STEP_S) : 0;
  const sc = isNum(scale) ? clamp(scale, 0, 1) : 1;
  const rand = typeof rng === 'function' ? rng : Math.random;
  const cap = Math.ceil(MAX_PARTICLES * sc);
  let next = list(state && state.list).map(p => ({ e: p.e, t: p.t + (step / TRAVEL_S) * p.s, s: p.s })).filter(p => p.t < 1);
  if (next.length > cap) next = next.sort((a, b) => a.t - b.t).slice(0, cap);       // a smaller budget drops the ones nearest their end
  const acc = {};
  const perEdge = new Map();
  for (const p of next) perEdge.set(p.e, (perEdge.get(p.e) || 0) + 1);
  for (const f of list(flows)) {
    if (!f || !isStr(f.id) || !isNum(f.rate) || f.rate <= 0) continue;
    const eff = f.rate * sc;
    let a = ((state && state.acc && state.acc[f.id]) || 0) + eff * step;
    const edgeCap = Math.min(EDGE_PARTICLES_MAX, Math.ceil(eff * TRAVEL_S) + 1);
    while (a >= 1) {
      a -= 1;
      if (next.length >= cap || (perEdge.get(f.id) || 0) >= edgeCap) { a = Math.min(a, 1); continue; }
      next.push({ e: f.id, t: 0, s: 0.8 + rand() * 0.4 });
      perEdge.set(f.id, (perEdge.get(f.id) || 0) + 1);
    }
    acc[f.id] = a;
  }
  return { list: next, acc };
}

// --- pan and zoom ---------------------------------------------------------------------------------------------------------
// A view is { x, y, k }: a world point (wx, wy) is drawn at (x + wx*k, y + wy*k) in CSS pixels.

const toScreen = (v, wx, wy) => ({ x: v.x + wx * v.k, y: v.y + wy * v.k });
const toWorld = (v, sx, sy) => ({ x: (sx - v.x) / v.k, y: (sy - v.y) / v.k });

/** Zoom by `factor` about the screen point (sx, sy), which stays where it is. k stays within 0.4..3. */
function zoomAt(v, factor, sx, sy) {
  if (!isNum(factor) || factor <= 0 || !isNum(sx) || !isNum(sy)) return v;
  const k = clamp(v.k * factor, ZOOM_MIN, ZOOM_MAX);
  const f = k / v.k;
  return { x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f, k };
}

/** A view that centres every node (each with its radius `r`) in a w x h window with `pad` to spare. Zoom stays within 0.4..FIT_MAX. */
function fitView(nodes, w, h, pad) {
  const W = isNum(w) && w > 0 ? w : 1;
  const H = isNum(h) && h > 0 ? h : 1;
  const ns = list(nodes).filter(n => n && isNum(n.x) && isNum(n.y));
  if (ns.length === 0) return { x: W / 2, y: H / 2, k: 1 };
  const p = isNum(pad) && pad >= 0 ? pad : 0;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of ns) {
    const r = isNum(n.r) ? n.r : 0;
    x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r); x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
  }
  const bw = Math.max(x1 - x0, 1);
  const bh = Math.max(y1 - y0, 1);
  const k = clamp(Math.min(Math.max(W - 2 * p, 1) / bw, Math.max(H - 2 * p, 1) / bh), ZOOM_MIN, FIT_MAX);
  return { x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k, k };
}

/** The node under a world point (within r + slack): the nearest centre, and among equals the one drawn last. */
function hitTest(nodes, wx, wy, slack) {
  const s = isNum(slack) ? slack : 0;
  let best = null;
  let bestD = Infinity;
  for (const n of list(nodes)) {
    if (!n || !isNum(n.x) || !isNum(n.y)) continue;
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d <= (isNum(n.r) ? n.r : 0) + s && d <= bestD) { best = n; bestD = d; }
  }
  return best;
}

/** A point on the quadratic curve from a to b, bowed `bend` px sideways; t 0..1. */
function curvePoint(a, b, t, bend) {
  const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / len) * bend;
  const cy = my + (dx / len) * bend;
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
}

// --- words ----------------------------------------------------------------------------------------------------------------

function shorten(s, max) {
  if (!isStr(s)) return '';
  if (s.length <= max) return s;
  return max <= 1 ? '…' : s.slice(0, max - 1) + '…';
}

function compact(n) {
  if (!isNum(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function duration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const two = v => String(v).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
}

const API = {
  buildGraph, sessionsFrom, lanesOf, agentLook, tabState, turnState,
  particleRate, adaptBudget, newParticles, stepParticles,
  shouldAnimate, shouldDraw, particlesOn,
  toScreen, toWorld, zoomAt, fitView, hitTest, curvePoint,
  shorten, compact, duration, keyOfPath, baseOfPath,
  ZOOM_MIN, ZOOM_MAX, FIT_MAX, MAX_AGENTS, MAX_SESSIONS, BUDGET_MIN, MAX_PARTICLES, EDGE_PARTICLES_MAX, TRAVEL_S, RATE_MIN, RATE_MAX, R,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.mapModel = API;

})(typeof window !== 'undefined' ? window : globalThis);
