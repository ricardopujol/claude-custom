'use strict';
/**
 * BACKLOG #155 (agent cues, part 1): an agent that launched background work and has nothing else going on shows
 * "waiting..." with what it waits on and how long, and turns red after 30 minutes. Built on the machine's existing
 * `quiet` flag (a backgrounded Bash, or a background child it launched): no new hook.
 *
 *   bgwait      quiet, nothing in flight, no foreground child, silent for WAIT_GRACE_MS or more
 *   bgwaitlate  the same, silent for WAIT_RED_MS (30 min) or more
 *
 * A waiting agent is never asleep or reaped while it waits (it has its own, longer silence limit, QUIET_STALL_MS), and
 * the next hooked event of its own ends the wait. It is a finer detail of `working`/`stressed`: `state` is untouched.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine, STALL_MS, MAX_INVOCATION_MS, WAIT_GRACE_MS, WAIT_RED_MS, QUIET_STALL_MS, BGWAIT, BGWAIT_LATE } = require('../host/mood-machine');

function rig(opts = {}) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, ...opts });
  let n = 0;
  const api = {
    m,
    advance(ms) { t += ms; m.tick(); },
    ev(event, payload) { m.handle({ event, payload }); },
    spawn(type, extra = {}) {
      const key = 'toolu_' + (++n);
      api.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type, ...extra.input }, ...extra.by });
      return { key, type, id: 'a' + type + '-' + String(n).padStart(16, '0') };
    },
    pre(a, tool, input = {}) { api.ev('PreToolUse', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: input, agent_id: a.id, agent_type: a.type }); return 'tu' + n; },
    post(a, tool, id, input = {}) { api.ev('PostToolUse', { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: { success: true }, agent_id: a.id, agent_type: a.type }); },
    detail: name => m.detailOf(name),
    now: () => t,
  };
  return api;
}

function started(r, type = 'miguel') {
  const a = r.spawn(type);
  r.post(a, 'Bash', r.pre(a, 'Bash', { command: 'true' }));
  return a;
}

const launch = (r, a, input = { command: 'npm test', run_in_background: true }) => r.pre(a, 'Bash', { run_in_background: true, ...input });

test('the constants are what the design says: 30 minutes to red, a longer silence limit than the red mark', () => {
  assert.strictEqual(WAIT_RED_MS, 30 * 60_000);
  assert.ok(QUIET_STALL_MS > WAIT_RED_MS);
  assert.ok(WAIT_GRACE_MS > 0 && WAIT_GRACE_MS < 60_000);
  assert.strictEqual(BGWAIT, 'bgwait');
  assert.strictEqual(BGWAIT_LATE, 'bgwaitlate');
});

test('a backgrounded Bash with nothing else going on is waiting, after the grace', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  assert.strictEqual(r.detail('miguel'), 'working', 'a thinking agent is not waiting yet');
  r.advance(WAIT_GRACE_MS - 1);
  assert.strictEqual(r.detail('miguel'), 'working');
  r.advance(1);
  assert.strictEqual(r.detail('miguel'), BGWAIT);
  assert.strictEqual(r.m.stateOf('miguel'), 'working', 'the base state is untouched');
});

test('what it waits on is the Bash description, else the command; and since is when it went quiet', () => {
  const r = rig();
  const a = started(r);
  launch(r, a, { command: 'npm test -- --watch=false', description: 'Run the unit tests' });
  const quietAt = r.now();
  r.advance(WAIT_GRACE_MS);
  assert.deepStrictEqual(r.m.waitOf('miguel'), { on: 'Run the unit tests', since: quietAt });

  const r2 = rig();
  const b = started(r2);
  launch(r2, b, { command: 'npm test' });
  r2.advance(WAIT_GRACE_MS);
  assert.strictEqual(r2.m.waitOf('miguel').on, 'npm test');
});

test('a long command is cut for the card, and a missing one gives no "on"', () => {
  const r = rig();
  const a = started(r);
  launch(r, a, { command: 'x'.repeat(500) });
  r.advance(WAIT_GRACE_MS);
  assert.ok(r.m.waitOf('miguel').on.length <= 60);

  const r2 = rig();
  const b = started(r2);
  r2.pre(b, 'Bash', { run_in_background: true });
  r2.advance(WAIT_GRACE_MS);
  assert.strictEqual(r2.detail('miguel'), BGWAIT);
  assert.strictEqual(r2.m.waitOf('miguel').on, null);
});

test('waiting on a background child names its description, else its type', () => {
  const r = rig();
  const p = started(r, 'miguel');
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'bg1', tool_input: { subagent_type: 'dexter', run_in_background: true, description: 'Review the diff' }, agent_id: p.id, agent_type: p.type });
  r.ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'bg1', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: 'adexter-0000000000000001' }, agent_id: p.id, agent_type: p.type });
  r.advance(WAIT_GRACE_MS);
  assert.strictEqual(r.detail('miguel'), BGWAIT);
  assert.strictEqual(r.m.waitOf('miguel').on, 'Review the diff');
});

test('it is never asleep or reaped while it waits: past the idle clock and past the 30 minute stall', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.advance(120_000);
  assert.strictEqual(r.m.stateOf('miguel'), 'working', 'past 90 s it is still awake');
  r.advance(32 * 60_000);
  assert.strictEqual(r.m.stateOf('miguel'), 'working', 'past the old 30 minute stall it is still there');
  assert.strictEqual(r.m.stack().includes('miguel'), true);
});

test('it turns red at 30 minutes of waiting, not before', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.advance(WAIT_RED_MS - 1);
  assert.strictEqual(r.detail('miguel'), BGWAIT);
  r.advance(1);
  assert.strictEqual(r.detail('miguel'), BGWAIT_LATE);
  assert.strictEqual(r.m.stateOf('miguel'), 'working');
});

test('it is finally let go after the quiet silence limit', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.advance(QUIET_STALL_MS + 1);
  assert.strictEqual(r.m.stack().includes('miguel'), false);
  assert.strictEqual(r.m.stateOf('miguel'), 'sleeping');
});

test("its own next hooked event ends the wait, and the clock starts again", () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.advance(WAIT_RED_MS);
  assert.strictEqual(r.detail('miguel'), BGWAIT_LATE);
  r.pre(a, 'Read', { file_path: 'C:/x' });
  assert.notStrictEqual(r.detail('miguel'), BGWAIT_LATE);
  assert.notStrictEqual(r.detail('miguel'), BGWAIT);
  r.advance(WAIT_GRACE_MS);
  assert.strictEqual(r.detail('miguel'), BGWAIT, 'still has its background task: waiting again');
  assert.strictEqual(r.m.waitOf('miguel').since, r.now() - WAIT_GRACE_MS);
});

test('a Bash in flight, a foreground helper or an open prompt is not the quiet wait', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.pre(a, 'Bash', { command: 'npm run build' });
  r.advance(WAIT_GRACE_MS * 2);
  assert.strictEqual(r.detail('miguel'), 'running');

  const r2 = rig();
  const p = started(r2, 'miguel');
  launch(r2, p);
  r2.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'fg', tool_input: { subagent_type: 'dexter' }, agent_id: p.id, agent_type: p.type });
  r2.advance(WAIT_GRACE_MS * 2);
  assert.strictEqual(r2.detail('miguel'), 'helper');

  const r3 = rig();
  const q = started(r3);
  launch(r3, q);
  r3.ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, agent_id: q.id, agent_type: q.type });
  r3.advance(WAIT_GRACE_MS * 2);
  assert.strictEqual(r3.detail('miguel'), 'waiting', 'waiting on a person outranks waiting on a task');
});

test('an agent that launched nothing in the background is never bgwait', () => {
  const r = rig();
  started(r);
  r.advance(10 * 60_000);
  assert.notStrictEqual(r.detail('miguel'), BGWAIT);
  assert.strictEqual(r.m.waitOf('miguel'), null);
});

test('a stressed agent that waits shows the wait too (the base state stays stressed)', () => {
  const r = rig();
  const a = started(r);
  r.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'bad', tool_input: {}, tool_response: { success: false }, agent_id: a.id, agent_type: a.type });
  launch(r, a);
  r.advance(WAIT_GRACE_MS);
  assert.strictEqual(r.m.stateOf('miguel'), 'stressed');
  assert.strictEqual(r.detail('miguel'), BGWAIT);
});

// Dexter 1 (PR #224): the wait ends with the work it stands for.
const BG_CHILD = (r, p, id = 'adexter-0000000000000001') => {
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'bg1', tool_input: { subagent_type: 'dexter', run_in_background: true, description: 'Review the diff' }, agent_id: p.id, agent_type: p.type });
  r.ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'bg1', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: id }, agent_id: p.id, agent_type: p.type });
  return { id, type: 'dexter' };
};

test('PR #224 Dexter 1: the background child stops at 60 s, the agent reads at 61 s and composes for 31 s: that is working, not "waiting on" the child', () => {
  const r = rig();
  const p = started(r, 'miguel');
  const kid = BG_CHILD(r, p);
  r.advance(60_000);
  r.ev('SubagentStop', { agent_id: kid.id, agent_type: kid.type });
  r.advance(1_000);
  r.pre(p, 'Read', { file_path: 'C:/x' });
  r.advance(WAIT_GRACE_MS + 1_000);
  assert.notStrictEqual(r.detail('miguel'), BGWAIT);
  assert.strictEqual(r.m.waitOf('miguel'), null);
});

test('PR #224 Dexter 1: while the child still runs it waits on it, and its stop ends the wait at once, with no event of the agent\'s own', () => {
  const r = rig();
  const p = started(r, 'miguel');
  const kid = BG_CHILD(r, p);
  r.advance(WAIT_GRACE_MS);
  assert.strictEqual(r.detail('miguel'), BGWAIT);
  r.ev('SubagentStop', { agent_id: kid.id, agent_type: kid.type });
  assert.notStrictEqual(r.detail('miguel'), BGWAIT);
  assert.strictEqual(r.m.waitOf('miguel'), null);
});

test('PR #224 Dexter 1: after the child ends, a real hang goes back to the ordinary clocks: stuck at 20 minutes, reaped at 30', () => {
  const r = rig();
  const p = started(r, 'miguel');
  const kid = BG_CHILD(r, p);
  r.ev('SubagentStop', { agent_id: kid.id, agent_type: kid.type });
  r.pre(p, 'Read', { file_path: 'C:/x' });
  r.advance(21 * 60_000);
  assert.strictEqual(r.detail('miguel'), 'stuck');
  r.advance(10 * 60_000);
  assert.strictEqual(r.m.stack().includes('miguel'), false);
});

test('PR #224 Dexter 1: one of two children stopping leaves the wait on the other; TaskStop ends a backgrounded Bash\'s', () => {
  const r = rig();
  const p = started(r, 'miguel');
  const k1 = BG_CHILD(r, p);
  r.ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'bg2', tool_input: { subagent_type: 'mortimer', run_in_background: true, description: 'Mutate' }, agent_id: p.id, agent_type: p.type });
  r.ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'bg2', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: 'amortimer-0000000000000002' }, agent_id: p.id, agent_type: p.type });
  r.ev('SubagentStop', { agent_id: k1.id, agent_type: k1.type });
  r.advance(WAIT_GRACE_MS);
  assert.strictEqual(r.m.waitOf('miguel').on, 'Mutate');

  const r2 = rig();
  const q = started(r2);
  launch(r2, q);
  r2.ev('PostToolUse', { tool_name: 'TaskStop', tool_use_id: 'ts', tool_input: { task_id: 'x' }, tool_response: { success: true }, agent_id: q.id, agent_type: q.type });
  r2.advance(WAIT_GRACE_MS * 2);
  assert.notStrictEqual(r2.detail('miguel'), BGWAIT);
});

// Dexter 2: a quiet run held on a prompt used to escape both the age cap and the stall clock.
test('PR #224 Dexter 2: a quiet foreground run held on a prompt, whose stop was dropped, is still ended by a clock', () => {
  const r = rig();
  const b = r.spawn('bee', { input: { run_in_background: true } });
  r.post(b, 'Bash', r.pre(b, 'Bash', { command: 'true' }));
  const c = r.spawn('cee', { by: { agent_id: b.id, agent_type: b.type } });
  r.post(c, 'Bash', r.pre(c, 'Bash', { command: 'true' }));
  launch(r, c);
  r.ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, agent_id: c.id, agent_type: c.type });
  r.advance(QUIET_STALL_MS + 1);
  assert.deepStrictEqual(r.m.stack(), []);
});

test('PR #224 Dexter 2: PROPERTY: whatever the flags, nothing stays open past the longest limit of total silence', () => {
  const opArb = fc.constantFrom('shell', 'permission', 'child', 'read');
  fc.assert(fc.property(fc.array(opArb, { minLength: 0, maxLength: 6 }), ops => {
    const r = rig();
    const b = r.spawn('bee', { input: { run_in_background: true } });
    r.post(b, 'Bash', r.pre(b, 'Bash', { command: 'true' }));
    const c = r.spawn('cee', { by: { agent_id: b.id, agent_type: b.type } });
    r.post(c, 'Bash', r.pre(c, 'Bash', { command: 'true' }));
    for (const o of ops) {
      if (o === 'shell') launch(r, c);
      else if (o === 'permission') r.ev('PermissionRequest', { tool_name: 'Edit', tool_input: {}, agent_id: c.id, agent_type: c.type });
      else if (o === 'child') BG_CHILD(r, c, 'akid-' + ops.length + '00000000000000');
      else r.pre(c, 'Read', { file_path: 'C:/x' });
    }
    r.advance(Math.max(QUIET_STALL_MS, MAX_INVOCATION_MS) + STALL_MS + 1);
    assert.deepStrictEqual(r.m.stack(), []);
  }), { numRuns: 100 });
});

// Dexter 7: the label and the wait must agree on what is in flight.
test('PR #224 Dexter 7: a quiet run whose Bash result was lost shows the wait (red) once that Bash has aged out of "in flight"', () => {
  const r = rig();
  const a = started(r);
  launch(r, a);
  r.pre(a, 'Bash', { command: 'lost' });          // no result will come
  r.advance(STALL_MS + 1);
  assert.strictEqual(r.detail('miguel'), BGWAIT_LATE);
});

test('PROPERTY: a run with a live background task is never asleep inside the quiet limit; red exactly from 30 minutes of silence; the wait ends with its work', () => {
  const opArb = fc.oneof(
    { weight: 3, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 8 * 60_000 }) }) },
    { weight: 1, arbitrary: fc.constant({ op: 'launch' }) },
    { weight: 1, arbitrary: fc.constant({ op: 'launchChild' }) },
    { weight: 1, arbitrary: fc.constant({ op: 'stopChild' }) },
    { weight: 1, arbitrary: fc.constant({ op: 'read' }) },
    { weight: 1, arbitrary: fc.constant({ op: 'bashOk' }) },
  );
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), ops => {
    const r = rig();
    const a = started(r);
    let shell = false;          // a backgrounded Bash: no end hook, it lasts
    let kid = null;             // a live background child
    let lastEvent = r.now();
    let gone = false;           // let go: later events name an id nobody holds
    let n = 0;
    for (const o of ops) {
      if (gone) break;
      if (o.op === 'advance') r.advance(o.ms);
      else if (o.op === 'launch') { launch(r, a); shell = true; lastEvent = r.now(); }
      else if (o.op === 'launchChild' && kid === null) { kid = BG_CHILD(r, a, 'akid-' + (++n) + '0000000000000'); lastEvent = r.now(); }
      else if (o.op === 'stopChild' && kid !== null) { r.ev('SubagentStop', { agent_id: kid.id, agent_type: kid.type }); kid = null; }
      else if (o.op === 'read') { r.pre(a, 'Read', { file_path: 'C:/x' }); lastEvent = r.now(); }
      else if (o.op === 'bashOk') { r.post(a, 'Bash', r.pre(a, 'Bash', { command: 'true' })); lastEvent = r.now(); }
      const quiet = shell || kid !== null;
      const silence = r.now() - lastEvent;
      const d = r.detail('miguel');
      if (silence >= (quiet ? QUIET_STALL_MS : STALL_MS)) { gone = true; continue; }
      if (quiet) assert.notStrictEqual(r.m.stateOf('miguel'), 'sleeping', 'never asleep while waiting');
      if (d === BGWAIT_LATE) assert.ok(quiet && silence >= WAIT_RED_MS, 'red only at 30 minutes or more');
      if (quiet && silence >= WAIT_RED_MS) assert.strictEqual(d, BGWAIT_LATE);
      if (d === BGWAIT) assert.ok(quiet && silence >= WAIT_GRACE_MS && silence < WAIT_RED_MS);
      if (!quiet) assert.ok(d !== BGWAIT && d !== BGWAIT_LATE, 'no work, no wait');
      if (r.m.waitOf('miguel') !== null) assert.ok(d === BGWAIT || d === BGWAIT_LATE, 'a wait is reported only while the card shows it');
    }
  }), { numRuns: 300 });
});
