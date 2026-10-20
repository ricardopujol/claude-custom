'use strict';
/**
 * What the Map panel asks the host for (BACKLOG #120) and no broadcast carries: hook events counted, per agent over the last minute,
 * the tool an agent has in hand, and when this host started. OBSERVATION ONLY -- the mood machine, occupancy and every other consumer
 * of the hook bridge decide what an event means; this only counts that one happened, so it can't make an agent look busier than it is.
 *
 *   createMapFeed({ now, startedAt, windowMs }) -> { note(ev), snapshot(), size() }
 *   note({ event, payload })   call for every hook event, once
 *   snapshot() -> { events, perMinute: { name: n }, tools: { name: tool }, startedAt, uptimeMs }
 *
 * An agent is keyed by the payload's `agent_type` (what the roster is keyed by too); the main session, which carries no agent_id, is
 * "main". A named teammate is filed under its type, so its rate may belong to a sibling of the same type: the panel treats the rate as
 * a hint for how fast to flow, never as a fact to print. A name is somebody else's string: the maps are Maps and the snapshot's objects
 * have no prototype, so an agent called `constructor` is just data.
 */

const WINDOW_MS = 60_000;
const TOOL_FRESH_MS = 8_000;
const STAMPS_MAX = 600;          // per agent: more than ten events a second is not a rate anyone can draw
const AGENTS_MAX = 200;
const NAME_MAX = 80;

const isStr = s => typeof s === 'string' && s !== '';

function createMapFeed({ now = Date.now, startedAt = now(), windowMs = WINDOW_MS } = {}) {
  let total = 0;
  let lastT = -Infinity;
  const agents = new Map();      // name -> { stamps: [ms], tool: string|null, toolAt: ms }

  function entry(name) {
    let e = agents.get(name);
    if (!e) {
      if (agents.size >= AGENTS_MAX) agents.delete(agents.keys().next().value);
      e = { stamps: [], tool: null, toolAt: 0 };
      agents.set(name, e);
    }
    return e;
  }

  // The wall clock can step BACK (a time sync, a manual fix). Stamps from the future would then never leave the window and an agent would stream at the
  // ceiling for the whole step; so a step back forgets every stamp and tool: the rates start again from the new clock.
  function steady(t) {
    if (t < lastT) for (const e of agents.values()) { e.stamps.length = 0; e.tool = null; }
    lastT = t;
    return t;
  }

  function note(ev) {
    if (!ev || typeof ev !== 'object' || !isStr(ev.event)) return;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const name = isStr(p.agent_type) && isStr(p.agent_id) ? p.agent_type.slice(0, NAME_MAX) : 'main';
    const t = steady(now());
    total += 1;
    const e = entry(name);
    e.stamps.push(t);
    if (e.stamps.length > STAMPS_MAX) e.stamps.splice(0, e.stamps.length - STAMPS_MAX);
    if (isStr(p.tool_name)) {
      if (ev.event === 'PreToolUse') { e.tool = p.tool_name.slice(0, NAME_MAX); e.toolAt = t; }
      else if ((ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') && e.tool === p.tool_name) { e.tool = null; }
    }
  }

  function snapshot() {
    const t = steady(now());
    const perMinute = Object.create(null);
    const tools = Object.create(null);
    for (const [name, e] of agents) {
      const from = t - windowMs;
      let k = 0;
      while (k < e.stamps.length && e.stamps[k] < from) k += 1;
      if (k > 0) e.stamps.splice(0, k);
      if (e.stamps.length > 0) perMinute[name] = e.stamps.length;
      if (e.tool !== null && t - e.toolAt <= TOOL_FRESH_MS) tools[name] = e.tool;
    }
    return { events: total, perMinute, tools, startedAt, uptimeMs: Math.max(0, t - startedAt) };
  }

  return { note, snapshot, size: () => agents.size };
}

module.exports = { createMapFeed, WINDOW_MS, TOOL_FRESH_MS, AGENTS_MAX };
