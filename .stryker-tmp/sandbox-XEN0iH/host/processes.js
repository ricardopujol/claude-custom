// @ts-nocheck
'use strict';
/**
 * What is running right now.
 *
 * The harness already receives every tool call's start and finish through the
 * hook bridge, and was throwing that away. A four-minute GPU job or a long test
 * run should visibly be running rather than looking like the session has hung —
 * which is exactly the gap this closes.
 *
 * A call is "running" between its PreToolUse and its PostToolUse. Nothing is
 * polled and no process is inspected; this is bookkeeping over events the host
 * already has.
 */

const MAX_LABEL = 80;

// A dropped hook would otherwise pin an entry as "running" for the rest of the
// session. Showing a stale process forever is worse than showing nothing, so
// anything older than this is swept.
const STALE_MS = 30 * 60 * 1000;

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

  function handle({ event, payload }) {
    const p = payload || {};
    if (event === 'PreToolUse') {
      running.set(keyFor(p), {
        tool: p.tool_name,
        label: labelFor(p.tool_name, p.tool_input),
        startedAt: now(),
      });
      return;
    }
    if (event === 'PostToolUse') {
      const key = keyFor(p);
      if (!running.delete(key)) {
        // No id, or an id that never started: fall back to the first entry with
        // a matching label so a missing correlator does not leak an entry.
        const label = labelFor(p.tool_name, p.tool_input);
        for (const [k, v] of running) {
          if (v.tool === p.tool_name && v.label === label) { running.delete(k); break; }
        }
      }
    }
  }

  function sweep() {
    const t = now();
    for (const [k, v] of running) {
      if (t - v.startedAt > STALE_MS) running.delete(k);
    }
  }

  function list() {
    const t = now();
    // Longest-running first: the slow thing is the one worth seeing.
    return [...running.values()]
      .map(v => ({ tool: v.tool, label: v.label, startedAt: v.startedAt, elapsedMs: t - v.startedAt }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs);
  }

  return { handle, list, sweep };
}

module.exports = { createProcessTracker, STALE_MS };
