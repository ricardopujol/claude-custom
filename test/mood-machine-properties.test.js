'use strict';
/**
 * PROPERTIES of the invocation-tracking mood machine (backlog #7).
 *
 * Every hand-written test in this area supplied one event order its author
 * thought of, and the name/invocation split still produced five bugs across
 * two reviews (F3, F4, F5, F7, the ×N badge). So these generate the ORDERS:
 * random, well-formed hook streams from a small simulated session, checked
 * against what the simulation says is actually alive.
 *
 * "Well-formed" means the stream a real session could send:
 *   - a subagent only finishes once its foreground children have (it is
 *     blocked on them);
 *   - Stop ends the main session's foreground work, and lists the background
 *     agents still running (measured: test/hooks-real-subagent-failure);
 *   - a background launch's own result arrives at once, naming its agentId
 *     (measured: `status: "async_launched"`);
 *   - each subagent speaks (a Bash call carrying its agent_id) before a
 *     same-type agent spawned after it does. That is the one assumption the
 *     machine's id binding rests on, so it is stated here rather than hidden.
 *
 * Time only moves in small steps under the shipped defaults, so no backstop
 * fires and the simulation's notion of "alive" is exact. The backstops have
 * their own structural property at the bottom, with large jumps.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine } = require('../host/mood-machine');

const TYPES = ['paris', 'miguel', 'dexter'];
const CALL_KINDS = ['ok', 'err', 'errFail', 'interruptFail', 'interruptPost'];
const QUIET_KINDS = ['ok', 'interruptFail', 'interruptPost'];

function opArb(callKinds) {
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant('spawn'), from: fc.nat(), type: fc.nat(), bg: fc.boolean(), flag: fc.boolean() }) },
    { weight: 5, arbitrary: fc.record({ op: fc.constant('call'), who: fc.nat(), kind: fc.constantFrom(...callKinds) }) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat(), result: fc.boolean() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('escSpawn'), who: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('escMain') }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('stop') }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 20_000 }) }) },
  );
}

// The simulated session: what is REALLY alive, and the hooks it would send.
function simulate(ops, { onStep, machineOpts = {} } = {}) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, ...machineOpts });
  const changes = [];
  m.on('change', c => changes.push(c));
  const agents = [];
  let n = 0;
  const alive = () => agents.filter(a => a.alive);
  const fgKids = a => agents.filter(c => c.alive && c.parent === a && !c.bg);
  const subtree = a => { const out = [a]; for (let k = 0; k < out.length; k++) out.push(...fgKids(out[k])); return out; };
  const mainFg = a => { for (let i = a; i; i = i.parent) if (i.bg) return false; return true; };
  const by = a => (a ? { agent_id: a.id, agent_type: a.type } : {});
  const send = (event, payload) => m.handle({ event, payload });
  const bash = (a, response) => send('PostToolUse', {
    tool_name: 'Bash', tool_input: { command: 'c' + (++n) }, tool_response: response, ...by(a) });

  for (const o of ops) {
    const live = alive();
    const pick = i => (live.length ? live[i % live.length] : null);
    switch (o.op) {
      case 'spawn': {
        const from = o.from % (live.length + 1) === 0 ? null : live[(o.from % (live.length + 1)) - 1];
        const a = { id: 'ag' + (++n), key: 'tu' + n, type: TYPES[o.type % TYPES.length], parent: from, bg: o.bg, alive: true };
        agents.push(a);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: a.key,
          tool_input: { subagent_type: a.type, description: 'd' + a.key, ...(a.bg && o.flag ? { run_in_background: true } : {}) }, ...by(from) });
        if (a.bg) send('PostToolUse', { tool_name: 'Agent', tool_use_id: a.key, tool_input: { subagent_type: a.type },
          tool_response: { isAsync: true, status: 'async_launched', agentId: a.id }, ...by(from) });
        bash(a, { exit_code: 0 });                                  // it speaks first
        break;
      }
      case 'call': {
        const a = pick(o.who);
        if (!a) break;
        if (o.kind === 'ok') bash(a, { exit_code: 0 });
        else if (o.kind === 'err') bash(a, { exit_code: 1 });
        else if (o.kind === 'interruptPost') bash(a, { interrupted: true });
        else send('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'f' + (++n) },
          error: 'x', is_interrupt: o.kind === 'interruptFail', ...by(a) });
        if (o.kind.startsWith('interrupt')) for (const d of subtree(a)) d.alive = false;
        break;
      }
      case 'finish': {
        let a = pick(o.who);
        if (!a) break;
        while (fgKids(a).length) a = fgKids(a)[0];                  // blocked on its children
        a.alive = false;
        send('SubagentStop', by(a));
        if (!a.bg && o.result) send('PostToolUse', { tool_name: 'Agent', tool_use_id: a.key,
          tool_input: { subagent_type: a.type }, tool_response: { status: 'completed', agentId: a.id }, ...by(a.parent) });
        break;
      }
      case 'escSpawn': {
        const a = live.filter(x => !x.bg)[o.who % Math.max(1, live.filter(x => !x.bg).length)];
        if (!a) break;
        send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: a.key, tool_input: { subagent_type: a.type },
          error: 'interrupted', is_interrupt: true, ...by(a.parent) });
        for (const d of subtree(a)) d.alive = false;
        break;
      }
      case 'escMain':
        send('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'm' }, error: 'x', is_interrupt: true });
        for (const a of live) if (mainFg(a)) a.alive = false;
        break;
      case 'stop':
        for (const a of live) if (mainFg(a)) a.alive = false;
        send('Stop', { background_tasks: alive().filter(a => a.bg).map(a => (
          { id: a.id, type: 'subagent', status: 'running', agent_type: a.type, description: 'd' + a.key })) });
        break;
      case 'sessionEnd':
        for (const a of live) a.alive = false;
        send('SessionEnd', { reason: 'clear' });
        break;
      case 'advance':
        t += o.ms;
        m.tick();
        break;
    }
    if (onStep) onStep({ o, m, alive: alive(), agents, changes, mainFg });
  }
  return { m, changes };
}

const RUNS = { numRuns: 300 };
const opsArb = fc.array(opArb(CALL_KINDS), { maxLength: 80 });
const busyStates = new Set(['working', 'stressed']);

test('property 1: after Stop only background work is working; after SessionEnd nothing is', () => {
  fc.assert(fc.property(opsArb, ops => {
    simulate(ops, { onStep: ({ o, m, alive }) => {
      if (o.op === 'sessionEnd') {
        assert.deepStrictEqual(m.stack(), []);
        for (const r of m.roster()) assert.notStrictEqual(r.state, 'working', r.agent);
      }
      if (o.op === 'stop') {
        // Everything alive after a Stop is background-rooted, by construction
        // of the simulation; the machine must agree name for name.
        for (const r of m.roster()) {
          if (r.state === 'working') assert.ok(alive.some(a => a.type === r.agent), r.agent);
        }
        assert.deepStrictEqual(m.stack().slice().sort(), alive.map(a => a.type).sort());
      }
    } });
  }), RUNS);
});

test('property 2: a card whose invocations have all ended is not working', () => {
  fc.assert(fc.property(opsArb, ops => {
    simulate(ops, { onStep: ({ m, alive }) => {
      for (const type of TYPES) {
        const live = alive.filter(a => a.type === type).length;
        assert.strictEqual(m.stack().filter(nm => nm === type).length, live, `${type}: open invocations = live runs`);
        if (live === 0) assert.notStrictEqual(m.stateOf(type), 'working', type);
      }
    } });
  }), RUNS);
});

test('property 3: a parent is never non-working while a live descendant runs', () => {
  fc.assert(fc.property(opsArb, ops => {
    simulate(ops, { onStep: ({ m, alive }) => {
      for (const a of alive) {
        // Descendants reached through FOREGROUND links: the work it waits on.
        const waitsOn = alive.some(d => { for (let p = d; p && !p.bg; p = p.parent) if (p.parent === a) return true; return false; });
        if (!waitsOn) continue;
        assert.ok(m.stack().includes(a.type), `${a.type} has a live child but no open invocation`);
        assert.ok(busyStates.has(m.stateOf(a.type)), `${a.type} is ${m.stateOf(a.type)} with a live child`);
      }
    } });
  }), RUNS);
});

test('property 4: interrupts never count as errors', () => {
  // With only clean calls and interrupts (every input unique, so no retry
  // loop), no card may ever be stressed.
  fc.assert(fc.property(fc.array(opArb(QUIET_KINDS), { maxLength: 80 }), ops => {
    const { changes } = simulate(ops);
    assert.ok(!changes.some(c => c.state === 'stressed'), JSON.stringify(changes.filter(c => c.state === 'stressed')));
  }), RUNS);
});

test('property 3, under the backstops: a reap never leaves a child open under an ended parent', () => {
  // Large time jumps against short clocks, so stall and cap reaps fire in
  // every order. Structural: every open invocation's foreground parent is
  // itself still open.
  //
  // Jumps mostly stay UNDER the stall, deliberately: a first version jumped
  // up to 400s against a 300s stall, so parent and child always went stale
  // together and a hand mutant that reaped parents first went unseen. The
  // dangerous case is a busy child keeping an old parent fresh while the
  // parent's CAP -- which nothing refreshes -- runs out first.
  // The general mix also ends chains too often (Stop, Esc, finish) for one to
  // live past a cap, so this generator is mostly spawning and working.
  const bigOps = fc.array(fc.oneof(
    { weight: 3, arbitrary: fc.record({ op: fc.constant('spawn'), from: fc.nat(), type: fc.nat(), bg: fc.boolean(), flag: fc.boolean() }) },
    { weight: 5, arbitrary: fc.record({ op: fc.constant('call'), who: fc.nat(), kind: fc.constant('ok') }) },
    { weight: 4, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 250_000 }) }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 250_000, max: 400_000 }) }) },
    { weight: 1, arbitrary: opArb(CALL_KINDS) },
  ), { maxLength: 80 });
  fc.assert(fc.property(bigOps, ops => {
    simulate(ops, { machineOpts: { stallMs: 300_000, maxInvocationMs: 700_000, idleMs: 90_000 },
      onStep: ({ m }) => {
        const invs = m.invocations();
        const open = new Set(invs.map(i => i.id));
        for (const i of invs) {
          if (i.background || i.parentId === null) continue;
          // A parent that ended by its own events ends its foreground
          // children with it; a reap never takes a parent before its child.
          assert.ok(open.has(i.parentId), `invocation ${i.id} (${i.name}) outlived its parent ${i.parentId}`);
        }
      } });
  }), {
    ...RUNS,
    // The known-dangerous shape, seeded because random mixes rarely build it:
    // a parent spawned well before its child, the child busy enough to keep
    // the parent fresh, and the parent's cap (700s) running out first.
    examples: [[[
      { op: 'spawn', from: 0, type: 0, bg: false, flag: false },
      { op: 'advance', ms: 200_000 },
      { op: 'spawn', from: 1, type: 1, bg: false, flag: false },
      ...Array.from({ length: 4 }, () => [{ op: 'advance', ms: 200_000 }, { op: 'call', who: 1, kind: 'ok' }]).flat(),
    ]]],
  });
});
