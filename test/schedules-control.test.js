'use strict';
/**
 * host/schedules-control.js: one host's side of the Schedules panel (BACKLOG #119 A7). Each host keeps ITS session's scheduled work in
 * the install-wide file .harness/state/schedules.json and reads every other host's, so any window lists every session.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createSchedulesControl, isSchedulesOnly, STORE_KEY } = require('../host/schedules-control');
const { CONTROL_TYPES } = require('../host/control');

const MIN = 60_000;
const NOW = new Date(2026, 9, 19, 22, 0, 0, 0).getTime();

function setup(n = 1) {
  const dir = tmpDir('sched-');
  const store = createStore({ dir });
  const clock = { t: NOW, now: () => clock.t };
  const frames = [];
  const make = (key, label) => createSchedulesControl({ store, key, cwd: `C:/p/${key}`, label: () => label, now: clock.now, emit: (f) => frames.push([key, f]), nightView: () => null });
  const controls = Array.from({ length: n }, (_, i) => make(String(i + 1), `proj / feat-${i + 1}`));
  return { dir, store, clock, frames, controls, make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const wake = (prompt, delay = 600, at) => ({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: delay, prompt, reason: 'because' }, tool_response: { scheduledFor: at } } });
const rowsOf = (payload) => payload.groups.flatMap(g => g.rows);

test('the store key, and the control type that lets a window ask for a refresh, are listed', () => {
  assert.strictEqual(STORE_KEY, 'schedules');
  assert.ok(CONTROL_TYPES.has('schedules'), 'off CONTROL_TYPES a "schedules" frame is TYPED into the pty as JSON');
});

test('isSchedulesOnly: the Pre and Post of CronCreate / CronDelete, and nothing else', () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    for (const tool_name of ['CronCreate', 'CronDelete']) assert.strictEqual(isSchedulesOnly({ event, payload: { tool_name } }), true, `${event} ${tool_name}`);
  }
  assert.strictEqual(isSchedulesOnly({ event: 'PostToolUseFailure', payload: { tool_name: 'CronCreate' } }), false);
  assert.strictEqual(isSchedulesOnly({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup' } }), false, 'the bedtime flag owns that one');
  assert.strictEqual(isSchedulesOnly({ event: 'PostToolUse', payload: { tool_name: 'Bash' } }), false);
  for (const junk of [null, undefined, 1, {}, { event: 'PostToolUse' }, { event: 'PostToolUse', payload: null }]) assert.strictEqual(isSchedulesOnly(junk), false);
});

test('a wakeup is written under this host\'s key with its folder and label, and shows in its own payload', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  assert.strictEqual(a.event(wake('check the PRs', 600, NOW + 600_000)), true);
  const file = JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8'));
  assert.strictEqual(file.version, 1);
  assert.deepStrictEqual([file.sessions['1'].cwd, file.sessions['1'].label, file.sessions['1'].endedAt, file.sessions['1'].updatedAt], ['C:/p/1', 'proj / feat-1', null, NOW]);
  const rows = rowsOf(a.payload());
  assert.deepStrictEqual(rows.map(r => [r.kind, r.session, r.cwd, r.promptLine, r.whenText]), [['wakeup', 'proj / feat-1', 'C:/p/1', 'check the PRs', 'in 10 min']]);
});

test('another host\'s rows appear in this one\'s payload, and changed() announces a write once', (t) => {
  const s = setup(2); t.after(s.cleanup);
  const [a, b] = s.controls;
  a.start(); b.start();
  assert.strictEqual(b.changed(), null, 'nothing yet');
  a.event(wake('from a', 600, NOW + 600_000));
  const frame = b.changed();
  assert.strictEqual(frame.type, 'schedules');
  assert.deepStrictEqual(rowsOf(frame.schedules).map(r => r.session), ['proj / feat-1']);
  assert.strictEqual(b.changed(), null, 'told once');
  b.event(wake('from b', 1200, NOW + 1200_000));
  assert.deepStrictEqual(rowsOf(b.payload()).map(r => r.session).sort(), ['proj / feat-1', 'proj / feat-2']);
});

test('an event that changes the list emits a frame; one that does not, does not', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  a.event({ event: 'PostToolUse', payload: { tool_name: 'Bash', tool_input: {} } });
  assert.deepStrictEqual(s.frames, []);
  a.event(wake('p', 600, NOW + 600_000));
  assert.strictEqual(s.frames.length, 1);
  assert.strictEqual(s.frames[0][1].type, 'schedules');
  a.event({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: {} } });
  assert.strictEqual(s.frames.length, 2);
  assert.deepStrictEqual(s.frames[1][1].schedules.groups, []);
});

test('with nothing scheduled this host keeps NO entry in the file (no heartbeat churn for an idle session)', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  a.beat();
  assert.strictEqual(fs.existsSync(s.store.pathOf(STORE_KEY)) ? Object.keys(JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8')).sessions).length : 0, 0);
  a.event(wake('p', 600, NOW + 600_000));
  a.event({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: {} } });
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8')).sessions), []);
});

test('the heartbeat refreshes updatedAt; a host that stops heartbeating is dimmed "session ended" for its neighbours after 3 minutes', (t) => {
  const s = setup(2); t.after(s.cleanup);
  const [a, b] = s.controls;
  a.start(); b.start();
  a.event(wake('p', 3000, NOW + 3000_000));
  s.clock.t += 2 * MIN; a.beat();
  s.clock.t += 2 * MIN;
  assert.strictEqual(rowsOf(b.payload())[0].ended, false, 'beat 2 minutes ago');
  s.clock.t += 2 * MIN;
  assert.strictEqual(rowsOf(b.payload())[0].ended, true, '4 minutes of silence');
});

test('a clean exit marks the session ended at once, and its rows go 10 minutes later; an exit with nothing scheduled leaves nothing', (t) => {
  const s = setup(3); t.after(s.cleanup);
  const [a, b, c] = s.controls;
  a.start(); b.start(); c.start();
  a.event(wake('p', 3000, NOW + 3000_000));
  c.end();
  assert.strictEqual(JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8')).sessions['3'], undefined);
  a.end();
  const r = rowsOf(b.payload())[0];
  assert.deepStrictEqual([r.ended, r.endedText], [true, 'session ended']);
  s.clock.t += 11 * MIN;
  assert.deepStrictEqual(b.payload().groups, []);
  b.event(wake('b', 600, s.clock.t + 600_000));
  const file = JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8'));
  assert.deepStrictEqual(Object.keys(file.sessions), ['2'], 'a write prunes entries that ended long ago');
});

test('start() restores this host\'s DURABLE cron jobs from the file and forgets the rest (they died with the session)', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  a.event(wake('w', 600, NOW + 600_000));
  a.event({ event: 'PostToolUse', payload: { tool_name: 'CronCreate', tool_input: { cron: '0 7 * * *', prompt: 'disk', durable: true }, tool_response: { id: 'disk', durable: true, recurring: true } } });
  a.event({ event: 'PostToolUse', payload: { tool_name: 'CronCreate', tool_input: { cron: '0 6 * * *', prompt: 'mem' }, tool_response: { id: 'mem', durable: false, recurring: true } } });
  s.clock.t += 5 * MIN;
  const again = s.make('1', 'proj / feat-1');          // the same host key after a restart
  again.start();
  assert.deepStrictEqual(rowsOf(again.payload()).map(r => r.id), ['disk']);
  assert.strictEqual(rowsOf(again.payload())[0].ended, false);
});

test('a corrupt file is replaced (the list is regenerable); a file that cannot be read right now is left alone and the own rows still show', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  fs.writeFileSync(s.store.pathOf(STORE_KEY), '{ not json');
  a.start();
  assert.doesNotThrow(() => a.event(wake('p', 600, NOW + 600_000)));
  assert.strictEqual(JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8')).sessions['1'].rows.length, 1);

  const busy = { ...s.store, readState: () => ({ status: 'unreadable', value: null, error: new Error('EBUSY') }), write: () => { throw new Error('must not write over a file it could not read'); }, withLock: (n, fn) => fn() };
  const b = createSchedulesControl({ store: busy, key: '9', cwd: 'C:/p/9', label: () => 'proj / busy', now: s.clock.now, emit: () => {}, nightView: () => null });
  b.start();
  assert.doesNotThrow(() => b.event(wake('mine', 600, NOW + 600_000)));
  assert.deepStrictEqual(rowsOf(b.payload()).map(r => r.promptLine), ['mine']);
});

test('a bedtime row carries the night\'s view, and touch() refreshes it when the PR count lands', (t) => {
  const s = setup(); t.after(s.cleanup);
  let night = { startedAt: NOW - 30 * MIN, wakes: 1, prs: null, nextWakeAt: NOW + 20 * MIN };
  const a = createSchedulesControl({ store: s.store, key: '1', cwd: 'C:/p/1', label: () => 'proj / night', now: s.clock.now, emit: (f) => s.frames.push(f), nightView: () => night });
  a.start();
  a.event(wake('Continue the /bedtime autonomous run', 1200, NOW + 1200_000));
  assert.strictEqual(rowsOf(a.payload())[0].detail, 'night since 21:30 · 1 wake');
  night = { ...night, prs: 3 };
  a.touch();
  assert.strictEqual(rowsOf(a.payload())[0].detail, 'night since 21:30 · 1 wake · 3 PRs');
  assert.ok(s.frames.length >= 2, 'the refreshed detail was broadcast');
});

test('the label is re-read on the heartbeat (a branch switch renames the session)', (t) => {
  const s = setup(); t.after(s.cleanup);
  let label = 'proj / one';
  const a = createSchedulesControl({ store: s.store, key: '1', cwd: 'C:/p/1', label: () => label, now: s.clock.now, emit: () => {}, nightView: () => null });
  a.start();
  a.event(wake('p', 3000, NOW + 3000_000));
  label = 'proj / two';
  a.beat();
  assert.strictEqual(rowsOf(a.payload())[0].session, 'proj / two');
});

test('a window\'s "schedules" request is answered with the current list; anything else is not ours', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  a.event(wake('p', 600, NOW + 600_000));
  assert.strictEqual(a.handles('schedules'), true);
  assert.strictEqual(a.handles('wand-add'), false);
  const f = a.reply({ type: 'schedules', op: 'get' });
  assert.strictEqual(f.type, 'schedules');
  assert.strictEqual(rowsOf(f.schedules).length, 1);
  assert.strictEqual(a.reply(null).type, 'schedules');
});

test('junk events and a broken store never throw out of the host\'s hook handler', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  for (const junk of [null, undefined, 4, 'x', {}, { event: 'PostToolUse', payload: 7 }]) assert.doesNotThrow(() => a.event(junk));
  const broken = { readState: () => { throw new Error('boom'); }, write: () => { throw new Error('boom'); }, withLock: () => { throw new Error('boom'); }, pathOf: () => 'x' };
  const b = createSchedulesControl({ store: broken, key: '2', cwd: 'C:/p/2', label: () => 'x', now: s.clock.now, emit: () => {}, nightView: () => null, log: () => {} });
  assert.doesNotThrow(() => b.start());
  assert.doesNotThrow(() => b.event(wake('p', 600, NOW + 600_000)));
  assert.doesNotThrow(() => b.beat());
  assert.doesNotThrow(() => b.end());
  assert.doesNotThrow(() => b.payload());
  assert.doesNotThrow(() => b.changed());
});

// The antivirus scan of a file just renamed can hold it for a moment (measured on this machine, host/wand-control.js): a read that fails
// then must not blank the OTHER sessions' rows, and what the file holds a moment later must still reach the windows.
test('a file that cannot be read for a moment keeps showing the last good list, and is looked at again shortly', async (t) => {
  const s = setup(2); t.after(s.cleanup);
  const [a] = s.controls;
  let busy = false;
  const flaky = { ...s.store, readState: (n) => (busy ? { status: 'unreadable', value: null, error: new Error('EBUSY') } : s.store.readState(n)) };
  flaky.withLock = (n, fn) => s.store.withLock(n, fn);
  flaky.write = (n, v) => s.store.write(n, v);
  const frames = [];
  const b = createSchedulesControl({ store: flaky, key: '2', cwd: 'C:/p/2', label: () => 'proj / feat-2', now: s.clock.now, emit: (f) => frames.push(f), nightView: () => null, retryMs: 5 });
  a.start(); b.start();
  a.event(wake('from a', 600, NOW + 600_000));
  assert.deepStrictEqual(rowsOf(b.changed().schedules).map(r => r.session), ['proj / feat-1'], 'seen once');
  busy = true;
  s.clock.t += MIN;                                     // the clock text moves, so the list is a different list
  assert.deepStrictEqual(rowsOf(b.payload()).map(r => r.session), ['proj / feat-1'], 'the last good list, not an empty one');
  const whileBusy = b.changed();
  assert.ok(whileBusy === null || rowsOf(whileBusy.schedules).length === 1, 'never a frame that drops the other session');
  a.event(wake('newer', 900, s.clock.t + 900_000));
  b.changed();                                          // unreadable: nothing new can be told yet, but a retry is armed
  busy = false;
  await new Promise(r => setTimeout(r, 60));
  const last = frames[frames.length - 1];
  assert.ok(last, 'the retry announced what the file holds now');
  assert.ok(rowsOf(last.schedules).some(r => r.promptLine === 'newer'), JSON.stringify(rowsOf(last.schedules).map(r => r.promptLine)));
  b.end();
});

test('end() stops a pending retry', async (t) => {
  const s = setup(1); t.after(s.cleanup);
  const busy = { ...s.store, readState: () => ({ status: 'unreadable', value: null, error: new Error('EBUSY') }), withLock: (n, fn) => s.store.withLock(n, fn), write: (n, v) => s.store.write(n, v) };
  const frames = [];
  const b = createSchedulesControl({ store: busy, key: '3', cwd: 'C:/p/3', label: () => 'x', now: s.clock.now, emit: (f) => frames.push(f), nightView: () => null, retryMs: 5 });
  b.start();
  b.changed();
  b.end();
  await new Promise(r => setTimeout(r, 40));
  assert.deepStrictEqual(frames, []);
});

// ---- PR #200 review pass ----------------------------------------------------------------------------------------------------

const cronPost = (id, durable, extra = {}) => ({ event: 'PostToolUse', payload: { tool_name: 'CronCreate', tool_input: { cron: '0 7 * * 1', prompt: 'weekly', durable }, tool_response: { id, durable, recurring: true, ...extra } } });
const filed = (s) => JSON.parse(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8')).sessions;

test('DEXTER 2: a removal whose save met a busy file is retried on the next heartbeat, so no ghost row is left for the other tabs', (t) => {
  const s = setup(); t.after(s.cleanup);
  let busy = false;
  const flaky = { ...s.store, readState: (n) => (busy ? { status: 'unreadable', value: null, error: new Error('EBUSY') } : s.store.readState(n)), withLock: (n, fn) => s.store.withLock(n, fn), write: (n, v) => s.store.write(n, v) };
  const a = createSchedulesControl({ store: flaky, key: '1', cwd: 'C:/p/1', label: () => 'proj / one', now: s.clock.now, emit: () => {}, nightView: () => null });
  a.start();
  a.event(wake('p', 600, NOW + 600_000));
  assert.ok(filed(s)['1'], 'saved');
  busy = true;
  a.event({ event: 'PostToolUse', payload: { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: {} } });
  assert.ok(filed(s)['1'], 'the save of the removal met the busy file: the ghost is still there');
  busy = false;
  a.beat();
  assert.strictEqual(filed(s)['1'], undefined, 'the heartbeat saved the removal, although there are no rows left to keep alive');
  a.end();
});

test('DEXTER 5: another project\'s entry under the same key is not restored (a port outlives its host)', (t) => {
  const s = setup(); t.after(s.cleanup);
  const seed = () => s.store.write(STORE_KEY, { version: 1, sessions: { 7402: { key: '7402', cwd: 'C:/proj-y', label: 'y', updatedAt: NOW, endedAt: NOW, rows: [
    { id: 'weekly', kind: 'cron', cron: '0 9 * * 1', recurring: true, durable: true, prompt: 'p', createdAt: NOW - 1000, at: null, human: null, reason: null }] } } });
  seed();
  const z = createSchedulesControl({ store: s.store, key: '7402', cwd: 'C:/proj-z', label: () => 'z', now: s.clock.now, emit: () => {}, nightView: () => null });
  z.start();
  assert.deepStrictEqual(rowsOf(z.payload()).filter(r => r.session === 'z'), [], 'proj-y\'s job is not proj-z\'s');
  seed();                                              // z's start replaced the entry it does not own; seed it again for the owner
  const y = createSchedulesControl({ store: s.store, key: '7402', cwd: 'C:/proj-y', label: () => 'y', now: s.clock.now, emit: () => {}, nightView: () => null });
  y.start();
  assert.deepStrictEqual(rowsOf(y.payload()).map(r => r.id), ['weekly'], 'its own host gets it back (the same folder, whatever the slash or case)');
  seed();
  const y2 = createSchedulesControl({ store: s.store, key: '7402', cwd: 'C:\\Proj-Y\\', label: () => 'y', now: s.clock.now, emit: () => {}, nightView: () => null });
  y2.start();
  assert.deepStrictEqual(rowsOf(y2.payload()).map(r => r.id), ['weekly']);
});

test('DEXTER 5: a host that has not started (its bind failed) never writes the shared file, and its end() writes nothing', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.start();
  a.event(wake('live host\'s row', 600, NOW + 600_000));
  const before = fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8');
  const loser = s.make('1', 'the loser');                  // the same key: it lost the port
  loser.event(wake('its own', 900, NOW + 900_000));
  loser.beat();
  loser.touch();
  loser.end();
  assert.strictEqual(fs.readFileSync(s.store.pathOf(STORE_KEY), 'utf8'), before, 'the live host\'s entry is untouched');
});

test('MIGUEL 3: when an ended host\'s entry is pruned, its durable cron jobs stay in the file (the CLI still fires them)', (t) => {
  const s = setup(2); t.after(s.cleanup);
  const [a, b] = s.controls;
  a.start(); b.start();
  a.event(wake('w', 3000, NOW + 3000_000));
  a.event(cronPost('keep', true));
  a.event(cronPost('lose', false));
  a.end();
  s.clock.t += 30 * MIN;
  b.event(wake('b', 600, s.clock.t + 600_000));              // any write prunes
  const kept = filed(s)['1'];
  assert.deepStrictEqual(kept.rows.map(r => r.id), ['keep']);
  const rows = rowsOf(b.payload()).filter(r => r.session === 'proj / feat-1');
  assert.deepStrictEqual(rows.map(r => [r.id, r.endedText]), [['keep', 'host ended, still scheduled by the CLI']]);
});

test('a hook event that arrives before start() is kept in memory and saved by start(), not lost to the restore', (t) => {
  const s = setup(); t.after(s.cleanup);
  const [a] = s.controls;
  a.event(wake('early', 600, NOW + 600_000));
  assert.strictEqual(fs.existsSync(s.store.pathOf(STORE_KEY)), false, 'nothing is written before start');
  a.start();
  assert.deepStrictEqual(filed(s)['1'].rows.map(r => r.prompt), ['early']);
});
