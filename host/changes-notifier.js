'use strict';
/**
 * When the Changes panel is told to look again (BACKLOG #119 A3). The host already sees every hook event; the ones for a tool that
 * can change a file in the worktree (the edit tools, and Bash / PowerShell for everything a command can do) start a two-second
 * quiet timer, and when it runs out every window gets `{ type: 'changes', action: 'changed' }`. The window re-asks for the list
 * only if its panel is showing, so a session nobody is looking at costs no git call.
 *
 *   createChangesNotifier({ announce, setTimer, clearTimer }) -> { handle(event) -> boolean, close() }
 *   isChangingTool(name) -> boolean
 *
 * The edit tools' PostToolUse isn't hooked (see host/settings-writer.js), so the PreToolUse that is hooked starts the timer: the
 * edit lands well inside the two seconds, and a Bash command's PostToolUse starts it again when the command ends.
 */
const DEBOUNCE_MS = 2000;
const CHANGING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);

const isChangingTool = (name) => typeof name === 'string' && CHANGING.has(name);

function createChangesNotifier({ announce, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }, clearTimer = clearTimeout } = {}) {
  let timer = null;

  function handle(event) {
    const p = event && typeof event === 'object' ? event.payload : null;
    if (!p || typeof p !== 'object' || !isChangingTool(p.tool_name)) return false;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      try { announce({ type: 'changes', action: 'changed' }); } catch (err) { console.log('[host] changes announce failed:', err && err.message); }
    }, DEBOUNCE_MS);
    return true;
  }

  function close() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return { handle, close };
}

module.exports = { createChangesNotifier, isChangingTool, DEBOUNCE_MS };
