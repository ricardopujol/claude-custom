'use strict';
/**
 * When the Changes panel is told to look again (BACKLOG #119 A3). The host already sees every hook event. The ones that say a file
 * may have changed start a two-second quiet timer, and when it runs out every window gets `{ type: 'changes', action: 'changed' }`.
 * The window re-asks for the list only if its panel is showing, so a session nobody is looking at costs no git call.
 *
 *   createChangesNotifier({ announce, setTimer, clearTimer, now }) -> { handle(event) -> boolean, close() }
 *   isChangingTool(name), isChangesOnly(event)
 *
 * WHAT ARMS IT (PR #199 Dexter 2 + Miguel Y1). A PreToolUse fires BEFORE the permission prompt, so with prompts on, the edit can
 * land minutes after it and a timer armed only by the Pre fires on an unchanged tree. So it is armed by:
 *   - PreToolUse of a changing tool (an auto-approved edit lands inside the two seconds);
 *   - PostToolUse and PostToolUseFailure of a changing tool (the edit has landed; host/settings-writer.js `changes: true` hooks the Post
 *     of the edit tools and PowerShell, Bash's Post is hooked already);
 *   - Stop and SubagentStop (the end of a turn or a subagent: a last look at what it left).
 * A background Bash gets its Post at launch, before the command writes; the next event or the Stop catches what it wrote.
 *
 * MAX WAIT (Dexter 5). Each event pushes the timer back, which on its own would never fire during a turn whose events arrive every
 * second or two. So the timer never waits past MAX_WAIT_MS from the first event of a burst.
 */
const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 10000;
const CHANGING_TOOLS = Object.freeze(new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']));
// The tools whose PostToolUse only this feature hooks: those events end here and never reach the mood engine or the Running panel.
const POST_ONLY_TOOLS = Object.freeze(new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'PowerShell']));
const END_EVENTS = new Set(['Stop', 'SubagentStop']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const isChangingTool = (name) => typeof name === 'string' && CHANGING_TOOLS.has(name);

function isChangesOnly(event) {
  const p = event && typeof event === 'object' ? event.payload : null;
  return !!p && typeof p === 'object' && event.event === 'PostToolUse' && typeof p.tool_name === 'string' && POST_ONLY_TOOLS.has(p.tool_name);
}

function createChangesNotifier({
  announce, now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }, clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let burstStart = 0;

  const arms = (event) => {
    if (!event || typeof event !== 'object') return false;
    if (END_EVENTS.has(event.event)) return true;
    const p = event.payload;
    return TOOL_EVENTS.has(event.event) && !!p && typeof p === 'object' && isChangingTool(p.tool_name);
  };

  function handle(event) {
    if (!arms(event)) return false;
    const t = now();
    if (timer !== null) clearTimer(timer); else burstStart = t;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, burstStart + MAX_WAIT_MS - t));
    timer = setTimer(() => {
      timer = null;
      try { announce({ type: 'changes', action: 'changed' }); } catch (err) { console.log('[host] changes announce failed:', err && err.message); }
    }, wait);
    return true;
  }

  function close() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return { handle, close };
}

module.exports = { createChangesNotifier, isChangingTool, isChangesOnly, DEBOUNCE_MS, MAX_WAIT_MS, CHANGING_TOOLS, POST_ONLY_TOOLS };
