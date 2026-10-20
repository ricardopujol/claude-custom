'use strict';
/**
 * host/schedules.js: the Schedules panel's model (BACKLOG #119 A7). Two halves, both pure:
 *   createSessionSchedule  one session's hook events -> its scheduled work (wakeups, loops, bedtime nights, cron jobs)
 *   buildView              every session's entry -> the grouped, ordered, dimmed list the panel draws
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const S = require('../host/schedules');

const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const NOW = local(2026, 10, 19, 22, 0);          // a Monday evening
const MIN = 60_000;

function clock(t = NOW) {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}
const ev = (event, payload) => ({ event, payload });
const post = (tool, input, response, extra = {}) => ev('PostToolUse', { tool_name: tool, tool_input: input, tool_response: response, ...extra });
const wakeup = (c, input, scheduledFor) => post('ScheduleWakeup', input, scheduledFor === undefined ? {} : { scheduledFor });

// --- the session model: ScheduleWakeup ---------------------------------------------------------------------------------------

test('a successful ScheduleWakeup becomes one wakeup row with its time, prompt and reason', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  assert.strictEqual(s.handle(wakeup(c, { delaySeconds: 1500, prompt: 'check the PRs', reason: 'CI takes ~20 min' }, NOW + 1500_000)), true);
  assert.deepStrictEqual(s.rows().map(r => [r.kind, r.at, r.prompt, r.reason]), [['wakeup', NOW + 1500_000, 'check the PRs', 'CI takes ~20 min']]);
});

test('only the PostToolUse counts: a PreToolUse is an intent, a failure schedules nothing', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  assert.strictEqual(s.handle(ev('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, prompt: 'p' } })), false);
  assert.strictEqual(s.handle(ev('PostToolUseFailure', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, prompt: 'p' } })), false);
  assert.deepStrictEqual(s.rows(), []);
});

test('a stop is honoured on the Pre too, as the bedtime night does (the call may never reach a Post)', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(wakeup(c, { delaySeconds: 600, prompt: 'p' }, NOW + 600_000));
  assert.strictEqual(s.handle(ev('PreToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true } })), true);
  assert.deepStrictEqual(s.rows(), []);
});

test('a new wakeup REPLACES the session\'s previous one', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(wakeup(c, { delaySeconds: 600, prompt: 'first' }, NOW + 600_000));
  s.handle(wakeup(c, { delaySeconds: 1200, prompt: 'second' }, NOW + 1200_000));
  assert.deepStrictEqual(s.rows().map(r => r.prompt), ['second']);
});

test('stop:true removes the wakeup and nothing else', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(wakeup(c, { delaySeconds: 600, prompt: 'p' }, NOW + 600_000));
  s.handle(post('CronCreate', { cron: '0 6 * * *', prompt: 'morning' }, { id: 'j1', recurring: true }));
  assert.strictEqual(s.handle(wakeup(c, { stop: true }, undefined)), true);
  assert.deepStrictEqual(s.rows().map(r => r.id), ['j1']);
  assert.strictEqual(s.handle(wakeup(c, { stop: true }, undefined)), false, 'nothing left to stop: no change');
});

test('a scheduledFor that is not believable falls back to now + the clamped delay; a missing delay schedules nothing', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(wakeup(c, { delaySeconds: 600, prompt: 'p' }, NOW - 5 * MIN));
  assert.strictEqual(s.rows()[0].at, NOW + 600_000);
  s.handle(wakeup(c, { delaySeconds: 99999, prompt: 'p' }, undefined));
  assert.strictEqual(s.rows()[0].at, NOW + 3600_000, 'clamped to the CLI\'s 3600');
  s.handle(wakeup(c, { delaySeconds: 5, prompt: 'p' }, null));
  assert.strictEqual(s.rows()[0].at, NOW + 60_000, 'clamped up to 60');
  const t = S.createSessionSchedule({ now: c.now });
  assert.strictEqual(t.handle(wakeup(c, { prompt: 'p' }, NOW + 600_000)), false);
  assert.strictEqual(t.handle(wakeup(c, { delaySeconds: NaN, prompt: 'p' }, NOW + 600_000)), false);
  assert.strictEqual(t.handle(wakeup(c, { delaySeconds: 600 }, NOW + 600_000)), false, 'no prompt: not a wakeup the CLI could replay');
  assert.deepStrictEqual(t.rows(), []);
});

test('kind: a /loop prompt is a loop, a bedtime run\'s prompt is bedtime, the rest are plain wakeups', () => {
  const kind = (prompt) => {
    const s = S.createSessionSchedule({ now: () => NOW });
    s.handle(wakeup(null, { delaySeconds: 600, prompt }, NOW + 600_000));
    return s.rows()[0].kind;
  };
  assert.strictEqual(kind('/loop 5m check the deploy'), 'loop');
  assert.strictEqual(kind('  /loop check it'), 'loop');
  assert.strictEqual(kind('<<autonomous-loop-dynamic>>'), 'loop');
  assert.strictEqual(kind('Continue the /bedtime autonomous run'), 'bedtime');
  assert.strictEqual(kind('/loop 5m run the bedtime-state tests'), 'loop', 'a /loop poll about bedtime is a loop, not a night');
  assert.strictEqual(kind('check the PRs'), 'wakeup');
});

test('the wake itself (the exact prompt replayed) consumes the wakeup: it is not still "scheduled"', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(wakeup(c, { delaySeconds: 600, prompt: 'check  the\nPRs' }, NOW + 600_000));
  assert.strictEqual(s.handle(ev('UserPromptSubmit', { prompt: 'something else' })), false);
  assert.strictEqual(s.rows().length, 1);
  assert.strictEqual(s.handle(ev('UserPromptSubmit', { prompt: 'check the PRs' })), true, 'whitespace-insensitive, like the bedtime night\'s match');
  assert.deepStrictEqual(s.rows(), []);
});

test('a subagent\'s events never count', () => {
  const s = S.createSessionSchedule({ now: () => NOW });
  assert.strictEqual(s.handle(post('ScheduleWakeup', { delaySeconds: 600, prompt: 'p' }, { scheduledFor: NOW + 600_000 }, { agent_id: 'a1' })), false);
  assert.strictEqual(s.handle(post('CronCreate', { cron: '* * * * *', prompt: 'p' }, { id: 'x' }, { agent_id: 'a1' })), false);
  assert.deepStrictEqual(s.rows(), []);
});

test('junk events never throw and change nothing', () => {
  const s = S.createSessionSchedule({ now: () => NOW });
  for (const junk of [null, undefined, 3, 'x', {}, { event: 5 }, { event: 'PostToolUse' }, { event: 'PostToolUse', payload: null },
    { event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: 'str', tool_response: 7 } },
    { event: 'PostToolUse', payload: { tool_name: 'CronCreate', tool_input: [], tool_response: null } }]) {
    assert.doesNotThrow(() => s.handle(junk));
  }
  assert.deepStrictEqual(s.rows(), []);
});

// --- the session model: cron -------------------------------------------------------------------------------------------------

test('CronCreate becomes a cron row keyed by the id the result carries; CronDelete removes it', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(post('CronCreate', { cron: '0 6 * * *', prompt: 'morning report', recurring: true, durable: false },
    { id: 'job-1', humanSchedule: 'Every day at 6:00 AM', recurring: true, durable: false }));
  const r = s.rows()[0];
  assert.deepStrictEqual([r.id, r.kind, r.cron, r.human, r.recurring, r.durable, r.prompt], ['job-1', 'cron', '0 6 * * *', 'Every day at 6:00 AM', true, false, 'morning report']);
  assert.strictEqual(s.handle(post('CronDelete', { id: 'job-1' }, { id: 'job-1' })), true);
  assert.deepStrictEqual(s.rows(), []);
  assert.strictEqual(s.handle(post('CronDelete', { id: 'job-1' }, { id: 'job-1' })), false);
});

test('recurring defaults to true when neither the result nor the input says; a one-shot remembers its first run', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(post('CronCreate', { cron: '*/10 * * * *', prompt: 'p' }, { id: 'a' }));
  assert.strictEqual(s.rows()[0].recurring, true);
  s.handle(post('CronCreate', { cron: '30 23 19 10 *', prompt: 'remind me', recurring: false }, { id: 'b', recurring: false }));
  const one = s.rows().find(r => r.id === 'b');
  assert.strictEqual(one.recurring, false);
  assert.strictEqual(one.at, local(2026, 10, 19, 23, 30), 'its one run, computed from the expression at creation');
});

test('a one-shot cron with an expression we cannot read uses the CLI\'s own nextFireAt, else has no time', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(post('CronCreate', { cron: '0 9 * * MON', prompt: 'p', recurring: false }, { id: 'a', recurring: false, nextFireAt: NOW + 5 * 3600_000 }));
  s.handle(post('CronCreate', { cron: '@weird', prompt: 'p', recurring: false }, { id: 'b', recurring: false }));
  assert.strictEqual(s.rows().find(r => r.id === 'a').at, NOW + 5 * 3600_000);
  assert.strictEqual(s.rows().find(r => r.id === 'b').at, null);
});

test('a fired one-shot (its exact prompt replayed) goes; a recurring job stays', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  s.handle(post('CronCreate', { cron: '30 23 19 10 *', prompt: 'remind me', recurring: false }, { id: 'once', recurring: false }));
  s.handle(post('CronCreate', { cron: '*/10 * * * *', prompt: 'poll' }, { id: 'every', recurring: true }));
  s.handle(ev('UserPromptSubmit', { prompt: 'remind me' }));
  s.handle(ev('UserPromptSubmit', { prompt: 'poll' }));
  assert.deepStrictEqual(s.rows().map(r => r.id), ['every']);
});

test('session end and a fresh start clear what dies with the session; a durable cron survives; a compaction clears nothing', () => {
  const c = clock();
  const s = S.createSessionSchedule({ now: c.now });
  const fill = () => {
    s.handle(wakeup(c, { delaySeconds: 600, prompt: 'w' }, NOW + 600_000));
    s.handle(post('CronCreate', { cron: '0 6 * * *', prompt: 'mem' }, { id: 'mem', durable: false }));
    s.handle(post('CronCreate', { cron: '0 7 * * *', prompt: 'disk', durable: true }, { id: 'disk', durable: true }));
  };
  fill();
  assert.strictEqual(s.handle(ev('SessionStart', { source: 'compact' })), false);
  assert.strictEqual(s.rows().length, 3);
  s.handle(ev('SessionEnd', {}));
  assert.deepStrictEqual(s.rows().map(r => r.id), ['disk']);
  fill();
  s.handle(ev('SessionStart', { source: 'startup' }));
  assert.deepStrictEqual(s.rows().map(r => r.id), ['disk']);
});

test('restore() brings back durable cron rows only, and a restored row survives the SessionStart that follows', () => {
  const c = clock();
  const saved = [
    { id: 'disk', kind: 'cron', cron: '0 7 * * *', recurring: true, durable: true, prompt: 'disk', createdAt: NOW - 1000, at: null, human: null, reason: null },
    { id: 'mem', kind: 'cron', cron: '0 6 * * *', recurring: true, durable: false, prompt: 'mem', createdAt: NOW - 1000, at: null, human: null, reason: null },
    { id: 'w', kind: 'wakeup', at: NOW + 1000, prompt: 'w', createdAt: NOW - 1000, durable: false },
    { nonsense: true }, null, 7,
  ];
  const s = S.createSessionSchedule({ now: c.now });
  s.restore(saved);
  assert.deepStrictEqual(s.rows().map(r => r.id), ['disk']);
  s.handle(ev('SessionStart', { source: 'startup' }));
  assert.deepStrictEqual(s.rows().map(r => r.id), ['disk']);
});

// --- the view ----------------------------------------------------------------------------------------------------------------

const entry = (rows, o = {}) => ({ key: '1', cwd: 'C:/p/a', label: 'proj / feat-a', pid: 1, updatedAt: NOW, endedAt: null, rows, ...o });
const wrow = (id, at, o = {}) => ({ id, kind: 'wakeup', at, prompt: `prompt ${id}`, reason: null, createdAt: NOW - MIN, durable: false, cron: null, recurring: false, human: null, ...o });
const ids = (view) => view.groups.map(g => [g.id, g.rows.map(r => r.id)]);

test('rows are grouped Next hour, Tonight, Later, Recurring and ordered soonest first inside each', () => {
  const rows = [
    wrow('later', local(2026, 10, 21, 14, 0)),
    wrow('tonight2', local(2026, 10, 20, 3, 0)),
    wrow('hour2', NOW + 50 * MIN),
    wrow('tonight1', local(2026, 10, 19, 23, 30)),
    wrow('hour1', NOW + 5 * MIN),
    { ...wrow('cron', null), kind: 'cron', cron: '0 6 * * *', recurring: true, createdAt: NOW - MIN },
  ];
  const view = S.buildView({ '1': entry(rows) }, NOW);
  assert.deepStrictEqual(ids(view), [
    ['next-hour', ['hour1', 'hour2']],
    ['tonight', ['tonight1', 'tonight2']],
    ['later', ['later']],
    ['recurring', ['cron']],
  ]);
  assert.deepStrictEqual(view.groups.map(g => g.label), ['Next hour', 'Tonight', 'Later', 'Recurring']);
  assert.strictEqual(view.nextHour, 2);
});

test('empty groups are left out; an empty list has no groups', () => {
  assert.deepStrictEqual(S.buildView({}, NOW).groups, []);
  assert.deepStrictEqual(S.buildView(null, NOW).groups, []);
  assert.deepStrictEqual(ids(S.buildView({ '1': entry([wrow('a', NOW + 5 * MIN)]) }, NOW)), [['next-hour', ['a']]]);
});

test('a recurring cron whose next run is inside the hour is in Next hour with its computed time, not under Recurring', () => {
  const row = { ...wrow('c', null), kind: 'cron', cron: '*/10 * * * *', recurring: true, human: 'Every 10 minutes' };
  const view = S.buildView({ '1': entry([row]) }, NOW);
  assert.deepStrictEqual(ids(view), [['next-hour', ['c']]]);
  const r = view.groups[0].rows[0];
  assert.strictEqual(r.at, local(2026, 10, 19, 22, 10));
  assert.strictEqual(r.whenText, 'in 10 min');
  assert.strictEqual(r.recurring, true);
});

test('a recurring cron outside the hour shows its schedule and its next run; an unreadable one shows "schedule: <raw>" and no time', () => {
  const daily = { ...wrow('d', null), kind: 'cron', cron: '0 6 * * *', recurring: true, human: 'every day 06:00' };
  const weird = { ...wrow('w', null), kind: 'cron', cron: '0 9 * * MON', recurring: true };
  const view = S.buildView({ '1': entry([daily, weird]) }, NOW);
  const rec = view.groups.find(g => g.id === 'recurring').rows;
  const d = rec.find(r => r.id === 'd');
  assert.strictEqual(d.whenText, 'every day 06:00');
  assert.strictEqual(d.nextText, 'next tomorrow 06:00');
  const w = rec.find(r => r.id === 'w');
  assert.strictEqual(w.whenText, 'schedule: 0 9 * * MON');
  assert.strictEqual(w.at, null);
  assert.strictEqual(w.nextText, null);
});

test('when text: minutes inside the hour, a clock time tonight, tomorrow and a weekday further out', () => {
  const view = S.buildView({ '1': entry([
    wrow('a', NOW + 23 * MIN), wrow('b', NOW + 20 * 1000), wrow('c', local(2026, 10, 19, 23, 30)), wrow('d', local(2026, 10, 20, 14, 5)), wrow('e', local(2026, 10, 24, 9, 0)),
  ]) }, NOW);
  const text = Object.fromEntries(view.groups.flatMap(g => g.rows).map(r => [r.id, r.whenText]));
  assert.deepStrictEqual(text, { a: 'in 23 min', b: 'in <1 min', c: '23:30', d: 'tomorrow 14:05', e: 'Sat 09:00' });
});

test('Tonight is the evening-to-06:00 window; a daytime wake is Later', () => {
  const noon = local(2026, 10, 19, 12, 0);
  const view = S.buildView({ '1': entry([wrow('afternoon', local(2026, 10, 19, 15, 0)), wrow('evening', local(2026, 10, 19, 19, 0)),
    wrow('small', local(2026, 10, 20, 2, 0)), wrow('morning', local(2026, 10, 20, 8, 0))]) }, noon);
  assert.deepStrictEqual(ids(view), [['tonight', ['evening', 'small']], ['later', ['afternoon', 'morning']]]);
});

test('a wakeup long past its time is dropped (it should have fired); one just past is still shown as due', () => {
  const view = S.buildView({ '1': entry([wrow('stale', NOW - 20 * MIN), wrow('due', NOW - 2 * MIN)]) }, NOW);
  assert.deepStrictEqual(ids(view), [['next-hour', ['due']]]);
  assert.strictEqual(view.groups[0].rows[0].whenText, 'due now');
});

test('a cron job expires after 7 days; a one-shot after its run', () => {
  const old = { ...wrow('old', null), kind: 'cron', cron: '0 6 * * *', recurring: true, createdAt: NOW - 8 * 86_400_000 };
  const spent = { ...wrow('spent', NOW - 30 * MIN), kind: 'cron', cron: '0 22 * * *', recurring: false };
  assert.deepStrictEqual(S.buildView({ '1': entry([old, spent]) }, NOW).groups, []);
});

test('a session that ended is dimmed "session ended" and drops after 10 minutes', () => {
  const rows = [wrow('a', NOW + 5 * MIN)];
  const ended = entry(rows, { endedAt: NOW - 3 * MIN });
  const v = S.buildView({ '1': ended }, NOW);
  assert.strictEqual(v.groups[0].rows[0].ended, true);
  assert.strictEqual(v.groups[0].rows[0].endedText, 'session ended');
  assert.strictEqual(v.nextHour, 0, 'a dead session\'s wake is not "coming up"');
  assert.deepStrictEqual(S.buildView({ '1': ended }, NOW + 8 * MIN).groups, [], '11 minutes after it ended');
  const silent = entry(rows, { updatedAt: NOW - 4 * MIN });
  assert.strictEqual(S.buildView({ '1': silent }, NOW).groups[0].rows[0].ended, true, 'a host that stopped heartbeating is treated as gone');
  assert.strictEqual(S.buildView({ '1': entry(rows, { updatedAt: NOW - 2 * MIN }) }, NOW).groups[0].rows[0].ended, false);
});

test('a row carries what the panel needs: session label and folder, the first prompt line, the full text for the hover, the reason', () => {
  const r = S.buildView({ '1': entry([wrow('a', NOW + 5 * MIN, { prompt: '\n  first line here  \nsecond line', reason: 'CI takes a while' })]) }, NOW).groups[0].rows[0];
  assert.strictEqual(r.promptLine, 'first line here');
  assert.strictEqual(r.promptFull, '\n  first line here  \nsecond line'.trim());
  assert.strictEqual(r.reason, 'CI takes a while');
  assert.deepStrictEqual([r.sessionKey, r.cwd, r.session, r.kind], ['1', 'C:/p/a', 'proj / feat-a', 'wakeup']);
  assert.ok(r.title.includes('first line here') && /session owns/i.test(r.title), 'the hover says the session owns its schedule');
});

test('a very long prompt line is cut with an ellipsis', () => {
  const r = S.buildView({ '1': entry([wrow('a', NOW + 5 * MIN, { prompt: 'x'.repeat(500) })]) }, NOW).groups[0].rows[0];
  assert.ok(r.promptLine.length <= 140 && r.promptLine.endsWith('…'));
});

test('a bedtime row carries the night\'s start, wakes and PR count into its detail', () => {
  const night = { startedAt: local(2026, 10, 19, 21, 30), wakes: 3, prs: 4, nextWakeAt: NOW + 20 * MIN };
  const row = wrow('w', NOW + 20 * MIN, { kind: 'bedtime', night });
  const r = S.buildView({ '1': entry([row]) }, NOW).groups[0].rows[0];
  assert.strictEqual(r.kind, 'bedtime');
  assert.strictEqual(r.detail, 'night since 21:30 · 3 wakes · 4 PRs');
  const none = S.buildView({ '1': entry([wrow('w', NOW + 20 * MIN, { kind: 'bedtime', night: { startedAt: night.startedAt, wakes: 0, prs: null } })]) }, NOW).groups[0].rows[0];
  assert.strictEqual(none.detail, 'night since 21:30', 'no PR count yet is absence, not "0 PRs"');
});

test('the footer says the desktop app\'s Routines are cloud-side, with the link', () => {
  const v = S.buildView({}, NOW);
  assert.match(v.footer.text, /Routines/);
  assert.match(v.footer.text, /cloud/);
  assert.strictEqual(v.footer.url, 'https://claude.ai/code');
});

test('PROPERTY: the view never throws on junk, lists each row once, orders groups, and sorts each group soonest first', () => {
  const junkRow = fc.oneof(
    fc.constant(null), fc.integer(), fc.string(),
    fc.record({ id: fc.string(), kind: fc.constantFrom('wakeup', 'loop', 'bedtime', 'cron', 'weird'), at: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: NOW * 2 }), fc.constant(NaN)),
      cron: fc.oneof(fc.constant(null), fc.constantFrom('*/5 * * * *', '0 6 * * *', 'junk', '30 14 28 2 *')), recurring: fc.boolean(), prompt: fc.string(), createdAt: fc.integer({ min: 0, max: NOW * 2 }) }, { requiredKeys: ['id'] }),
  );
  const junkEntry = fc.oneof(fc.constant(null), fc.string(), fc.record({ key: fc.string(), rows: fc.array(junkRow, { maxLength: 6 }), updatedAt: fc.oneof(fc.integer({ min: 0, max: NOW * 2 }), fc.constant(undefined)), endedAt: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: NOW * 2 })) }, { requiredKeys: [] }));
  fc.assert(fc.property(fc.dictionary(fc.string({ maxLength: 4 }), junkEntry, { maxKeys: 4 }), fc.integer({ min: NOW - 86_400_000, max: NOW + 86_400_000 }), (entries, now) => {
    const v = S.buildView(entries, now);
    const order = ['next-hour', 'tonight', 'later', 'recurring'];
    let last = -1;
    const seen = new Set();
    for (const g of v.groups) {
      const i = order.indexOf(g.id);
      assert.ok(i > last, 'groups in fixed order, none repeated');
      last = i;
      assert.ok(g.rows.length > 0);
      let prev = -Infinity;
      for (const r of g.rows) {
        assert.ok(!seen.has(r.key), 'a row appears once');
        seen.add(r.key);
        const at = r.at === null ? Infinity : r.at;
        assert.ok(at >= prev, 'soonest first');
        prev = at;
      }
    }
    assert.strictEqual(v.nextHour, v.groups.filter(g => g.id === 'next-hour').flatMap(g => g.rows).filter(r => !r.ended).length);
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: every row with a time and a live session is in the group its time says', () => {
  fc.assert(fc.property(fc.integer({ min: -30 * MIN, max: 40 * 86_400_000 }), (offset) => {
    const at = NOW + offset;
    const v = S.buildView({ '1': entry([wrow('a', at)]) }, NOW);
    if (offset < -15 * MIN) { assert.deepStrictEqual(v.groups, []); return true; }
    const g = v.groups[0];
    if (offset <= 60 * MIN) assert.strictEqual(g.id, 'next-hour');
    else assert.notStrictEqual(g.id, 'next-hour');
    assert.notStrictEqual(g.id, 'recurring');
    return true;
  }), { numRuns: 300 });
});
