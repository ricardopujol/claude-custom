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
  // Only tools whose Post hooks are registered (host/settings-writer.js POST_TOOL_MATCHER): a Read has none (PR #239 Dexter 6).
  const failed = (type, tool = 'Bash') =>
    send('PostToolUseFailure', { tool_name: tool, tool_use_id: 'tu' + (++n), tool_input: { command: 'b' }, error: 'boom', ...by(type) });
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
  r.failed('ta', 'Bash');
  assert.strictEqual(r.m.stateOf('ta'), 'stressed');
  assert.strictEqual(r.m.causeOf('ta'), 'A Bash call failed');
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
  // Ricardo's sentence said "the same read"; a read has no Post hook, so the live shape is a repeated command (PR #239 Dexter 6).
  for (let i = 0; i < 3; i++) { r.ok('ta', 'Bash', { command: 'npm test' }); if (i < 2) r.advance(20_000); }
  assert.strictEqual(r.m.causeOf('ta'), '2 messages to the hub failed to send, then it retried the same command 3 times in 40 s');
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
  const changes = [];
  r.m.on('change', (c) => changes.push(c));
  r.err('ta');
  const before = r.cards.length;
  const changedBefore = changes.length;
  r.err('ta');
  assert.ok(r.cards.length > before, 'the second failure changed the words');
  assert.strictEqual(r.cards[r.cards.length - 1].agent, 'ta');
  assert.strictEqual(changes.length, changedBefore, 'and no repeated `change`: the state and detail stayed (PR #239 Miguel S2)');
});

test('stressCause: no record, or nothing in it, is no cause', () => {
  assert.strictEqual(stressCause(null), null);
  assert.strictEqual(stressCause({ failures: [], retry: null }), null);
  const f = [];
  addFailure(f, { tool: 'Bash', at: 0 });
  addFailure(f, { tool: 'Edit', at: 5 });
  addFailure(f, { tool: 'Bash', at: 9 });
  assert.strictEqual(stressCause({ failures: f, retry: null }), '2 Bash calls failed, then an Edit call failed');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Grep', count: 4, from: 0, to: 125_000 } }), 'It retried the same search 4 times in 2 min 5 s');
});

// ---- the property -------------------------------------------------------------------------------------------------

const TYPES = ['ta', 'tb'];
// PR #239 Dexter 8: the generator reaches the seams the review found. A `quiet` spawn says nothing until its first call, so first
// speech can come in any order against spawn order (crosswise binding, Dexter 2); `result` is a spawn's completed result (adopt(),
// with or without a SubagentStop after it); `resume` brings an ended run back by SendMessage, inside its flash or after (Dexter 3);
// `again` re-delivers the last event as it was.
const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('spawn'), type: fc.nat(), fail: fc.boolean(), quiet: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ op: fc.constant('call'), who: fc.nat(), kind: fc.constantFrom('ok', 'same', 'same', 'err', 'fail', 'send'), tool: fc.constantFrom('Bash', 'Artifact') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 0, max: 12_000 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('finish'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('result'), who: fc.nat(), stopToo: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('resume'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('again') }) },
  // PR #239 Dexter R2-1: a main-session call with no agent_id, before the host has seen any labelled one (the old fallback pins it
  // on the youngest foreground run, a guess). A good call, as a main-session Bash that returns before a subagent speaks.
  { weight: 1, arbitrary: fc.record({ op: fc.constant('main') }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('interrupt'), who: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('stop') }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('sessionEnd') }) },
);

function run(ops, onStep) {
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t, stallMs: 10 ** 12, maxInvocationMs: 10 ** 12, quietStallMs: 10 ** 12 });
  // `live`: the runs going; `gone`: runs that spoke and ended (the machine knows their ids, so a resume reaches them).
  // `own`: the oracle's model of a run's OWN state (PR #239 Dexter 1), from its own calls only.
  const live = [];
  const gone = [];
  let n = 0;
  let last = null;                                  // the last event, for `again`: { event, payload, apply }
  // `labelled`: a call naming its agent_id has been sent; `guessedTypes`: names a pre-labelled main call was pinned on.
  const state = { labelled: false, guessedTypes: new Set() };
  const send = (event, payload, apply = null) => {
    last = { event, payload, apply };
    if (payload && payload.agent_id) state.labelled = true;
    m.handle({ event, payload });
    if (apply) apply();
  };
  const by = (a) => ({ agent_id: a.id, agent_type: a.type });
  const fresh = (a) => Object.assign(a, { own: 'working', sig: null, reps: 0 });
  const leave = (a) => { live.splice(live.indexOf(a), 1); if (a.spoke) gone.push(a); };
  // Ops that name a run by its id pick one that has SPOKEN: a SubagentStop of a run that never spoke is first-come bound to some
  // unbound record of its type, the crosswise limit the machine accepts (host/mood-machine.js bind()).
  const spoken = () => live.filter(a => a.spoke);
  for (const o of ops) {
    const pick = (list, i) => (list.length ? list[i % list.length] : null);
    switch (o.op) {
      case 'spawn': {
        const type = TYPES[o.type % TYPES.length];
        const key = 'toolu_' + (++n);
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: key, tool_input: { subagent_type: type } });
        if (o.fail) { send('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: key, error: 'boom' }); break; }
        const a = fresh({ id: 'a' + type + '-' + String(++n).padStart(16, '0'), type, key, spoke: !o.quiet, background: false });
        live.push(a);
        if (!o.quiet) send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: {}, ...by(a) });
        break;
      }
      case 'call': {
        const a = pick(live, o.who);
        if (!a) break;
        a.spoke = true;
        const common = { tool_name: o.tool, tool_use_id: 'tu' + (++n), ...by(a) };
        const apply = () => {
          if (o.kind === 'fail' || o.kind === 'send' || o.kind === 'err') { a.own = 'stressed'; a.sig = null; a.reps = 0; return; }
          const sig = o.kind === 'same' ? o.tool + ':same' : null;
          a.reps = sig !== null && sig === a.sig ? a.reps + 1 : 1;
          a.sig = sig;
          a.own = a.reps >= 3 ? 'stressed' : 'working';
        };
        if (o.kind === 'fail') send('PostToolUseFailure', { ...common, tool_input: {}, error: 'x' }, apply);
        else if (o.kind === 'send') send('PostToolUse', { ...common, tool_name: 'SendMessage', tool_input: { to: 'hub' }, tool_response: { success: false } }, apply);
        else send('PostToolUse', { ...common, tool_input: { command: o.kind === 'same' ? 'same' : 'c' + (++n) },
          tool_response: { exit_code: o.kind === 'err' ? 1 : 0 } }, apply);
        break;
      }
      case 'advance': t += o.ms; m.tick(); last = null; break;
      case 'finish': { const a = pick(spoken(), o.who); if (!a) break; send('SubagentStop', by(a)); leave(a); break; }
      case 'result': {
        // A spawned run's completed result, naming its id; its own SubagentStop may follow (a no-op then) or never come.
        const a = pick(spoken().filter(x => !x.background), o.who);
        if (!a) break;
        send('PostToolUse', { tool_name: 'Agent', tool_use_id: a.key, tool_input: { subagent_type: a.type }, tool_response: { status: 'completed', agentId: a.id } });
        if (o.stopToo) send('SubagentStop', by(a));
        leave(a);
        break;
      }
      case 'resume': {
        const a = pick(gone, o.who);
        if (!a) break;
        send('PostToolUse', { tool_name: 'SendMessage', tool_use_id: 'sm' + (++n), tool_input: { to: a.id, message: 'again' },
          tool_response: { success: true, resumedAgentId: a.id } });
        gone.splice(gone.indexOf(a), 1);
        live.push(fresh(Object.assign(a, { background: true })));     // a resumed run is background work, a fresh record
        break;
      }
      case 'again': if (last) send(last.event, last.payload, last.apply); break;
      case 'main': {
        if (state.labelled) break;                   // only before the first labelled call: after it, nothing is pinned by guess
        const fg = live.filter(x => !x.background);
        if (fg.length) state.guessedTypes.add(fg[fg.length - 1].type);
        send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'main' + (++n), tool_input: { command: 'main ' + n }, tool_response: { exit_code: 0 } });
        break;
      }
      case 'interrupt': { const a = pick(spoken(), o.who); if (!a) break; send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), is_interrupt: true, ...by(a) }); leave(a); break; }
      // The turn ends its foreground runs; a resumed (background) run outlives it.
      case 'stop': send('Stop', {}); for (const a of live.filter(x => !x.background)) leave(a); break;
      case 'sessionEnd': send('SessionEnd', {}); for (const a of [...live]) leave(a); break;
      default: throw new Error(o.op);
    }
    onStep(m, live, state);
  }
}

const sentence = (c) => typeof c === 'string' && c.trim() !== '';

test('property: whatever the events, a stressed card always carries a non-empty cause, and a card not stressed carries none', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
    run(ops, (m, live, state) => {
      for (const r of m.roster()) {
        const c = m.causeOf(r.agent);
        if (r.state === 'stressed') assert.ok(sentence(c), `${r.agent} is stressed with no cause`);
        else assert.strictEqual(c, null, `${r.agent} is ${r.state} and still says ${JSON.stringify(c)}`);
        // #142 b: the same holds for every instance card, and the instance cards are the live runs (plus finishes still flashing).
        // Runs are matched by their OWN agent_id, never by spawn key: a crosswise binding puts a run on its sibling's record (and
        // card id) until adopt() corrects it, and the card must show the run's own record all along (Dexter 1, 2).
        const rows = m.instancesOf(r.agent);
        const mine = live.filter(a => a.type === r.agent);
        if (rows === null) {
          assert.ok(mine.length <= 1, `${r.agent}: ${mine.length} live runs and no instance cards`);
          // PR #239 Dexter 1: one card left with one live run is THAT run's card, never a departed sibling's record.
          // While no call has been labelled yet, a name a main call was pinned on keeps the name-scoped rule (the accepted guess of
          // an older CLI); from the first labelled call on, that guess is void (Dexter R2-1).
          const stillGuessed = !state.labelled && state.guessedTypes.has(r.agent);
          if (mine.length === 1 && !stillGuessed) assert.strictEqual(r.state, mine[0].own, `${r.agent}: the one card shows ${r.state}, its run is ${mine[0].own}`);
          continue;
        }
        assert.ok(rows.length >= 2, `${r.agent}: instance cards only for two or more`);
        assert.strictEqual(new Set(rows.map(x => x.id)).size, rows.length, `${r.agent}: an id twice`);
        const liveRows = rows.filter(x => x.ended !== true);
        assert.strictEqual(liveRows.length, mine.length, `${r.agent}: ${liveRows.length} live cards for ${mine.length} live runs`);
        for (const a of mine.filter(x => x.spoke)) {
          const its = liveRows.filter(x => x.agentId === a.id);
          assert.strictEqual(its.length, 1, `${r.agent}: live run ${a.id} is one card`);
          assert.strictEqual(its[0].state, a.own, `${r.agent}/${a.id}: its card shows ${its[0].state}, the run is ${a.own}`);
        }
        for (const x of rows) {
          if (x.state === 'stressed') assert.ok(sentence(x.cause), `${r.agent}/${x.id} is stressed with no cause`);
          else assert.strictEqual(x.cause, undefined, `${r.agent}/${x.id} is ${x.state} and still says ${JSON.stringify(x.cause)}`);
          if (x.ended === true) assert.ok(x.state === 'happy' || x.state === 'stressed', `${r.agent}/${x.id}: an ended run only shows its finish`);
        }
        // An asleep name shows no cards at all (Dexter 8: the SLEEPING clear of the flashes).
        assert.notStrictEqual(r.state, 'sleeping', `${r.agent} is asleep with ${rows.length} cards`);
      }
    });
  }), { numRuns: 500 });
});
