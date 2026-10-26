'use strict';
/**
 * PROPERTIES of the finer card states (BACKLOG #55), over random, well-formed hook streams from a small simulated
 * session. Rebuilt after PR #154 (Dexter 8): the first oracle was a transliteration of the machine's own bookkeeping,
 * so it shared every premise of the code it checked. This one is written from the HOOK CONTRACT, not from refine():
 *
 *   - a run's tool calls are sequential, so its LAST call is the one in flight: a Bash with no result yet is running
 *     only while it is the run's last call; a newer call of any kind ends it (a denied or blocked Bash never gets a
 *     result, and must not stay "running");
 *   - a file tool's PreToolUse (no PostToolUse is hooked) is "reading"/"writing" for a moment, then nothing;
 *   - the CLI's Notification never names an agent (2.1.296), so none marks a card; a PermissionRequest hook does, by
 *     agent_id, until the agent's next hooked event (without an agent_id it is the main session's own prompt);
 *   - hooks see no unhooked tools, so silence means stuck only for a run with no background work, no Bash in flight and
 *     no foreground child, and its silence is refreshed by its own events and its foreground descendants' (up to a
 *     background run);
 *   - the retry loop is the NAME's (two runs of one agent share it), and it is re-signed by every result: a different
 *     call, or a failed one, ends the repeat count (an interrupt ends the run but leaves the name's count untouched);
 *   - Stop ends the main session's foreground runs; an interrupt ends the run and its foreground descendants.
 *
 * Checked after every step, per card: (1) SHAPE, (2) NO STICKING and (3) PRIORITY (the detail equals what the live
 * signals support, best first), (4) QUIET (a card with no live run shows its state), (5) EVENTS (every change carries
 * a detail, nothing is announced twice in a row, the roster is the last thing announced).
 *
 * Generated: parallel runs of one name, a Bash PreToolUse with no result while the run carries on, unnamed prompts,
 * Stop, interrupts, and long silences (stuckMs is 30 s here).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine, TOOL_LINGER_MS } = require('../host/mood-machine');

const MAX_AGENTS = 6;
const TYPES = ['ta', 'tb', 'tc'];
const FILE_TOOLS = { Read: 'reading', Grep: 'reading', Glob: 'reading', Edit: 'writing', Write: 'writing', NotebookEdit: 'writing' };
const FINER = { working: ['working', 'reading', 'writing', 'running', 'waiting', 'stuck', 'helper'],
  stressed: ['stressed', 'waiting', 'stuck', 'helper'] };
const RANK = { waiting: 6, stuck: 5, helper: 4, running: 3, reading: 3, writing: 3 };
const STUCK_MS = 30_000;

const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('spawn'), from: fc.nat(), type: fc.nat(), bg: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('bashPre'), who: fc.nat(), bg: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('bashPost'), who: fc.nat(), kind: fc.constantFrom('ok', 'ok', 'err', 'fail'), same: fc.boolean(), ofLast: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('filePre'), who: fc.nat(), tool: fc.constantFrom(...Object.keys(FILE_TOOLS)) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('postOnly'), who: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('mainPre'), tool: fc.constantFrom('Edit', 'Read', 'Bash') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('permission'), who: fc.nat(), named: fc.boolean(), tool: fc.constantFrom('Edit', 'Bash', 'WebFetch') }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('notify'), type: fc.constantFrom('permission_prompt', 'elicitation_dialog', 'idle_prompt') }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 20_000 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('interrupt'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('stop') }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
);

function simulate(ops, onStep) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, stuckMs: STUCK_MS, stallMs: 10 ** 12, maxInvocationMs: 10 ** 12 });
  const changes = [];
  m.on('change', c => changes.push(c));
  const agents = [];          // { id, type, parent, bg, alive, last, waiting, quiet, lastAct }
  const loops = new Map();    // name -> { sig, n }: the retry loop is the NAME's
  let n = 0;
  const alive = () => agents.filter(a => a.alive);
  const fgKids = a => agents.filter(c => c.alive && c.parent === a && !c.bg);
  const subtree = a => { const out = [a]; for (let k = 0; k < out.length; k++) out.push(...fgKids(out[k])); return out; };
  const mainFg = a => { for (let i = a; i; i = i.parent) if (i.bg) return false; return true; };
  const send = (event, payload) => m.handle({ event, payload });
  const by = a => ({ agent_id: a.id, agent_type: a.type });
  // a hooked event of the run: it is alive, and so is the chain above it, up to a background run
  const refresh = a => { for (let i = a; i; i = i.parent) { i.lastAct = t; if (i.bg) break; } };
  const loopOf = name => { if (!loops.has(name)) loops.set(name, { sig: null, n: 0 }); return loops.get(name); };

  for (const o of ops) {
    const live = alive();
    const pick = i => (live.length ? live[i % live.length] : null);
    switch (o.op) {
      case 'spawn': {
        if (agents.length >= MAX_AGENTS) break;
        const at = o.from % (live.length + 1);
        const parent = at === 0 ? null : live[at - 1];
        const type = TYPES[o.type % TYPES.length];
        const key = 'toolu_' + (++n);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: key,
          tool_input: { subagent_type: type, run_in_background: o.bg }, ...(parent ? by(parent) : {}) });
        if (!live.some(x => x.type === type)) loops.set(type, { sig: null, n: 0 });      // a fresh run starts its loop clean
        if (parent) { refresh(parent); parent.waiting = false; parent.last = { kind: 'other' }; if (o.bg) parent.quiet = true; }
        const a = { id: 'a' + type + '-' + String(++n).padStart(16, '0'), type, parent, bg: o.bg, alive: true,
          last: null, waiting: false, quiet: false, lastAct: t };
        agents.push(a);
        // the run speaks at once, so the machine knows its id
        send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: {}, ...by(a) });
        a.last = { kind: 'file', file: 'reading', at: t };
        break;
      }
      case 'bashPre': {
        const a = pick(o.who);
        if (!a) break;
        const id = 'tu' + (++n);
        send('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'c' + n, ...(o.bg ? { run_in_background: true } : {}) }, ...by(a) });
        refresh(a);
        a.waiting = false;
        if (o.bg) { a.quiet = true; a.last = { kind: 'other' }; } else a.last = { kind: 'bash', id, open: true };
        break;
      }
      case 'bashPost': {
        const a = pick(o.who);
        if (!a) break;
        // the result of the run's last Bash, or of some call that is no longer in flight
        const id = o.ofLast && a.last && a.last.kind === 'bash' ? a.last.id : 'tu' + (++n);
        const command = o.same ? 'same' : 'c' + (++n);
        const common = { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...by(a) };
        if (o.kind === 'fail') send('PostToolUseFailure', common);
        else send('PostToolUse', { ...common, tool_response: o.kind === 'err' ? { exit_code: 1 } : { exit_code: 0 } });
        refresh(a);
        a.waiting = false;
        if (a.last && a.last.kind === 'bash' && a.last.id === id) a.last.open = false;
        const loop = loopOf(a.type);
        if (o.kind === 'ok') { const sig = 'Bash:' + JSON.stringify({ command }); loop.n = sig === loop.sig ? loop.n + 1 : 1; loop.sig = sig; }
        else { loop.n = 0; loop.sig = null; }
        break;
      }
      case 'filePre': {
        const a = pick(o.who);
        if (!a) break;
        send('PreToolUse', { tool_name: o.tool, tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/f' }, ...by(a) });
        refresh(a);
        a.waiting = false;
        a.last = { kind: 'file', file: FILE_TOOLS[o.tool], at: t };
        break;
      }
      case 'postOnly': {
        const a = pick(o.who);
        if (!a) break;
        send('PostToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm' + (++n), tool_input: {}, tool_response: { success: false }, ...by(a) });
        refresh(a);
        a.waiting = false;
        a.last = { kind: 'other' };          // a call whose only hook is its Post is still a newer call
        // success:false is an error: the machine zeroes repeats and lastSignature (mood-machine.js 770-776)
        loopOf(a.type).n = 0; loopOf(a.type).sig = null;
        break;
      }
      case 'mainPre':
        send('PreToolUse', { tool_name: o.tool, tool_use_id: 'tu' + (++n), tool_input: {} });
        break;
      case 'permission': {
        const a = pick(o.who);
        send('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: o.tool, tool_input: {}, permission_suggestions: [],
          ...(o.named && a ? by(a) : {}) });
        if (o.named && a) a.waiting = true;       // without an agent_id it is the main session's own prompt: no card
        break;
      }
      case 'notify':
        send('Notification', { notification_type: o.type, message: 'Claude needs your permission to use Edit' });   // never names an agent
        break;
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
      case 'interrupt': {
        const a = pick(o.who);
        if (!a) break;
        send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), is_interrupt: true, ...by(a) });
        refresh(a);          // the machine refreshes the run and its chain (mood-machine.js 760) before it returns at 766
        for (const x of subtree(a)) x.alive = false;
        break;
      }
      case 'stop':
        send('Stop', {});
        for (const a of live) if (mainFg(a)) a.alive = false;
        break;
      case 'sessionEnd':
        send('SessionEnd', {});
        for (const a of agents) a.alive = false;
        break;
      default: throw new Error(o.op);
    }
    onStep({ m, agents, changes, t, o, loops, fgKids });
  }
}

// What the contract says one live run shows, given the card's base state.
function runDetail(a, state, t, loops, fgKids) {
  if (a.waiting) return 'waiting';
  const kids = fgKids(a).length > 0;
  const bashInFlight = !!a.last && a.last.kind === 'bash' && a.last.open;
  const silent = !a.quiet && !kids && !bashInFlight && t - a.lastAct > STUCK_MS;
  if ((loops.get(a.type) || { n: 0 }).n >= 3 || silent) return 'stuck';
  if (kids) return 'helper';
  if (state !== 'working') return state;
  if (bashInFlight) return 'running';
  if (a.last && a.last.kind === 'file' && t - a.last.at <= TOOL_LINGER_MS) return a.last.file;
  return 'working';
}

test('property: a card shows exactly the finest name its live signals support, highest priority first', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 70 }), (ops) => {
    simulate(ops, ({ m, agents, changes, t, loops, fgKids }) => {
      for (const r of m.roster()) {
        // 1. shape
        if (r.state === 'working' || r.state === 'stressed') assert.ok(FINER[r.state].includes(r.detail), `${r.agent}: ${r.state}/${r.detail}`);
        else assert.strictEqual(r.detail, r.state, `${r.agent}: a ${r.state} card has no finer name`);
        assert.strictEqual(m.detailOf(r.agent), r.detail);
        const runs = agents.filter(x => x.alive && x.type === r.agent);
        // 4. a card with no live run shows its state
        if (runs.length === 0) { assert.strictEqual(r.detail, r.state, `${r.agent} has no live run`); continue; }
        if (r.state !== 'working' && r.state !== 'stressed') continue;
        // 2 + 3. the best of what its live runs support
        let want = r.state;
        for (const a of runs) {
          const d = runDetail(a, r.state, t, loops, fgKids);
          if ((RANK[d] || 0) > (RANK[want] || 0)) want = d;
        }
        assert.strictEqual(r.detail, want, `${r.agent}: state ${r.state}, ${runs.length} live run(s)`);
      }
      // 5. events
      for (const c of changes) assert.ok(typeof c.detail === 'string' && c.detail, 'a change carries a detail');
      for (const r of m.roster()) {
        const last = [...changes].reverse().find(c => c.agent === r.agent);
        assert.ok(last, `${r.agent} was announced`);
        assert.deepStrictEqual([last.state, last.detail], [r.state, r.detail], `${r.agent}: the roster is the last thing announced`);
      }
    });
  }), { numRuns: 600, examples: [[[
    // BACKLOG #95 (Dexter F1): three identical ok Bash results trip the retry loop, then a failed SendMessage ends it.
    { op: 'spawn', from: 0, type: 0, bg: false },
    { op: 'bashPost', who: 0, kind: 'ok', same: true, ofLast: false },
    { op: 'bashPost', who: 0, kind: 'ok', same: true, ofLast: false },
    { op: 'bashPost', who: 0, kind: 'ok', same: true, ofLast: false },
    { op: 'postOnly', who: 0 },
  ]], [[
    // PR #182 (Dexter 1): an interrupt is a hooked event of the run, so it refreshes the parent chain before the run ends.
    { op: 'spawn', from: 0, type: 0, bg: false },
    { op: 'spawn', from: 1, type: 1, bg: false },
    { op: 'advance', ms: 20000 },
    { op: 'advance', ms: 15000 },
    { op: 'interrupt', who: 1 },
  ]]] });
});

test('property: the same (agent, state, detail) is never announced twice in a row', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 70 }), (ops) => {
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

test('property: when the session ends nothing finer lingers, and prompts that name no agent never mark a card', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
    simulate([...ops, { op: 'sessionEnd' }], ({ m, o }) => {
      if (o.op !== 'sessionEnd') return;
      for (const r of m.roster()) assert.strictEqual(r.detail, r.state, `${r.agent} after SessionEnd`);
    });
    // every PermissionRequest loses its agent_id (the main session's own prompt) and every Notification is what the CLI sends: no card waits
    const unnamed = ops.map(x => (x.op === 'permission' ? { ...x, named: false } : x));
    simulate(unnamed, ({ m }) => {
      for (const r of m.roster()) assert.notStrictEqual(r.detail, 'waiting', `${r.agent}: nobody named an agent`);
    });
  }), { numRuns: 200 });
});
