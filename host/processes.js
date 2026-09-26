'use strict';
/**
 * What is running right now.
 *
 * The harness already receives every tool call's start and finish through the
 * hook bridge, and was throwing that away. A four-minute GPU job or a long test
 * run should visibly be running rather than looking like the session has hung —
 * which is exactly the gap this closes.
 *
 * A call is "running" from its PreToolUse until its own close arrives --
 * PostToolUse on success, PostToolUseFailure on failure. Nothing is polled and
 * no process is inspected (a hook payload carries no PID to inspect); this is
 * bookkeeping over events the host already has.
 *
 * PostToolUseFailure is the one that was missing. A failed call NEVER fires
 * PostToolUse, so every non-zero Bash exit sat in the panel as "running" until
 * the sweep -- measured by verify/probe-failure-payloads.js on 2026-09-25.
 *
 * Backstops, for a close that is lost anyway, keyed on who OWNS the call (the
 * payload's agent_id; absent means the main session):
 *   SubagentStop(agent_id) -> that subagent's open calls end
 *   Stop                   -> the main session's open calls end. NOT a
 *                             subagent's: a background agent outlives its
 *                             parent's turn, and Stop fires first (measured).
 *   SessionEnd             -> everything ends (/clear kills background
 *                             agents: verify/probe-clear-background.js)
 * A call ended by a backstop is shown as "stale" for a short while rather than
 * vanishing, because its own close never came -- and a missed event nobody can
 * see is how this bug went unnoticed.
 */

const MAX_LABEL = 80;

// A dropped hook would otherwise pin an entry as "running" for the rest of the
// session. Showing a stale process forever is worse than showing nothing, so
// anything older than this is swept.
const STALE_MS = 30 * 60 * 1000;

// How long a call ended by a backstop stays visible as "stale".
const STALE_SHOW_MS = 2 * 60 * 1000;

const CLOSE_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

function labelFor(toolName, input) {
  const i = input || {};
  const raw =
    i.subagent_type ||
    i.command ||
    i.description ||
    i.file_path ||
    i.pattern ||
    toolName ||
    'tool';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + '…' : text;
}

// Two concurrent runs of the same command are two processes, so the id is used
// when present. Without one, the command text is the only correlator available
// — imperfect for identical concurrent calls, but far better than not tracking.
function keyFor(payload) {
  const p = payload || {};
  if (p.tool_use_id) return String(p.tool_use_id);
  return `${p.tool_name}:${JSON.stringify(p.tool_input ?? null)}`;
}

function createProcessTracker({ now = Date.now } = {}) {
  const running = new Map();

  // Ends every still-running call `owns` accepts, keeping it visible as stale.
  // Returns how many it ended, so the host can log that a close went missing.
  function endOwned(owns) {
    const t = now();
    let ended = 0;
    for (const v of running.values()) {
      if (v.endedAt === null && owns(v.owner)) { v.endedAt = t; ended++; }
    }
    return ended;
  }

  function handle({ event, payload }) {
    const p = payload || {};
    if (event === 'PreToolUse') {
      running.set(keyFor(p), {
        tool: p.tool_name,
        label: labelFor(p.tool_name, p.tool_input),
        owner: p.agent_id ?? null,
        startedAt: now(),
        endedAt: null,
      });
      return 0;
    }
    if (CLOSE_EVENTS.has(event)) {
      // A close with an id closes that id or nothing. Falling back by label
      // there deleted a still-running twin whose sibling had been swept
      // (Dexter F2).
      if (p.tool_use_id) { running.delete(keyFor(p)); return 0; }
      // No id at all: fall back to a matching label so a missing correlator does
      // not leak an entry -- but only a RUNNING call of the SAME owner, or it
      // closes a stale row and leaves the live one running forever (Miguel 1),
      // or closes another agent's call. Not by key: an id-less key is the
      // command text, which a stale twin shares.
      const label = labelFor(p.tool_name, p.tool_input);
      const owner = p.agent_id ?? null;
      for (const [k, v] of running) {
        if (v.endedAt === null && v.owner === owner && v.tool === p.tool_name && v.label === label) {
          running.delete(k);
          break;
        }
      }
      return 0;
    }
    // No agent_id means no way to know which calls were its. Guessing would
    // end a background agent's live command, so it ends nothing.
    if (event === 'SubagentStop') return p.agent_id ? endOwned(o => o === p.agent_id) : 0;
    if (event === 'Stop') return endOwned(o => o === null);
    // Measured: /clear fires SessionEnd (reason "clear") and KILLS background
    // agents, so every open call is over -- ended visibly, not wiped.
    if (event === 'SessionEnd') return endOwned(() => true);
    return 0;
  }

  // Returns how many entries it removed: a sweep that empties the list must
  // still be announced, or the panel keeps showing the last row.
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [k, v] of running) {
      if (v.endedAt === null ? t - v.startedAt > STALE_MS : t - v.endedAt >= STALE_SHOW_MS) {
        running.delete(k);
        removed++;
      }
    }
    return removed;
  }

  function list() {
    const t = now();
    // Longest-running first: the slow thing is the one worth seeing. A stale
    // entry's clock stopped when it was ended.
    return [...running.values()]
      .map(v => ({
        tool: v.tool,
        label: v.label,
        state: v.endedAt === null ? 'running' : 'stale',
        startedAt: v.startedAt,
        elapsedMs: (v.endedAt ?? t) - v.startedAt,
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs);
  }

  return { handle, list, sweep };
}

module.exports = { createProcessTracker, STALE_MS, STALE_SHOW_MS };
