'use strict';
/**
 * Mechanical, deterministic mood state machine.
 *
 * No model calls: free, instant, and explainable — which is what matters when a
 * face is wrong and you need to know why. Every transition below is traceable
 * to one hook event or one elapsed timeout.
 *
 *   PreToolUse(Agent|Task)  -> working
 *   PostToolUse ok          -> working
 *   PostToolUse error       -> stressed (err++)
 *   same tool x3 running    -> stressed
 *   SubagentStop, err == 0  -> happy    (flash) -> sleeping
 *   SubagentStop, err > 0   -> stressed (flash) -> sleeping
 *   idle > idleMs           -> sleeping  (only if NOT still running -- FF2)
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
function isFailure(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.interrupted === true) return true;
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

function createMoodMachine({ now = Date.now, idleMs = 90_000, stallMs = STALL_MS,
                            maxInvocationMs = MAX_INVOCATION_MS, flashMs = 8_000 } = {}) {
  const machine = new EventEmitter();

  // agent -> { state, errors, lastActivity, flashUntil, lastSignature, repeats }
  const agents = new Map();
  // Innermost-first stack of running agents, so a Bash failure is attributed to
  // the agent that actually ran it rather than to whoever started first.
  // Entries are invocations -- `{ name, startedAt }` -- because the same agent
  // can be running twice and the two have different lifetimes. `stack()`
  // still returns bare names, so every consumer (host.js's `party`) is
  // unchanged.
  const stack = [];
  const names = () => stack.map(e => e.name);
  const running = (name) => stack.some(e => e.name === name);

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

  function current() {
    return stack.length ? stack[stack.length - 1].name : null;
  }

// The tool that launches a subagent. Claude Code calls it "Agent"; older
// versions called it "Task". Verified against the real CLI, which sends
// tool_name:"Agent" with subagent_type in tool_input -- this repo had assumed
// "Task" everywhere, so the roster stayed empty in every real session while
// every test passed on hand-written "Task" fixtures.
const AGENT_TOOLS = new Set(['Agent', 'Task']);

  function handle({ event, payload }) {
    const p = payload || {};
    const tool = p.tool_name;

    if (event === 'PreToolUse' && AGENT_TOOLS.has(tool)) {
      const agent = p.tool_input && p.tool_input.subagent_type;
      if (!agent) return;                     // nothing identifiable to light up
      const a = ensure(agent);
      // "A fresh run starts clean" -- but only if it IS a fresh run. Dexter,
      // Finding 4: `ensure` returns the record for the NAME, so launching a
      // parallel second instance wiped the error the first one had already
      // recorded, and that instance's SubagentStop then showed a happy face
      // for a run that failed. Same name/invocation disagreement as F3.
      if (!running(agent)) {
        a.errors = 0;
        a.repeats = 0;
        a.lastSignature = null;
      }
      a.flashUntil = 0;
      a.lastActivity = now();
      stack.push({ name: agent, startedAt: now() });
      setState(agent, a, WORKING);
      return;
    }

    if (event === 'PostToolUse') {
      const agent = current();
      if (!agent) return;                     // no running agent to attribute to
      const a = ensure(agent);

      // THE WHOLE CHAIN IS ALIVE, not just its innermost link. Dexter, PR #33,
      // Finding 5: only `current()` had its clock advanced, so a delegating
      // parent sat silent while its child did the work and was reaped as
      // stalled. A parent that delegated is not stalled -- it is waiting, which
      // is the correct thing for it to be doing and is the normal shape of
      // every multi-agent run in this project.
      //
      // The MOOD is still attributed to `current()` alone, deliberately: a
      // Bash failure belongs to the agent that ran it, which is the property
      // `stack` was built for in the first place. Only the liveness clock is
      // shared.
      for (const inv of stack) {
        const entry = agents.get(inv.name);
        if (entry) entry.lastActivity = now();
      }
      a.lastActivity = now();

      if (isFailure(p.tool_response)) {
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
      // The payload NAMES the agent (agent_type), so use it. Popping the stack
      // is a guess that only holds while agents finish in the order they
      // started -- with parallel work it credits the wrong one, and then the
      // delegation chain describes a session that never happened. Found by
      // verify/probe-payloads.js reading a real SubagentStop.
      const named = p.agent_type;
      let agent;
      if (named) {
        const at = stack.map(e => e.name).lastIndexOf(named);
        if (at === -1) return;              // never started here; not ours to end
        stack.splice(at, 1);
        agent = named;
      } else {
        const popped = stack.pop();         // older versions send no agent_type
        agent = popped && popped.name;
      }
      if (!agent) return;
      const a = ensure(agent);
      a.lastActivity = now();

      // ONE INSTANCE FINISHING IS NOT THE AGENT FINISHING.
      //
      // The card is DERIVED from whether any invocation of this name remains,
      // rather than set by whichever event spoke last. Flashing here while a
      // sibling is still working would celebrate a completion that has not
      // happened, and the flash then hands over to the sleep path -- which is
      // exactly the route Finding 3 took to put a running agent to sleep.
      //
      // Deriving it in ONE place is the structural half of the fix. The
      // name/invocation split produced four bugs in a single review (F3, F4,
      // F5, F7) plus Vera's ×N badge on PR #34, every one of them a site that
      // read the stack and drew its own conclusion. There is now one
      // conclusion.
      if (running(agent)) {
        setState(agent, a, a.errors > 0 ? STRESSED : WORKING);
        return;
      }

      a.flashUntil = now() + flashMs;
      setState(agent, a, a.errors > 0 ? STRESSED : HAPPY);
      return;
    }
  }

  function tick() {
    const t = now();

    // STRANDED INVOCATIONS FIRST, on their own unrefreshable clock. Dexter F7:
    // without this the chain-wide `lastActivity` refresh means a silence clock
    // only fires when the entire session is quiet, so a dropped SubagentStop
    // leaves an entry on the stack forever -- and it takes the reap Miguel
    // just made effective with it.
    const stranded = new Set();
    for (let i = stack.length - 1; i >= 0; i--) {
      if (t - stack[i].startedAt > maxInvocationMs) stranded.add(stack.splice(i, 1)[0].name);
    }
    // Slept immediately, and only when the NAME has no invocation left: the
    // same agent may be running twice and one instance outliving the cap says
    // nothing about the other.
    for (const name of stranded) {
      if (running(name)) continue;
      const a = agents.get(name);
      if (a && a.state !== SLEEPING) {
        a.flashUntil = 0;
        setState(name, a, SLEEPING);
      }
    }
    for (const [agent, a] of agents) {
      if (a.state === SLEEPING) continue;

      // A finished agent holds its happy/stressed flash, then sleeps.
      //
      // UNLESS IT IS STILL RUNNING. Dexter, PR #33, Finding 3 -- and this is
      // the finding that mattered most, because Ricardo's original symptom
      // ("it appears as sleeping sometimes even though its running") SURVIVED
      // the fix written for it. This branch `continue`d before the stack check
      // below was ever reached, so `stack.includes` got no vote on any entry
      // carrying a flashUntil. Two parallel instances of one agent, the first
      // finishes, the flash expires, and the second -- demonstrably on the
      // stack -- was put to sleep and stayed there.
      //
      // The root is that `agents` is keyed by NAME and `stack` by INVOCATION,
      // so the two disagree the moment a name is launched twice.
      if (a.flashUntil) {
        if (t > a.flashUntil) {
          a.flashUntil = 0;
          setState(agent, a, running(agent) ? WORKING : SLEEPING);
        }
        continue;
      }

      // FF2: SILENCE IS NOT ABSENCE OF LIFE. `lastActivity` only advances on
      // hook events, so an agent thinking for longer than idleMs -- or inside
      // one long tool call -- emits nothing and used to be declared asleep
      // while it was demonstrably running. Observed on Paris in real use.
      //
      // `stack` holds every agent that has started and not yet emitted
      // SubagentStop, which IS the definition of running, and the machine has
      // maintained it all along for delegation attribution.
      //
      // The timeout is still here and still earns its place: it reaps an agent
      // whose SubagentStop never arrived, so a crashed subagent does not stay
      // "working" forever. It just no longer outranks direct evidence of life.
      //
      // NOTE, measured: the `idleMs` side of this is currently UNREACHABLE.
      // PreToolUse pushes onto the stack, PostToolUse attributes to
      // `current()` which reads the stack, and SubagentStop pops and hands to
      // the flash timer -- so every awake, non-flashing agent is on the stack.
      // It is kept because it is the right rule for an agent that is awake and
      // not running, and deleting it would make the next path that creates one
      // immortal. test/mood-machine.test.js says which clock is live.
      // A RUNNING agent is judged on the stall clock, not the idle clock.
      // `stack` holds every agent that started and has not emitted
      // SubagentStop, which is the definition of running, and the machine has
      // maintained it all along for delegation attribution.
      const isRunning = running(agent);
      const limit = isRunning ? stallMs : idleMs;
      if (t - a.lastActivity <= limit) continue;

      // A STALLED RUNNING AGENT IS PRESUMED DEAD, SO IT LEAVES THE STACK.
      //
      // Miguel, PR #33 review, R1. The first version of this fix set the state
      // and left the agent on the stack -- so it was still `current()`, the
      // next PostToolUse from anywhere attributed to it and revived it to
      // WORKING, and because it was STILL on the stack it came back onto the
      // thirty-minute clock with every tool call resetting lastActivity. A
      // crashed subagent then never slept again for the rest of the session.
      // Before FF2 it woke too, but fell asleep ninety seconds later: the fix
      // for a temporary wrong state had made it permanent.
      //
      // EVERY occurrence, not the last one. The mood record is keyed by agent
      // NAME, so declaring that name stalled declares all of its live
      // invocations stalled; leaving one behind leaves the name `current()`
      // and reproduces the revival one instance further along.
      if (isRunning) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === agent) stack.splice(i, 1);
        }
      }
      setState(agent, a, SLEEPING);
    }
  }

  machine.handle = handle;
  machine.tick = tick;
  machine.stateOf = agent => (agents.get(agent) || { state: SLEEPING }).state;
  // Live delegation chain, outermost first. Already maintained to attribute a
  // failure to the innermost running agent; exposing it is free.
  // Bare NAMES, unchanged for every consumer -- host.js draws this as `party`.
  // The invocation objects are internal; only their lifetimes are.
  machine.stack = () => names();
  machine.roster = () => [...agents].map(([agent, a]) => ({ agent, state: a.state }));

  return machine;
}

module.exports = { createMoodMachine, STALL_MS, SLEEPING, WORKING, HAPPY, STRESSED };
