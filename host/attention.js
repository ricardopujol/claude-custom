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

const fs = require('fs');
const path = require('path');
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
// running (a dev server) is not work waiting to finish for ever, so it is handled
// separately below (young shells wait, old ones don't). Agents count as: type
// 'subagent', or anything naming an agent_type. A status that isn't a
// known end is read as running (Dexter F2: fail closed -- the backstop below
// resolves a wrong guess; failing open would toast mid-work).
const ENDED = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped', 'error']);
const isRunningAgent = t => t != null &&
  (t.type === 'subagent' || typeof t.agent_type === 'string') && !ENDED.has(t.status);
const runningAgents = p => (Array.isArray(p.background_tasks) ? p.background_tasks.filter(isRunningAgent) : []);

// A background shell (BACKLOG #78, Ricardo 2026-10-09): finished waits for one too, but not for ever -- a dev
// server or a watcher never ends. So only a shell younger than 10 minutes holds it back. Measured
// (verify/probe-background-shell.js): the CLI lists a shell in `background_tasks` as { id, type: 'shell', status,
// description, command } with NO start time. Its age comes from its own output file, <scratchpad_dir>/../tasks/
// <id>.output, born when the command started (on Windows its birth time is the start, mtime is the last write);
// where that can't be read it is anchored at the first Stop that listed the shell, so unknown means "young, for
// 10 minutes from now" and never "young for ever".
const SHELL_MAX_AGE_MS = 10 * 60 * 1000;
const isRunningShell = t => t != null && t.type === 'shell' && !ENDED.has(t.status);
const runningShells = p => (Array.isArray(p.background_tasks) ? p.background_tasks.filter(isRunningShell) : []);

// `stat` is injectable for tests. Null for anything not a clean answer: a wrong start must not make a shell old.
function makeShellStartedAt(stat = fs.statSync) {
  return (task, payload) => {
    const id = task && task.id;
    const sp = payload && payload.scratchpad_dir;
    if (typeof id !== 'string' || !id || typeof sp !== 'string' || !sp) return null;
    if (id === '..' || /[\\/]/.test(id)) return null;        // an id is a file stem, never a path
    try {
      const born = stat(path.join(path.dirname(sp), 'tasks', id + '.output')).birthtimeMs;
      return typeof born === 'number' && Number.isFinite(born) && born > 0 ? born : null;
    } catch { return null; }
  };
}

// Events only the MAIN session makes while it works. A subagent's tool events carry agent_id.
const MAIN_ACTIVITY = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit']);

// Stop can fire more than once around a single turn ending, and two toasts for
// one event is how a notification system loses its credibility.
const DEFAULT_DEBOUNCE_MS = 4000;

// Agents seen to stop, remembered so a Stop that still lists one as running
// isn't held for it (Dexter, notify round 2 F2: its SubagentStop can reach us
// first -- host/mood-machine.js guards the same race with its endedIds).
// Bounded: only recent ones can race.
const ENDED_MEMORY = 200;

// `agents` is a provider, not a value: the roster changes between the moment
// attention is wired up and the moment a turn ends.
// A timer that never keeps the host process alive on its own.
const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; };

// `shellStartedAt(task, stopPayload)` -> ms since epoch, or null when it can't be told.
function createAttention({ now = Date.now, project = '', agents = () => [],
                          debounceMs = DEFAULT_DEBOUNCE_MS,
                          shellStartedAt = makeShellStartedAt(),
                          setTimer = unrefTimer, clearTimer = clearTimeout } = {}) {
  const emitter = new EventEmitter();
  // Debounced per KIND, not globally: a request for input must not be swallowed
  // because a turn happened to end a moment earlier.
  const lastSent = new Map();

  // A Stop held back while agents ran (Dexter, notify F1): the agent ids it
  // waited on, or null. Nothing guarantees another Stop -- a resume that never
  // notifies, a follow-up turn that ends in StopFailure -- so once every one
  // of them has stopped, Claude Code's own idle_prompt raises "finished"
  // (Ricardo, 2026-10-01: idle_prompt only). A settle timer was tried and
  // fired into a working session: the host couldn't tell the main session was
  // quiet. The only timer left is the shell wait below. What cancels it is every
  // main-session hook the host sees (UserPromptSubmit, and a PreToolUse of ANY
  // tool, file tools included: host.js hands those to `activity` before its
  // occupancy-only return). A turn that opens with no prompt and uses no tool at
  // all (a background task's notice answered in plain text) is invisible, so the
  // timer can still fire into it: one early "finished", bounded by that turn's own Stop.
  let held = null;
  const ended = new Set();

  // OSC 7501 (host/program-status.js) is a second source for the MAIN session's cue. Once the CLI has spoken it, it wins:
  // the hook-derived raises below stop, and the 7501 source (programStatus) decides. Sticky for the host's life: a CLI that
  // speaks the protocol keeps speaking it, and a gap between two reports must not hand the cue back to the hooks.
  // The hooks keep running underneath (the held-back bookkeeping, agent cards, occupancy and the mood machine are not
  // touched); only what they RAISE is held back.
  let statusLive = false;
  let statusState = null;

  function raise(kind, { title, body, urgent }, fromStatus = false) {
    if (statusLive && !fromStatus) return;
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

  const STATUS_WORDS = {
    permission: 'Waiting for your permission',
    question: 'Has a question for you',
    auth: 'Needs you to sign in',
  };

  // The snapshot host/program-status.js keeps, handed over on every change. Only a CHANGE of the root record's state
  // raises, so a new message on the same state (or a re-report) cannot toast twice. working / idle / a cleared root
  // raise nothing here: the window clears its cue when it sees them (app/tab-status.js pendingAfter 'answered').
  // `error` raises like blocked: something is waiting on you (BACKLOG #116, default).
  function programStatus(snapshot) {
    const live = !!snapshot && snapshot.live === true;
    if (live) statusLive = true;
    const root = live && snapshot.root && typeof snapshot.root === 'object' ? snapshot.root : null;
    const state = root && typeof root.state === 'string' ? root.state : null;
    if (state === statusState) return;
    statusState = state;
    const said = root && typeof root.msg === 'string' && root.msg !== '' ? root.msg : null;
    if (state === 'blocked' || state === 'error') {
      raise('input-needed', {
        title: project ? `${project} needs you` : 'Claude needs you',
        body: said || (state === 'error' ? 'Hit an error' : STATUS_WORDS[root.kind] || 'Waiting for you'),
        urgent: true,
      }, true);
    } else if (state === 'done') {
      raise('finished', {
        title: project ? `${project} finished` : 'Claude finished',
        body: said || summarize('Stop', {}, { agents: agents() }),
        urgent: false,
      }, true);
    }
  }

  // Young shells a held-back Stop waits on: when each turns 10 minutes old (ms). `starts` is the best start known
  // per shell id: the output file's birth time when it could be read (remembered, so a later unreadable stat can't
  // make an old shell young again), else the moment of the FIRST Stop that listed it. Waiting always ends.
  const starts = new Map();
  let timer = null;

  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const youngShell = () => held !== null && held.shells.some(at => at > now());
  const settled = () => held !== null && held.ids.size === 0 && held.unnamed === 0 && !youngShell();

  // Arms the one timer for the last young shell to turn 10 minutes old. Never longer than 10 minutes (a bad clock
  // must not make it so), never shorter than 1 ms.
  function armShellTimer() {
    if (held === null || timer !== null || !youngShell()) return;
    timer = setTimer(expire, Math.min(SHELL_MAX_AGE_MS, Math.max(1, Math.max(...held.shells) - now())));
  }

  // The turn is over, an agent may have stopped, and a shell may have aged out: with nothing else waiting,
  // that is "everything finished". A timer that fires a hair early (it runs on the monotonic clock, `now` is the
  // wall clock) finds the shell still young by a millisecond: it re-arms for the rest, it never gives up.
  function expire() {
    timer = null;
    if (settled()) { held = null; finished({}); return; }
    armShellTimer();
  }

  function shellExpiry(task, p) {
    const t = now();
    const id = typeof task.id === 'string' && task.id ? task.id : null;
    if (id === null) return t + SHELL_MAX_AGE_MS;             // nothing to remember it by: 10 minutes from this Stop
    const read = shellStartedAt(task, p);
    if (typeof read === 'number' && Number.isFinite(read)) starts.set(id, read);
    else if (!starts.has(id)) starts.set(id, t);
    if (starts.size > ENDED_MEMORY) starts.delete(starts.keys().next().value);   // deliberate: 200+ shells in one session
    // A start in the future (a stepped clock) is no younger than now.
    return Math.min(starts.get(id), t) + SHELL_MAX_AGE_MS;
  }

  // Main-session activity: the session is not quiet, so the shell timer must not fire into it. host.js calls this
  // for EVERY hook event, before its early return for file-tool PreToolUse events (which never reach `handle`).
  function activity({ event, payload }) {
    const p = payload || {};
    if (MAIN_ACTIVITY.has(event) && !(typeof p.agent_id === 'string' && p.agent_id)) stopTimer();
  }

  function handle({ event, payload }) {
    const p = payload || {};

    if (MAIN_ACTIVITY.has(event)) { activity({ event, payload }); return; }

    // A turn that ended in an error sends no Stop. Whatever cancelled the timer (a prompt), it is over now, so a
    // shell that is still young gets its timer back, and one that has aged out releases the held "finished".
    if (event === 'StopFailure') {
      if (settled()) { held = null; finished({}); } else armShellTimer();
      return;
    }

    if (event === 'Notification') {
      if (p.notification_type === 'idle_prompt') {
        if (settled()) { held = null; finished({}); return; }
        armShellTimer();                                       // quiet now, and the shell is still young: wait for it
      }
      if (p.notification_type !== undefined && !NEEDS_INPUT.has(p.notification_type)) return;
      raise('input-needed', {
        title: project ? `${project} needs you` : 'Claude needs you',
        body: summarize('Notification', p, {}),
        urgent: true,
      });
      return;
    }

    if (event === 'Stop') {
      held = null;
      stopTimer();
      const running = runningAgents(p).filter(t => !ended.has(t.id));
      const shells = runningShells(p).map(t => shellExpiry(t, p)).filter(at => at > now());
      if (running.length || shells.length) {
        const ids = new Set(running.map(t => t.id).filter(id => typeof id === 'string' && id));
        // One with no id can't be crossed off: only a later Stop resolves it.
        held = { ids, unnamed: running.length - ids.size, shells };
        armShellTimer();
        return;
      }
      finished(p);
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

    if (event === 'SessionEnd') { held = null; ended.clear(); starts.clear(); stopTimer(); }
  }

  // BACKLOG #119 A2: a permission ask the claude-custom mod saw (`tool.check` resolved to `ask`). It is the CLI's own
  // permission_prompt, seen from inside: the same message the CLI words, through `handle`, so the same debounce makes the
  // CLI's own Notification for the same prompt one toast and not two. Only the tool NAME crosses; the mod never sends its input.
  function ask(a) {
    if (!a || typeof a !== 'object' || typeof a.tool !== 'string' || a.tool === '') return;
    handle({ event: 'Notification', payload: { notification_type: 'permission_prompt', message: `Claude needs your permission to use ${a.tool}` } });
  }

  emitter.handle = handle;
  emitter.ask = ask;
  emitter.activity = activity;
  emitter.programStatus = programStatus;
  return emitter;
}

module.exports = { createAttention, makeShellStartedAt, unrefTimer, DEFAULT_DEBOUNCE_MS, NEEDS_INPUT, SHELL_MAX_AGE_MS };
