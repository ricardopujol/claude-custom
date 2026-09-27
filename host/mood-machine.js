'use strict';
/**
 * Mechanical, deterministic mood state machine.
 *
 * No model calls: free, instant, and explainable — which is what matters when a
 * face is wrong and you need to know why. Every transition below is traceable
 * to one hook event or one elapsed timeout.
 *
 *   PreToolUse(Agent|Task)  -> working   (opens an invocation, parent-linked)
 *   PostToolUse ok          -> working
 *   PostToolUse error       -> stressed (err++)
 *   PostToolUseFailure      -> stressed (err++)  -- a failed call's ONLY event
 *   same tool x3 running    -> stressed
 *   SubagentStop, err == 0  -> happy    (flash) -> sleeping
 *   SubagentStop, err > 0   -> stressed (flash) -> sleeping
 *   interrupt (Esc)         -> that run + foreground descendants end; never err++
 *   Stop                    -> the main session's foreground runs finish
 *   SessionEnd              -> every run ends, background included
 *   stall / invocation cap  -> that run ends (never while a foreground child runs)
 *   idle > idleMs           -> sleeping  (only if NOT still running -- FF2)
 *
 * A card is working while any invocation of its name is open; a parent stays
 * open while a foreground child it waits on runs. Background runs are their
 * own roots.
 *
 * Time is injected and transitions are applied by `tick()`, so the host owns
 * scheduling and the machine stays testable without wall-clock waits.
 */

const { EventEmitter } = require('events');

const SLEEPING = 'sleeping';
const WORKING = 'working';
const HAPPY = 'happy';
const STRESSED = 'stressed';

const RETRY_LIMIT = 3;

// Claude Code's hook payloads are not strongly shaped, so failure detection is
// deliberately permissive: treating a stringy "1" as success would make the
// mood engine quietly wrong rather than loudly broken.
//
// `interrupted: true` is NOT here any more: an interrupt is decided before this
// is asked, and is never a failure (backlog #7).
function isFailure(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.success === false) return true;
  const code = response.exit_code ?? response.exitCode ?? response.code;
  if (code === undefined || code === null) return false;
  return Number(code) !== 0;
}

// How long a RUNNING agent may be silent before we conclude it died rather
// than that it is thinking. FF2.
//
// Two thresholds, because there are two different questions. `idleMs` asks
// "has this agent been quiet long enough to look idle?" -- fine for an agent
// with no live invocation. A running agent needs the other question: "has it
// been quiet so long that SubagentStop can only have been lost?" Ninety
// seconds answers the first and badly misanswers the second; agents routinely
// think for minutes without emitting a hook.
//
// It is still a guess, because hooks are the only liveness signal there is.
// Set where it is: long enough that no real turn reaches it, short enough that
// a crashed subagent does not read as working for the rest of the session.
const STALL_MS = 30 * 60_000;

// The longest ONE INVOCATION may live before it is presumed stranded.
//
// Dexter, PR #33, Finding 7. `lastActivity` is refreshable -- it has to be, or
// a thinking agent reads as asleep (FF2), and F5 widened that refresh to the
// whole delegation chain because a parent whose child is working is waiting,
// not stalled. But once every stack member is refreshed by any session
// activity, a silence clock can only fire when the WHOLE SESSION goes quiet,
// so a stranded entry -- one whose SubagentStop was dropped, which
// host/usage.js records happening 31 times in 35 events -- never reaps at all.
//
// One refreshable clock cannot answer two questions. `lastActivity` answers
// "is it thinking". `startedAt` answers "how long has this invocation
// existed", and NOTHING refreshes it.
const MAX_INVOCATION_MS = 45 * 60_000;

// The tool that launches a subagent. Claude Code calls it "Agent"; older
// versions called it "Task". Verified against the real CLI, which sends
// tool_name:"Agent" with subagent_type in tool_input -- this repo had assumed
// "Task" everywhere, so the roster stayed empty in every real session while
// every test passed on hand-written "Task" fixtures.
const AGENT_TOOLS = new Set(['Agent', 'Task']);

// A spawn's own result says how it was launched. Measured on real sessions:
// background -> { isAsync: true, status: "async_launched", agentId }, at once;
// foreground -> { status: "completed", agentId, ... }, when the agent is done.
const isAsyncLaunch = r => !!r && typeof r === 'object' && (r.isAsync === true || r.status === 'async_launched');
const isCompleted = r => !!r && typeof r === 'object' && r.status === 'completed';

function createMoodMachine({ now = Date.now, idleMs = 90_000, stallMs = STALL_MS,
                            maxInvocationMs = MAX_INVOCATION_MS, flashMs = 8_000 } = {}) {
  const machine = new EventEmitter();

  // CARDS, keyed by agent NAME: the face the roster shows.
  // name -> { state, errors, lastActivity, flashUntil, lastSignature, repeats }
  //
  // Errors stay name-scoped on purpose (see test/mood-machine.test.js, "a
  // failure is not cleared by a sibling finishing cleanly"): a name that
  // recorded a failure shows it until every instance of it has finished.
  const agents = new Map();

  // INVOCATIONS: every subagent run that has started and not ended, in start
  // order. Backlog #7. The old structure was a name-keyed stack whose nesting
  // was IMPLIED by order, which cannot say whose child an agent is, and so
  // could neither end a chain nor keep a parent alive on its own child's
  // account without keeping every other agent alive too.
  //
  //   { id, key, name, agentId, parent, background, description,
  //     startedAt, lastActivity }
  //
  // key      the spawn's tool_use_id (null on older payloads without one).
  // agentId  the subagent's own agent_id, once known. NOTHING in the spawn
  //          names it: PreToolUse(Agent) carries tool_use_id, the subagent's
  //          calls carry agent_id, and only the spawn's RESULT
  //          (tool_response.agentId) joins the two -- at once for a
  //          background launch, at the end for a foreground one. Until then
  //          the first sighting of an unknown agent_id binds it to the oldest
  //          unbound invocation of the same type (see bind()).
  // parent   the spawner's invocation, or null for the main session (a spawn
  //          with no agent_id is the main session's, as every call is).
  // background  a background run is its own root: it outlives its spawner's
  //          turn (Stop fires while it runs -- measured), does not keep its
  //          spawner's card working, and is not ended with its spawner.
  const invs = [];
  const spawns = new Map();          // key -> invocation, including ended ones
  let serial = 0;
  // Has this CLI ever said whose call is whose? The current CLI puts agent_id
  // on every subagent call and on nothing of the main session's, so once one
  // has arrived, a call WITHOUT one is the main session's own (Dexter, PR #56,
  // #3). Before that, it may be an older CLI that labels nobody.
  let saysWho = false;

  const isOpen = inv => invs.includes(inv);
  const running = name => invs.some(i => i.name === name);
  const current = () => (invs.length ? invs[invs.length - 1] : null);

  function ensure(agent) {
    let a = agents.get(agent);
    if (!a) {
      a = { state: SLEEPING, errors: 0, lastActivity: now(), flashUntil: 0, lastSignature: null, repeats: 0 };
      agents.set(agent, a);
    }
    return a;
  }

  function setState(agent, a, state) {
    if (a.state === state) return;
    a.state = state;
    machine.emit('change', { agent, state });
  }

  // agent_id -> its invocation. An id seen for the first time is bound to the
  // OLDEST open invocation of its type that has no id yet: agents of one type
  // start in the order they were spawned. When two same-type siblings are
  // bound crosswise the CARD is unaffected -- both are the same name -- and
  // the spawn's result, which names its agentId, corrects it (see adopt()).
  function bind(agentId, agentType) {
    if (!agentId) return null;
    const known = invs.find(i => i.agentId === agentId);
    if (known) return known;
    const free = agentType ? invs.find(i => !i.agentId && i.name === agentType) : undefined;
    if (!free) return null;          // never started here: not ours to credit
    free.agentId = agentId;
    return free;
  }

  // The spawn's result names the id for certain; a guess that went the other
  // way is swapped rather than left holding someone else's identity.
  function adopt(inv, agentId) {
    if (!agentId || inv.agentId === agentId) return;
    const other = invs.find(i => i.agentId === agentId);
    if (other) other.agentId = inv.agentId;
    inv.agentId = agentId;
  }

  const fgChildren = inv => invs.filter(c => c.parent === inv && !c.background);

  // `inv` and every FOREGROUND descendant: what ends when it ends. A
  // background descendant is its own root and carries on.
  function subtree(inv) {
    const out = [inv];
    for (let k = 0; k < out.length; k++) out.push(...fgChildren(out[k]));
    return out;
  }

  // Foreground all the way up to the main session: the work a turn owns.
  function mainForeground(inv) {
    for (let i = inv; i; i = i.parent) if (i.background) return false;
    return true;
  }

  // THE WHOLE CHAIN IS ALIVE, not just its innermost link (Dexter, PR #33,
  // F5): a parent whose child is working is waiting, not stalled. Walked up
  // the PARENT LINK now, and stopped at a background edge, because background
  // work does not keep its spawner's card working.
  function refresh(inv) {
    const t = now();
    for (let i = inv; i && isOpen(i); i = i.parent) {
      i.lastActivity = t;
      const card = agents.get(i.name);
      if (card) card.lastActivity = t;
      if (i.background) break;
    }
  }

  // A payload with no agent_id at all comes from an older CLI that does not
  // say whose call it is, so it keeps the old rule: the whole set is alive.
  function refreshAll() {
    for (const i of invs) refresh(i);
  }

  // Ends `list`. `completed` says whether the run FINISHED (SubagentStop, a
  // completed result, the turn ending) or was CUT OFF (Esc, /clear, a reap).
  // A finished card flashes happy/stressed; a cut-off one just sleeps, because
  // celebrating a run that did not finish is the display lying.
  //
  // ONE INSTANCE ENDING IS NOT THE AGENT ENDING: the card is derived from
  // whether any invocation of the name remains (F3), in this one place.
  function end(list, completed) {
    const names = new Map();         // name -> finished (any of its ended runs)
    for (const inv of list) {
      const at = invs.indexOf(inv);
      if (at === -1) continue;
      invs.splice(at, 1);
      names.set(inv.name, names.get(inv.name) || completed(inv));
    }
    for (const [name, finished] of names) {
      const a = ensure(name);
      a.lastActivity = now();
      if (running(name)) {
        setState(name, a, a.errors > 0 ? STRESSED : WORKING);
      } else if (finished) {
        a.flashUntil = now() + flashMs;
        setState(name, a, a.errors > 0 ? STRESSED : HAPPY);
      } else {
        a.flashUntil = 0;
        setState(name, a, SLEEPING);
      }
    }
  }

  // The invocation that ran to its end, finished; its foreground descendants,
  // which it could not have finished without, were cut off.
  const finish = inv => end(subtree(inv), i => i === inv);
  const cutOff = list => end(list, () => false);

  // The spawn's own result: PostToolUse / PostToolUseFailure of the Agent
  // tool, matched by tool_use_id. It is the SPAWNER's call, never the child's.
  function spawnResult(inv, event, p, interrupted) {
    if (!isOpen(inv)) return;
    if (interrupted) { cutOff(subtree(inv)); return; }
    if (event === 'PostToolUseFailure') {
      ensure(inv.name).errors++;
      finish(inv);
      return;
    }
    const r = p.tool_response;
    if (r && typeof r === 'object' && r.agentId) { saysWho = true; adopt(inv, r.agentId); }
    if (isAsyncLaunch(r)) { inv.background = true; return; }
    if (isCompleted(r)) finish(inv);
  }

  function handle({ event, payload }) {
    const p = payload || {};
    const tool = p.tool_name;
    if (p.agent_id) saysWho = true;

    if (event === 'PreToolUse' && AGENT_TOOLS.has(tool)) {
      const input = p.tool_input || {};
      const agent = input.subagent_type;
      if (!agent) return;                     // nothing identifiable to light up
      const a = ensure(agent);
      // "A fresh run starts clean" -- but only if it IS a fresh run (Dexter
      // F4): a parallel second instance must not wipe the first's errors.
      if (!running(agent)) {
        a.errors = 0;
        a.repeats = 0;
        a.lastSignature = null;
      }
      a.flashUntil = 0;
      a.lastActivity = now();
      const parent = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
      const inv = {
        id: ++serial, key: p.tool_use_id ?? null, name: agent, agentId: null, parent,
        background: input.run_in_background === true, description: input.description,
        startedAt: now(), lastActivity: now(),
      };
      invs.push(inv);
      if (inv.key !== null) spawns.set(inv.key, inv);
      if (parent) refresh(parent);
      setState(agent, a, WORKING);
      return;
    }

    const failureEvent = event === 'PostToolUseFailure';
    if (event === 'PostToolUse' || failureEvent) {
      // AN INTERRUPT IS NOBODY'S FAILURE, on either path. The user pressed Esc
      // (Dexter F4). It used to count as a failure when it arrived as
      // PostToolUse `interrupted: true` and not when it arrived as
      // PostToolUseFailure `is_interrupt` -- the same act, two faces.
      const interrupted = failureEvent
        ? p.is_interrupt === true
        : !!p.tool_response && typeof p.tool_response === 'object' && p.tool_response.interrupted === true;

      const spawned = AGENT_TOOLS.has(tool) && p.tool_use_id != null ? spawns.get(p.tool_use_id) : undefined;
      if (spawned) {
        const spawner = p.agent_id ? bind(p.agent_id, p.agent_type) : null;
        if (spawner) refresh(spawner);
        spawnResult(spawned, event, p, interrupted);
        return;
      }

      // WHOSE call. Measured: a subagent's calls carry agent_id + agent_type, a
      // main-session call carries neither. A FAILURE with no agent_id is the
      // main session's (Dexter F1) -- and an interrupted one means Esc aborted
      // the main turn, which ends its foreground chain (Stop does not fire).
      if (failureEvent && !p.agent_id) {
        if (interrupted) cutOff(invs.filter(mainForeground));
        return;
      }
      // A PostToolUse with no agent_id is the main session's own call on a CLI
      // that labels subagent calls, and touches no subagent's state, errors
      // or clocks (Dexter, PR #56, #3: every main-session call used to be
      // pinned on the youngest open agent). Only a CLI that has never labelled
      // anything keeps the old fallback, and then only onto the main
      // session's own foreground work -- never a background run.
      let inv;
      if (p.agent_id) inv = bind(p.agent_id, p.agent_type);
      else if (!saysWho) inv = [...invs].reverse().find(mainForeground);
      if (!inv) return;                       // no running agent to attribute to
      if (p.agent_id) refresh(inv); else refreshAll();

      // The interrupted invocation ends, with its foreground descendants.
      if (interrupted) { cutOff(subtree(inv)); return; }

      const agent = inv.name;
      const a = ensure(agent);
      if (failureEvent || isFailure(p.tool_response)) {
        a.errors++;
        a.repeats = 0;
        a.lastSignature = null;
        setState(agent, a, STRESSED);
        return;
      }

      // A repeated identical call reads as a retry loop even when each
      // individual call reports success.
      const signature = tool + ':' + JSON.stringify(p.tool_input ?? null);
      a.repeats = signature === a.lastSignature ? a.repeats + 1 : 1;
      a.lastSignature = signature;

      setState(agent, a, a.repeats >= RETRY_LIMIT ? STRESSED : WORKING);
      return;
    }

    if (event === 'SubagentStop') {
      // The payload NAMES the agent, so use it (verify/probe-payloads.js).
      // Older versions send no agent_id: then the youngest invocation of the
      // named type, and with no name at all the youngest invocation.
      let inv;
      if (p.agent_id) inv = bind(p.agent_id, p.agent_type);
      else if (p.agent_type) inv = [...invs].reverse().find(i => i.name === p.agent_type);
      else inv = current();
      if (!inv) return;                       // never started here; not ours to end
      finish(inv);
      return;
    }

    if (event === 'Stop') {
      // THE TURN IS OVER, so the foreground work it owned is over: one still
      // open lost its close, and it finished (Stop does not fire on Esc).
      //
      // NOT background work. Measured (test/hooks-real-subagent-failure):
      // Stop fires while a background agent still runs, and lists it in
      // `background_tasks` -- even one launched with no run_in_background.
      for (const task of Array.isArray(p.background_tasks) ? p.background_tasks : []) {
        if (!task || !task.id) continue;
        const inv = invs.find(i => i.agentId === task.id)
          || invs.find(i => !i.agentId && i.name === task.agent_type
            && (task.description == null || i.description === task.description));
        if (!inv) continue;
        inv.agentId = task.id;
        inv.background = true;
      }
      finishAll(invs.filter(mainForeground));
      return;
    }

    if (event === 'SessionEnd') {
      // Measured: /clear fires SessionEnd and KILLS background agents
      // (verify/probe-clear-background.js). Everything is cut off.
      cutOff([...invs]);
    }
  }

  function finishAll(list) { end(list, () => true); }

  function tick() {
    const t = now();

    // BACKSTOPS, PER INVOCATION. Two clocks, because there are two questions
    // (Dexter F7): `lastActivity` asks "is it thinking" and is refreshed up
    // the parent link; `startedAt` asks "how long has this run existed" and
    // NOTHING refreshes it, so a run whose SubagentStop was dropped is reaped
    // even while the rest of the session is busy.
    //
    // Newest first, and never an invocation with a live FOREGROUND child: a
    // parent is never ended while a descendant it is waiting on still runs.
    // Children are younger, so they cross their own limits first and the
    // parent follows them out -- in this same pass, when it is stale too.
    const gone = new Set();
    for (let k = invs.length - 1; k >= 0; k--) {
      const inv = invs[k];
      const stale = t - inv.startedAt > maxInvocationMs || t - inv.lastActivity > stallMs;
      if (stale && !fgChildren(inv).some(c => !gone.has(c))) gone.add(inv);
    }
    // A reaped run was cut off, so it sleeps at once -- not whenever the idle
    // clock catches up (test/mood-machine-kills.test.js).
    if (gone.size) cutOff([...gone]);

    for (const [agent, a] of agents) {
      if (a.state === SLEEPING) continue;

      // A finished agent holds its happy/stressed flash, then sleeps --
      // UNLESS IT IS STILL RUNNING (Dexter, PR #33, F3). `flashUntil` is only
      // set when no invocation of the name remains and PreToolUse zeroes it,
      // so the WORKING side is unreachable today (measured by Mortimer); it is
      // kept as the defence against the class that produced F3.
      if (a.flashUntil) {
        if (t > a.flashUntil) {
          a.flashUntil = 0;
          setState(agent, a, running(agent) ? WORKING : SLEEPING);
        }
        continue;
      }

      // A RUNNING card is judged by its invocations' clocks above. The idle
      // clock is the rule for a card that is awake and NOT running -- which no
      // path produces today (every ending either flashes or sleeps), kept so
      // the next path that does is not immortal.
      if (running(agent)) continue;
      if (t - a.lastActivity > idleMs) setState(agent, a, SLEEPING);
    }
  }

  machine.handle = handle;
  machine.tick = tick;
  machine.stateOf = agent => (agents.get(agent) || { state: SLEEPING }).state;
  // Every live invocation's NAME, in start order -- one entry per running
  // instance, unchanged for every consumer (host.js draws this as `party`,
  // app/agent-card-display.js counts it for the ×N badge).
  machine.stack = () => invs.map(i => i.name);
  machine.roster = () => [...agents].map(([agent, a]) => ({ agent, state: a.state }));
  // The live invocation tree, read-only, for tests and diagnostics.
  machine.invocations = () => invs.map(i => ({
    id: i.id, name: i.name, key: i.key, agentId: i.agentId,
    parentId: i.parent ? i.parent.id : null, background: i.background,
  }));

  return machine;
}

module.exports = { createMoodMachine, STALL_MS, SLEEPING, WORKING, HAPPY, STRESSED };
