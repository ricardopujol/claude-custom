'use strict';
/**
 * What the host tells every window about the night (host/night-status.js, backlog #52): the bedtime view plus
 * "PRs so far", pushed only when it changed, with the PR count asked at the start and at every wake.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createNightStatus } = require('../host/night-status');
const { createBedtime } = require('../host/bedtime-state');

const T0 = Date.UTC(2026, 9, 3, 6, 15, 0);
const MIN = 60_000;
const PROMPT = '/bedtime overnight run';

function rig({ prs = async () => 2 } = {}) {
  let t = T0;
  const asked = [];
  const sent = [];
  const n = createNightStatus({
    bedtime: createBedtime({ now: () => t }),
    countPrs: (since) => { asked.push(since); return prs(since); },
    now: () => t,
    onChange: (p) => sent.push(p),
  });
  const api = {
    n, asked, sent,
    at(ms) { t = ms; return api; },
    send(event, payload = {}) { return n.handle({ event, payload }); },
    // a whole successful call: the Pre, then the Post with the CLI's scheduledFor (a night starts on the Post)
    sched(delay = 1800) {
      const input = { delaySeconds: delay, reason: 'r', prompt: PROMPT };
      api.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: input });
      return api.send('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: input, tool_response: { scheduledFor: t + delay * 1000 } });
    },
  };
  return api;
}
const settle = () => new Promise(r => setImmediate(r));

test('no night: no payload, nothing pushed, no gh call', () => {
  const r = rig();
  r.send('UserPromptSubmit', { prompt: '/bedtime' });
  assert.strictEqual(r.n.payload(), null);
  assert.deepStrictEqual(r.sent, []);
  assert.deepStrictEqual(r.asked, []);
});

test('the night starting pushes at once with PRs unknown (null), asks gh from the start time, then pushes the count', async () => {
  const r = rig();
  r.sched();
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.sent[0].prs, null, 'unknown until gh answers: never 0');
  assert.deepStrictEqual(r.asked, [T0]);
  await settle();
  assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.sent[1].prs, 2);
  assert.strictEqual(r.n.payload().prs, 2);
});

test('gh failing leaves the count unknown, and the rest of the chip stays', async () => {
  const r = rig({ prs: async () => null });
  r.sched();
  await settle();
  const p = r.n.payload();
  assert.strictEqual(p.prs, null);
  assert.strictEqual(p.startedAt, T0);
  assert.strictEqual(typeof p.nextWakeAt, 'number');
  assert.strictEqual(r.sent.length, 1, 'null after null changes nothing, so nothing more is pushed');
});

test('gh throwing or never answering cannot break the host: it is just unknown', async () => {
  const r = rig({ prs: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => r.sched());
  await settle();
  assert.strictEqual(r.n.payload().prs, null);
  const r2 = rig({ prs: () => Promise.reject(new Error('offline')) });
  r2.sched();
  await settle();
  assert.strictEqual(r2.n.payload().prs, null);
});

test('each wake asks again; a call that is not a wake does not', async () => {
  const r = rig();
  r.sched();
  await settle();
  r.send('Stop');
  r.at(T0 + 31 * MIN);
  r.send('UserPromptSubmit', { prompt: 'how is it going' });       // the person typing: not a wake
  r.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(r.asked.length, 1);
  r.send('UserPromptSubmit', { prompt: PROMPT });                   // the wake
  assert.strictEqual(r.asked.length, 2);
  assert.deepStrictEqual(r.asked, [T0, T0]);
});

test('a late answer for a night that has ended is dropped, never shown on the next one', async () => {
  let release;
  const slow = new Promise(res => { release = res; });
  let call = 0;
  const r = rig({ prs: () => (call++ === 0 ? slow : Promise.resolve(7)) });
  r.sched();
  r.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
  r.at(T0 + MIN);
  r.sched();                                         // a new night
  await settle();
  assert.strictEqual(r.n.payload().prs, 7);
  release(99);
  await settle();
  assert.strictEqual(r.n.payload().prs, 7, 'the first night\'s answer arrived late and was ignored');
});

test('stop clears it: a null is pushed so every window drops the chip, once', () => {
  const r = rig();
  r.sched();
  r.sent.length = 0;
  r.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
  assert.deepStrictEqual(r.sent, [null]);
  r.send('Stop');
  assert.strictEqual(r.sent.length, 1, 'already clear: nothing more');
});

test('tick: the overdue verdict is time, so it is pushed when the clock makes it, not before', () => {
  const r = rig();
  r.sched(1800);
  r.send('Stop');
  const wake = r.n.payload().nextWakeAt;
  r.sent.length = 0;
  r.at(wake + 14 * MIN);
  r.n.tick();
  assert.deepStrictEqual(r.sent, []);
  r.at(wake + 16 * MIN);
  r.n.tick();
  assert.deepStrictEqual(r.sent, [null]);
  r.n.tick();
  assert.strictEqual(r.sent.length, 1);
});

test('a listener that throws never wedges the host', () => {
  const b = createBedtime({ now: () => T0 });
  const n = createNightStatus({ bedtime: b, countPrs: async () => 1, now: () => T0, onChange: () => { throw new Error('socket'); } });
  assert.doesNotThrow(() => n.handle({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: PROMPT } } }));
});

test('property: the payload is null or has a count that is null or a non-negative integer, whatever gh says', async () => {
  await fc.assert(fc.asyncProperty(fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 500 }), fc.constant(undefined), fc.constant(-3), fc.constant(1.5), fc.constant('4')), async (said) => {
    const r = rig({ prs: async () => said });
    r.sched();
    await settle();
    const p = r.n.payload();
    return p !== null && (p.prs === null || (Number.isInteger(p.prs) && p.prs >= 0));
  }));
});

test('a real zero is a zero: gh said no PRs yet, and the chip may say so', async () => {
  const r = rig({ prs: async () => 0 });
  r.sched();
  await settle();
  assert.strictEqual(r.n.payload().prs, 0);
  assert.strictEqual(r.sent[r.sent.length - 1].prs, 0);
});

// --- Miguel G2: a failed gh call keeps the last known count, marked stale; the limit is a floor ----------------
test('G2: a count that was known and then gh fails keeps its number, marked stale; the next good answer clears it', async () => {
  const answers = [3, null, 4];
  const r = rig({ prs: async () => answers.shift() });
  r.sched();
  await settle();
  assert.strictEqual(r.n.payload().prs, 3);
  assert.strictEqual(r.n.payload().prsStale, false);
  r.send('Stop');
  r.at(T0 + 31 * MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });        // a wake: ask again, and gh fails
  await settle();
  assert.strictEqual(r.n.payload().prs, 3, 'the last answer is kept');
  assert.strictEqual(r.n.payload().prsStale, true);
  r.at(T0 + 35 * MIN);
  r.sched(600);                                          // the woken turn schedules again
  r.send('Stop');
  r.at(T0 + 46 * MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  await settle();
  assert.strictEqual(r.n.payload().prs, 4);
  assert.strictEqual(r.n.payload().prsStale, false);
});

test('G2: gh failing before any answer stays unknown and is not "stale": there is no number to mark', async () => {
  const r = rig({ prs: async () => null });
  r.sched();
  await settle();
  assert.strictEqual(r.n.payload().prs, null);
  assert.strictEqual(r.n.payload().prsStale, false);
});

test('G2: a count at gh\'s list limit is a floor, and says so; a new night starts with no stale number from the last', async () => {
  const { PR_LIMIT } = require('../host/night-prs');
  const r = rig({ prs: async () => PR_LIMIT });
  r.sched();
  await settle();
  assert.strictEqual(r.n.payload().prsCapped, true);
  const q = rig({ prs: async () => PR_LIMIT - 1 });
  q.sched();
  await settle();
  assert.strictEqual(q.n.payload().prsCapped, false);
  const n = rig({ prs: async () => 5 });
  n.sched();
  await settle();
  n.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
  n.at(T0 + MIN);
  n.sched();
  assert.strictEqual(n.n.payload().prs, null, 'the new night has no number yet');
  assert.strictEqual(n.n.payload().prsStale, false);
});
