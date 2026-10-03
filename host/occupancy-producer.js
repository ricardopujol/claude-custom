'use strict';
/**
 * The launching host's half of worktree occupancy (backlog #44 + #47, DESIGN_WORKTREE_OCCUPANCY.md): hook
 * events in, claim files out. host/agent-occupancy.js decides what an event proves; host/occupancy-store.js
 * writes the file; this keeps what an agent has touched so far and ties the two together.
 *
 *   createOccupancyProducer({ writer, roots, ownRoot, fromBranch, hostPid, hostStartedAt, nameOf, isTeammate, now, log })
 *     .handle(event)          -- never throws
 *     .tick()                 -- never throws; expires the claims of teammates that have idled too long
 *   teammateFromMeta(payload) -- is the agent of this SubagentStop an in_process_teammate? (its .meta.json)
 *   isOccupancyOnly(event)    -- the PreToolUse for Read/Edit/Write/NotebookEdit/Grep/Glob that the occupancy
 *                                matcher (host/settings-writer.js) brings. host.js hands these to the producer and to
 *                                NOTHING else: their PostToolUse isn't hooked, so the Running panel
 *                                (host/processes.js) would show every Read as running forever.
 *
 * What it does with an event:
 *   PreToolUse    a proven touch (host/agent-occupancy.js claimFrom) is added to the agent's touches and its
 *                 claim file rewritten (the writer throttles `lastAt`). A touch outside every known worktree
 *                 may just be a worktree git hadn't listed yet: when the list is stale it is refreshed and the
 *                 event judged ONCE more -- only for an event that carries an agent_id.
 *   SubagentStop  that agent's file is deleted and its touches forgotten -- UNLESS it is a teammate. A named
 *                 background agent in an interactive session is an `in_process_teammate`: MEASURED
 *                 (verify/probe-teammate-occupancy.js), its SubagentStop is the end of a TURN. It then idles,
 *                 still the one working in that worktree, until SendMessage wakes it. Its claim stays until
 *                 IDLE_MS have passed since its last touch (checked at the stop and on every tick), the
 *                 session ends, or the host exits. A touch wakes it: a WORKING teammate is never expired.
 *   SessionEnd    every claim this host made is deleted.
 * An agent that touched two worktrees keeps both touches: the latest is its claim, the rest are `also`.
 * The touch book is bounded (AGENTS_MAX agents, TOUCHES_MAX worktrees each), oldest forgotten first.
 */

const { claimFrom, buildClaim, safeAgentId, TOUCH_TOOLS } = require('./agent-occupancy');
const { normPath } = require('./project-layout');

const fs = require('fs');

const AGENTS_MAX = 100;
const TOUCHES_MAX = 16;
// How long an idle teammate keeps its claim after its last touch. The same 10 minutes as the transcript
// producer's staleness (host/occupancy-transcripts.js STALE_MS): one rule for "it has gone quiet".
const IDLE_MS = 10 * 60 * 1000;
const TEAMMATE = 'in_process_teammate';

/**
 * Is the agent of this SubagentStop payload a teammate? Read off the `.meta.json` Claude Code writes beside
 * the agent's transcript (`agent_transcript_path`): `taskKind` is `in_process_teammate`. Anything else --
 * no path, no file, not JSON -- is "not known to be one": false, and the claim goes as it always did.
 */
function teammateFromMeta(payload, { readFileSync = fs.readFileSync } = {}) {
  const file = payload && typeof payload === 'object' ? payload.agent_transcript_path : null;
  if (typeof file !== 'string' || !/.jsonl$/.test(file)) return false;
  try {
    const meta = JSON.parse(readFileSync(file.replace(/.jsonl$/, '.meta.json'), 'utf8'));
    return !!meta && typeof meta === 'object' && meta.taskKind === TEAMMATE;
  } catch {
    return false;
  }
}

function isOccupancyOnly(event) {
  return !!event && typeof event === 'object' && event.event === 'PreToolUse'
    && !!event.payload && typeof event.payload === 'object' && TOUCH_TOOLS.has(event.payload.tool_name);
}

// An event that could be an agent working somewhere: worth a git call if the list of worktrees is stale.
function couldClaim(event) {
  const p = event.payload;
  return event.event === 'PreToolUse' && !!p && typeof p === 'object' && safeAgentId(p.agent_id) !== null
    && (TOUCH_TOOLS.has(p.tool_name) || p.tool_name === 'Bash');
}

function createOccupancyProducer({
  writer, roots, ownRoot, fromBranch = () => null, hostPid, hostStartedAt = () => null, nameOf = () => null,
  isTeammate = () => false, now = Date.now, log = () => {}, idleMs = IDLE_MS,
} = {}) {
  const book = new Map();      // agentId -> Map(normPath(worktree) -> { worktree, firstAt, lastAt, count })
  const idle = new Set();      // teammates that ended a turn and have not touched anything since

  function drop(id) {
    book.delete(id);
    idle.delete(id);
    writer.remove(id);
  }

  // An idle teammate whose last touch is idleMs old has gone quiet: its claim goes. true when it went.
  function expire(id) {
    const touches = book.get(id);
    const last = touches ? Math.max(...[...touches.values()].map(t => t.lastAt)) : -Infinity;
    if (now() - last < idleMs) return false;
    drop(id);
    return true;
  }

  function record(claim) {
    const t = now();
    let touches = book.get(claim.agentId);
    book.delete(claim.agentId);                    // re-inserted last: Map order is "least recently active first"
    if (!touches) touches = new Map();
    book.set(claim.agentId, touches);
    idle.delete(claim.agentId);                    // a touch: it is working again
    while (book.size > AGENTS_MAX) { const oldest = book.keys().next().value; book.delete(oldest); idle.delete(oldest); }

    const key = normPath(claim.worktree);
    const prev = touches.get(key);
    touches.delete(key);
    touches.set(key, { worktree: claim.worktree, firstAt: prev ? prev.firstAt : t, lastAt: t, count: (prev ? prev.count : 0) + 1 });
    while (touches.size > TOUCHES_MAX) touches.delete(touches.keys().next().value);

    const rec = buildClaim({
      agentId: claim.agentId,
      agent: claim.agent || nameOf(claim.agentId) || null,
      fromBranch: fromBranch(),
      fromRoot: ownRoot,
      hostPid,
      hostStartedAt: hostStartedAt(),
      touches: [...touches.values()],
    });
    if (rec === null) return;
    const out = writer.write(rec);
    if (out && out.ok === false) log('[occupancy] claim not written:', out.error);
  }

  function dispatch(event) {
    if (!event || typeof event !== 'object') return;
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (event.event === 'SubagentStop') {
      const id = safeAgentId(p.agent_id);
      if (id === null) return;
      let mate = false;
      try { mate = book.has(id) && isTeammate(p) === true; } catch { mate = false; }
      if (!mate) { drop(id); return; }
      idle.add(id);
      expire(id);
      return;
    }
    if (event.event === 'SessionEnd') {
      book.clear();
      idle.clear();
      writer.removeAll();
      return;
    }
    if (event.event !== 'PreToolUse') return;
    const claim = claimFrom(event, roots.get(), ownRoot);
    if (claim !== null) { record(claim); return; }
    if (couldClaim(event) && roots.stale()) {
      Promise.resolve()
        .then(() => roots.refresh())
        .then(() => {
          const again = claimFrom(event, roots.get(), ownRoot);
          if (again !== null) record(again);
        })
        .catch(err => log('[occupancy] retry after refreshing the worktree list failed:', err && err.message));
    }
  }

  function handle(event) {
    try { dispatch(event); } catch (err) { log('[occupancy] could not handle an event:', err && err.message); }
  }

  function tick() {
    try {
      for (const id of [...idle]) expire(id);
    } catch (err) {
      log('[occupancy] could not expire an idle claim:', err && err.message);
    }
  }

  return { handle, tick };
}

module.exports = { createOccupancyProducer, isOccupancyOnly, teammateFromMeta, AGENTS_MAX, TOUCHES_MAX, IDLE_MS };
