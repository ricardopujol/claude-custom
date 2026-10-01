'use strict';
/**
 * When a session wants you back.
 *
 * Two moments matter, and they are not the same:
 *
 *   Notification -> the session is BLOCKED waiting for input. Urgent: nothing
 *                   progresses until you answer.
 *   Stop         -> the turn finished. Worth knowing, not urgent.
 *
 * Deliberately NOT SubagentStop: subagents stop constantly during one piece of
 * work, and notifying on those would fire dozens of times per task, which
 * trains you to ignore the notifications entirely. (It is READ, below, only to
 * know when a held-back "finished" is due.)
 *
 * The host decides WHAT is worth raising; app/attention-surface.js decides
 * where it goes. An OS toast only appears when the window is NOT focused —
 * if you are already looking at it, the in-window cue has said it. The rule
 * below gates every surface, not only the toast (Ricardo, 2026-10-01).
 */

const { EventEmitter } = require('events');
const { summarize } = require('./attention-summary');

// ONLY when it needs you, or is really done (Ricardo, 2026-10-01). Notification
// also fires for an idle reminder (60 s after a turn ends -- the same "finished"
// again), a login, a quota event, an MCP form closing... Of its
// `notification_type`s, these are the ones that are waiting on you. A type added
// later raises nothing until it is named here (the hook log names every type,
// so a new one is visible). No type at all is an older CLI, which can't be told
// apart, so it raises as it always did.
const NEEDS_INPUT = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

// Stop fires at the end of every TURN, and a turn ends while background agents
// are still working -- their results start the next one. It lists them in
// `background_tasks`, each { id, type: 'subagent', status: 'running',
// agent_type, description } (measured: test/hooks-real-subagent-failure.
// fixture.jsonl). A running agent means the work isn't finished. A shell left
// running (a dev server) is not work waiting to finish, so only agents count:
// type 'subagent', or anything naming an agent_type. A status that isn't a
// known end is read as running (Dexter F2: fail closed -- the backstop below
// resolves a wrong guess; failing open would toast mid-work).
const ENDED = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped', 'error']);
const isRunningAgent = t => t != null &&
  (t.type === 'subagent' || typeof t.agent_type === 'string') && !ENDED.has(t.status);
const runningAgents = p => (Array.isArray(p.background_tasks) ? p.background_tasks.filter(isRunningAgent) : []);

// Stop can fire more than once around a single turn ending, and two toasts for
// one event is how a notification system loses its credibility.
const DEFAULT_DEBOUNCE_MS = 4000;

// A held-back "finished" whose agents have all stopped, with no new turn: how
// long the main session must stay quiet before it is raised anyway.
const DEFAULT_SETTLE_MS = 60000;
// A pending backstop is no reason for a process to stay alive.
function unrefTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

// `agents` is a provider, not a value: the roster changes between the moment
// attention is wired up and the moment a turn ends.
function createAttention({ now = Date.now, project = '', agents = () => [],
                          debounceMs = DEFAULT_DEBOUNCE_MS, settleMs = DEFAULT_SETTLE_MS,
                          setTimer = unrefTimer, clearTimer = clearTimeout } = {}) {
  const emitter = new EventEmitter();
  // Debounced per KIND, not globally: a request for input must not be swallowed
  // because a turn happened to end a moment earlier.
  const lastSent = new Map();

  // A Stop held back while agents ran (Dexter, notify F1): the agent ids it
  // waited on, or null. Nothing guarantees another Stop -- a SubagentStop that
  // lands just after (the measured 1 ms race), a resume that never notifies,
  // a follow-up turn that ends in StopFailure -- so once every one of them has
  // stopped, "finished" comes from the first of: a clean Stop, Claude Code's
  // own idle_prompt, or `settleMs` of a quiet main session.
  let held = null;
  let timer = null;

  function raise(kind, { title, body, urgent }) {
    const t = now();
    const previous = lastSent.get(kind);
    if (previous !== undefined && t - previous < debounceMs) return;
    lastSent.set(kind, t);
    emitter.emit('attention', { kind, project, title, body, urgent, at: t });
  }

  function finished(p) {
    raise('finished', {
      title: project ? `${project} finished` : 'Claude finished',
      body: summarize('Stop', p, { agents: agents() }),
      urgent: false,
    });
  }

  function disarm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function release() { held = null; disarm(); }
  const settled = () => held !== null && held.ids.size === 0 && held.unnamed === 0;
  function arm() {
    disarm();
    timer = setTimer(() => { timer = null; if (settled()) { release(); finished({}); } }, settleMs);
  }

  function handle({ event, payload }) {
    const p = payload || {};

    if (event === 'Notification') {
      if (p.notification_type === 'idle_prompt' && settled()) { release(); finished({}); return; }
      if (p.notification_type !== undefined && !NEEDS_INPUT.has(p.notification_type)) return;
      raise('input-needed', {
        title: project ? `${project} needs you` : 'Claude needs you',
        body: summarize('Notification', p, {}),
        urgent: true,
      });
      return;
    }

    if (event === 'Stop') {
      release();
      const running = runningAgents(p);
      if (running.length) {
        const ids = new Set(running.map(t => t.id).filter(id => typeof id === 'string' && id));
        // One with no id can't be crossed off: only a later Stop resolves it.
        held = { ids, unnamed: running.length - ids.size };
        return;
      }
      finished(p);
      return;
    }

    if (held === null) return;
    if (event === 'SubagentStop') {
      if (held.ids.delete(p.agent_id) && settled()) arm();
    } else if (event === 'UserPromptSubmit' || event === 'SessionEnd') {
      release();                                   // you're here, or it's over
    } else if (timer !== null && (event === 'PreToolUse' || event === 'PostToolUse') && !p.agent_id) {
      arm();                                       // the main session is working again
    }
  }

  emitter.handle = handle;
  return emitter;
}

module.exports = { createAttention, DEFAULT_DEBOUNCE_MS, DEFAULT_SETTLE_MS };
