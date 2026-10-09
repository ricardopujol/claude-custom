'use strict';
/**
 * PROPERTIES of the finer card states (BACKLOG #55), over random, well-formed
 * hook streams from a small simulated session.
 *
 * The simulation keeps its OWN account of what is in flight for each agent --
 * Bash calls begun and not ended, the newest file tool, an unanswered prompt,
 * the same call repeated -- and the machine's `detail` is checked against it
 * after every step:
 *
 *   1. SHAPE      detail is state itself for a sleeping or happy card, and one of
 *                 the finer names that fit for a working or stressed one.
 *   2. NO STICKING a finer name is only ever shown while the signal behind it
 *                 holds: running <- a Bash in flight; reading/writing <- a file
 *                 tool within the linger; waiting <- a prompt nobody has answered;
 *                 helper <- a foreground child still running.
 *   3. PRIORITY   waiting > stuck > helper > running/writing/reading: when
 *                 several hold the highest is shown.
 *   4. QUIET      with nothing in flight, nothing waiting and no retry loop, a
 *                 working card is plain `working`, and a card with no live run
 *                 shows its state.
 *   5. EVENTS     every change carries a detail, nothing is announced twice in
 *                 a row, and the roster's detail is the last one announced.
 *
 * A Notification that names nobody is read against the newest tool call of
 * anyone (host/mood-machine.js, notification()); the simulation applies the
 * same rule, and generates the main session's own calls so it is exercised.
 * Silence-based "stuck" has its own unit test: here stuckMs is out of reach.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine, TOOL_LINGER_MS, WAIT_ATTRIBUTION_MS } = require('../host/mood-machine');

const MAX_AGENTS = 5;
const FILE_TOOLS = { Read: 'reading', Grep: 'reading', Glob: 'reading', Edit: 'writing', Write: 'writing', NotebookEdit: 'writing' };
const FINER = { working: ['working', 'reading', 'writing', 'running', 'waiting', 'stuck', 'helper'],
  stressed: ['stressed', 'waiting', 'stuck', 'helper'] };

const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('spawn'), from: fc.nat(), bg: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('bashPre'), who: fc.nat(), bg: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('bashPost'), who: fc.nat(), kind: fc.constantFrom('ok', 'ok', 'err', 'fail'), same: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('filePre'), who: fc.nat(), tool: fc.constantFrom(...Object.keys(FILE_TOOLS)) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('mainPre'), tool: fc.constantFrom('Edit', 'Read', 'Bash') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('notify'), who: fc.nat(), named: fc.boolean(),
    type: fc.constantFrom('permission_prompt', 'permission_prompt', 'elicitation_dialog', 'idle_prompt') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 9_000 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
);

function simulate(ops, onStep) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, stuckMs: 10 ** 12, stallMs: 10 ** 12, maxInvocationMs: 10 ** 12 });
  const changes = [];
  m.on('change', c => changes.push(c));
  const agents = [];                   // { id, type, parent, bg, alive, bash: Map(id->at), file, waiting, repeats, sig }
  let n = 0;
  let lastPre = null;                  // { agent|null, at }
  const alive = () => agents.filter(a => a.alive);
  const fgKids = a => agents.filter(c => c.alive && c.parent === a && !c.bg);
  const send = (event, payload) => m.handle({ event, payload });
  const by = a => ({ agent_id: a.id, agent_type: a.type });

  for (const o of ops) {
    const live = alive();
    const pick = i => (live.length ? live[i % live.length] : null);
    switch (o.op) {
      case 'spawn': {
        if (agents.length >= MAX_AGENTS) break;
        const at = o.from % (live.length + 1);
        const parent = at === 0 ? null : live[at - 1];
        const type = 'ty' + agents.length;
        const key = 'toolu_' + (++n);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: key,
          tool_input: { subagent_type: type, run_in_background: o.bg }, ...(parent ? by(parent) : {}) });
        const a = { id: 'a' + type + '-' + String(n).padStart(16, '0'), type, parent, bg: o.bg, alive: true,
          bash: new Map(), file: null, waiting: false, repeats: 0, sig: null };
        agents.push(a);
        if (parent) { parent.waiting = false; lastPre = { agent: parent, at: t }; }
        // The run speaks at once, so the machine knows its id.
        const id = 'tu' + (++n);
        send('PreToolUse', { tool_name: 'Read', tool_use_id: id, tool_input: {}, ...by(a) });
        a.file = { kind: 'reading', at: t };
        lastPre = { agent: a, at: t };
        break;
      }
      case 'bashPre': {
        const a = pick(o.who);
        if (!a) break;
        const id = 'tu' + (++n);
        send('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'c' + n, ...(o.bg ? { run_in_background: true } : {}) }, ...by(a) });
        a.waiting = false;
        lastPre = { agent: a, at: t };
        if (!o.bg) a.bash.set(id, t);
        break;
      }
      case 'bashPost': {
        const a = pick(o.who);
        if (!a) break;
        const id = a.bash.size ? a.bash.keys().next().value : 'tu' + (++n);
        const command = o.same ? 'same' : 'c' + (++n);
        const common = { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...by(a) };
        if (o.kind === 'fail') send('PostToolUseFailure', common);
        else send('PostToolUse', { ...common, tool_response: o.kind === 'err' ? { exit_code: 1 } : { exit_code: 0 } });
        a.waiting = false;
        a.bash.delete(id);
        if (o.kind === 'ok') { const s = 'Bash:' + JSON.stringify({ command }); a.repeats = s === a.sig ? a.repeats + 1 : 1; a.sig = s; }
        else { a.repeats = 0; a.sig = null; }
        break;
      }
      case 'filePre': {
        const a = pick(o.who);
        if (!a) break;
        send('PreToolUse', { tool_name: o.tool, tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/f' }, ...by(a) });
        a.waiting = false;
        a.file = { kind: FILE_TOOLS[o.tool], at: t };
        lastPre = { agent: a, at: t };
        break;
      }
      case 'mainPre':
        send('PreToolUse', { tool_name: o.tool, tool_use_id: 'tu' + (++n), tool_input: {} });
        lastPre = { agent: null, at: t };
        break;
      case 'notify': {
        const waits = o.type !== 'idle_prompt';
        const a = pick(o.who);
        if (o.named && a) send('Notification', { notification_type: o.type, message: 'm', ...by(a) });
        else send('Notification', { notification_type: o.type, message: 'm' });
        if (!waits) break;
        if (o.named && a) a.waiting = true;
        else if (!o.named && lastPre && lastPre.agent && lastPre.agent.alive && t - lastPre.at <= WAIT_ATTRIBUTION_MS) lastPre.agent.waiting = true;
        break;
      }
      case 'advance':
        t += o.ms;
        m.tick();
        break;
      case 'finish': {
        const a = pick(o.who);
        if (!a || fgKids(a).length) break;
        send('SubagentStop', by(a));
        a.alive = false;
        break;
      }
      case 'sessionEnd':
        send('SessionEnd', {});
        for (const a of agents) a.alive = false;
        lastPre = null;
        break;
      default: throw new Error(o.op);
    }
    onStep({ m, agents, changes, t, o });
  }
}

// What the simulation says the card should show, given the machine's own base state.
function expected(a, state, t, kids) {
  if (a.waiting) return 'waiting';
  if (a.repeats >= 3) return 'stuck';
  if (kids > 0) return 'helper';
  if (state !== 'working') return state;
  let newest = null;
  for (const at of a.bash.values()) if (!newest || at >= newest.at) newest = { kind: 'running', at };
  if (a.file && t - a.file.at <= TOOL_LINGER_MS && (!newest || a.file.at > newest.at)) newest = a.file;
  return newest ? newest.kind : 'working';
}

test('property: a card shows exactly the finest name its live signals support, highest priority first', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
    simulate(ops, ({ m, agents, changes, t }) => {
      const roster = new Map(m.roster().map(r => [r.agent, r]));
      for (const [name, r] of roster) {
        // 1. shape
        if (r.state === 'working' || r.state === 'stressed') assert.ok(FINER[r.state].includes(r.detail), `${name}: ${r.state}/${r.detail}`);
        else assert.strictEqual(r.detail, r.state, `${name}: a ${r.state} card has no finer name`);
        assert.strictEqual(m.detailOf(name), r.detail);
        const a = agents.find(x => x.type === name);
        // 4. a card with no live run shows its state
        if (!a.alive) { assert.strictEqual(r.detail, r.state, `${name} has no live run`); continue; }
        // 2 + 3 + 4: the detail the signals support, by priority
        const kids = agents.filter(c => c.alive && c.parent === a && !c.bg).length;
        assert.strictEqual(r.detail, expected(a, r.state, t, kids), `${name}: state ${r.state}`);
      }
      // 5. events
      for (const c of changes) assert.ok(typeof c.detail === 'string' && c.detail, 'a change carries a detail');
      for (const [name, r] of roster) {
        const last = [...changes].reverse().find(c => c.agent === name);
        assert.ok(last, `${name} was announced`);
        assert.deepStrictEqual([last.state, last.detail], [r.state, r.detail], `${name}: the roster is the last thing announced`);
      }
    });
  }), { numRuns: 400 });
});

test('property: the same (agent, state, detail) is never announced twice in a row', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
    let all = null;
    simulate(ops, ({ changes }) => { all = changes; });
    const lastOf = new Map();
    for (const c of all || []) {
      const key = c.state + '|' + c.detail;
      assert.notStrictEqual(lastOf.get(c.agent), key, `${c.agent} announced ${key} twice running`);
      lastOf.set(c.agent, key);
    }
  }), { numRuns: 300 });
});

test('property: once the session ends or time passes with nothing pending, nothing finer lingers', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
    simulate([...ops, { op: 'sessionEnd' }], ({ m, o }) => {
      if (o.op !== 'sessionEnd') return;
      for (const r of m.roster()) assert.strictEqual(r.detail, r.state, `${r.agent} after SessionEnd`);
    });
  }), { numRuns: 200 });
});
