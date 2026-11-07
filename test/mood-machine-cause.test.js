'use strict';
/**
 * BACKLOG #162: hovering a stressed agent shows why. The mood machine knows each cause (host/mood-machine.js header: a tool error,
 * a failed call, the same call three times running, SubagentStop with errors), and now says it: `causeOf(agent)` is one short
 * sentence built by host/stress-cause.js from the card's own record, present while the card is stressed and gone when it isn't.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createMoodMachine, FLASH_MS } = require('../host/mood-machine');
const { stressCause, addFailure } = require('../host/stress-cause');

function rig() {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t });
  const cards = [];
  m.on('cards', (c) => cards.push(c));
  let n = 0;
  const send = (event, payload) => m.handle({ event, payload });
  const id = (type) => 'a' + type + '-' + String(1).padStart(16, '0');
  const by = (type) => ({ agent_id: id(type), agent_type: type });
  const spawnAgent = (type, key = 'toolu_' + (++n)) => {
    send('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type } });
    send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/a' }, ...by(type) });
    return key;
  };
  const ok = (type, tool = 'Bash', input = { command: 'c' + (++n) }) =>
    send('PostToolUse', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: input, tool_response: { exit_code: 0 }, ...by(type) });
  const err = (type, tool = 'Bash') =>
    send('PostToolUse', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: { command: 'x' }, tool_response: { exit_code: 1 }, ...by(type) });
  const failed = (type, tool = 'Read') =>
    send('PostToolUseFailure', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/b' }, error: 'boom', ...by(type) });
  const sendFailed = (type, to) =>
    send('PostToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm' + (++n), tool_input: { to, message: 'hi' }, tool_response: { success: false }, ...by(type) });
  return { m, cards, send, by, spawnAgent, ok, err, failed, sendFailed, advance: (ms) => { t += ms; m.tick(); } };
}

test('a tool error: the cause names the tool, and counts', () => {
  const r = rig();
  r.spawnAgent('ta');
  assert.strictEqual(r.m.causeOf('ta'), null, 'a working card has no cause');
  r.err('ta');
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'A Bash call failed');
  r.err('ta');
  assert.strictEqual(r.m.causeOf('ta'), '2 Bash calls failed');
});

test('a failed call (PostToolUseFailure, its only event) is a cause too', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.failed('ta', 'Read');
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'A Read call failed');
});

test('a message that failed to send says whom it was for', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.sendFailed('ta', 'the hub');
  assert.strictEqual(r.m.causeOf('ta'), 'A message to the hub failed to send');
  r.sendFailed('ta', 'the hub');
  assert.strictEqual(r.m.causeOf('ta'), '2 messages to the hub failed to send');
});

test('the same call three times running: the cause says what and how long it took', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.ok('ta', 'Bash', { command: 'npm test' });
  r.advance(20_000);
  r.ok('ta', 'Bash', { command: 'npm test' });
  assert.strictEqual(r.m.causeOf('ta'), null, 'twice is not a loop');
  r.advance(20_000);
  r.ok('ta', 'Bash', { command: 'npm test' });
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'It retried the same command 3 times in 40 s');
});

test('Ricardo\'s example: failures, then a retry loop, in the order they happened', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.sendFailed('ta', 'the hub');
  r.sendFailed('ta', 'the hub');
  for (let i = 0; i < 3; i++) { r.ok('ta', 'Read', { file_path: 'C:/same' }); if (i < 2) r.advance(20_000); }
  assert.strictEqual(r.m.causeOf('ta'), '2 messages to the hub failed to send, then it retried the same read 3 times in 40 s');
});

test('SubagentStop with errors: the stressed flash carries what failed', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.err('ta');
  r.ok('ta');
  assert.strictEqual(r.m.stateOf('ta'), 'working', 'a later good call shows working again');
  assert.strictEqual(r.m.causeOf('ta'), null, 'and the cause leaves with stressed');
  r.send('SubagentStop', r.by('ta'));
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'A Bash call failed');
});

test('a spawn that fails is the run failing', () => {
  const r = rig();
  r.send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: { subagent_type: 'ta' } });
  r.send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: { subagent_type: 'ta' }, error: 'boom' });
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'Its run failed');
});

test('the cause clears when the state leaves stressed, and a fresh run starts clean', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.err('ta');
  r.send('SubagentStop', r.by('ta'));
  r.advance(FLASH_MS + 1);
  assert.strictEqual(r.m.stateOf('ta'), 'sleeping');
  assert.strictEqual(r.m.causeOf('ta'), null);
  r.spawnAgent('ta', 'toolu_again');
  r.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu-z', tool_input: { command: 'x' }, tool_response: { exit_code: 1 },
    agent_id: 'ata-' + String(2).padStart(16, '0'), agent_type: 'ta' });
  assert.strictEqual(r.m.causeOf('ta'), 'A Bash call failed', 'the earlier run\'s failure is not counted again');
});

test('a cause that changes while the card stays stressed is announced as `cards`, never as a repeated `change`', () => {
  const r = rig();
  r.spawnAgent('ta');
  r.err('ta');
  const before = r.cards.length;
  r.err('ta');
  assert.ok(r.cards.length > before, 'the second failure changed the words');
  assert.strictEqual(r.cards[r.cards.length - 1].agent, 'ta');
});

test('stressCause: no record, or nothing in it, is no cause', () => {
  assert.strictEqual(stressCause(null), null);
  assert.strictEqual(stressCause({ failures: [], retry: null }), null);
  const f = [];
  addFailure(f, { tool: 'Bash', at: 0 });
  addFailure(f, { tool: 'Edit', at: 5 });
  addFailure(f, { tool: 'Bash', at: 9 });
  assert.strictEqual(stressCause({ failures: f, retry: null }), '2 Bash calls failed, then an Edit call failed');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Grep', count: 4, from: 0, to: 125_000 } }), 'It retried the same search 4 times in 2 min');
});

// ---- the property -------------------------------------------------------------------------------------------------

const TYPES = ['ta', 'tb'];
const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('spawn'), type: fc.nat(), fail: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ op: fc.constant('call'), who: fc.nat(), kind: fc.constantFrom('ok', 'same', 'same', 'err', 'fail', 'send'), tool: fc.constantFrom('Bash', 'Read') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 12_000 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('interrupt'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('stop') }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
);

function run(ops, onStep) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, stallMs: 10 ** 12, maxInvocationMs: 10 ** 12, quietStallMs: 10 ** 12 });
  const live = [];
  let n = 0;
  const send = (event, payload) => m.handle({ event, payload });
  const by = (a) => ({ agent_id: a.id, agent_type: a.type });
  for (const o of ops) {
    const pick = (i) => (live.length ? live[i % live.length] : null);
    switch (o.op) {
      case 'spawn': {
        const type = TYPES[o.type % TYPES.length];
        const key = 'toolu_' + (++n);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type } });
        if (o.fail) { send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: key, error: 'boom' }); break; }
        const a = { id: 'a' + type + '-' + String(++n).padStart(16, '0'), type, key };
        live.push(a);
        send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: {}, ...by(a) });
        break;
      }
      case 'call': {
        const a = pick(o.who);
        if (!a) break;
        const common = { tool_name: o.tool, tool_use_id: 'tu' + (++n), ...by(a) };
        if (o.kind === 'fail') send('PostToolUseFailure', { ...common, tool_input: {}, error: 'x' });
        else if (o.kind === 'send') send('PostToolUse', { ...common, tool_name: 'SendMessage', tool_input: { to: 'hub' }, tool_response: { success: false } });
        else send('PostToolUse', { ...common, tool_input: { command: o.kind === 'same' ? 'same' : 'c' + (++n) },
          tool_response: { exit_code: o.kind === 'err' ? 1 : 0 } });
        break;
      }
      case 'advance': t += o.ms; m.tick(); break;
      case 'finish': { const a = pick(o.who); if (!a) break; send('SubagentStop', by(a)); live.splice(live.indexOf(a), 1); break; }
      case 'interrupt': { const a = pick(o.who); if (!a) break; send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), is_interrupt: true, ...by(a) }); live.splice(live.indexOf(a), 1); break; }
      case 'stop': send('Stop', {}); live.length = 0; break;
      case 'sessionEnd': send('SessionEnd', {}); live.length = 0; break;
      default: throw new Error(o.op);
    }
    onStep(m, live);
  }
}

const sentence = (c) => typeof c === 'string' && c.trim() !== '';

test('property: whatever the events, a stressed card always carries a non-empty cause, and a card not stressed carries none', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
    run(ops, (m, live) => {
      for (const r of m.roster()) {
        const c = m.causeOf(r.agent);
        if (r.state === 'stressed') assert.ok(sentence(c), `${r.agent} is stressed with no cause`);
        else assert.strictEqual(c, null, `${r.agent} is ${r.state} and still says ${JSON.stringify(c)}`);
        // #142 b: the same holds for every instance card, and the instance cards are the live runs (plus finishes still flashing)
        const rows = m.instancesOf(r.agent);
        const mine = live.filter(a => a.type === r.agent).map(a => a.key);
        if (rows === null) { assert.ok(mine.length <= 1, `${r.agent}: ${mine.length} live runs and no instance cards`); continue; }
        assert.ok(rows.length >= 2, `${r.agent}: instance cards only for two or more`);
        assert.strictEqual(new Set(rows.map(x => x.id)).size, rows.length, `${r.agent}: an id twice`);
        for (const k of mine) assert.strictEqual(rows.filter(x => x.id === k).length, 1, `${r.agent}: live run ${k} is one card`);
        for (const x of rows) {
          if (x.state === 'stressed') assert.ok(sentence(x.cause), `${r.agent}/${x.id} is stressed with no cause`);
          else assert.strictEqual(x.cause, undefined, `${r.agent}/${x.id} is ${x.state} and still says ${JSON.stringify(x.cause)}`);
          if (!mine.includes(x.id)) assert.ok(x.state === 'happy' || x.state === 'stressed', `${r.agent}/${x.id}: an ended run only shows its finish`);
        }
      }
    });
  }), { numRuns: 500 });
});
