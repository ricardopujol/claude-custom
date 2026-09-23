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

function createMoodMachine({ now = Date.now, idleMs = 90_000, stallMs = STALL_MS, flashMs = 8_000 } = {}) {
  const machine = new EventEmitter();

  // agent -> { state, errors, lastActivity, flashUntil, lastSignature, repeats }
  const agents = new Map();
  // Innermost-first stack of running agents, so a Bash failure is attributed to
  // the agent that actually ran it rather than to whoever started first.
  const stack = [];

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
    return stack.length ? stack[stack.length - 1] : null;
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
      a.errors = 0;                           // a fresh run starts clean
      a.repeats = 0;
      a.lastSignature = null;
      a.flashUntil = 0;
      a.lastActivity = now();
      stack.push(agent);
      setState(agent, a, WORKING);
      return;
    }

    if (event === 'PostToolUse') {
      const agent = current();
      if (!agent) return;                     // no running agent to attribute to
      const a = ensure(agent);
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
        const at = stack.lastIndexOf(named);
        if (at === -1) return;              // never started here; not ours to end
        stack.splice(at, 1);
        agent = named;
      } else {
        agent = stack.pop();                // older versions send no agent_type
      }
      if (!agent) return;
      const a = ensure(agent);
      a.lastActivity = now();
      a.flashUntil = now() + flashMs;
      setState(agent, a, a.errors > 0 ? STRESSED : HAPPY);
      return;
    }
  }

  function tick() {
    const t = now();
    for (const [agent, a] of agents) {
      if (a.state === SLEEPING) continue;

      // A finished agent holds its happy/stressed flash, then sleeps.
      if (a.flashUntil) {
        if (t > a.flashUntil) {
          a.flashUntil = 0;
          setState(agent, a, SLEEPING);
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
      // A RUNNING agent is judged on the stall clock, not the idle clock.
      // `stack` holds every agent that started and has not emitted
      // SubagentStop, which is the definition of running, and the machine has
      // maintained it all along for delegation attribution.
      const limit = stack.includes(agent) ? stallMs : idleMs;
      if (t - a.lastActivity > limit) setState(agent, a, SLEEPING);
    }
  }

  machine.handle = handle;
  machine.tick = tick;
  machine.stateOf = agent => (agents.get(agent) || { state: SLEEPING }).state;
  // Live delegation chain, outermost first. Already maintained to attribute a
  // failure to the innermost running agent; exposing it is free.
  machine.stack = () => [...stack];
  machine.roster = () => [...agents].map(([agent, a]) => ({ agent, state: a.state }));

  return machine;
}

module.exports = { createMoodMachine, STALL_MS, SLEEPING, WORKING, HAPPY, STRESSED };
