'use strict';
/**
 * Is a turn running in this session's MAIN conversation, or is a dialog waiting on you?
 *
 * PR #93 Dexter F1 / F2. The Git drawer's *Type /merged* types into a session, so it must know the
 * session is at rest. The subagent roster can't say that (a main-session turn that calls no agent
 * touches no subagent's state, host/mood-machine.js), and "needs you" is attention state (a glance clears
 * it). This is measured from the hooks Claude Code itself fires, and from nothing else:
 *
 *   SessionStart          known from here on; startup / resume / clear start at rest (compact is
 *                         mid-session and changes nothing)
 *   UserPromptSubmit      a turn opened
 *   a tool event of the   a turn is open: the main session calls tools only inside a turn (this also
 *   MAIN session          covers a UserPromptSubmit whose pipe write was lost)
 *   Notification          a dialog is open: a permission prompt, an elicitation, an agent asking. No
 *                         type at all is an older CLI, which can't be told apart: read as a dialog
 *   Stop                  the turn is over -- unless it lists background agents still running: their
 *                         results start the next turn on their own, so it stays open until a later Stop,
 *                         or Claude Code's idle_prompt once every agent it waited on has stopped
 *   idle_prompt           Claude Code says it's waiting at the prompt: the turn is over (an interrupted
 *                         turn fires no Stop). It never closes a dialog
 *   SessionEnd            unknown again
 *
 * snapshot() is 'idle' | 'turn' | 'prompt', or null when this host hasn't seen the session start.
 * Unknown is not idle: the gate treats null as "can't tell". Only the CLI's own events move it; no
 * timers (a settle timer once fired "finished" into a working session, test/source-contracts.test.js).
 */

const { NEEDS_INPUT } = require('./attention');

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const CLEAN_STARTS = new Set(['startup', 'resume', 'clear']);
// A Stop's background_tasks: the same reading as host/attention.js (fail closed on an unknown status).
const ENDED = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped', 'error']);
const isRunningAgent = t => t != null &&
  (t.type === 'subagent' || typeof t.agent_type === 'string') && !ENDED.has(t.status);
const ENDED_MEMORY = 200;

function createTurnState() {
  let known = false;
  let turn = false;
  let dialog = false;
  // A Stop held open by background agents: the ids it waits on, and how many it can't name
  let held = null;
  const ended = new Set();

  const snapshot = () => (!known ? null : dialog ? 'prompt' : turn ? 'turn' : 'idle');

  function apply(event, p) {
    if (event === 'SessionStart') {
      known = true;
      if (CLEAN_STARTS.has(p.source)) { turn = false; dialog = false; held = null; }
      return;
    }
    if (event === 'SessionEnd') { known = false; turn = false; dialog = false; held = null; ended.clear(); return; }
    if (event === 'UserPromptSubmit') { turn = true; dialog = false; held = null; return; }
    if (TOOL_EVENTS.has(event)) {
      // any tool moving means a dialog was answered; only the MAIN session's calls prove a turn
      dialog = false;
      if (!(typeof p.agent_id === 'string' && p.agent_id)) turn = true;
      return;
    }
    if (event === 'Notification') {
      if (p.notification_type === 'idle_prompt') {
        if (held === null || (held.ids.size === 0 && held.unnamed === 0)) { turn = false; held = null; }
        return;
      }
      if (p.notification_type === undefined || NEEDS_INPUT.has(p.notification_type)) dialog = true;
      return;
    }
    if (event === 'SubagentStop') {
      if (typeof p.agent_id === 'string' && p.agent_id) {
        ended.add(p.agent_id);
        if (ended.size > ENDED_MEMORY) ended.delete(ended.values().next().value);
        if (held !== null) held.ids.delete(p.agent_id);
      }
      return;
    }
    if (event === 'Stop') {
      dialog = false;
      const running = (Array.isArray(p.background_tasks) ? p.background_tasks : [])
        .filter(isRunningAgent).filter(t => !ended.has(t.id));
      if (running.length) {
        const ids = new Set(running.map(t => t.id).filter(id => typeof id === 'string' && id));
        held = { ids, unnamed: running.length - ids.size };
        turn = true;
      } else {
        held = null;
        turn = false;
      }
    }
  }

  /** Feeds one hook event; answers whether the snapshot changed. */
  function handle(ev) {
    if (!ev || typeof ev.event !== 'string') return false;
    const before = snapshot();
    apply(ev.event, ev.payload && typeof ev.payload === 'object' ? ev.payload : {});
    return snapshot() !== before;
  }

  return { handle, snapshot };
}

module.exports = { createTurnState };
