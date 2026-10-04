'use strict';
/**
 * The bedtime night (host/bedtime-state.js, backlog #52, DESIGN_TERMINAL_BAR.md "Bedtime").
 *
 * The rule is the one verify/probe-bedtime-signal.js measured, tightened by PR #99's review:
 *   start     a main-session ScheduleWakeup that SUCCEEDED (its PostToolUse carries scheduledFor) and whose prompt is a
 *             bedtime loop's (the /bedtime token, the word leading it, or the skill's own phrase), never a poll that
 *             merely says "bedtime", never the Pre event alone, never a typed /bedtime
 *   next wake the PostToolUse's `scheduledFor`
 *   wake      a UserPromptSubmit that EXACTLY equals the last scheduled prompt: a typed prompt is never one
 *   end       `stop: true`, SessionEnd / a fresh SessionStart, 15 min past a wake that never came, a Stop with nothing
 *             scheduled that stays that way 15 min, or 12 h -- and an ended night STAYS ended in the state
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const B = require('../host/bedtime-state');
const { createBedtime, isBedtimeLoopPrompt, isBedtimeOnly, OVERDUE_MS, MAX_NIGHT_MS } = B;

const MIN = 60_000;
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 3, 2, 15, 0);
const PROMPT = '/bedtime overnight run (claude-custom). Continue the task list.';
const clamp = (s) => Math.min(3600, Math.max(60, s));

function rig(start = T0) {
  let t = start;
  const b = createBedtime({ now: () => t });
  const api = {
    b,
    at(ms) { t = ms; return api; },
    send(event, payload = {}) { return b.handle({ event, payload }); },
    input: (prompt, delay) => ({ delaySeconds: delay, reason: 'r', prompt, noop: false }),
    // the call's intent only (PreToolUse)
    pre(prompt, delay, extra = {}) { return api.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: api.input(prompt, delay), ...extra }); },
    // the call's result (PostToolUse), with the CLI's own scheduledFor
    posted(prompt, delay, scheduledFor, extra = {}) {
      return api.send('PostToolUse', {
        tool_name: 'ScheduleWakeup', tool_input: api.input(prompt, delay),
        tool_response: { scheduledFor, clampedDelaySeconds: delay, wasClamped: false }, ...extra,
      });
    },
    // a whole successful call: Pre then Post, scheduled exactly call + delay
    sched(prompt, delay, extra = {}) {
      const a = api.pre(prompt, delay, extra);
      const c = api.posted(prompt, delay, t + clamp(delay) * 1000, extra);
      return a || c;
    },
    stop() { return api.send('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } }); },
    view(ms = t) { return b.view(ms); },
  };
  return api;
}

test('isBedtimeLoopPrompt: the /bedtime token, the word leading the prompt, or the skill\'s own phrase', () => {
  for (const yes of ['/bedtime overnight run', 'bedtime — overnight run. Task 1 done', 'Continue the /bedtime autonomous run for X', 'Continue the bedtime overnight run on Genghis Khan',
    'Continue the bedtime protocol run on X', '  /Bedtime  ', 'BEDTIME', '("/bedtime x")', 'resume the bedtime autonomous run']) {
    assert.strictEqual(isBedtimeLoopPrompt(yes), true, yes);
  }
});

test('isBedtimeLoopPrompt: a poll that merely says bedtime is not a night (PR #99 Dexter F2)', () => {
  for (const no of ['/loop 10m check whether the /bedtime run opened its PRs', '/loop 5m /bedtime now', '  /LOOP 1h /bedtime overnight run',
    '/loop 5m run the bedtime-state tests', 'check whether the bedtime PR merged', '/loop 10m poll whether the bedtime PR merged',
    'is the bedtime run finished?', 'bedtimes story', 'overbedtime', 'a/bedtime-state', 'run /bedtime-state tests', '<<autonomous-loop-dynamic>>',
    'Check on the background test run', '', null, undefined, 5, {}]) {
    assert.strictEqual(isBedtimeLoopPrompt(no), false, String(no));
  }
});

test('the real prompts: every one of this machine\'s bedtime ScheduleWakeup prompts is accepted, every other one rejected', () => {
  const rows = fs.readFileSync(path.join(__dirname, 'bedtime-signal.fixture.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.kind === 'transcript' && !r.stop && typeof r.prompt === 'string');
  assert.ok(rows.length >= 100, `the fixture holds the prompt text (${rows.length})`);
  const wrong = rows.filter(r => isBedtimeLoopPrompt(r.prompt) !== r.bedtimeRun);
  assert.deepStrictEqual(wrong.map(r => r.prompt.slice(0, 60)), []);
  assert.ok(rows.some(r => r.bedtimeRun) && rows.some(r => !r.bedtimeRun));
});

test('nothing runs until a bedtime ScheduleWakeup succeeds: a fresh machine has no night', () => {
  assert.strictEqual(rig().view(), null);
});

test('a successful bedtime ScheduleWakeup starts the night, and its next wake is the CLI\'s scheduledFor', () => {
  const r = rig();
  assert.strictEqual(r.pre(PROMPT, 1800), false, 'the intent alone starts nothing');
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.posted(PROMPT, 1800, T0 + 1859_000), true);
  assert.deepStrictEqual(r.view(), { startedAt: T0, nextWakeAt: T0 + 1859_000, awake: true, wakes: 0, lastWakeAt: null });
});

test('F8: a call that never succeeded starts no night: Pre then a failure, a denial, or nothing at all', () => {
  const r = rig();
  r.pre(PROMPT, 3600);
  r.send('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 3600, prompt: PROMPT } });
  r.send('Stop');
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.view(T0 + 70 * MIN), null);
  const q = rig();
  q.pre(PROMPT, 3600);
  q.send('Stop');
  assert.strictEqual(q.view(), null);
  assert.strictEqual(q.b.snapshot(), null);
});

test('a Post with no Pre (the Pre was lost) still starts the night', () => {
  const r = rig();
  r.posted(PROMPT, 1800, T0 + 1850_000);
  assert.strictEqual(r.view().nextWakeAt, T0 + 1850_000);
});

test('a Post whose scheduledFor is missing or not believable starts no night', () => {
  for (const bad of [0, -5, T0 - 60 * MIN, T0 - 1, T0 + 5 * HOUR, NaN, Infinity, '2026', null, undefined]) {
    const q = rig();
    q.pre(PROMPT, 1200);
    q.posted(PROMPT, 1200, bad);
    assert.strictEqual(q.view(), null, String(bad));
  }
});

test('a running night whose Post has no believable scheduledFor falls back to call + the clamped delay', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  for (const [delay, want] of [[1200, 1200_000], [5, 60_000], [99999, 3600_000]]) {
    r.at(T0 + 10 * MIN);
    r.posted(PROMPT, delay, undefined);
    assert.strictEqual(r.view().nextWakeAt, T0 + 10 * MIN + want, `delay ${delay}`);
  }
});

test('scheduledFor is believed from "now" to the longest delay plus the runtime\'s slack, both ends inclusive', () => {
  const edge = (sf) => { const r = rig(); r.sched(PROMPT, 1800); r.at(T0 + MIN); r.posted(PROMPT, 1200, sf); return r.view().nextWakeAt; };
  const now = T0 + MIN;
  assert.strictEqual(edge(now), now, 'exactly now is believed');
  assert.strictEqual(edge(now - 1), now + 1200_000, 'a moment ago is not');
  assert.strictEqual(edge(now + HOUR + 120_000), now + HOUR + 120_000, 'the longest delay plus 120 s is believed');
  assert.strictEqual(edge(now + HOUR + 120_001), now + 1200_000, 'one ms further is not');
  assert.strictEqual(edge(Infinity), now + 1200_000);
});

test('only the RESULT carries scheduledFor: a Pre event that happens to hold one is not believed', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  r.at(T0 + MIN);
  r.pre(PROMPT, 1200, { tool_response: { scheduledFor: T0 + 9 * MIN } });
  assert.strictEqual(r.view().nextWakeAt, T0 + 1800_000, 'unchanged');
});

test('a poll (a ScheduleWakeup that is not a bedtime run) never starts a night, and never touches a running one', () => {
  const r = rig();
  r.sched('Check on the background test run', 90);
  r.sched('<<autonomous-loop-dynamic>>', 600);
  r.sched('/loop 5m run the bedtime-state tests', 300);
  r.sched('check whether the bedtime PR merged', 300);
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);
  const before = JSON.stringify(r.view());
  r.sched('/loop 5m run the bedtime-state tests', 300);
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
  assert.strictEqual(r.view().awake, true);
  assert.strictEqual(r.send('Stop'), true);
  assert.strictEqual(r.view().awake, false);
  assert.strictEqual(r.view().nextWakeAt, T0 + 1800_000);
});

test('F3: a wake is the scheduled prompt replayed: it consumes the schedule, and counts', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  r.at(T0 + 1860_800);
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: PROMPT }), true);
  assert.deepStrictEqual(r.view(), { startedAt: T0, nextWakeAt: null, awake: true, wakes: 1, lastWakeAt: T0 + 1860_800 });
  r.at(T0 + 1900_000);
  r.sched(PROMPT, 1500); r.send('Stop');
  const v = r.view();
  assert.strictEqual(v.nextWakeAt, T0 + 1900_000 + 1500_000);
  assert.strictEqual(v.wakes, 1);
  assert.strictEqual(v.awake, false);
});

test('F3: the wake matches the LAST scheduled prompt, whitespace folded, and a replayed prompt with other words is not one', () => {
  const r = rig();
  r.sched('/bedtime overnight run. DONE: task 1.', 60);
  r.sched('/bedtime overnight run. DONE: task 1, task 2.', 60);        // the schedule is replaced each call
  r.send('Stop');
  r.at(T0 + 2 * MIN);
  r.send('UserPromptSubmit', { prompt: '/bedtime overnight run. DONE: task 1.' });
  assert.strictEqual(r.view().wakes, 0, 'the previous call\'s prompt is not the pending one');
  r.send('UserPromptSubmit', { prompt: '/bedtime  overnight run.\nDONE: task 1, task 2. ' });
  assert.strictEqual(r.view().wakes, 1);
});

test('F3: a typed prompt that mentions bedtime is not a wake: the schedule stays, the night does not flap', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  const wake = r.view().nextWakeAt;
  r.at(T0 + 10 * MIN);
  for (const typed of ['how is the bedtime run doing?', '/bedtime', '/bedtime how is it going', 'continue the /bedtime autonomous run']) {
    r.send('UserPromptSubmit', { prompt: typed });
    r.send('Stop');
  }
  const v = r.view(T0 + 26 * MIN);
  assert.ok(v !== null, 'a typed turn is not the end of the night');
  assert.strictEqual(v.wakes, 0);
  assert.strictEqual(v.nextWakeAt, wake, 'nextWakeAt untouched');
});

test('F3: the scheduled prompt typed again after its wake was consumed is not a second wake', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view().wakes, 1);
});

test('a prompt with no text, or a number, never throws and is not a wake; a person\'s own prompt opens a turn (awake)', () => {
  const r = rig();
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(T0 + 2 * MIN);
  assert.doesNotThrow(() => r.send('UserPromptSubmit', {}));
  assert.doesNotThrow(() => r.send('UserPromptSubmit', { prompt: 42 }));
  r.send('Stop');
  r.send('UserPromptSubmit', { prompt: 'what time is it' });
  assert.strictEqual(r.view().wakes, 0);
  assert.strictEqual(r.view().awake, true);
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
  r.sched(PROMPT, 1800); r.send('Stop');
  const wake = r.view().nextWakeAt;
  assert.ok(r.view(wake + OVERDUE_MS) !== null, 'exactly at the grace it is still on');
  assert.strictEqual(r.view(wake + OVERDUE_MS + 1), null);
});

test('overdue never fires on a session that is mid-turn: a long woken turn, or the person typing, is alive', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  r.at(r.view().nextWakeAt + 1000);
  r.send('UserPromptSubmit', { prompt: PROMPT });             // woke, working for hours with nothing scheduled yet
  assert.ok(r.view(T0 + 4 * HOUR) !== null);
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

// --- F1: an ended night stays ended, in the STATE ------------------------------------------------------------
const at = (h, m = 0) => Date.UTC(2026, 9, 3, h, m, 0);

test('F1: 23:00 start, Stop at 05:00 with nothing scheduled, "status?" at 08:00: no night, in the view AND the state', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600);
  r.at(at(23, 55));
  r.send('UserPromptSubmit', { prompt: PROMPT });
  r.at(at(23) + 6 * HOUR);                                     // 05:00
  r.send('Stop');                                              // the last turn rescheduled nothing
  assert.strictEqual(r.view(at(23) + 6 * HOUR + 16 * MIN), null, '05:16: over');
  r.at(at(23) + 9 * HOUR);                                     // 08:00
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: 'status?' }), true, 'the end is recorded now');
  assert.strictEqual(r.view(), null, 'not "overnight - working" again');
  assert.strictEqual(r.b.snapshot(), null, 'gone from the state');
  r.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' } });
  r.send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  r.send('Stop');
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.view(at(23) + 9 * HOUR + 20 * MIN), null);
  assert.strictEqual(r.b.snapshot(), null);
});

test('F1: the overdue variant: a wake that never came, then the person at 08:00, never shows "wake due"', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600); r.send('Stop');
  const wake = r.view().nextWakeAt;                            // ~00:00
  r.at(wake + 5 * HOUR);
  r.send('UserPromptSubmit', { prompt: 'status?' });
  assert.strictEqual(r.view(), null);
  r.send('PreToolUse', { tool_name: 'Read', tool_input: {} });
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.view(wake + 5 * HOUR + 20 * MIN), null);
  r.send('Stop');
  assert.strictEqual(r.view(), null);
});

test('F1: an overdue night is dormant, and ONLY the scheduled prompt replayed (a late wake after a sleeping PC) wakes it, as the same night', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600); r.send('Stop');
  const wake = r.view().nextWakeAt;
  r.at(wake + 2 * HOUR);
  assert.strictEqual(r.send('UserPromptSubmit', { prompt: 'status?' }), true);
  assert.strictEqual(r.view(), null);
  r.send('Stop');
  assert.strictEqual(r.view(), null);
  r.at(wake + 3 * HOUR);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  const v = r.view();
  assert.ok(v !== null, 'the evidence outranks the clock');
  assert.strictEqual(v.startedAt, at(23), 'the same night: its identity, wakes and PRs window survive');
  assert.strictEqual(v.wakes, 1);
});

test('F1: after a no-reschedule end there is nothing pending, so even the old prompt typed again does not revive it', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(at(23) + MIN * 2);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  r.at(at(23) + 10 * MIN);
  r.send('Stop');
  r.at(at(23) + HOUR);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.b.snapshot(), null);
});

test('F1: only a new bedtime ScheduleWakeup starts a night again after an end', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 60); r.send('Stop');
  r.at(at(23) + 3 * HOUR);
  r.send('UserPromptSubmit', { prompt: 'status?' });
  assert.strictEqual(r.view(), null);
  r.sched(PROMPT, 1800);
  assert.strictEqual(r.view().startedAt, at(23) + 3 * HOUR);
  assert.strictEqual(r.view().wakes, 0);
});

// --- F5: the 12 h cap ENDS the run ---------------------------------------------------------------------------
test('F5: twelve hours from the start ends the run, even mid-turn', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  assert.ok(r.view(T0 + MAX_NIGHT_MS) !== null);
  assert.strictEqual(r.view(T0 + MAX_NIGHT_MS + 1), null);
});

test('F5: a loop still scheduling after the cap starts NO new night, however its prompt is worded, until stop / SessionEnd / SessionStart', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  r.at(T0 + MAX_NIGHT_MS + MIN);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view(), null, 'a wake never revives a night that old');
  r.sched(PROMPT, 1800);
  r.sched('/bedtime overnight run. A different state: PR #5 done.', 1800);
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.b.snapshot(), null);
  r.at(T0 + MAX_NIGHT_MS + HOUR);
  r.sched(PROMPT, 1800);
  assert.strictEqual(r.view(), null, 'still latched an hour later');
});

test('F5: the latch clears on stop, on SessionEnd and on a fresh SessionStart: then a bedtime ScheduleWakeup is a new night', () => {
  for (const clear of [(r) => r.stop(), (r) => r.send('SessionEnd'), (r) => r.send('SessionStart', { source: 'startup' })]) {
    const r = rig();
    r.sched(PROMPT, 1800);
    r.at(T0 + MAX_NIGHT_MS + MIN);
    r.send('Stop');
    clear(r);
    r.at(T0 + MAX_NIGHT_MS + 5 * MIN);
    r.sched(PROMPT, 1800);
    assert.strictEqual(r.view().startedAt, T0 + MAX_NIGHT_MS + 5 * MIN);
    assert.strictEqual(r.view().wakes, 0);
  }
});

test('F5: a compaction does not clear the cap latch', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  r.at(T0 + MAX_NIGHT_MS - 10 * MIN);
  r.sched(PROMPT, 1800);                                     // the loop is alive up to the cap
  r.at(T0 + MAX_NIGHT_MS + MIN);
  r.send('Stop');
  r.send('SessionStart', { source: 'compact' });
  r.sched(PROMPT, 1800);
  assert.strictEqual(r.view(), null);
});

// --- Dexter r2 F1: the cap latch is only for a run that was still alive at 12 h ------------------------------------
const DAY = 24 * HOUR;
const PROMPT2 = '/bedtime overnight run (claude-custom), the second night.';

test('r2 F1: idle 00:30, typed 11:05, then a /bedtime run at 23:00 the next day IS a night (the idle end is not a cap)', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600);
  r.at(at(23, 1)); r.send('Stop');
  r.at(at(23) + HOUR + 1000); r.send('UserPromptSubmit', { prompt: PROMPT });      // the wake, 00:00:01
  r.at(at(23) + 90 * MIN); r.send('Stop');                                          // 00:30: nothing scheduled
  r.at(at(23) + 12 * HOUR + 5 * MIN);                                               // 11:05, 12 h 05 min after the start
  r.send('UserPromptSubmit', { prompt: 'good morning' });
  assert.strictEqual(r.b.snapshot(), null, 'dropped as an idle end');
  r.at(at(23) + DAY);
  r.sched(PROMPT2, 3600);
  assert.ok(r.view() !== null, 'the next evening\'s run shows');
  assert.strictEqual(r.view().startedAt, at(23) + DAY);
});

test('r2 F1: a dormant night (a wake that never came) that nobody revives ends at its own limit, never feeding the latch', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600); r.send('Stop');
  r.at(at(23) + 9 * HOUR); r.send('UserPromptSubmit', { prompt: 'status?' });       // dormant from here
  r.at(at(23) + 12 * HOUR + 5 * MIN); r.send('UserPromptSubmit', { prompt: 'any event' });
  assert.strictEqual(r.b.snapshot(), null, 'cleared at its limit');
  r.at(at(23) + DAY);
  r.sched(PROMPT2, 3600);
  assert.strictEqual(r.view().startedAt, at(23) + DAY);
});

test('r2 F1: a run that was still alive at 12 h latches, but only against ITS OWN loop: a later real run is not suppressed', () => {
  const r = rig(at(22));
  r.sched(PROMPT, 3600);
  r.at(at(22) + 12 * HOUR - 10 * MIN);
  r.sched(PROMPT, 3600);                                                            // alive right up to the cap
  r.at(at(22) + 12 * HOUR + MIN);                                                   // still awake at the cap
  r.send('UserPromptSubmit', { prompt: 'x' });
  r.sched(PROMPT, 3600);                                                            // its loop keeps scheduling
  assert.strictEqual(r.view(), null, 'the continuation of the capped run starts no night');
  r.at(at(22) + 12 * HOUR + 50 * MIN);
  r.sched(PROMPT, 3600);
  assert.strictEqual(r.view(), null, 'still its loop (within one wake cycle of its last call)');
  r.at(at(22) + 12 * HOUR + 50 * MIN + 2 * HOUR);                                    // the loop went quiet for two hours
  r.sched(PROMPT2, 3600);
  assert.ok(r.view() !== null, 'a call that is no continuation (the loop was silent past one cycle) is a new run');
  assert.strictEqual(r.view().startedAt, at(22) + 12 * HOUR + 50 * MIN + 2 * HOUR);
});

test('r2 F1: a capped run\'s replayed wakes keep its latch alive (they prove the loop is still going)', () => {
  const r = rig(at(22));
  r.sched(PROMPT, 3600);
  r.at(at(22) + 12 * HOUR + MIN);
  r.send('UserPromptSubmit', { prompt: 'x' });                                      // latch set
  for (let k = 1; k <= 4; k++) {
    r.at(at(22) + 12 * HOUR + MIN + k * 50 * MIN);
    r.send('UserPromptSubmit', { prompt: PROMPT });                                 // replayed each cycle
    r.sched(PROMPT, 3000);
  }
  assert.strictEqual(r.view(), null, 'three hours on, the same loop is still suppressed');
});

test('r2 F1: a turn that ends without a Stop (an interrupt, a usage limit) still sleeps the night on the CLI\'s idle_prompt', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600);
  r.send('Notification', { notification_type: 'idle_prompt' });
  assert.strictEqual(r.view().awake, false);
  assert.strictEqual(r.b.snapshot().idleSince, null, 'a wake is still scheduled');
  const q = rig(at(23));
  q.sched(PROMPT, 3600); q.send('Stop');
  q.at(at(23) + HOUR + 1000); q.send('UserPromptSubmit', { prompt: PROMPT });       // woke; the turn then dies
  q.at(at(23) + 2 * HOUR); q.send('Notification', { notification_type: 'idle_prompt' });
  assert.strictEqual(q.b.snapshot().idleSince, at(23) + 2 * HOUR, 'nothing scheduled: the clock starts');
  assert.strictEqual(q.view(at(23) + 2 * HOUR + OVERDUE_MS + 1), null, 'over 15 min later, not held awake to the 12 h cap');
});

test('r2 F1: other notifications (a permission prompt) do not sleep the night; a subagent\'s idle_prompt never counts', () => {
  const r = rig(at(23));
  r.sched(PROMPT, 3600);
  r.send('Notification', { notification_type: 'permission_prompt' });
  r.send('Notification', {});
  r.send('Notification', { notification_type: 'idle_prompt', agent_id: 'a1' });
  assert.strictEqual(r.view().awake, true);
});

test('r2 F1 property: after any history and a quiet gap past 12 h, a successful bedtime ScheduleWakeup starts a night, unless the capped run\'s own loop was still scheduling', () => {
  fc.assert(fc.property(seq, fc.integer({ min: 13 * HOUR, max: 40 * HOUR }), (events, gap) => {
    let t = T0;
    const b = createBedtime({ now: () => t });
    for (const e of events) { t += e.dt; feed(b, e, t); }
    const last = t;
    t = last + gap + MAX_NIGHT_MS;                                                    // quiet for longer than any cap or grace
    feed(b, { k: 'sched', prompt: PROMPT2, delay: 3600 }, t);
    const v = b.view(t);
    return v !== null && v.startedAt === t;
  }));
});

test('handle reports a change exactly when the state moved, and is total on junk', () => {
  const r = rig();
  for (const junk of [null, undefined, 4, 'x', {}, { event: 3 }, { event: 'PreToolUse' }, { event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup' } },
    { event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT } } },
    { event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { prompt: PROMPT, delaySeconds: 'soon' }, tool_response: { scheduledFor: T0 + MIN } } }]) {
    assert.strictEqual(r.b.handle(junk), false);
  }
  assert.strictEqual(r.view(), null);
  assert.strictEqual(r.sched(PROMPT, 1800), true);
  assert.strictEqual(r.sched(PROMPT, 1800), false, 'the identical call again changes nothing');
});

// --- found by mutation testing -------------------------------------------------------------------------------
test('a ScheduleWakeup that failed (PostToolUseFailure) schedules nothing', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  const before = r.view().nextWakeAt;
  r.at(T0 + MIN);
  r.send('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: PROMPT } });
  assert.strictEqual(r.view().nextWakeAt, before, 'the failed call moved nothing');
});

test('only ScheduleWakeup schedules or stops: another tool with the same input shape does neither', () => {
  const r = rig();
  r.send('PostToolUse', { tool_name: 'Agent', tool_input: { delaySeconds: 60, prompt: PROMPT }, tool_response: { scheduledFor: T0 + 2 * MIN } });
  assert.strictEqual(r.view(), null, 'an Agent prompt that is a bedtime run starts no night');
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
    () => ({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, prompt: PROMPT } } }),
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

test('only Stop puts the night to sleep: other events leave an awake session awake', () => {
  for (const [event, payload] of [['Notification', { notification_type: 'permission_prompt' }], ['SubagentStop', {}], ['PreCompact', {}], ['Whatever', {}]]) {
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

test('a wake at exactly twelve hours still counts; one ms later the run has ended', () => {
  const r = rig();
  r.sched(PROMPT, 1800); r.send('Stop');
  r.at(T0 + MAX_NIGHT_MS);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view().wakes, 1);
  r.at(T0 + MAX_NIGHT_MS + 1);
  r.send('UserPromptSubmit', { prompt: PROMPT });
  assert.strictEqual(r.view(), null);
});

test('the view holds exactly what a real night holds', () => {
  const r = rig();
  r.sched(PROMPT, 1800);
  assert.deepStrictEqual(Object.keys(r.view()).sort(), ['awake', 'lastWakeAt', 'nextWakeAt', 'startedAt', 'wakes']);
});

test('isBedtimeOnly: the ScheduleWakeup Pre / Post events the bedtime matcher brings, and nothing else', () => {
  const ev = (event, payload) => ({ event, payload });
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'ScheduleWakeup' })), true);
  assert.strictEqual(isBedtimeOnly(ev('PostToolUse', { tool_name: 'ScheduleWakeup' })), true);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'Bash' })), false);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', { tool_name: 'Agent' })), false);
  assert.strictEqual(isBedtimeOnly(ev('Stop', { tool_name: 'ScheduleWakeup' })), false);
  assert.strictEqual(isBedtimeOnly(ev('PreToolUse', {})), false);
  for (const junk of [null, undefined, {}, 3, { event: 'PreToolUse' }]) assert.strictEqual(isBedtimeOnly(junk), false);
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
    b.handle({ event: row.event, payload: row.payload });
    seen.push([row.event, row.payload.tool_name || '', b.view(t) === null ? 'off' : (b.view(t).awake ? 'awake' : 'asleep')]);
  }
  const names = seen.map(s => s.join(':'));
  assert.strictEqual(names.indexOf('PreToolUse:ScheduleWakeup:off') >= 0, true, 'the Pre alone starts nothing: ' + names.join(' | '));
  const iPost = names.indexOf('PostToolUse:ScheduleWakeup:awake');
  assert.ok(iPost >= 0, 'the Post starts it: ' + names.join(' | '));
  const stopAfter = names.indexOf('Stop::asleep');
  assert.ok(stopAfter > iPost, 'the turn that scheduled it ends, asleep: ' + names.join(' | '));
  const wake = rows.findIndex((r, i) => i > 0 && r.event === 'UserPromptSubmit' && r.payload.prompt.startsWith('bedtime probe tick'));
  assert.ok(wake > 0);
  assert.strictEqual(names[wake], 'UserPromptSubmit::awake', 'the replayed prompt is a wake');
  assert.strictEqual(names[names.length - 1].split(':')[2], 'off', 'after ScheduleWakeup { stop: true } the night is over');
  const post = rows.find(r => r.event === 'PostToolUse' && !r.payload.tool_input.stop);
  assert.ok(Math.abs(rows[wake].at - post.payload.tool_response.scheduledFor) < 5000);
});

// --- properties ------------------------------------------------------------------------------------------
const arbPrompt = fc.constantFrom(PROMPT, '/bedtime x', 'Continue the /bedtime autonomous run', 'poll the tests', '<<autonomous-loop-dynamic>>', '/loop 5m run the bedtime-state tests');
const dt = fc.integer({ min: 0, max: 40 * MIN });
const arbEvent = fc.oneof(
  fc.record({ k: fc.constant('sched'), prompt: arbPrompt, delay: fc.integer({ min: 0, max: 7200 }), dt }),
  fc.record({ k: fc.constant('stopcall'), dt }),
  fc.record({ k: fc.constant('turnstop'), dt }),
  fc.record({ k: fc.constant('prompt'), prompt: arbPrompt, dt }),
  fc.record({ k: fc.constant('typed'), dt }),
  fc.record({ k: fc.constant('tool'), dt }),
  fc.record({ k: fc.constant('end'), dt }),
);
const seq = fc.array(arbEvent, { maxLength: 30 });

function feed(b, e, t) {
  const input = (e.prompt && e.delay !== undefined) ? { delaySeconds: e.delay, reason: 'r', prompt: e.prompt, noop: false } : null;
  switch (e.k) {
    case 'sched':
      b.handle({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: input } });
      b.handle({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: input, tool_response: { scheduledFor: t + clamp(e.delay) * 1000 } } });
      break;
    case 'stopcall': b.handle({ event: 'PreToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { stop: true } } }); break;
    case 'turnstop': b.handle({ event: 'Stop', payload: {} }); break;
    case 'prompt': b.handle({ event: 'UserPromptSubmit', payload: { prompt: e.prompt } }); break;
    case 'typed': b.handle({ event: 'UserPromptSubmit', payload: { prompt: 'status? is the bedtime run ok' } }); break;
    case 'tool': b.handle({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }); break;
    default: b.handle({ event: 'SessionEnd', payload: {} });
  }
}

function play(events) {
  let t = T0;
  const b = createBedtime({ now: () => t });
  for (const e of events) { t += e.dt; feed(b, e, t); }
  return { b, t };
}

test('property: after a stop (or the session ending) with nothing scheduled since, the night is never "running", at any time', () => {
  fc.assert(fc.property(seq, fc.constantFrom('stopcall', 'end'), fc.integer({ min: 0, max: 20 * HOUR }), (events, closer, later) => {
    const { b, t } = play([...events, { k: closer, dt: 1000 }]);
    return b.view(t) === null && b.view(t + later) === null;
  }));
});

test('property: a night only ever exists because a bedtime run\'s ScheduleWakeup succeeded', () => {
  fc.assert(fc.property(seq, (events) => {
    const { b, t } = play(events);
    return events.some(e => e.k === 'sched' && isBedtimeLoopPrompt(e.prompt)) || b.view(t) === null;
  }));
});

test('property: overdue is monotone: once the view is off with no further events, it stays off as time passes', () => {
  fc.assert(fc.property(seq, fc.integer({ min: 0, max: 30 * HOUR }), fc.integer({ min: 0, max: 30 * HOUR }), (events, a, d) => {
    const { b, t } = play(events);
    return b.view(t + a) !== null || b.view(t + a + d) === null;
  }));
});

test('property (F1): once the view is off for any reason but a late wake, no typed prompt, tool call or Stop ever brings it back', () => {
  const quiet = fc.array(fc.constantFrom('typed', 'tool', 'turnstop'), { maxLength: 12 });
  fc.assert(fc.property(seq, fc.integer({ min: 0, max: 30 * HOUR }), quiet, (events, gap, more) => {
    let t = T0;
    const b = createBedtime({ now: () => t });
    for (const e of events) { t += e.dt; feed(b, e, t); }
    t += gap;
    if (b.view(t) !== null) return true;
    for (const k of more) { feed(b, { k, dt: 0 }, t); t += 1000; }
    return b.view(t) === null;
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
