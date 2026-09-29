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
 *   - the main session makes its own calls, with no agent_id (Dexter, PR #56,
 *     #3: the machine used to pin them on the youngest agent);
 *   - a finished run's SubagentStop and its spawn's completed result arrive
 *     in EITHER order, and SubagentStop may arrive twice (Dexter #4, #6);
 *   - a subagent's PostToolUse may carry interrupted:true, and the run goes
 *     on (Dexter #2).
 *
 * LATE FIRST SPEECH, and where it is allowed (Dexter #6). The machine binds
 * an agent_id to the oldest unbound run of its type, so a run that speaks
 * late can be bound CROSSWISE with a same-type sibling. Between SIBLINGS
 * UNDER ONE PARENT that's harmless -- which one is which doesn't change the
 * card -- and it's the shape of Dexter #1, so it's generated: runs of
 * LATE_TYPE may speak late (or never) and are always spawned by the main
 * session. They may spawn children of their own -- speaking at that moment,
 * since the spawn carries their agent_id -- and a foreground run's
 * SubagentStop may be DROPPED, leaving only its spawn's result: together
 * that's the shape of Dexter R1, where correcting a crosswise pair left a
 * live sibling's child on the record that finished. (A run that never spoke
 * doesn't get its SubagentStop dropped: see `finish`.) Across DIFFERENT parents, or
 * under a key-addressed Esc, a crosswise binding is the PR's documented
 * known limitation (nothing in the payloads can tell the runs apart until
 * the spawn's result arrives), so the generator doesn't ask for it: every
 * other type speaks at once, and escSpawn never targets LATE_TYPE.
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
const LATE_TYPE = 'dexter';
const CALL_KINDS = ['ok', 'err', 'errFail', 'interruptFail', 'interruptPost'];
const QUIET_KINDS = ['ok', 'interruptFail', 'interruptPost'];
const MAIN_KINDS = ['ok', 'err', 'interruptPost', 'repeat'];
const QUIET_MAIN_KINDS = ['ok', 'interruptPost'];

function opArb(callKinds, mainKinds = MAIN_KINDS) {
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant('spawn'), from: fc.nat(), type: fc.nat(), bg: fc.boolean(),
      flag: fc.boolean(), late: fc.boolean() }) },
    { weight: 5, arbitrary: fc.record({ op: fc.constant('call'), who: fc.nat(), kind: fc.constantFrom(...callKinds) }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant('mainCall'), kind: fc.constantFrom(...mainKinds) }) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat(), result: fc.boolean(),
      resultFirst: fc.boolean(), dup: fc.boolean(), drop: fc.boolean() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('lateEcho'), who: fc.nat(), stop: fc.boolean() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('escSpawn'), who: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('escMain') }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('stop') }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 20_000 }) }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('resume'), who: fc.nat() }) },
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
  // Sending an agent's id is what lets the machine know it; `told` records it.
  const by = a => { if (!a) return {}; a.told = true; return { agent_id: a.id, agent_type: a.type }; };
  // Has any payload yet said whose call is whose? (see property 6)
  let labelled = false;
  const send = (event, payload) => {
    if (payload.agent_id || (payload.tool_response && payload.tool_response.agentId)) labelled = true;
    m.handle({ event, payload });
  };
  const bash = (a, response) => send('PostToolUse', {
    tool_name: 'Bash', tool_input: { command: 'c' + (++n) }, tool_response: response, ...by(a) });

  for (const o of ops) {
    const wasLabelled = labelled;
    const live = alive();
    const pick = i => (live.length ? live[i % live.length] : null);
    switch (o.op) {
      case 'spawn': {
        // Weighted toward LATE_TYPE, so silent same-type siblings -- the
        // shape a crosswise or stolen binding needs -- are common.
        const type = TYPES[Math.min(o.type % 6, TYPES.length - 1)];
        const spawners = live;
        const at = o.from % (spawners.length + 1);
        const from = type === LATE_TYPE || at === 0 ? null : spawners[at - 1];
        const a = { id: 'ag' + (++n), key: 'tu' + n, type, parent: from, bg: o.bg, alive: true };
        agents.push(a);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: a.key,
          tool_input: { subagent_type: a.type, description: 'd' + a.key, ...(a.bg && o.flag ? { run_in_background: true } : {}) }, ...by(from) });
        if (a.bg) {
          a.told = true;
          send('PostToolUse', { tool_name: 'Agent', tool_use_id: a.key, tool_input: { subagent_type: a.type },
            tool_response: { isAsync: true, status: 'async_launched', agentId: a.id }, ...by(from) });
        }
        if (!(type === LATE_TYPE && o.late)) bash(a, { exit_code: 0 });   // speaks at once, or later
        break;
      }
      case 'mainCall': {
        // The main session's own call: no agent_id. Nothing alive changes.
        const main = (response, input = { command: 'main' + (++n) }) =>
          send('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: response });
        if (o.kind === 'ok') main({ exit_code: 0 });
        else if (o.kind === 'err') main({ exit_code: 1 });
        else if (o.kind === 'interruptPost') main({ interrupted: true });
        else for (let i = 0; i < 3; i++) main({ exit_code: 0 }, { file_path: 'same' });
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
        // Only an ABORTED call (PostToolUseFailure is_interrupt) ends the run.
        // A PostToolUse interrupted:true arrived, so the agent carries on
        // (Dexter, PR #56, #2 -- this oracle used to share the machine's
        // premise that it ended the run, so it could not find that bug).
        if (o.kind === 'interruptFail') for (const d of subtree(a)) d.alive = false;
        break;
      }
      case 'finish': {
        let a = pick(o.who);
        if (!a) break;
        while (fgKids(a).length) a = fgKids(a)[0];                  // blocked on its children
        a.alive = false;
        const stop = () => send('SubagentStop', by(a));
        const result = () => {
          if (!a.bg && o.result) send('PostToolUse', { tool_name: 'Agent', tool_use_id: a.key,
            tool_input: { subagent_type: a.type }, tool_response: { status: 'completed', agentId: a.id }, ...by(a.parent) });
        };
        // A dropped SubagentStop (31 times in 35, host/usage.js) leaves only
        // the result to say the run ended, so it's only dropped when one comes
        // -- and only for a run that has SPOKEN. A run that never made a call
        // and lost its SubagentStop is held by no record the machine can pick
        // for certain (after a Stop or a reap, an unbound record of its type
        // may be a different live run), so it's left to the stall reaper: a
        // documented limitation, like the crosswise Esc below.
        if (o.drop && !a.bg && o.result && a.told) { result(); break; }
        if (o.resultFirst) { result(); stop(); } else { stop(); result(); }
        if (o.dup) stop();                                          // delivered twice
        break;
      }
      case 'lateEcho': {
        // A delayed or duplicated event from a run that has already ended.
        // Nothing alive changes (Dexter, PR #56, #4).
        //
        // Only from a run whose id the machine was TOLD before it ended. A run
        // that ended without ever sending its id (silent, then closed by Stop)
        // can't be recognised later: its first event looks exactly like a
        // silent same-type sibling speaking for the first time. That's the
        // first-come binding limitation, not something #4 can fix.
        const dead = agents.filter(x => !x.alive && x.told);
        if (!dead.length) break;
        const a = dead[o.who % dead.length];
        if (o.stop) send('SubagentStop', by(a)); else bash(a, { exit_code: 1 });
        break;
      }
      case 'escSpawn': {
        const targets = live.filter(x => !x.bg && x.type !== LATE_TYPE);
        const a = targets[o.who % Math.max(1, targets.length)];
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
      case 'resume': {
        // The main session brings an ended agent back with SendMessage to its
        // agent_id (Ricardo's hand check of PR #66). It runs again as its own
        // background root, on the SAME id, until its next SubagentStop. Only a
        // run the machine could know by id: one that spoke before it ended,
        // and not LATE_TYPE, whose ids may be bound crosswise (see the header).
        const dead = agents.filter(x => !x.alive && x.told && x.type !== LATE_TYPE);
        if (!dead.length) break;
        const a = dead[o.who % dead.length];
        a.alive = true;
        a.bg = true;
        a.parent = null;
        send('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm' + (++n),
          tool_input: { to: a.id, summary: 's', message: 'm' } });
        break;
      }
    }
    if (onStep) onStep({ o, m, alive: alive(), agents, changes, mainFg, wasLabelled });
  }
  return { m, changes };
}

const RUNS = { numRuns: 300 };
// fast-check's default `size: 'small'` keeps an array near ten ops however
// high maxLength is, which is too short for a crosswise binding to form and
// then bite. 'max' lets streams run to the full length.
const LONG = { maxLength: 80, size: 'max' };
const opsArb = fc.array(opArb(CALL_KINDS), LONG);
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
  fc.assert(fc.property(fc.array(opArb(QUIET_KINDS, QUIET_MAIN_KINDS), LONG), ops => {
    const { changes } = simulate(ops);
    assert.ok(!changes.some(c => c.state === 'stressed'), JSON.stringify(changes.filter(c => c.state === 'stressed')));
  }), RUNS);
});

test('property 6: a main-session call never touches a subagent (Dexter, PR #56, #3)', () => {
  // Once this CLI has labelled any call with an agent_id, a call WITHOUT one
  // is the main session's own, so it changes no card and no run. Before the
  // first label the machine can't tell a current CLI from an older one that
  // labels nobody, and keeps that CLI's fallback onto main-session
  // foreground work -- the one residual, stated here rather than hidden.
  fc.assert(fc.property(opsArb, ops => {
    let before = null;
    simulate(ops, { onStep: ({ o, m, wasLabelled }) => {
      const now = { roster: JSON.stringify(m.roster()), stack: JSON.stringify(m.stack()) };
      if (o.op === 'mainCall' && wasLabelled && before) assert.deepStrictEqual(now, before, o.kind);
      before = now;
    } });
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
  ), LONG);
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
