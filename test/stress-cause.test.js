'use strict';
/**
 * host/stress-cause.js on its own (PR #239 Dexter 6, Miguel Y4, S7, S10): the ONE source of a stressed card's sentence (#162),
 * pinned without the mood machine. Fixtures use only calls that can reach it live: a PostToolUse / PostToolUseFailure is hooked
 * for host/settings-writer.js POST_TOOL_MATCHER's tools (Bash, SendMessage, Agent ...), never for Read, Grep or Glob.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { stressCause, addFailure, MAX_KINDS, TO_MAX } = require('../host/stress-cause');

const record = (fails, retry = null) => {
  const failures = [];
  fails.forEach((f, i) => addFailure(failures, { at: i, ...f }));
  return { failures, retry };
};

test('one and many of a kind: the plurals', () => {
  assert.strictEqual(stressCause(record([{ tool: 'Bash' }])), 'A Bash call failed');
  assert.strictEqual(stressCause(record([{ tool: 'Bash' }, { tool: 'Bash' }])), '2 Bash calls failed');
  assert.strictEqual(stressCause(record([{ tool: 'Artifact' }])), 'An Artifact call failed', 'an, before a vowel');
  assert.strictEqual(stressCause(record([{ run: true }])), 'Its run failed');
  assert.strictEqual(stressCause(record([{ run: true }, { run: true }])), '2 of its runs failed');
  assert.strictEqual(stressCause(record([{}])), 'A tool call failed', 'a failure with no tool name');
});

test('a message that failed to send: with its recipient, without one, and a long recipient capped', () => {
  assert.strictEqual(stressCause(record([{ tool: 'SendMessage', to: 'the hub' }])), 'A message to the hub failed to send');
  assert.strictEqual(stressCause(record([{ tool: 'SendMessage' }])), 'A message failed to send');
  assert.strictEqual(stressCause(record([{ tool: 'SendMessage', to: '  ' }])), 'A message failed to send', 'a blank recipient is none');
  assert.strictEqual(stressCause(record([{ tool: 'SendMessage', to: 'x' }, { tool: 'SendMessage', to: 'y' }])),
    'A message to x failed to send, then a message to y failed to send', 'two recipients are two kinds');
  // S7: `to` is whatever the model typed; it is drawn in a tooltip and kept per kind, so it's capped.
  const long = 'r'.repeat(200);
  const said = stressCause(record([{ tool: 'SendMessage', to: long }]));
  assert.strictEqual(said, `A message to ${'r'.repeat(TO_MAX - 1)}… failed to send`);
  assert.ok(TO_MAX <= 60);
  const f = [];
  addFailure(f, { tool: 'SendMessage', to: long, at: 0 });
  addFailure(f, { tool: 'SendMessage', to: long + 'tail', at: 1 });
  assert.strictEqual(f.length, 1, 'two recipients alike up to the cap are one kind');
  assert.strictEqual(f[0].n, 2);
});

test('the record is bounded: past MAX_KINDS kinds, the rest is one count', () => {
  const f = [];
  for (let i = 0; i < MAX_KINDS + 5; i++) addFailure(f, { tool: 'T' + i, at: i });
  assert.strictEqual(f.length, MAX_KINDS + 1);
  assert.deepStrictEqual(f[MAX_KINDS], { rest: true, n: 5, first: MAX_KINDS });
  addFailure(f, { tool: 'T0', at: 99 });
  assert.strictEqual(f[0].n, 2, 'a kind already kept still counts on');
  assert.strictEqual(f.length, MAX_KINDS + 1);
});

test('more than three kinds: the sentence names three and counts the rest, singular and plural', () => {
  assert.strictEqual(stressCause(record([{ tool: 'Bash' }, { tool: 'TaskStop' }, { tool: 'Agent' }, { tool: 'Artifact' }])),
    'A Bash call failed, then a TaskStop call failed, then an Agent call failed, then 1 more call failed');
  assert.strictEqual(stressCause(record([{ tool: 'Bash' }, { tool: 'TaskStop' }, { tool: 'Agent' }, { tool: 'Artifact' }, { tool: 'Artifact' }])),
    'A Bash call failed, then a TaskStop call failed, then an Agent call failed, then 2 more calls failed');
  const f = [];
  for (let i = 0; i < MAX_KINDS + 2; i++) addFailure(f, { tool: 'T' + i, at: i });
  assert.match(stressCause({ failures: f, retry: null }), /then 7 more calls failed$/, 'the kinds past three plus the rest bucket');
});

test('a retry series: the noun for a plain tool, the tool\'s own name otherwise, and no count when it isn\'t one', () => {
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Bash', count: 3, from: 0, to: 40_000 } }), 'It retried the same command 3 times in 40 s');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'mcp__db__query', count: 3, from: 0, to: 2_000 } }),
    'It retried the same mcp__db__query call 3 times in 2 s');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: null, count: 3, from: 0, to: 1_000 } }), 'It retried the same call 3 times in 1 s');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Bash', count: 0, from: 0, to: 1_000 } }), 'It retried the same command in 1 s');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Bash', count: 2.5, from: 0, to: 1_000 } }), 'It retried the same command in 1 s');
});

test('the span at its boundaries (S10): seconds under a minute, minutes and seconds under ten minutes, whole minutes after', () => {
  const say = (ms) => stressCause({ failures: [], retry: { tool: 'Bash', count: 3, from: 0, to: ms } });
  assert.strictEqual(say(0), 'It retried the same command 3 times in 1 s', 'never "in 0 s"');
  assert.strictEqual(say(59_499), 'It retried the same command 3 times in 59 s');
  assert.strictEqual(say(59_500), 'It retried the same command 3 times in 1 min', 'never "in 60 s"');
  assert.strictEqual(say(60_000), 'It retried the same command 3 times in 1 min');
  assert.strictEqual(say(90_000), 'It retried the same command 3 times in 1 min 30 s', 'not "in 2 min"');
  assert.strictEqual(say(599_000), 'It retried the same command 3 times in 9 min 59 s');
  assert.strictEqual(say(600_000), 'It retried the same command 3 times in 10 min');
  assert.strictEqual(say(629_000), 'It retried the same command 3 times in 10 min');
  assert.strictEqual(say(-5), 'It retried the same command 3 times', 'a negative span (a clock step back) says no span');
  assert.strictEqual(stressCause({ failures: [], retry: { tool: 'Bash', count: 3, from: NaN, to: 5 } }), 'It retried the same command 3 times');
});

test('failures and the retry series in the order they happened; an unknown time goes last', () => {
  const failures = [];
  addFailure(failures, { tool: 'Bash', at: 50 });
  assert.strictEqual(stressCause({ failures, retry: { tool: 'Bash', count: 3, from: 10, to: 30 } }),
    'It retried the same command 3 times in 1 s, then a Bash call failed');
  const unknown = [];
  addFailure(unknown, { tool: 'Bash' });
  assert.strictEqual(stressCause({ failures: unknown, retry: { tool: 'Bash', count: 3, from: 10, to: 30 } }),
    'It retried the same command 3 times in 1 s, then a Bash call failed');
});

test('property: the sentence is null or one non-empty sentence with a capital, and the record never holds more than MAX_KINDS + 1', () => {
  const fail = fc.record({ tool: fc.option(fc.constantFrom('Bash', 'SendMessage', 'Agent', 'TaskStop', 'Artifact', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6')),
    to: fc.option(fc.string({ maxLength: 120 })), run: fc.boolean(), at: fc.option(fc.integer()) });
  const retry = fc.option(fc.record({ tool: fc.option(fc.string()), count: fc.integer({ min: -1, max: 9 }),
    from: fc.option(fc.integer()), to: fc.option(fc.integer()) }));
  fc.assert(fc.property(fc.array(fail, { maxLength: 40 }), retry, (fails, r) => {
    const failures = [];
    for (const f of fails) addFailure(failures, { ...f, tool: f.tool ?? undefined, to: f.to ?? undefined, at: f.at ?? undefined });
    assert.ok(failures.length <= MAX_KINDS + 1);
    assert.strictEqual(failures.reduce((s, f) => s + f.n, 0), fails.length, 'every failure is counted once');
    const s = stressCause({ failures, retry: r });
    if (s === null) assert.ok(failures.length === 0 && !r);
    else { assert.ok(s.trim() !== ''); assert.strictEqual(s.charAt(0), s.charAt(0).toUpperCase()); assert.doesNotMatch(s, /NaN|undefined|null/); }
  }), { numRuns: 300 });
});

// Whether the mood machine's cause tests post only hooked tools is a source-shape check: test/source-contracts.test.js.
