'use strict';
/**
 * Mechanical, deterministic mood state machine.
 *
 * No model calls: free, instant, and explainable — which is what matters when a
 * face is wrong and you need to know why. Every transition below is traceable
 * to one hook event or one elapsed timeout.
 *
 *   PreToolUse(Task)        -> working
 *   PostToolUse ok          -> working
 *   PostToolUse error       -> stressed (err++)
 *   same tool x3 running    -> stressed
 *   SubagentStop, err == 0  -> happy    (flash) -> sleeping
 *   SubagentStop, err > 0   -> stressed (flash) -> sleeping
 *   idle > idleMs           -> sleeping
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

function createMoodMachine({ now = Date.now, idleMs = 90_000, flashMs = 8_000 } = {}) {
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

  function handle({ event, payload }) {
    const p = payload || {};
    const tool = p.tool_name;

    if (event === 'PreToolUse' && tool === 'Task') {
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
      const agent = stack.pop();
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

      if (t - a.lastActivity > idleMs) setState(agent, a, SLEEPING);
    }
  }

  machine.handle = handle;
  machine.tick = tick;
  machine.stateOf = agent => (agents.get(agent) || { state: SLEEPING }).state;
  machine.roster = () => [...agents].map(([agent, a]) => ({ agent, state: a.state }));

  return machine;
}

module.exports = { createMoodMachine, SLEEPING, WORKING, HAPPY, STRESSED };
