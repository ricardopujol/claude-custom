'use strict';
/**
 * The bedtime night (host/bedtime-state.js, backlog #52, DESIGN_TERMINAL_BAR.md "Bedtime").
 *
 * The rule is the one verify/probe-bedtime-signal.js measured, not the one the design guessed:
 *   start     a main-session ScheduleWakeup whose prompt names `bedtime` (not the first ScheduleWakeup: one in five
 *             real ones is a /loop poll; not a typed /bedtime: that is the supervised checkpoint chat)
 *   next wake the PostToolUse's `scheduledFor`, else call time + delaySeconds (clamped to the CLI's [60, 3600])
 *   wake      a UserPromptSubmit with the scheduled prompt: the CLI replays it verbatim, ~1 s after scheduledFor
 *   end       `stop: true`, SessionEnd / a fresh SessionStart, 15 min past a wake that never came, a Stop with
 *             nothing scheduled that stays that way 15 min, or 12 h from the start
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const B = require('../host/bedtime-state');
const { createBedtime, mentionsBedtime, OVERDUE_MS, MAX_NIGHT_MS } = B;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 3, 2, 15, 0);
const PROMPT = '/bedtime overnight run (claude-custom). Continue the task list.';

function rig(start = T0) {
  let t = start;
  const b = createBedtime({ now: () => t });
  const at = (ms) => { t = ms; return rigApi; };
  const rigApi = {
    b,
    at,
    send(event, payload = {}) { return b.handle({ event, payload }); },
    sched(prompt, delay, extra = {}) { return this.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: delay, reason: 'r', prompt, noop: false }, ...extra }); },
    posted(prompt, delay, scheduledFor) {
      return this.send('PostToolUse', {
        tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: delay, reason: 'r', prompt, noop: false },
        tool_response: { scheduledFor, clampedDelaySeconds: delay, wasClamped: false },
      });
    },
    stop() { return this.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } }); },
    view(ms = t) { return b.view(ms); },
  };
  return rigApi;
}

test('mentionsBedtime: the word, anywhere, any case; not a longer word, not a poll', () => {
  for (const yes of ['/bedtime overnight run', 'bedtime — overnight run', 'Continue the /bedtime autonomous run for X', 'BEDTIME', '  /Bedtime  ']) {
    assert.strictEqual(mentionsBedtime(yes), true, yes);
  }
  for (const no of ['Check on the background test run', '<<autonomous-loop-dynamic>>', 'bedtimes story', 'overbedtime', '', null, undefined, 5, {}]) {
    assert.strictEqual(mentionsBedtime(no), false, String(no));
  }
});

test('nothing runs until a bedtime ScheduleWakeup: a fresh machine has no night', () => {
  const r = rig();
  assert.strictEqual(r.view(), null);
});

test('a bedtime ScheduleWakeup starts the night; its next wake is the call time plus the delay until Post says better', () => {
  const r = rig();
  assert.strictEqual(r.sched(PROMPT, 1800), true);
  assert.deepStrictEqual(r.view(), { startedAt: T0, nextWakeAt: T0 + 1800_000, awake: true, wakes: 0, lastWakeAt: null });
  assert.strictEqual(r.posted(PROMPT, 1800, T0 + 1859_000), true);
  assert.strictEqual(r.view().nextWakeAt, T0 + 1859_000, 'scheduledFor is the CLI\'s own answer and wins');
});

test('the delay is clamped to the CLI\'s own [60, 3600] when only the Pre event arrived', () => {
  assert.strictEqual((r => { r.sched(PROMPT, 5); return r.view().nextWakeAt; })(rig()), T0 + 60_000);
  assert.strictEqual((r => { r.sched(PROMPT, 99999); return r.view().nextWakeAt; })(rig()), T0 + 3600_000);
});

test('a Post with no Pre (the Pre was lost) still starts the night', () => {
  const r = rig();
  r.posted(PROMPT, 1800, T0 + 1850_000);
  assert.strictEqual(r.view().nextWakeAt, T0 + 1850_000);
});

test('a scheduledFor that is not believable (past, absurdly far, not a number) falls back to the estimate', () => {
  for (const bad of [0, -5, T0 - 60 * MIN, T0 + 5 * 3600_000, NaN, '2026', null, undefined]) {
    const r = rig();
    r.sched(PROMPT, 1200);
    r.posted(PROMPT, 1200, bad);
    assert.strictEqual(r.view().nextWakeAt, T0 + 1200_000, String(bad));
  }
});

test('a poll (a ScheduleWakeup that does not name bedtime) never starts a night, and never touches a running one', () => {
  const r = rig();
  r.sched('Check on the background test run', 90);
  r.sched('<<autonomous-loop-dynamic>>', 600);
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);
  const before = JSON.stringify(r.view());
  assert.strictEqual(r.sched('Check on the background test run', 90), false);
  assert.strictEqual(JSON.stringify(r.view()), before);
});

test('a typed /bedtime is the supervised checkpoint chat, not the start of the night', () => {
  const r = rig();
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: '/bedtime focus on the bar' }), false);
  assert.strictEqual(r.view(), null);
});

test("a subagent's calls never move the machine (they carry agent_id)", () => {
  const r = rig();
  assert.strictEqual(r.sched(PROMPT, 1800, { agent_id: 'a1', agent_type: 'electron-pro' }), false);
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);
  const snap = JSON.stringify(r.b.snapshot());
  r.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, agent_id: 'a1' });
  r.send('Stop', { agent_id: 'a1' });
  r.send('SessionEnd', { agent_id: 'a1' });
  r.send('UserPromptSubmit', { prompt: PROMPT, agent_id: 'a1' });
  assert.strictEqual(JSON.stringify(r.b.snapshot()), snap);
});

test('the turn that scheduled it ends: asleep until the wake, and Stop reports the change', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  r.posted(PROMPT, 1800, T0 + 1859_000);
  assert.strictEqual(r.view().awake, true);
  assert.strictEqual(r.send('Stop'), true);
  assert.strictEqual(r.view().awake, false);
  assert.strictEqual(r.view().nextWakeAt, T0 + 1859_000);
});

test('a wake (the scheduled prompt replayed) consumes the schedule and counts: awake, no next wake, until it schedules again', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.posted(PROMPT, 1800, T0 + 1860_000); r.send('Stop');
  r.at(T0 + 1860_800);
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: PROMPT }), true);
  assert.deepStrictEqual(r.view(), { startedAt: T0, nextWakeAt: null, awake: true, wakes: 1, lastWakeAt: T0 + 1860_800 });
  r.at(T0 + 1900_000);
  r.sched(PROMPT, 1500); r.posted(PROMPT, 1500, T0 + 3420_000); r.send('Stop');
  const v = r.view();
  assert.strictEqual(v.nextWakeAt, T0 + 3420_000);
  assert.strictEqual(v.wakes, 1);
  assert.strictEqual(v.awake, false);
});

test('a wake whose text is reworded still counts when it names bedtime (the CLI may hand slash prompts back expanded)', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  r.send('UserPromptSubmit', { prompt: '/bedtime overnight run (claude-custom). Continue the task list. ' });
  assert.strictEqual(r.view().wakes, 1);
});

test("a person's own prompt in the night opens a turn (awake) but is not a wake", () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.posted(PROMPT, 1800, T0 + 1860_000); r.send('Stop');
  r.at(T0 + 5 * MIN);
  r.send('UserPromptSubmit', { prompt: 'how is it going?' });
  const v = r.view();
  assert.strictEqual(v.awake, true);
  assert.strictEqual(v.wakes, 0);
  assert.strictEqual(v.nextWakeAt, T0 + 1860_000, 'the schedule is still pending');
});

test('stop: true ends the night at once, from Pre or from Post, and nothing is "running" after it', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  assert.strictEqual(r.stop(), true);
  assert.strictEqual(r.view(), null);
  const r2 = rig();
  r2.sched(PROMPT, 1800);
  r2.send('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: {} });
  assert.strictEqual(r2.view(), null);
  assert.strictEqual(rig().stop(), false, 'stopping a loop that is not a night changes nothing');
});

test('SessionEnd and a fresh SessionStart end it; a compaction does not', () => {
  for (const [event, payload, ends] of [['SessionEnd', {}, true], ['SessionStart', { source: 'startup' }, true],
    ['SessionStart', { source: 'clear' }, true], ['SessionStart', { source: 'resume' }, true], ['SessionStart', { source: 'compact' }, false]]) {
    const r = rig();
    r.sched(PROMPT, 1800);
    r.send(event, payload);
    assert.strictEqual(r.view() === null, ends, `${event} ${payload.source || ''}`);
  }
});

test('overdue: 15 minutes past a wake that never came, a sleeping night is over, and not before', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.posted(PROMPT, 1800, T0 + 1860_000); r.send('Stop');
  assert.ok(r.view(T0 + 1860_000 + OVERDUE_MS) !== null, 'exactly at the grace it is still on');
  assert.strictEqual(r.view(T0 + 1860_000 + OVERDUE_MS + 1), null);
});

test('overdue never fires on a session that is mid-turn: a long woken turn, or the person typing, is alive', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.posted(PROMPT, 1800, T0 + 1860_000); r.send('Stop');
  r.at(T0 + 1861_000);
  r.send('UserPromptSubmit', { prompt: PROMPT });             // woke, working for hours with nothing scheduled yet
  assert.ok(r.view(T0 + 4 * 3600_000) !== null);
  const q = rig();
  q.sched(PROMPT, 60); q.send('Stop');
  q.at(T0 + 2 * MIN);
  q.send('UserPromptSubmit', { prompt: 'a question' });       // typing delays the wake it is queued behind
  assert.ok(q.view(T0 + 2 * MIN + OVERDUE_MS + 10 * MIN) !== null);
});

test('a woken turn that ends with nothing scheduled is over 15 minutes later, not at once', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  r.at(T0 + 10 * MIN);
  r.send('Stop');                                              // no ScheduleWakeup in this turn
  assert.ok(r.view(T0 + 10 * MIN + OVERDUE_MS) !== null);
  assert.strictEqual(r.view(T0 + 10 * MIN + OVERDUE_MS + 1), null);
});

test('a late wake brings an overdue night back: the evidence outranks the clock', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.posted(PROMPT, 1800, T0 + 1860_000); r.send('Stop');
  r.at(T0 + 3 * 3600_000);
  assert.strictEqual(r.view(), null);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.ok(r.view() !== null);
});

test('twelve hours from the start ends it, even mid-turn, and it is dropped for good (a wake no longer revives it)', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  assert.ok(r.view(T0 + MAX_NIGHT_MS) !== null);
  assert.strictEqual(r.view(T0 + MAX_NIGHT_MS + 1), null);
  r.at(T0 + MAX_NIGHT_MS + MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);                                        // a NEW schedule is a new night
  assert.strictEqual(r.view().startedAt, T0 + MAX_NIGHT_MS + MIN);
});

test('handle reports a change exactly when the snapshot moved, and is total on junk', () => {
  const r = rig();
  for (const junk of [null, undefined, 4, 'x', {}, { event: 3 }, { event: 'PreToolUse' }, { event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup' } },
    { event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT } } },
    { event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT, delaySeconds: 'soon' } } }]) {
    assert.strictEqual(r.b.handle(junk), false);
  }
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.sched(PROMPT, 1800), true);
  assert.strictEqual(r.sched(PROMPT, 1800), false, 'the identical call again changes nothing');
});

// --- the fixture: real payloads from verify/probe-bedtime-signal.js --capture --------------------------
test('REAL CAPTURE: the CLI\'s own ScheduleWakeup, wake and stop events drive the machine through a whole loop', () => {
  const rows = fs.readFileSync(path.join(__dirname, 'bedtime-signal.fixture.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.kind === 'hook');
  assert.ok(rows.length >= 8, 'the capture is in the repo');
  let t = 0;
  const b = createBedtime({ now: () => t });
  const seen = [];
  for (const row of rows) {
    t = row.at;
    // the capture's prompt says "bedtime probe tick"; the machine must treat it as a bedtime loop
    b.handle({ event: row.event, payload: row.payload });
    seen.push([row.event, row.payload.tool_name || '', b.view(t) === null ? 'off' : (b.view(t).awake ? 'awake' : 'asleep')]);
  }
  const names = seen.map(s => s.join(':'));
  const iSched = names.indexOf('PreToolUse:ScheduleWakeup:awake');
  assert.ok(iSched >= 0, names.join(' | '));
  const stopAfter = names.indexOf('Stop::asleep');
  assert.ok(stopAfter > iSched, 'the turn that scheduled it ends, asleep: ' + names.join(' | '));
  const wake = rows.findIndex((r, i) => i > 0 && r.event === 'UserPromptSubmit' && r.payload.prompt.startsWith('bedtime probe tick'));
  assert.ok(wake > 0);
  assert.strictEqual(names[wake], 'UserPromptSubmit::awake', 'the replayed prompt is a wake');
  assert.strictEqual(names[names.length - 1].split(':')[2], 'off', 'after ScheduleWakeup { stop: true } the night is over');
  // the wake came within a second of the CLI's own scheduledFor
  const post = rows.find(r => r.event === 'PostToolUse' && !r.payload.tool_input.stop);
  assert.ok(Math.abs(rows[wake].at - post.payload.tool_response.scheduledFor) < 5000);
});

// --- properties ------------------------------------------------------------------------------------------
const arbPrompt = fc.constantFrom(PROMPT, '/bedtime x', 'Continue the /bedtime autonomous run', 'poll the tests', '<<autonomous-loop-dynamic>>');
const arbEvent = fc.oneof(
  fc.record({ k: fc.constant('sched'), prompt: arbPrompt, delay: fc.integer({ min: 0, max: 7200 }), dt: fc.integer({ min: 0, max: 40 * MIN }) }),
  fc.record({ k: fc.constant('stopcall'), dt: fc.integer({ min: 0, max: 40 * MIN }) }),
  fc.record({ k: fc.constant('turnstop'), dt: fc.integer({ min: 0, max: 40 * MIN }) }),
  fc.record({ k: fc.constant('prompt'), prompt: arbPrompt, dt: fc.integer({ min: 0, max: 40 * MIN }) }),
  fc.record({ k: fc.constant('tool'), dt: fc.integer({ min: 0, max: 40 * MIN }) }),
  fc.record({ k: fc.constant('end'), dt: fc.integer({ min: 0, max: 40 * MIN }) }),
);
const seq = fc.array(arbEvent, { maxLength: 30 });

function play(events) {
  let t = T0;
  const b = createBedtime({ now: () => t });
  for (const e of events) {
    t += e.dt;
    const ev = ({
      sched: () => ({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: e.delay, reason: 'r', prompt: e.prompt, noop: false } } }),
      stopcall: () => ({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { stop: true } } }),
      turnstop: () => ({ event: 'Stop', payload: {} }),
      prompt: () => ({ event: 'UserPromptSubmit', payload: { prompt: e.prompt } }),
      tool: () => ({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }),
      end: () => ({ event: 'SessionEnd', payload: {} }),
    })[e.k]();
    b.handle(ev);
  }
  return { b, t };
}

test('property: after a stop (or the session ending) with nothing scheduled since, the night is never "running", at any time', () => {
  fc.assert(fc.property(seq, fc.constantFrom('stopcall', 'end'), fc.integer({ min: 0, max: 20 * 3600_000 }), (events, closer, later) => {
    const { b, t } = play([...events, { k: closer, dt: 1000 }]);
    return b.view(t) === null && b.view(t + later) === null;
  }));
});

test('property: a night only ever exists because a bedtime ScheduleWakeup was called', () => {
  fc.assert(fc.property(seq, (events) => {
    const { b, t } = play(events);
    const everScheduled = events.some(e => e.k === 'sched' && /bedtime/i.test(e.prompt));
    return everScheduled || b.view(t) === null;
  }));
});

test('property: overdue is monotone: once the view is off with no further events, it stays off as time passes', () => {
  fc.assert(fc.property(seq, fc.integer({ min: 0, max: 30 * 3600_000 }), fc.integer({ min: 0, max: 30 * 3600_000 }), (events, a, d) => {
    const { b, t } = play(events);
    return b.view(t + a) !== null || b.view(t + a + d) === null;
  }));
});

test('property: the view is well-formed: finite times, startedAt never after now, nextWakeAt never before its own call', () => {
  fc.assert(fc.property(seq, (events) => {
    const { b, t } = play(events);
    const v = b.view(t);
    if (v === null) return true;
    const finite = (x) => x === null || Number.isFinite(x);
    return Number.isFinite(v.startedAt) && v.startedAt <= t && finite(v.nextWakeAt) && finite(v.lastWakeAt)
      && typeof v.awake === 'boolean' && Number.isInteger(v.wakes) && v.wakes >= 0
      && (v.nextWakeAt === null || v.nextWakeAt >= v.startedAt);
  }));
});

test('property: subagent events never move the snapshot', () => {
  fc.assert(fc.property(seq, fc.constantFrom('PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'SessionStart'), arbPrompt, (events, name, prompt) => {
    const { b, t } = play(events);
    const before = JSON.stringify(b.snapshot());
    b.handle({ event: name, payload: { agent_id: 'a1', agent_type: 'x', prompt, source: 'startup', tool_name: 'ScheduleWakeup', tool_input: { stop: true, prompt, delaySeconds: 60 } } });
    return JSON.stringify(b.snapshot()) === before && t >= T0;
  }));
});

test('isBedtimeOnly: the ScheduleWakeup Pre / Post events the bedtime matcher brings, and nothing else', () => {
  const { isBedtimeOnly } = B;
  const ev = (event, payload) => ({ event, payload });
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'ScheduleWakeup' })), true);
  assert.strictEqual(isBedtimeOnly(ev('PostToolUse', { tool_name: 'ScheduleWakeup' })), true);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'Bash' })), false);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'Agent' })), false);
  assert.strictEqual(isBedtimeOnly(ev('Stop', { tool_name: 'ScheduleWakeup' })), false);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', {})), false);
  for (const junk of [null, undefined, {}, 3, { event: 'PreToolUse' }]) assert.strictEqual(isBedtimeOnly(junk), false);
});

// --- found by mutation testing -------------------------------------------------------------------------------
test('scheduledFor is believed from "now" to the longest delay plus the runtime\'s slack, both ends inclusive', () => {
  const edge = (sf) => { const r = rig(); r.sched(PROMPT, 1200); r.posted(PROMPT, 1200, sf); return r.view().nextWakeAt; };
  assert.strictEqual(edge(T0), T0, 'exactly now is believed');
  assert.strictEqual(edge(T0 - 1), T0 + 1200_000, 'a moment ago is not');
  assert.strictEqual(edge(T0 + 3600_000 + 120_000), T0 + 3600_000 + 120_000, 'the longest delay plus 120 s is believed');
  assert.strictEqual(edge(T0 + 3600_000 + 120_001), T0 + 1200_000, 'one ms further is not');
  assert.strictEqual(edge(Infinity), T0 + 1200_000);
});

test('only the RESULT carries scheduledFor: a Pre event that happens to hold one is not believed', () => {
  const r = rig();
  r.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 1200, prompt: PROMPT }, tool_response: { scheduledFor: T0 + 600_000 } });
  assert.strictEqual(r.view().nextWakeAt, T0 + 1200_000);
});

test('a ScheduleWakeup that failed (PostToolUseFailure) schedules nothing and starts nothing', () => {
  const r = rig();
  r.send('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: PROMPT } });
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);
  const before = r.view().nextWakeAt;
  r.send('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: PROMPT } });
  assert.strictEqual(r.view().nextWakeAt, before, 'the failed call moved nothing');
});

test('only ScheduleWakeup schedules or stops: another tool with the same input shape does neither', () => {
  const r = rig();
  r.send('PreToolUse', { tool_name: 'Agent', tool_input: { delaySeconds: 60, prompt: PROMPT } });
  assert.strictEqual(r.view(), null, 'an Agent prompt that names bedtime starts no night');
  r.sched(PROMPT, 1800);
  r.send('PreToolUse', { tool_name: 'Bash', tool_input: { stop: true } });
  r.send('PostToolUse', { tool_name: 'Bash', tool_input: { stop: true } });
  assert.ok(r.view() !== null, 'a Bash call with stop in its input is not the loop stopping');
});

test('any main-session tool call, a poll included, wakes a sleeping night (a turn is open); with no night it does nothing', () => {
  for (const call of [
    () => ({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }),
    () => ({ event: 'PostToolUse', payload: { tool_name: 'Read', tool_input: {} } }),
    () => ({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 90, prompt: 'poll the tests' } } }),
    () => ({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT } } }),
  ]) {
    const r = rig();
    r.sched(PROMPT, 1800); r.send('Stop');
    assert.strictEqual(r.view().awake, false);
    r.at(T0 + MIN);
    r.b.handle(call());
    assert.strictEqual(r.view().awake, true);
    assert.strictEqual(r.b.snapshot().idleSince, null);
    assert.strictEqual(rig().b.handle(call()), false, 'no night: nothing to wake');
  }
});

test('a prompt reworded into a different sentence that names bedtime is still a wake', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  r.send('UserPromptSubmit', { prompt: 'Continue the /bedtime autonomous run' });
  assert.strictEqual(r.view().wakes, 1);
});

test('a prompt that does not say bedtime and is not the scheduled one is not a wake; one with no text never throws', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  assert.doesNotThrow(() => r.send('UserPromptSubmit', {}));
  assert.doesNotThrow(() => r.send('UserPromptSubmit', { prompt: 42 }));
  r.send('UserPromptSubmit', { prompt: 'what time is it' });
  assert.strictEqual(r.view().wakes, 0);
  assert.strictEqual(r.view().awake, true);
});

test('only Stop puts the night to sleep: other events leave an awake session awake', () => {
  for (const [event, payload] of [['Notification', { notification_type: 'idle_prompt' }], ['SubagentStop', {}], ['PreCompact', {}], ['Whatever', {}]]) {
    const r = rig();
    r.sched(PROMPT, 1800);
    r.send(event, payload);
    assert.strictEqual(r.view().awake, true, event);
  }
});

test('Stop with a wake already scheduled leaves nothing to time out; with none scheduled it starts the clock', () => {
  const a = rig();
  a.sched(PROMPT, 1800); a.send('Stop');
  assert.strictEqual(a.b.snapshot().idleSince, null);
  const b = rig();
  b.sched(PROMPT, 60); b.send('Stop');
  b.at(T0 + 2 * MIN);
  b.send('UserPromptSubmit', { prompt: PROMPT });
  b.at(T0 + 9 * MIN);
  b.send('Stop');
  assert.strictEqual(b.b.snapshot().idleSince, T0 + 9 * MIN);
});

test('snapshot is null with no night, a COPY with one, and never aliases the machine\'s own state', () => {
  const r = rig();
  assert.strictEqual(r.b.snapshot(), null);
  r.sched(PROMPT, 1800);
  const s = r.b.snapshot();
  assert.strictEqual(s.startedAt, T0);
  assert.strictEqual(s.prompt, PROMPT);
  s.startedAt = 1;
  assert.strictEqual(r.b.snapshot().startedAt, T0);
});

test('a night is dropped only AFTER twelve hours, not at twelve', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  r.at(T0 + MAX_NIGHT_MS);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view().wakes, 1, 'a wake at exactly twelve hours still counts');
  r.at(T0 + MAX_NIGHT_MS + 1);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view(), null, 'one ms later it has been dropped');
});

test('a null startedAt or a junk payload never makes a view: view reads only what a real night holds', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  const v = r.view();
  assert.deepStrictEqual(Object.keys(v).sort(), ['awake', 'lastWakeAt', 'nextWakeAt', 'startedAt', 'wakes']);
});
