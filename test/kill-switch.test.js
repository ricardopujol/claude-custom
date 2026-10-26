'use strict';
/**
 * The sentinel kill switch and the night budget (host/kill-switch.js; documentation/PLAN_SAFETY_NET.md, lane 2). Pure: every
 * clock, timer and file check is injected, so nothing here touches the disk or waits.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ks = require('../host/kill-switch');

// A fake timer pair: `fire()` runs every live interval callback once, `run(ms)` advances a fake clock and runs the
// timeouts that fall due.
function fakeTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return { id, unref() {} }; },
    clearInterval: (h) => { if (h) intervals.delete(h.id); },
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, at: now + Math.max(0, ms) }); return { id, unref() {} }; },
    clearTimeout: (h) => { if (h) timeouts.delete(h.id); },
    fire() { for (const { fn } of [...intervals.values()]) fn(); },
    run(ms) {
      now += ms;
      for (const [id, t] of [...timeouts]) if (t.at <= now) { timeouts.delete(id); t.fn(); }
    },
    intervals, timeouts,
  };
}

// --- where the sentinels are -------------------------------------------------------------------------------------

test('sentinelsFor: STOP-ALL in the claude home first, then the project\'s own STOP under <dev>\\.claude-custom', () => {
  const home = path.join('C:', 'Users', 'someone', '.claude');
  const dev = path.join('C:', 'proj', 'dev');
  assert.deepStrictEqual(ks.sentinelsFor({ claudeHome: home, stateRoot: dev }), [
    path.join(home, 'STOP-ALL'),
    path.join(dev, '.claude-custom', 'STOP'),
  ]);
});

test('sentinelsFor: a folder that is no project has only the machine-wide sentinel; no home, none of its own', () => {
  const home = path.join('C:', 'h', '.claude');
  assert.deepStrictEqual(ks.sentinelsFor({ claudeHome: home, stateRoot: null }), [path.join(home, 'STOP-ALL')]);
  assert.deepStrictEqual(ks.sentinelsFor({ claudeHome: '', stateRoot: '' }), []);
  assert.deepStrictEqual(ks.sentinelsFor(), []);
});

test('scopeOf: which sentinel it is, from its name', () => {
  assert.strictEqual(ks.scopeOf(path.join('x', 'STOP-ALL')), 'all');
  assert.strictEqual(ks.scopeOf(path.join('x', '.claude-custom', 'STOP')), 'project');
  assert.strictEqual(ks.scopeOf(null), null);
});

// --- the watch ---------------------------------------------------------------------------------------------------

function setup(present = new Set(), opts = {}) {
  const t = fakeTimers();
  const trips = [];
  const w = ks.watch({
    sentinelPaths: ['A/STOP-ALL', 'B/STOP'],
    intervalMs: 1000,
    onTrip: (trip) => trips.push(trip),
    exists: (p) => present.has(p),
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
    ...opts,
  });
  return { t, trips, w, present };
}

test('watch: no sentinel, no trip, however many ticks', () => {
  const { t, trips } = setup();
  for (let i = 0; i < 5; i++) t.fire();
  assert.deepStrictEqual(trips, []);
});

test('watch: trips on the tick after a sentinel appears, and names it', () => {
  const { t, trips, present } = setup();
  t.fire();
  present.add('B/STOP');
  t.fire();
  assert.deepStrictEqual(trips, [{ sentinel: 'B/STOP', scope: 'project' }]);
});

test('watch: polls at the interval it was given (the 5 s promise rests on it)', () => {
  const { t } = setup();
  assert.strictEqual(t.intervals.size, 1);
  assert.strictEqual([...t.intervals.values()][0].ms, 1000);
});

test('watch: trips once while the file stays', () => {
  const { t, trips, present } = setup();
  present.add('A/STOP-ALL');
  for (let i = 0; i < 4; i++) t.fire();
  assert.strictEqual(trips.length, 1);
  assert.deepStrictEqual(trips[0], { sentinel: 'A/STOP-ALL', scope: 'all' });
});

test('watch: a second sentinel appearing while tripped does not trip again', () => {
  const { t, trips, present } = setup();
  present.add('B/STOP');
  t.fire();
  present.add('A/STOP-ALL');
  t.fire();
  present.delete('B/STOP');      // one of them still there: still tripped
  t.fire();
  assert.strictEqual(trips.length, 1);
});

test('watch: re-arms once every sentinel is gone, and trips again on the next appearance', () => {
  const { t, trips, present } = setup();
  present.add('A/STOP-ALL');
  t.fire();
  present.delete('A/STOP-ALL');
  t.fire();
  assert.strictEqual(trips.length, 1);
  present.add('A/STOP-ALL');
  t.fire();
  assert.strictEqual(trips.length, 2);
});

test('watch: STOP-ALL is named first when both are there at once', () => {
  const { t, trips, present } = setup();
  present.add('B/STOP');
  present.add('A/STOP-ALL');
  t.fire();
  assert.strictEqual(trips[0].sentinel, 'A/STOP-ALL');
});

test('watch: check() answers at once (the refuse-to-spawn question) and trips like a tick would', () => {
  const { t, trips, w, present } = setup();
  assert.strictEqual(w.check(), null);
  present.add('B/STOP');
  assert.strictEqual(w.check(), 'B/STOP');
  assert.strictEqual(trips.length, 1);
  t.fire();
  assert.strictEqual(w.check(), 'B/STOP');
  assert.strictEqual(trips.length, 1, 'still the one trip');
});

test('watch: an exists() that throws is read as absent and does not stop the watch', () => {
  let boom = true;
  const present = new Set(['A/STOP-ALL']);
  const { t, trips } = setup(present, { exists: (p) => { if (boom) throw new Error('EACCES'); return present.has(p); } });
  t.fire();
  assert.deepStrictEqual(trips, []);
  boom = false;
  t.fire();
  assert.strictEqual(trips.length, 1);
});

test('watch: a throwing onTrip does not break the watch or stop the trip being remembered', () => {
  const present = new Set();
  const { t, w } = setup(present, { onTrip: () => { throw new Error('listener'); } });
  present.add('A/STOP-ALL');
  assert.doesNotThrow(() => t.fire());
  assert.strictEqual(w.check(), 'A/STOP-ALL');
});

test('watch: stop() clears the interval', () => {
  const { t, w } = setup();
  w.stop();
  assert.strictEqual(t.intervals.size, 0);
});

test('watch: a bad interval is refused rather than turned into a busy loop', () => {
  for (const bad of [0, -1, NaN, null, '1000']) {
    assert.throws(() => setup(new Set(), { intervalMs: bad }), /intervalMs/);
  }
});

test('watch: no sentinel paths is a watch that never trips', () => {
  const t = fakeTimers();
  const trips = [];
  const w = ks.watch({ sentinelPaths: [], onTrip: (x) => trips.push(x), exists: () => true, setInterval: t.setInterval, clearInterval: t.clearInterval });
  t.fire();
  assert.strictEqual(w.check(), null);
  assert.deepStrictEqual(trips, []);
});

//// --- a refused host stays refused only while the file is there ---------------------------------------------------------

// Dexter F4 / Miguel Y1 (PR #210): the host the switch kept from starting must be able to start once the file is deleted,
// including one that is reattached or a dev tab that can't be closed.
function refusedHost() {
  const present = new Set(['H/STOP-ALL']);
  const t = fakeTimers();
  let term = null;
  const calls = [];
  const s = ks.createStopper({ term: () => term, stopPty: () => {}, killChildTree: () => {}, log: () => {}, notify: () => {} });
  const w = ks.watch({
    sentinelPaths: ['H/STOP-ALL'],
    exists: (p) => present.has(p),
    onTrip: ({ sentinel, scope }) => s.stop({ kind: term ? 'tripped' : 'refused', sentinel, scope }),
    onClear: () => { if (s.clearRefused()) calls.push('restart'); },
    setInterval: t.setInterval, clearInterval: t.clearInterval,
  });
  return { present, t, s, w, calls, setTerm: (x) => { term = x; } };
}

test('refused F4: a host refused at start is refused while the file stays, and can start once it is deleted', () => {
  const { present, t, s, w, calls } = refusedHost();
  w.check();                                                    // startSession's own check at boot
  assert.strictEqual(s.state().kind, 'refused');
  t.fire();
  assert.strictEqual(s.state().kind, 'refused', 'still there: still refused');
  assert.deepStrictEqual(calls, []);
  present.delete('H/STOP-ALL');
  t.fire();                                                     // the next poll sees it gone
  assert.strictEqual(s.state(), null, 'the refusal is cleared');
  assert.deepStrictEqual(calls, ['restart'], 'and the host is told to start its session, once');
  t.fire();
  assert.deepStrictEqual(calls, ['restart']);
});

test('refused F4: startSession\'s own check() clears it too (a window reattached before the next poll)', () => {
  const { present, s, w, calls } = refusedHost();
  w.check();
  present.delete('H/STOP-ALL');
  assert.strictEqual(w.check(), null);
  assert.strictEqual(s.state(), null);
  assert.deepStrictEqual(calls, ['restart']);
});

test('refused F4: the file coming back after a clear refuses (and re-trips) again', () => {
  const { present, s, w } = refusedHost();
  w.check();
  present.delete('H/STOP-ALL');
  w.check();
  present.add('H/STOP-ALL');
  w.check();
  assert.strictEqual(s.state().kind, 'refused');
});

test('refused F4: clearRefused() clears only a refusal; a trip or the night budget stays', () => {
  const pty = { pid: 7 };
  for (const info of [{ kind: 'tripped', sentinel: 'H/STOP-ALL' }, { kind: 'night-budget', startedAt: 0, budgetMs: 1 }]) {
    const { s } = stopper(pty);
    s.stop(info);
    assert.strictEqual(s.clearRefused(), false);
    assert.strictEqual(s.state().kind, info.kind);
  }
  const { s } = stopper(null);
  assert.strictEqual(s.clearRefused(), false, 'nothing stopped: nothing to clear');
  s.stop({ kind: 'refused', sentinel: 'x' });
  assert.strictEqual(s.clearRefused(), true);
  assert.strictEqual(s.state(), null);
  assert.strictEqual(s.stop({ kind: 'refused', sentinel: 'x' }), true, 'a cleared host can be refused again');
});

test('watch: onClear fires once when the sentinel that tripped it is gone, never for a sentinel that never tripped; a throwing onClear is contained', () => {
  const present = new Set();
  let cleared = 0;
  const { t, w } = setup(present, { onClear: () => { cleared++; throw new Error('listener'); } });
  t.fire();
  assert.strictEqual(cleared, 0);
  present.add('A/STOP-ALL');
  t.fire();
  assert.strictEqual(cleared, 0);
  present.delete('A/STOP-ALL');
  assert.doesNotThrow(() => t.fire());
  assert.strictEqual(cleared, 1);
  t.fire();
  assert.strictEqual(cleared, 1);
  assert.strictEqual(w.check(), null);
});

// --- the night budget --------------------------------------------------------------------------------------------

test('NIGHT_BUDGET_MS is 8 h 30 min, and it is under bedtime-state\'s 12 h cap (a budget at or over it could never fire)', () => {
  const { MAX_NIGHT_MS } = require('../host/bedtime-state');
  assert.strictEqual(ks.NIGHT_BUDGET_MS, (8 * 60 + 30) * 60_000);
  assert.ok(ks.NIGHT_BUDGET_MS < MAX_NIGHT_MS, 'the view drops a night older than MAX_NIGHT_MS, so a later deadline is never seen');
  assert.ok(ks.NIGHT_FRESH_AFTER_MS > ks.NIGHT_BUDGET_MS, 'a new night can only be fresh after the old budget is spent');
  assert.strictEqual(ks.NIGHT_FRESH_AFTER_MS, 16 * 3_600_000);
});

// The clock only moves through `go(ms)`, which also runs the poll once (the host's 1 s tick, as long as it is armed).
function budget(start = 1_000_000, opts = {}) {
  const t = fakeTimers(start);
  const fired = [];
  const saved = [];
  let on = null;
  const b = ks.createNightBudget({
    budgetMs: 1000,
    freshAfterMs: 4000,
    onExpire: (x) => fired.push(x),
    nightNow: () => on,
    now: t.now,
    save: (a) => saved.push(a),
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
    ...opts,
  });
  return { t, fired, saved, b, setNight: (p) => { on = p; b.update(p); }, go: (ms) => { t.run(ms); t.fire(); } };
}

test('budget: fires once at the deadline counted from the night\'s start, not before', () => {
  const { fired, setNight, go } = budget(1_000_000);
  setNight({ startedAt: 1_000_000 - 200 });     // the night began 200 ms before the host heard of it
  go(799);
  assert.deepStrictEqual(fired, []);
  go(1);
  assert.deepStrictEqual(fired, [{ startedAt: 999_800, deadline: 1_000_800 }]);
});

test('budget: does not fire again, whatever the night does after', () => {
  const { fired, setNight, go } = budget(0);
  setNight({ startedAt: 0 });
  go(1000);
  setNight({ startedAt: 0 });
  setNight({ startedAt: 5000 });
  go(10_000);
  assert.strictEqual(fired.length, 1);
});

test('budget: a payload for the same night changes nothing (every wake pushes one)', () => {
  const { t, fired, saved, setNight, go } = budget(0);
  setNight({ startedAt: 0, wakes: 0 });
  go(500);
  setNight({ startedAt: 0, wakes: 1 });
  assert.strictEqual(t.intervals.size, 1);
  assert.deepStrictEqual(saved, [0]);
  go(500);
  assert.strictEqual(fired.length, 1);
});

test('budget: a night that ended, with no new one started, is not killed at its deadline (nothing is running)', () => {
  const { fired, setNight, go } = budget(0);
  setNight({ startedAt: 0 });
  go(400);
  setNight(null);
  go(5000);
  assert.deepStrictEqual(fired, []);
});

// Dexter F1 (PR #210): the budget is keyed on the FIRST night start, which the agent can't reset. `ScheduleWakeup({ stop: true })`
// ends the night, the next bedtime wake starts a "new" one; the deadline stays the first night's.
test('budget F1: a stop followed by a new night does not move the kill (stop at 07:00, re-schedule, the kill still lands at 07:30)', () => {
  const H = 3_600_000;
  const { fired, setNight, go } = budget(23 * H, { budgetMs: 8.5 * H, freshAfterMs: 16 * H });   // 23:00
  setNight({ startedAt: 23 * H });
  go(8 * H);                                    // 07:00
  setNight(null);                               // ScheduleWakeup({ stop: true })
  go(5000);
  setNight({ startedAt: 31 * H + 5000 });       // 07:00:05, a "new" night
  assert.deepStrictEqual(fired, []);
  go(0.5 * H - 5000);                           // 07:30
  assert.deepStrictEqual(fired, [{ startedAt: 23 * H, deadline: 31.5 * H }]);
});

test('budget F1: a new night after the deadline already passed is killed at once, not given a fresh 8 h 30 min', () => {
  const { fired, setNight, go } = budget(0);
  setNight({ startedAt: 0 });
  go(300);
  setNight(null);
  go(2000);                                     // 2300: past the 1000 deadline while no night was on
  setNight({ startedAt: 2300 });
  assert.deepStrictEqual(fired, [{ startedAt: 0, deadline: 1000 }]);
});

test('budget F1: a night freshAfterMs after the anchor gets its own deadline, and the new anchor is saved', () => {
  const b = budget(0);
  b.setNight({ startedAt: 0 });
  b.setNight(null);
  b.go(4000);                                   // the anchor is now 4000 ms old = freshAfterMs
  assert.deepStrictEqual(b.fired, [], 'nobody was running a night, so nothing was stopped');
  b.setNight({ startedAt: 4000 });
  assert.deepStrictEqual(b.saved, [0, 4000]);
  b.go(999);
  assert.deepStrictEqual(b.fired, []);
  b.go(1);
  assert.deepStrictEqual(b.fired, [{ startedAt: 4000, deadline: 5000 }]);
});

test('budget F1: one ms short of freshAfterMs the old anchor still stands', () => {
  const b = budget(0);
  b.setNight({ startedAt: 0 });
  b.setNight(null);
  b.go(3999);
  b.setNight({ startedAt: 3999 });
  assert.deepStrictEqual(b.saved, [0]);
  assert.deepStrictEqual(b.fired, [{ startedAt: 0, deadline: 1000 }]);
});

test('budget F1: a host restart mid-night keeps the deadline (the anchor is loaded, not re-learned from the new night)', () => {
  const first = budget(0);
  first.setNight({ startedAt: 0 });
  assert.deepStrictEqual(first.saved, [0]);
  // the host is replaced 600 ms in; the loop resumes there and starts a "new" night at its first wake
  const second = budget(600, { load: () => first.saved[first.saved.length - 1] });
  second.setNight({ startedAt: 600 });
  assert.deepStrictEqual(second.saved, [], 'the old anchor stands, nothing new is written');
  second.go(399);
  assert.deepStrictEqual(second.fired, []);
  second.go(1);
  assert.deepStrictEqual(second.fired, [{ startedAt: 0, deadline: 1000 }]);
});

test('budget F1: a loaded anchor is watched from the start, so a night that appears after the deadline is killed on the next tick', () => {
  const b = budget(2000, { load: () => 0 });
  assert.strictEqual(b.t.intervals.size, 1);
  b.go(1000);
  assert.deepStrictEqual(b.fired, [], 'no night is on: nothing to stop');
  b.setNight({ startedAt: 3000 });
  assert.strictEqual(b.fired.length, 1);
});

test('budget F1: a loaded anchor that is stale, in the future, or junk is ignored', () => {
  for (const bad of [0, -5000, 10_000, NaN, null, undefined, '0', {}]) {
    const b = budget(5000, { load: () => bad });
    if (bad === 0) { assert.strictEqual(b.t.intervals.size, 0, 'older than freshAfterMs'); continue; }
    assert.strictEqual(b.t.intervals.size, 0, String(bad));
    b.setNight({ startedAt: 5000 });
    assert.deepStrictEqual(b.saved, [5000], String(bad));
  }
  assert.doesNotThrow(() => budget(0, { load: () => { throw new Error('unreadable'); } }));
  assert.doesNotThrow(() => budget(0, { save: () => { throw new Error('read-only'); } }).setNight({ startedAt: 0 }));
});

// Miguel Y3 (PR #210): one long setTimeout may not wake on time after the lid was shut. The poll compares the wall clock instead.
test('budget Y3: sleeping past the deadline trips on the first tick after waking (an injected clock jump)', () => {
  const { t, fired, setNight } = budget(0);
  setNight({ startedAt: 0 });
  t.run(300); t.fire();
  assert.deepStrictEqual(fired, []);
  t.run(3000);                                  // the machine slept: one jump, no ticks in between
  assert.deepStrictEqual(fired, []);
  t.fire();                                     // the first tick after waking
  assert.deepStrictEqual(fired, [{ startedAt: 0, deadline: 1000 }]);
});

test('budget Y3: it polls with the interval, not a timeout; and stops polling once it has fired, and on stop()', () => {
  const a = budget(0);
  a.setNight({ startedAt: 0 });
  assert.strictEqual(a.t.timeouts.size, 0);
  assert.strictEqual(a.t.intervals.size, 1);
  a.go(1000);
  assert.strictEqual(a.t.intervals.size, 0);
  const again = budget(0);
  again.setNight({ startedAt: 0 });
  again.b.stop();
  assert.strictEqual(again.t.intervals.size, 0);
  again.go(5000);
  assert.deepStrictEqual(again.fired, []);
});

test('budget: junk payloads change nothing; a non-number start is no night', () => {
  const { t, fired, saved, b, go } = budget(0);
  for (const junk of [undefined, 42, 'x', {}, { startedAt: null }, { startedAt: '0' }, { startedAt: NaN }]) b.update(junk);
  go(10_000);
  assert.deepStrictEqual(fired, []);
  assert.deepStrictEqual(saved, []);
  assert.strictEqual(t.intervals.size, 0);
});

test('budget: a throwing onExpire is contained', () => {
  const { setNight, go } = budget(0, { onExpire: () => { throw new Error('x'); } });
  setNight({ startedAt: 0 });
  assert.doesNotThrow(() => go(1000));
});

test('budget: a bad budget, or a fresh window not longer than it, is refused', () => {
  for (const bad of [0, -5, NaN, '1']) assert.throws(() => budget(0, { budgetMs: bad }), /budgetMs/);
  assert.throws(() => budget(0, { freshAfterMs: 1000 }), /freshAfterMs/);
  assert.throws(() => budget(0, { freshAfterMs: NaN }), /freshAfterMs/);
});

// --- the anchor on disk --------------------------------------------------------------------------------------------

test('loadAnchor / saveAnchor: the anchor survives a round trip through the injected file ops; a bad file is no anchor', () => {
  const files = new Map();
  const io = {
    read: (f) => { if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(f); },
    write: (f, data) => files.set(f, data),
    mkdir: () => {},
  };
  const f = path.join('P', '.claude-custom', 'night-anchor.json');
  assert.strictEqual(ks.loadAnchor(f, io), null);
  ks.saveAnchor(f, 12345, io);
  assert.strictEqual(ks.loadAnchor(f, io), 12345);
  for (const bad of ['', 'not json', '{}', '{"anchor":"1"}', '{"anchor":null}', '[1]', 'null']) {
    files.set(f, bad);
    assert.strictEqual(ks.loadAnchor(f, io), null, bad);
  }
  assert.strictEqual(ks.loadAnchor('', io), null);
  assert.throws(() => ks.saveAnchor('', 1, io));
});

// --- what the host says ------------------------------------------------------------------------------------------

test('describeStop: names the sentinel and how to undo it, for a trip, a refusal and the night budget', () => {
  const trip = ks.describeStop({ kind: 'tripped', sentinel: 'C:/h/.claude/STOP-ALL' });
  assert.match(trip, /C:\/h\/\.claude\/STOP-ALL/);
  assert.match(trip, /delete/i);
  assert.match(trip, /close and reopen/i, 'a stopped session does not restart itself');
  const refused = ks.describeStop({ kind: 'refused', sentinel: 'C:/p/dev/.claude-custom/STOP' });
  assert.match(refused, /C:\/p\/dev\/\.claude-custom\/STOP/);
  assert.match(refused, /didn't start/);
  assert.match(refused, /starts by itself/);
  assert.doesNotMatch(refused, /close and reopen/i);
  const night = ks.describeStop({ kind: 'night-budget', startedAt: Date.UTC(2026, 9, 25, 1, 0), budgetMs: ks.NIGHT_BUDGET_MS });
  assert.match(night, /8 h 30 min/);
  assert.strictEqual(ks.describeStop(null), '');
});

// --- a refused host with no window goes ---------------------------------------------------------------------------

test('createLinger: a stopped host with no window goes after the grace; a window, or not being stopped, resets it', () => {
  let now = 0;
  const l = ks.createLinger({ graceMs: 100, now: () => now });
  assert.strictEqual(l.update(false, 0), false);
  assert.strictEqual(l.update(true, 1), false);
  assert.strictEqual(l.update(true, 0), false);
  now = 99;
  assert.strictEqual(l.update(true, 0), false);
  now = 100;
  assert.strictEqual(l.update(true, 0), true);
  now = 150;
  assert.strictEqual(l.update(true, 1), false, 'a window attached: the clock starts over');
  now = 200;
  assert.strictEqual(l.update(true, 0), false);
  now = 300;
  assert.strictEqual(l.update(true, 0), true);
});

// --- the STOP ALL button's write ----------------------------------------------------------------------------------

test('requestStopAll: writes the sentinel only after the confirm says yes, with a line saying who and when', async () => {
  const writes = [];
  const dirs = [];
  const out = await ks.requestStopAll({
    file: path.join('H', '.claude', 'STOP-ALL'),
    confirm: async () => true,
    write: (f, data) => writes.push([f, data]),
    mkdir: (d) => dirs.push(d),
    now: () => Date.UTC(2026, 9, 25, 3, 4, 5),
  });
  assert.strictEqual(out.outcome, 'written');
  assert.deepStrictEqual(dirs, [path.join('H', '.claude')]);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][0], path.join('H', '.claude', 'STOP-ALL'));
  assert.match(writes[0][1], /2026-10-25T03:04:05/);
  assert.match(writes[0][1], /STOP ALL button/);
});

test('requestStopAll: a cancel writes nothing', async () => {
  const writes = [];
  const out = await ks.requestStopAll({ file: 'f', confirm: async () => false, write: (...a) => writes.push(a), mkdir: () => {} });
  assert.strictEqual(out.outcome, 'cancelled');
  assert.deepStrictEqual(writes, []);
});

test('requestStopAll: a failed write is reported, never reported as done', async () => {
  const out = await ks.requestStopAll({ file: 'f', confirm: async () => true, write: () => { throw new Error('EPERM'); }, mkdir: () => {} });
  assert.strictEqual(out.outcome, 'failed');
  assert.match(out.error, /EPERM/);
});

test('requestStopAll: a confirm that throws is a cancel, not a write', async () => {
  const writes = [];
  const out = await ks.requestStopAll({ file: 'f', confirm: async () => { throw new Error('no window'); }, write: (...a) => writes.push(a), mkdir: () => {} });
  assert.strictEqual(out.outcome, 'cancelled');
  assert.deepStrictEqual(writes, []);
});

test('requestStopAll: no file to write is a failure up front', async () => {
  const out = await ks.requestStopAll({ file: '', confirm: async () => true, write: () => {}, mkdir: () => {} });
  assert.strictEqual(out.outcome, 'failed');
});

// --- the host's stop: says why, then kills the tracked pty's tree, once ---------------------------------------------

function stopper(term, opts = {}) {
  const calls = [];
  const s = ks.createStopper({
    term: () => term,
    stopPty: (t, deps) => calls.push(['stopPty', t, deps.killChildTree]),
    killChildTree: 'the-kill-tree-fn',
    log: (line) => calls.push(['log', line]),
    notify: (state) => calls.push(['notify', state]),
    now: () => 1234,
    ...opts,
  });
  return { s, calls };
}

test('createStopper: a trip with a live pty says why first, then stops exactly that pty through kill-tree', () => {
  const pty = { pid: 4242 };
  const { s, calls } = stopper(pty);
  assert.strictEqual(s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL', scope: 'all' }), true);
  assert.deepStrictEqual(calls.map(c => c[0]), ['log', 'notify', 'stopPty']);
  assert.match(calls[0][1], /H\/STOP-ALL/);
  assert.strictEqual(calls[2][1], pty, 'the tracked pty itself, not a pid looked up by name');
  assert.strictEqual(calls[2][2], 'the-kill-tree-fn');
  assert.deepStrictEqual(calls[1][1], { kind: 'tripped', sentinel: 'H/STOP-ALL', scope: 'all', at: 1234, kill: null, text: calls[0][1].replace(/^\[kill-switch\] /, '') });
  assert.deepStrictEqual(s.state(), calls[1][1]);
});

test('createStopper: with no pty (refused at start) it says why and kills nothing', () => {
  const { s, calls } = stopper(null);
  s.stop({ kind: 'refused', sentinel: 'P/.claude-custom/STOP', scope: 'project' });
  assert.deepStrictEqual(calls.map(c => c[0]), ['log', 'notify']);
});

test('createStopper: once per host; a second stop (the budget after a trip) does nothing', () => {
  const { s, calls } = stopper({ pid: 1 });
  s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL', scope: 'all' });
  assert.strictEqual(s.stop({ kind: 'night-budget', startedAt: 0, budgetMs: 1 }), false);
  assert.strictEqual(calls.filter(c => c[0] === 'stopPty').length, 1);
  assert.strictEqual(s.state().kind, 'tripped');
});

// --- F5: the kill outcome is read, logged for what it was, and retried when it did not land ---------------------------------

// A pty whose kill answers from a script, the way host/kill-tree.js's killChildTree would: one answer per attempt.
function scriptedKill(answers) {
  const calls = [];
  const logs = [];
  const notes = [];
  let last = null;
  let i = 0;
  const pty = { pid: 55 };
  const s = ks.createStopper({
    term: () => pty,
    stopPty: () => { calls.push('stopPty'); last = answers[Math.min(i++, answers.length - 1)]; },
    killChildTree: () => {},
    outcomeOf: () => last,
    log: (l) => logs.push(l),
    notify: (st) => notes.push(st),
    now: () => 1,
    ...{},
  });
  return { s, calls, logs, notes };
}

test('F5: a proven kill is logged with its real outcome; an unproven one says so and is retried by retry()', () => {
  const { s, calls, logs } = scriptedKill(['unknown', 'unknown', 'killed']);
  s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL', scope: 'all' });
  assert.strictEqual(calls.length, 1);
  assert.match(logs.join('\n'), /unknown/);
  assert.doesNotMatch(logs.slice(1).join('\n'), /was stopped/, 'the outcome line does not claim a stop that was not proven');
  assert.strictEqual(s.state().kill, 'unknown');
  assert.strictEqual(s.retry(), true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(s.retry(), true);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(s.state().kill, 'killed');
  assert.match(logs[logs.length - 1], /killed/);
  assert.strictEqual(s.retry(), false, 'proven: nothing more to do');
  assert.strictEqual(calls.length, 3);
});

test('F5: retry() gives up after maxRetries, and does nothing for a kill that landed or a host with no pty', () => {
  const unlanded = scriptedKill(['failed']);
  unlanded.s.stop({ kind: 'tripped', sentinel: 'x' });
  let tries = 0;
  while (unlanded.s.retry()) tries++;
  assert.strictEqual(tries, 5);
  const landed = scriptedKill(['gone']);
  landed.s.stop({ kind: 'tripped', sentinel: 'x' });
  assert.strictEqual(landed.s.retry(), false);
  const refused = ks.createStopper({ term: () => null, stopPty: () => assert.fail('no pty'), killChildTree: () => {}, outcomeOf: () => 'unknown' });
  refused.stop({ kind: 'refused', sentinel: 'x' });
  assert.strictEqual(refused.retry(), false);
});

test('F5: the latch does not block a later sentinel or the budget from trying the kill again', () => {
  const { s, calls } = scriptedKill(['unknown', 'killed']);
  assert.strictEqual(s.stop({ kind: 'night-budget', startedAt: 0, budgetMs: 1 }), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL', scope: 'all' }), false, 'still one stop per host');
  assert.strictEqual(calls.length, 2, 'but the second ask tried the kill again');
  assert.strictEqual(s.state().kind, 'night-budget', 'and did not rewrite why it began');
  assert.strictEqual(s.state().kill, 'killed');
  assert.strictEqual(s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL' }), false);
  assert.strictEqual(calls.length, 2, 'a landed kill is not repeated');
});

test('F5: an unproven kill tells the tab, not only host.log', () => {
  const { s, notes } = scriptedKill(['unknown', 'killed']);
  s.stop({ kind: 'tripped', sentinel: 'H/STOP-ALL' });
  assert.strictEqual(notes.length, 2);
  assert.match(notes[1].text, /not confirmed/i);
  s.retry();
  assert.strictEqual(notes.length, 2, 'a landed retry adds no alarm');
});

test('createStopper: a throwing log or notify still kills the pty', () => {
  const pty = { pid: 9 };
  const kills = [];
  const s = ks.createStopper({
    term: () => pty, stopPty: (t) => kills.push(t), killChildTree: () => {},
    log: () => { throw new Error('log'); }, notify: () => { throw new Error('notify'); },
  });
  assert.doesNotThrow(() => s.stop({ kind: 'tripped', sentinel: 'x/STOP' }));
  assert.deepStrictEqual(kills, [pty]);
});

test('createStopper: nothing stopped yet is a null state', () => {
  assert.strictEqual(stopper(null).s.state(), null);
});

test('stopAllHome: ~/.claude from the home folder, whatever CLAUDE_CONFIG_DIR says; the probe seam stands in for it', () => {
  const home = path.join('C:', 'Users', 'someone');
  assert.strictEqual(ks.stopAllHome({ home }), path.join(home, '.claude'));
  assert.strictEqual(ks.stopAllHome({ seam: path.join('S', 'claude'), home }), path.join('S', 'claude'));
  assert.strictEqual(ks.stopAllHome({ seam: '', home }), path.join(home, '.claude'));
  assert.strictEqual(ks.stopAllHome({}), null);
});
// --- main's whole STOP ALL path, for real (Miguel Y2) --------------------------------------------------------------------------

const fs = require('fs');
const { writeFileAtomic } = require('../host/atomic-write');
const { writeIdentity } = require('../host/host-identity');
const { identitiesIn } = require('../host/background-hosts');

const { tmpDir } = require('./tmp-dir');

test('runStopAll: the question gets the real path, a yes writes ~/.claude/STOP-ALL through the atomic write, and nothing else is left behind', async () => {
  const home = tmpDir();
  try {
    const asked = [];
    const r = await ks.runStopAll({
      home,
      confirm: async (file) => { asked.push(file); return true; },
      write: (f, data) => writeFileAtomic(f, data),
      now: () => Date.UTC(2026, 9, 26, 1, 2, 3),
    });
    const file = path.join(home, '.claude', 'STOP-ALL');
    assert.deepStrictEqual(asked, [file], 'asked once, with the path that will be written');
    assert.strictEqual(r.outcome, 'written');
    assert.strictEqual(r.file, file);
    assert.match(fs.readFileSync(file, 'utf8'), /2026-10-26T01:02:03.*STOP ALL button/);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude')), ['STOP-ALL'], 'no temp file left beside it');
    assert.strictEqual(ks.sentinelsFor({ claudeHome: path.join(home, '.claude') })[0], file, 'the very path every host polls');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runStopAll: a no writes nothing and creates nothing; the probe seam stands in for the home', async () => {
  const home = tmpDir();
  const seam = tmpDir();
  try {
    const no = await ks.runStopAll({ home, confirm: async () => false, write: (f, d) => writeFileAtomic(f, d) });
    assert.strictEqual(no.outcome, 'cancelled');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude')), false);
    const yes = await ks.runStopAll({ home, seam, confirm: async () => true, write: (f, d) => writeFileAtomic(f, d) });
    assert.strictEqual(yes.file, path.join(seam, 'STOP-ALL'));
    assert.strictEqual(fs.existsSync(path.join(seam, 'STOP-ALL')), true);
    assert.strictEqual(fs.existsSync(path.join(home, '.claude')), false, 'the real home is never touched while a seam is set');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(seam, { recursive: true, force: true }); }
});

test('runStopAll: no home and no seam fails up front, without asking', async () => {
  const r = await ks.runStopAll({ confirm: async () => assert.fail('must not ask'), write: () => assert.fail('must not write') });
  assert.strictEqual(r.outcome, 'failed');
});

test('runStopAll: the unstoppable count rides on a written result only; a throwing or odd counter is zero', async () => {
  const base = { home: 'H', mkdir: () => {}, write: () => {} };
  assert.strictEqual((await ks.runStopAll({ ...base, confirm: async () => true, countUnstoppable: () => 3 })).unstoppable, 3);
  assert.strictEqual((await ks.runStopAll({ ...base, confirm: async () => false, countUnstoppable: () => 3 })).unstoppable, 0, 'cancelled: nothing was written');
  assert.strictEqual((await ks.runStopAll({ ...base, confirm: async () => true, write: () => { throw new Error('EPERM'); }, countUnstoppable: () => 3 })).unstoppable, 0);
  for (const odd of [() => { throw new Error('x'); }, () => NaN, () => -2, () => 1.5, () => 'many', () => null]) {
    assert.strictEqual((await ks.runStopAll({ ...base, confirm: async () => true, countUnstoppable: odd })).unstoppable, 0);
  }
});

// Dexter F3 (PR #210): a host from before this build doesn't watch the file. Its identity file has no killSwitch key.
test('F3: a host publishes killSwitch in its identity file, so STOP ALL can tell the old ones from the new', () => {
  const dir = tmpDir();
  try {
    writeIdentity({ dir, port: 7711, cwd: 'C:/proj', pid: 4242 });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hosts', '7711.json'), 'utf8')).killSwitch, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F3: countUnstoppable counts live hosts without killSwitch, in every install, and not dead ones, new ones or unreadable ones', () => {
  const a = tmpDir();
  const b = tmpDir();
  try {
    const put = (install, port, doc) => {
      fs.mkdirSync(path.join(install, '.harness', 'hosts'), { recursive: true });
      fs.writeFileSync(path.join(install, '.harness', 'hosts', `${port}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc));
    };
    writeIdentity({ dir: path.join(a, '.harness'), port: 7001, cwd: 'C:/p', pid: 101 });                // new build, alive
    put(a, 7002, { port: 7002, cwd: 'C:/p', pid: 102, startedAt: 1 });                                   // old build, alive
    put(a, 7003, { port: 7003, cwd: 'C:/p', pid: 103, startedAt: 1, side: true });                       // old side host, alive
    put(a, 7004, { port: 7004, cwd: 'C:/p', pid: 104, startedAt: 1 });                                   // old build, dead
    put(b, 7005, { port: 7005, cwd: 'C:/q', pid: 105, startedAt: 1 });                                   // a sibling worktree's old host
    put(b, 7006, 'not json');
    put(b, 7007, { port: 7007, cwd: 'C:/q', pid: 'x' });
    const alive = new Set([101, 102, 103, 105]);
    const n = ks.countUnstoppable({ installs: [a, b], identitiesIn, isAlive: (pid) => alive.has(pid) });
    assert.strictEqual(n, 3);
    assert.strictEqual(ks.countUnstoppable({ installs: [a], identitiesIn, isAlive: () => false }), 0);
    assert.strictEqual(ks.countUnstoppable({ installs: [path.join(a, 'missing'), a], identitiesIn: (i) => { if (i !== a) throw new Error('unreadable'); return identitiesIn(i); }, isAlive: (pid) => alive.has(pid) }), 2, 'an install that cannot be listed is skipped');
    assert.strictEqual(ks.countUnstoppable(), 0);
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('F3: describeUnstoppable is a plain count, singular and plural, and empty for none', () => {
  assert.match(ks.describeUnstoppable(1), /^1 running session started on an older build/);
  assert.match(ks.describeUnstoppable(4), /^4 running sessions started on an older build/);
  assert.strictEqual(ks.describeUnstoppable(0), '');
  assert.strictEqual(ks.describeUnstoppable(NaN), '');
});

