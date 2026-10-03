'use strict';
/**
 * The launching host's half of worktree occupancy (backlog #44 + #47, DESIGN_WORKTREE_OCCUPANCY.md): hook
 * events in, claim files out. host/agent-occupancy.js decides what an event proves; host/occupancy-store.js
 * writes the file; this keeps what an agent has touched so far and ties the two together.
 *
 *   createOccupancyProducer({ writer, roots, ownRoot, fromBranch, hostPid, hostStartedAt, nameOf, now, log })
 *     .handle(event)          -- never throws
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
 *   SubagentStop  that agent's file is deleted and its touches forgotten.
 *   SessionEnd    every claim this host made is deleted.
 * An agent that touched two worktrees keeps both touches: the latest is its claim, the rest are `also`.
 * The touch book is bounded (AGENTS_MAX agents, TOUCHES_MAX worktrees each), oldest forgotten first.
 */

const { claimFrom, buildClaim, safeAgentId, TOUCH_TOOLS } = require('./agent-occupancy');
const { normPath } = require('./project-layout');

const AGENTS_MAX = 100;
const TOUCHES_MAX = 16;

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
  now = Date.now, log = () => {},
} = {}) {
  const book = new Map();      // agentId -> Map(normPath(worktree) -> { worktree, firstAt, lastAt, count })

  function record(claim) {
    const t = now();
    let touches = book.get(claim.agentId);
    book.delete(claim.agentId);                    // re-inserted last: Map order is "least recently active first"
    if (!touches) touches = new Map();
    book.set(claim.agentId, touches);
    while (book.size > AGENTS_MAX) book.delete(book.keys().next().value);

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
      book.delete(id);
      writer.remove(id);
      return;
    }
    if (event.event === 'SessionEnd') {
      book.clear();
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

  return { handle };
}

module.exports = { createOccupancyProducer, isOccupancyOnly, AGENTS_MAX, TOUCHES_MAX };
