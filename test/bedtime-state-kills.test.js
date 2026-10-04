'use strict';
/**
 * The bedtime night's guards and boundaries (backlog #60, Mortimer's release-#101 part 2): the continuation
 * window after a capped run at its exact edge, what a failed tool call and a replayed prompt do to a capped or
 * dormant run, the malformed-event guards, and the believability window of `scheduledFor`.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createBedtime, isBedtimeLoopPrompt, isBedtimeOnly, OVERDUE_MS, MAX_NIGHT_MS } = require('../host/bedtime-state');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 3, 2, 15, 0);
const PROMPT = '/bedtime overnight run (claude-custom). Continue the task list.';
// one wake cycle: the longest delay (1 h) + the CLI's slack (2 min) + the grace (15 min), the doc's "77 min"
const CONTINUATION_MS = 77 * MIN;
const SLACK_MS = 2 * MIN;

function rig(start = T0) {
  let t = start;
  const b = createBedtime({ now: () => t });
  const api = {
    b,
    at(ms) { t = ms; return api; },
    send(event, payload = {}) { return b.handle({ event, payload }); },
    posted(prompt, delay, scheduledFor, extra = {}) {
      return api.send('PostToolUse', {
        tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: delay, reason: 'r', prompt, noop: false },
        tool_response: { scheduledFor, clampedDelaySeconds: delay, wasClamped: false }, ...extra,
      });
    },
    sched(prompt = PROMPT, delay = 3600, extra = {}) { return api.posted(prompt, delay, t + delay * 1000, extra); },
    bash() { return api.send('PreToolUse', { tool_name: 'Bash' }); },
    view(ms = t) { return b.view(ms); },
  };
  return api;
}

// A night that was alive at its 12 h cap: `lastSeen` is L, the last sign of life before the cap.
function capped() {
  const r = rig();
  r.sched();
  const L = T0 + MAX_NIGHT_MS - 1;
  r.at(L).bash();
  r.at(T0 + MAX_NIGHT_MS + 1).bash();
  assert.strictEqual(r.b.snapshot(), null, 'the cap ended the night');
  return { r, L };
}

// ---- the continuation window ----

test('a bedtime call exactly one wake cycle after a capped run\'s last sign of life is still that run\'s loop; one ms later is a new run', () => {
  const edge = capped();
  edge.r.at(edge.L + CONTINUATION_MS).sched();
  assert.strictEqual(edge.r.view(), null, 'at the edge: a continuation, no new night');

  const past = capped();
  past.r.at(past.L + CONTINUATION_MS + 1).sched();
  assert.notStrictEqual(past.r.view(), null, 'one ms later: a new night');
});

test('a continuation moves the last sign of life, so the window slides with each call', () => {
  const { r, L } = capped();
  r.at(L + CONTINUATION_MS).sched();
  r.at(L + 2 * CONTINUATION_MS).sched();
  assert.strictEqual(r.view(), null, 'each call is within a cycle of the one before');
  r.at(L + 3 * CONTINUATION_MS + 1).sched();
  assert.notStrictEqual(r.view(), null);
});

test('a replay of the capped run\'s own prompt (any spacing) keeps its loop alive; a different prompt does not', () => {
  const same = capped();
  same.r.at(same.L + 60 * MIN).send('UserPromptSubmit', { prompt: PROMPT.replace(/ /g, '  ') + '\n' });
  same.r.at(same.L + CONTINUATION_MS + 10 * MIN).sched();
  assert.strictEqual(same.r.view(), null, 'the replay moved lastSeen, so this is still its loop');

  const other = capped();
  assert.strictEqual(other.r.at(other.L + 60 * MIN).send('UserPromptSubmit', { prompt: 'something I typed' }), false);
  other.r.at(other.L + CONTINUATION_MS + 10 * MIN).sched();
  assert.notStrictEqual(other.r.view(), null, 'a typed prompt proves nothing: a new run');
});

test('an event that is not a prompt never refreshes a capped run, and a prompt with no text does not throw', () => {
  const { r, L } = capped();
  for (const [event, payload] of [['Stop', {}], ['Notification', { notification_type: 'idle_prompt' }], ['UserPromptSubmit', {}],
    ['UserPromptSubmit', { prompt: 5 }], ['UserPromptSubmit', { prompt: null }], ['PreCompact', { prompt: PROMPT }]]) {
    assert.doesNotThrow(() => r.at(L + 60 * MIN).send(event, payload), event);
  }
  r.at(L + CONTINUATION_MS + 10 * MIN).sched();
  assert.notStrictEqual(r.view(), null, 'nothing above counted as a sign of life');
});

test('with no night and nothing capped, a prompt (or none) is ignored without throwing', () => {
  const r = rig();
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: PROMPT }), false);
  assert.strictEqual(r.send('UserPromptSubmit', {}), false);
  assert.strictEqual(r.send('UserPromptSubmit'), false);
});

test('a dormant night that reaches the 12 h cap does not latch: its replayed prompt proves nothing, and a new call starts a night', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Stop');
  r.at(T0 + 3600_000 + OVERDUE_MS + 1).bash();                  // overdue with a wake pending: dormant, not gone
  assert.strictEqual(r.b.snapshot().dormant, true);
  const X = T0 + MAX_NIGHT_MS + 2;
  r.at(T0 + MAX_NIGHT_MS + 1).bash();
  assert.strictEqual(r.b.snapshot(), null);
  assert.strictEqual(r.at(X).send('UserPromptSubmit', { prompt: PROMPT }), false, 'nothing is capped, so nothing changes');
  r.at(X + 10 * MIN).sched();
  assert.notStrictEqual(r.view(), null);
});

// ---- tool events ----

test('a failed tool call is a sign of life: it wakes a sleeping night', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Stop');
  assert.strictEqual(r.view().awake, false);
  r.at(T0 + 2 * MIN).send('PostToolUseFailure', { tool_name: 'Bash' });
  assert.strictEqual(r.view().awake, true);
});

test('a ScheduleWakeup that FAILED changes nothing about the schedule: a stop request in it does not end the night', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN);
  r.send('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
  assert.notStrictEqual(r.view(), null);
  assert.strictEqual(r.b.snapshot().nextWakeAt, T0 + 3600_000);
  r.send('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } });
  assert.strictEqual(r.view(), null, 'the same request that SUCCEEDED does end it');
});

test('a tool event that is not a bedtime call is just activity: it wakes a sleeping night and moves nothing else', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Stop');
  r.at(T0 + 2 * MIN);
  assert.strictEqual(r.send('PostToolUse', { tool_name: 'Edit' }), true);
  const v = r.view();
  assert.strictEqual(v.awake, true);
  assert.strictEqual(v.nextWakeAt, T0 + 3600_000);
});

// ---- who counts ----

test('an event from a subagent is ignored; an empty or non-string agent_id is the main session', () => {
  for (const agent_id of ['a1', 'agent-7', ' ']) {
    const r = rig();
    assert.strictEqual(r.sched(PROMPT, 3600, { agent_id }), false, agent_id);
    assert.strictEqual(r.view(), null, agent_id);
  }
  for (const agent_id of ['', 5, null, undefined, {}, false]) {
    const r = rig();
    assert.strictEqual(r.sched(PROMPT, 3600, { agent_id }), true, String(agent_id));
    assert.notStrictEqual(r.view(), null, String(agent_id));
  }
});

test('events and payloads that are not what they should be never throw and change nothing', () => {
  const r = rig();
  for (const ev of [null, undefined, 5, 'Stop', true, [], {}, { event: 5 }, { event: null }, { event: {} }, { payload: {} }]) {
    assert.doesNotThrow(() => assert.strictEqual(r.b.handle(ev), false), JSON.stringify(ev));
  }
  for (const payload of [null, undefined, 5, 'x', [], [{ tool_name: 'ScheduleWakeup' }], true]) {
    assert.doesNotThrow(() => r.b.handle({ event: 'PostToolUse', payload }), JSON.stringify(payload));
    assert.doesNotThrow(() => r.b.handle({ event: 'Stop', payload }), JSON.stringify(payload));
  }
  assert.strictEqual(r.b.snapshot(), null);
});

test('a ScheduleWakeup whose tool_input or tool_response is null, an array or a string is handled', () => {
  for (const tool_input of [null, [], 'x', 5, undefined]) {
    const r = rig();
    assert.doesNotThrow(() => r.send('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input, tool_response: { scheduledFor: T0 + 60_000 } }), JSON.stringify(tool_input));
    assert.strictEqual(r.view(), null);
  }
  for (const tool_response of [null, [], 'x', 5, undefined]) {
    const r = rig();
    assert.doesNotThrow(() => r.send('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT, delaySeconds: 60 }, tool_response }), JSON.stringify(tool_response));
    assert.strictEqual(r.view(), null, 'no scheduledFor, no night');
  }
});

// ---- believability of scheduledFor ----

test('scheduledFor is believed from "now" up to the longest delay plus the slack, inclusive, and only as a finite number', () => {
  const start = (v) => { const r = rig(); r.posted(PROMPT, 3600, v); return r.view(); };
  assert.notStrictEqual(start(T0), null);
  assert.notStrictEqual(start(T0 + 3600_000 + SLACK_MS), null);
  assert.strictEqual(start(T0 - 1), null);
  assert.strictEqual(start(T0 + 3600_000 + SLACK_MS + 1), null);
  for (const v of [String(T0 + 60_000), `${T0 + 60_000}`, NaN, Infinity, -Infinity, null, undefined, {}, [T0 + 60_000], true, new Date(T0 + 60_000)]) {
    assert.strictEqual(start(v), null, String(v));
  }
});

test('a believable scheduledFor is used as is for the next wake; an unbelievable one falls back to now + the clamped delay', () => {
  const believed = rig();
  believed.sched();
  believed.at(T0 + MIN).posted(PROMPT, 600, T0 + 20 * MIN);
  assert.strictEqual(believed.view().nextWakeAt, T0 + 20 * MIN);
  const fallback = rig();
  fallback.sched();
  fallback.at(T0 + MIN).posted(PROMPT, 600, 'soon');
  assert.strictEqual(fallback.view().nextWakeAt, T0 + MIN + 600_000);
  const clamped = rig();
  clamped.sched();
  clamped.at(T0 + MIN).posted(PROMPT, 5, null);
  assert.strictEqual(clamped.view().nextWakeAt, T0 + MIN + 60_000, 'a delay under a minute is a minute');
  const long = rig();
  long.sched();
  long.at(T0 + MIN).posted(PROMPT, 99_999, null);
  assert.strictEqual(long.view().nextWakeAt, T0 + MIN + 3600_000, 'a delay over an hour is an hour');
});

test('a delay that is not a finite number never schedules anything', () => {
  for (const delay of ['60', NaN, Infinity, null, undefined, {}]) {
    const r = rig();
    r.posted(PROMPT, delay, T0 + 60_000);
    assert.strictEqual(r.view(), null, String(delay));
  }
});

// ---- overdue, to the millisecond ----

test('a night is overdue only past its wake plus the grace: exactly on it is still alive, one ms later is not', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Stop');
  const wake = T0 + 3600_000;
  assert.notStrictEqual(r.view(wake + OVERDUE_MS), null);
  assert.strictEqual(r.view(wake + OVERDUE_MS + 1), null);
});

test('a Stop with nothing scheduled ends the night only once it has stayed that way for the grace, to the millisecond', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('UserPromptSubmit', { prompt: PROMPT });          // the wake: nothing is scheduled now
  r.at(T0 + 10 * MIN).send('Stop');
  const idle = T0 + 10 * MIN;
  assert.notStrictEqual(r.view(idle + OVERDUE_MS), null);
  assert.strictEqual(r.view(idle + OVERDUE_MS + 1), null);
});

// ---- the sleep signals ----

test('an idle_prompt puts an awake night to sleep, and only a Notification of that type does', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(r.view().awake, true);
  r.at(T0 + 2 * MIN).send('SessionNotice', { notification_type: 'idle_prompt' });
  assert.strictEqual(r.view().awake, true);
  assert.strictEqual(r.at(T0 + 3 * MIN).send('Notification', { notification_type: 'idle_prompt' }), true);
  assert.strictEqual(r.view().awake, false);
  r.at(T0 + 4 * MIN).send('Notification', { notification_type: 'idle_prompt' });
  assert.strictEqual(r.view().awake, false, 'already asleep, stays asleep');
});

test('a Stop does nothing to a dormant night', () => {
  const r = rig();
  r.sched();
  r.at(T0 + MIN).send('Stop');
  r.at(T0 + 3600_000 + OVERDUE_MS + 1).bash();
  assert.strictEqual(r.b.snapshot().dormant, true);
  const before = JSON.stringify(r.b.snapshot());
  assert.strictEqual(r.at(T0 + 3600_000 + OVERDUE_MS + 2).send('Stop'), false);
  assert.strictEqual(JSON.stringify(r.b.snapshot()), before);
});

test('a wake replayed with different whitespace is the wake; the same words run together are not', () => {
  const r = rig();
  r.sched('/bedtime overnight run a b', 3600);
  assert.strictEqual(r.at(T0 + MIN).send('UserPromptSubmit', { prompt: '  /bedtime   overnight\nrun a\tb ' }), true);
  assert.strictEqual(r.view().wakes, 1);
  const r2 = rig();
  r2.sched('/bedtime overnight run a b', 3600);
  r2.at(T0 + MIN).send('UserPromptSubmit', { prompt: '/bedtimeovernightrunab' });
  assert.strictEqual(r2.view().wakes, 0, 'not the scheduled prompt, only a person typing');
  const r3 = rig();
  r3.sched('/bedtime overnight run a b', 3600);
  r3.at(T0 + MIN).send('UserPromptSubmit', { prompt: '/bedtime overnight run ab' });
  assert.strictEqual(r3.view().wakes, 0);
});

// ---- the prompt classifier ----

test('isBedtimeLoopPrompt: a /loop that is not at the start does not disqualify a bedtime prompt', () => {
  assert.strictEqual(isBedtimeLoopPrompt('Continue the /bedtime autonomous run (see /loop docs)'), true);
  assert.strictEqual(isBedtimeLoopPrompt('bedtime overnight run, then /loop 5m'), true);
  assert.strictEqual(isBedtimeLoopPrompt('/loop 5m /bedtime x'), false);
  assert.strictEqual(isBedtimeLoopPrompt('  /loop /bedtime'), false);
});

test('isBedtimeLoopPrompt: a value that only reads as a bedtime prompt once coerced to text is not one', () => {
  assert.strictEqual(isBedtimeLoopPrompt({ toString: () => '/bedtime overnight run' }), false);
  assert.strictEqual(isBedtimeLoopPrompt(['/bedtime overnight run']), false);
  assert.strictEqual(isBedtimeLoopPrompt(new String('/bedtime overnight run')), false);
});

test('isBedtimeOnly: only a Pre or Post ScheduleWakeup event with an object payload; anything else is false and does not throw', () => {
  const ok = (event, payload) => isBedtimeOnly({ event, payload });
  assert.strictEqual(ok('PreToolUse', { tool_name: 'ScheduleWakeup' }), true);
  assert.strictEqual(ok('PostToolUse', { tool_name: 'ScheduleWakeup' }), true);
  assert.strictEqual(ok('PostToolUseFailure', { tool_name: 'ScheduleWakeup' }), false);
  assert.strictEqual(ok('PreToolUse', { tool_name: 'Bash' }), false);
  assert.strictEqual(ok('PreToolUse', null), false);
  assert.strictEqual(ok('PreToolUse', [{ tool_name: 'ScheduleWakeup' }]), false);
  assert.strictEqual(ok('PreToolUse', 'ScheduleWakeup'), false);
  for (const ev of [null, undefined, 5, 'PreToolUse', true, 0, '']) assert.strictEqual(isBedtimeOnly(ev), false, String(ev));
});
