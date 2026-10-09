'use strict';
/**
 * What an agent has been doing lately, for the speech bubbles (BACKLOG #80): the last tool NAME and the last few file NAMES,
 * read from hook events. Nothing else is kept: not a command, not a tool's input, never file contents.
 *
 *   createActivity().note({ event, payload })  .of(agent) -> { tool, files }  .size()
 *
 * Keyed by the event's `agent_type` (the same name the mood machine files a run under); the main session has none and is not
 * tracked. A Map, so an agent called `__proto__` is ordinary. At most AGENTS_MAX agents are held, oldest dropped.
 */

const FILES_MAX = 3;
const AGENTS_MAX = 200;
const FILE_KEYS = ['file_path', 'path', 'notebook_path'];

const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() || null : null);

function createActivity() {
  const byAgent = new Map();

  function note(ev) {
    if (!ev || typeof ev !== 'object' || ev.event !== 'PreToolUse') return;
    const p = ev.payload;
    if (!p || typeof p !== 'object' || typeof p.agent_type !== 'string' || !p.agent_type) return;
    const prev = byAgent.get(p.agent_type) || { tool: undefined, files: [] };
    const tool = typeof p.tool_name === 'string' ? p.tool_name : prev.tool;
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    const key = FILE_KEYS.find((k) => baseName(input[k]));
    const files = key ? [baseName(input[key]), ...prev.files.filter((f) => f !== baseName(input[key]))].slice(0, FILES_MAX) : prev.files;
    byAgent.delete(p.agent_type);          // re-set moves it to the end: the oldest is first
    byAgent.set(p.agent_type, { tool, files });
    while (byAgent.size > AGENTS_MAX) byAgent.delete(byAgent.keys().next().value);
  }

  function of(agent) {
    const a = byAgent.get(agent);
    return a ? { tool: a.tool, files: [...a.files] } : { tool: undefined, files: [] };
  }

  return { note, of, size: () => byAgent.size };
}

module.exports = { createActivity };
