'use strict';
/**
 * host/map-feed.js (BACKLOG #120): what the Map panel asks of the host that no broadcast carries -- hook events counted, per agent over the
 * last minute, the tool in hand, and when this host started. Observation only: it never decides anything about an agent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createMapFeed } = require('../host/map-feed');

const ev = (event, p = {}) => ({ event, payload: p });
const rig = (o = {}) => { const t = { now: 1_000_000 }; return { t, feed: createMapFeed({ now: () => t.now, startedAt: 500_000, ...o }) }; };

test('every hook event counts once toward the total, whoever sent it', () => {
  const { feed } = rig();
  feed.note(ev('PreToolUse', { tool_name: 'Read', agent_type: 'dexter', agent_id: 'a1' }));
  feed.note(ev('PostToolUse', { tool_name: 'Read', agent_type: 'dexter', agent_id: 'a1' }));
  feed.note(ev('PreToolUse', { tool_name: 'Bash' }));
  assert.strictEqual(feed.snapshot().events, 3);
});

test('events a minute are counted per agent type; the main session is "main"', () => {
  const { feed, t } = rig();
  for (let i = 0; i < 20; i += 1) { t.now += 1000; feed.note(ev('PreToolUse', { tool_name: 'Edit', agent_type: 'dexter', agent_id: 'a1' })); }
  for (let i = 0; i < 5; i += 1) { t.now += 1000; feed.note(ev('PreToolUse', { tool_name: 'Bash' })); }
  const s = feed.snapshot();
  assert.strictEqual(s.perMinute.dexter, 20);
  assert.strictEqual(s.perMinute.main, 5);
});

test('only the last minute counts: the rate falls as the agent goes quiet', () => {
  const { feed, t } = rig();
  for (let i = 0; i < 10; i += 1) feed.note(ev('PreToolUse', { agent_type: 'x', agent_id: 'i' }));
  assert.strictEqual(feed.snapshot().perMinute.x, 10);
  t.now += 30_000;
  assert.strictEqual(feed.snapshot().perMinute.x, 10);
  t.now += 31_000;
  assert.ok(!('x' in feed.snapshot().perMinute), 'a silent minute drops the agent from the rates, it is not a 0');
  assert.strictEqual(feed.snapshot().events, 10, 'the total never forgets');
});

test('the tool in hand: set by a PreToolUse, cleared by its PostToolUse, stale after a few seconds', () => {
  const { feed, t } = rig();
  feed.note(ev('PreToolUse', { tool_name: 'Grep', agent_type: 'miguel', agent_id: 'm' }));
  assert.strictEqual(feed.snapshot().tools.miguel, 'Grep');
  feed.note(ev('PostToolUse', { tool_name: 'Grep', agent_type: 'miguel', agent_id: 'm' }));
  assert.ok(!('miguel' in feed.snapshot().tools));
  feed.note(ev('PreToolUse', { tool_name: 'Write', agent_type: 'miguel', agent_id: 'm' }));
  t.now += 9000;
  assert.ok(!('miguel' in feed.snapshot().tools), 'a Write has no Post hook: it lingers a few seconds and goes');
});

test('the host\'s start and uptime ride along', () => {
  const { feed } = rig();
  const s = feed.snapshot();
  assert.strictEqual(s.startedAt, 500_000);
  assert.strictEqual(s.uptimeMs, 500_000);
});

test('junk events are ignored, not counted, and never throw', () => {
  const { feed } = rig();
  for (const bad of [null, undefined, 3, {}, { event: 5 }, { event: '' }, { event: 'PreToolUse', payload: 'x' }]) assert.doesNotThrow(() => feed.note(bad));
  assert.strictEqual(feed.snapshot().events, 1, 'only the last one has a name; a payload that is not an object is main-session');
});

test('an agent named like an Object property is data, not a property', () => {
  const { feed } = rig();
  feed.note(ev('PreToolUse', { agent_type: '__proto__', agent_id: 'i' }));
  feed.note(ev('PreToolUse', { agent_type: 'constructor', agent_id: 'i' }));
  const s = feed.snapshot();
  assert.strictEqual(Object.getPrototypeOf(s.perMinute), null);
  assert.strictEqual(s.perMinute.constructor, 1);
  assert.strictEqual(JSON.parse(JSON.stringify(s)).perMinute.constructor, 1);
});

test('it stays small: a flood of events and of agent names is bounded', () => {
  const { feed } = rig();
  for (let i = 0; i < 5000; i += 1) feed.note(ev('PreToolUse', { agent_type: 'one', agent_id: 'i' }));
  for (let i = 0; i < 1000; i += 1) feed.note(ev('PreToolUse', { agent_type: 'n' + i, agent_id: 'i' }));
  const s = feed.snapshot();
  assert.ok(Object.keys(s.perMinute).length <= 200);
  assert.ok(s.perMinute.one === undefined || s.perMinute.one <= 600);
  assert.strictEqual(s.events, 6000);
  assert.ok(feed.size() <= 200);
});

test('P: whatever arrives, the snapshot is plain numbers and strings', () => {
  const evArb = fc.record({ event: fc.constantFrom('PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', ''), payload: fc.oneof(fc.constant(null), fc.record({ agent_type: fc.oneof(fc.string({ maxLength: 20 }), fc.constant(undefined), fc.integer()), agent_id: fc.oneof(fc.string({ maxLength: 4 }), fc.constant(undefined)), tool_name: fc.oneof(fc.string({ maxLength: 10 }), fc.constant(undefined), fc.integer()) })) });
  fc.assert(fc.property(fc.array(fc.tuple(evArb, fc.integer({ min: 0, max: 20000 })), { maxLength: 80 }), (list) => {
    const { feed, t } = rig();
    for (const [e, gap] of list) { t.now += gap; feed.note(e); }
    const s = JSON.parse(JSON.stringify(feed.snapshot()));
    assert.ok(Number.isInteger(s.events) && s.events >= 0);
    for (const v of Object.values(s.perMinute)) assert.ok(Number.isInteger(v) && v > 0);
    for (const v of Object.values(s.tools)) assert.strictEqual(typeof v, 'string');
  }), { numRuns: 200 });
});
