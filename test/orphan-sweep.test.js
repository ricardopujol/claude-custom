'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MARK_VAR, makeMark, parseMark, markFromEnv, markEnv } = require('../host/probe-mark');
const { writeIdentity, readIdentity } = require('../host/host-identity');
const { readIdentities, readProcessTable, judge, sweep, makeKill, START_TOLERANCE } = require('../verify/lib/orphan-sweep');
const { main } = require('../verify/sweep-orphans');

const LAUNCHER = 4000;
const MARK = makeMark(LAUNCHER, 'abcdef012345');
const T0 = 133000000000000000n;                       // a host's start, FILETIME
const entry = (o = {}) => ({ file: 'f', port: 7000, pid: 100, start: String(T0), mark: MARK, launcherPid: LAUNCHER, ...o });
// a table where the host (100) has parent 50 and the launcher is 4000; both rows are added by the case
const tableOf = (rows) => new Map(rows.map(([pid, ppid, created]) => [pid, { ppid, created: BigInt(created) }]));
const HOST_ROW = [100, 50, T0];
const base = (extra = []) => tableOf([HOST_ROW, ...extra]);

// ---- the mark ------------------------------------------------------------------------------------------------------------

test('makeMark / parseMark: round trip, and only the exact shape is a mark', () => {
  assert.deepStrictEqual(parseMark(MARK), { pid: LAUNCHER, rand: 'abcdef012345' });
  assert.match(makeMark(), /^pm1-\d+-[0-9a-f]{12}$/);
  for (const bad of [undefined, null, 42, '', 'pm1-0-abcdef012345', 'pm1--1-abcdef012345', 'pm1-12-ABCDEF012345', 'pm1-12-abcdef01234', 'pm1-12-abcdef0123456',
    'pm2-12-abcdef012345', ' pm1-12-abcdef012345', 'pm1-12-abcdef012345\n', 'pm1-99999999999-abcdef012345', 'pm1-1e3-abcdef012345']) {
    assert.strictEqual(parseMark(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => makeMark(0), /valid mark/);
});

test('markFromEnv: the valid value, else null; markEnv sets a fresh one every time', () => {
  assert.strictEqual(markFromEnv({ [MARK_VAR]: MARK }), MARK);
  assert.strictEqual(markFromEnv({ [MARK_VAR]: 'junk' }), null);
  assert.strictEqual(markFromEnv({}), null);
  assert.strictEqual(markFromEnv(null), null);
  const env = { [MARK_VAR]: MARK };
  const m = markEnv(env, 77);
  assert.notStrictEqual(m, MARK);
  assert.strictEqual(env[MARK_VAR], m);
  assert.strictEqual(parseMark(m).pid, 77);
  assert.ok(!MARK_VAR.startsWith('CLAUDE_CUSTOM_'), 'not stripped with a tab\'s CLAUDE_CUSTOM_* variables');
});

// ---- the identity file -------------------------------------------------------------------------------------------------------

const { tmpDir: makeTmp } = require('./tmp-dir');
function tmpDir() { return makeTmp('cc-sweep-test-'); }
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('writeIdentity: a valid probeMark is written; none, or a malformed one, writes no key; readIdentity does not expose it', () => {
  const dir = tmpDir();
  try {
    writeIdentity({ dir, port: 7001, cwd: 'C:/x', probeMark: MARK, processStartedAt: String(T0) });
    writeIdentity({ dir, port: 7002, cwd: 'C:/x' });
    writeIdentity({ dir, port: 7003, cwd: 'C:/x', probeMark: 'pm1-1-ZZZ' });
    const doc = (p) => JSON.parse(fs.readFileSync(path.join(dir, 'hosts', `${p}.json`), 'utf8'));
    assert.strictEqual(doc(7001).probeMark, MARK);
    assert.ok(!('probeMark' in doc(7002)));
    assert.ok(!('probeMark' in doc(7003)));
    assert.deepStrictEqual(Object.keys(readIdentity({ dir, port: 7001 })).sort(), ['cwd', 'pid', 'port', 'startedAt'], 'the app\'s reader is unchanged');
  } finally { rm(dir); }
});

test('readIdentities: marked ones are returned, unmarked and unreadable are only counted', () => {
  const dir = tmpDir();
  try {
    writeIdentity({ dir, port: 7001, cwd: 'C:/x', probeMark: MARK, processStartedAt: String(T0) });
    writeIdentity({ dir, port: 7002, cwd: 'C:/x', processStartedAt: String(T0) });
    fs.writeFileSync(path.join(dir, 'hosts', '7003.json'), '{ half');
    fs.writeFileSync(path.join(dir, 'hosts', '7004.token'), 'secret');
    fs.writeFileSync(path.join(dir, 'hosts', 'notes.json'), '{}');
    const r = readIdentities(dir);
    assert.strictEqual(r.marked.length, 1);
    assert.strictEqual(r.marked[0].port, 7001);
    assert.strictEqual(r.marked[0].start, String(T0));
    assert.strictEqual(r.marked[0].launcherPid, LAUNCHER);
    assert.strictEqual(r.unmarked, 1);
    assert.strictEqual(r.unreadable, 1);
    assert.deepStrictEqual(readIdentities(path.join(dir, 'nowhere')), { marked: [], unmarked: 0, unreadable: 0 });
  } finally { rm(dir); }
});

// ---- the verdict ---------------------------------------------------------------------------------------------------------------

// A host is stopped only on an answer of exactly 0 windows (PR #232 Dexter 1), so the tests about the OTHER proofs say "nobody attached".
const NO_WINDOWS = { get: () => 0 };
const j = (e, t, o = {}) => judge(e, t, { windows: NO_WINDOWS, ...o });

test('judge: parent and launcher both gone, host proven, nobody attached: stop', () => {
  assert.strictEqual(j(entry(), base()).action, 'stop');
});

test('judge: a parent still running keeps the host; so does a launcher still running', () => {
  assert.match(j(entry(), base([[50, 1, T0 - 1000n]])).why, /parent 50 is still running/);
  assert.match(j(entry(), base([[LAUNCHER, 1, T0 - 1000n]])).why, /probe 4000 is still running/);
  assert.strictEqual(j(entry(), base([[50, 1, T0 - 1n], [LAUNCHER, 1, T0 - 1n]])).action, 'leave');
});

test('judge: a parent or launcher pid reused AFTER the host started is not alive (it cannot be the original)', () => {
  assert.strictEqual(j(entry(), base([[50, 1, T0 + 1n], [LAUNCHER, 1, T0 + 5000000n]])).action, 'stop');
  assert.strictEqual(j(entry(), base([[50, 1, T0], [LAUNCHER, 1, T0 + 5000000n]])).action, 'leave', 'started at the same instant: could be the original, doubt keeps it');
});

test('judge: the host pid must be the process the file names: absent, or another start time, is left alone', () => {
  assert.match(j(entry(), tableOf([])).why, /not running/);
  assert.match(j(entry(), tableOf([[100, 50, T0 + 30000n]])).why, /another process/);
  assert.match(j(entry(), tableOf([[100, 50, T0 - 30000n]])).why, /another process/);
  assert.strictEqual(j(entry(), tableOf([[100, 50, T0 + 20000n]])).action, 'stop', 'inside the 2 ms the table\'s precision allows');
});

test('judge: no start time, no pid, or the sweep\'s own pid: left alone', () => {
  assert.match(j(entry({ start: null }), base()).why, /never published its start time/);
  assert.match(j(entry({ pid: null }), base()).why, /no usable pid/);
  assert.match(j(entry(), base(), { self: [100] }).why, /own process/);
});

test('judge: a parent pid of 0 (no parent) counts as gone, even with a pid-0 row in the table', () => {
  assert.strictEqual(j(entry(), tableOf([[100, 0, T0]])).action, 'stop');
  // The System Idle row is pid 0 and older than everything: without the `pid > 0` guard it would read as a living parent (PR #232 Miguel G1).
  assert.strictEqual(j(entry(), tableOf([[100, 0, T0], [0, 0, T0 - 1n]])).action, 'stop');
});

test('judge: a window attached keeps the host, however dead its parent and probe are (a probe re-run on its port, a person\'s Open)', () => {
  const one = judge(entry(), base(), { windows: new Map([[100, 1]]) });
  assert.strictEqual(one.action, 'leave');
  assert.match(one.why, /1 window is attached/);
  assert.match(judge(entry(), base(), { windows: new Map([[100, 3]]) }).why, /3 windows are attached/);
  assert.notStrictEqual(one.unproven, true, 'a host in use is not "unproven"');
});

test('judge: a window count that is missing or not a whole number keeps the host and marks it unproven; only exactly 0 stops', () => {
  for (const windows of [null, undefined, new Map(), new Map([[100, null]]), new Map([[100, -1]]), new Map([[100, '0']]), new Map([[100, 0.5]]), new Map([[100, NaN]])]) {
    const v = judge(entry(), base(), { windows });
    assert.strictEqual(v.action, 'leave', String(windows && [...windows]));
    assert.strictEqual(v.unproven, true);
    assert.match(v.why, /could not be asked whether a window is attached/);
  }
  assert.strictEqual(judge(entry(), base(), { windows: new Map([[100, 0]]) }).action, 'stop');
});

test('judge: "unproven" is only for a host that is RUNNING: a stale file with no start time is just stale', () => {
  assert.strictEqual(j(entry({ start: null }), base()).unproven, true);
  assert.strictEqual(j(entry({ start: null }), tableOf([])).unproven, false);
  assert.notStrictEqual(j(entry(), tableOf([])).unproven, true);
});

// ---- the sweep ---------------------------------------------------------------------------------------------------------------

function fixture(rows) {
  const dir = tmpDir();
  for (const [port, mark, pid, start] of rows) writeIdentity({ dir, port, cwd: 'C:/x', pid, processStartedAt: start, probeMark: mark });
  return dir;
}
const zeroCounts = async (targets) => new Map(targets.map(t => [t.pid, 0]));

test('sweep: stops exactly the marked orphan, by pid with its recorded start; leaves unmarked, live-owner, reused, unproven and in-use alike', async () => {
  const live = makeMark(4001, '111111111111');
  const dir = fixture([
    [7001, MARK, 101, String(T0)],          // orphan
    [7002, undefined, 102, String(T0)],     // unmarked: a person's window, parent dead too
    [7003, live, 103, String(T0)],          // its launcher 4001 is running
    [7004, MARK, 104, String(T0)],          // pid reused (another start)
    [7005, MARK, 105, undefined],           // never published its start
    [7006, MARK, 106, String(T0)],          // an orphan a window has since attached to
  ]);
  try {
    const table = tableOf([[101, 50, T0], [102, 50, T0], [103, 50, T0], [104, 50, T0 + 99999999n], [105, 50, T0], [106, 50, T0], [4001, 1, T0 - 10n]]);
    const killed = [];
    const asked = [];
    const windowCountsFn = async (targets) => { asked.push(targets); return new Map(targets.map(t => [t.pid, t.pid === 106 ? 1 : 0])); };
    const kill = (...a) => { killed.push(a); return 'killed'; };
    const dry = await sweep({ dir, table, dryRun: true, kill, self: [], windowCountsFn });
    assert.deepStrictEqual(dry.wouldStop.map(x => x.pid), [101]);
    assert.deepStrictEqual(killed, [], 'a dry run kills nothing');
    assert.deepStrictEqual(asked[0], [{ pid: 101, port: 7001 }, { pid: 106, port: 7006 }], 'the window query is asked only for hosts that passed every other proof');
    const r = await sweep({ dir, table, dryRun: false, kill, self: [], windowCountsFn });
    assert.deepStrictEqual(killed, [[101, String(T0)]], 'one kill, with the recorded start for the proof');
    assert.deepStrictEqual(r.stopped.map(x => x.pid), [101]);
    assert.strictEqual(r.unmarked, 1);
    assert.deepStrictEqual(r.left.map(x => x.pid).sort(), [103, 104, 105, 106]);
    assert.match(r.left.find(x => x.pid === 106).why, /window is attached/);
    assert.deepStrictEqual(r.unproven.map(x => x.pid), [105], 'only the running host with no start time is in doubt');
  } finally { rm(dir); }
});

test('sweep: the default is a DRY RUN: with no dryRun given, a marked dead-parent orphan is reported and never killed', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    const killed = [];
    const r = await sweep({ dir, table: tableOf([[101, 50, T0]]), kill: (...a) => { killed.push(a); return 'killed'; }, self: [], windowCountsFn: zeroCounts });
    assert.deepStrictEqual(r.wouldStop.map(x => x.pid), [101]);
    assert.deepStrictEqual(killed, []);
    assert.deepStrictEqual(r.stopped, []);
  } finally { rm(dir); }
});

test('sweep: a window count that cannot be had (null, a throw, not a Map) stops nothing and reports the host as unproven', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    for (const windowCountsFn of [async () => null, async () => { throw new Error('powershell died'); }, async () => ({ get: () => 0 }), async () => new Map()]) {
      let called = 0;
      const r = await sweep({ dir, table: tableOf([[101, 50, T0]]), dryRun: false, kill: () => { called++; return 'killed'; }, self: [], windowCountsFn });
      assert.strictEqual(called, 0);
      assert.deepStrictEqual(r.unproven.map(x => x.pid), [101]);
      assert.deepStrictEqual(r.left.map(x => x.pid), [101]);
    }
  } finally { rm(dir); }
});

test('sweep: the window query is not made when nothing passed the other proofs', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    const r = await sweep({ dir, table: tableOf([[101, 50, T0], [50, 1, T0 - 5n]]), dryRun: false, kill: () => assert.fail('no kill'), self: [], windowCountsFn: () => assert.fail('no query') });
    assert.deepStrictEqual(r.left.map(x => x.pid), [101]);
  } finally { rm(dir); }
});

test('sweep: a kill that answers gone / mismatch is "left", unknown / failed / a throw is "failed"; none is "stopped"', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)], [7002, MARK, 102, String(T0)], [7003, MARK, 103, String(T0)], [7004, MARK, 104, String(T0)]]);
  try {
    const table = tableOf([101, 102, 103, 104].map(p => [p, 50, T0]));
    const answers = { 101: 'gone', 102: 'mismatch', 103: 'unknown', 104: () => { throw new Error('boom'); } };
    const r = await sweep({ dir, table, dryRun: false, self: [], windowCountsFn: zeroCounts, kill: (pid) => { const a = answers[pid]; return typeof a === 'function' ? a() : a; } });
    assert.deepStrictEqual(r.stopped, []);
    assert.deepStrictEqual(r.left.map(x => x.pid).sort(), [101, 102]);
    assert.deepStrictEqual(r.failed.map(x => x.pid).sort(), [103, 104]);
  } finally { rm(dir); }
});

test('makeKill: the kill proves the start within the SAME tolerance as the table proof (one rule, PR #232 Miguel G3)', () => {
  const calls = [];
  const kill = makeKill((...a) => { calls.push(a); return 'killed'; });
  assert.strictEqual(kill(101, '133000000000000000'), 'killed');
  assert.deepStrictEqual(calls, [[101, '133000000000000000', { toleranceTicks: 20000 }]]);
  assert.strictEqual(START_TOLERANCE, 20000n);
});

test('sweep: a process table that could not be read stops nothing and says unknown', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    let called = 0;
    const r = await sweep({ dir, table: null, dryRun: false, kill: () => { called++; return 'killed'; }, self: [], windowCountsFn: zeroCounts });
    assert.strictEqual(r.unknown, true);
    assert.strictEqual(called, 0);
  } finally { rm(dir); }
});

test('sweep: no identity files, or none marked, is a clean "nothing"; the table is not even read', async () => {
  const dir = fixture([[7001, undefined, 101, String(T0)]]);
  try {
    const r = await sweep({ dir, table: null, dryRun: false, kill: () => assert.fail('no kill'), self: [], windowCountsFn: zeroCounts });
    assert.strictEqual(r.unknown, false, 'nothing to judge, so an unreadable table does not matter');
    assert.deepStrictEqual([r.wouldStop, r.stopped, r.failed, r.unproven], [[], [], [], []]);
    assert.strictEqual(r.unmarked, 1);
  } finally { rm(dir); }
});

// ---- the command ---------------------------------------------------------------------------------------------------------------

const fakeLock = (events) => ({ release: () => { events.push('release'); return true; } });

test('main: with marked dead-parent hosts in the folder and no --stop, nothing is stopped and no lock is taken (the dry-run default)', async () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    const killed = [];
    const lines = [];
    const sweepFn = (o) => sweep({ ...o, table: tableOf([[101, 50, T0]]), kill: (...a) => { killed.push(a); return 'killed'; }, self: [], windowCountsFn: zeroCounts });
    const code = await main(['--dir', dir], { log: (l) => lines.push(l), sweepFn, acquireLock: () => assert.fail('a dry run takes no lock') });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(killed, []);
    assert.match(lines.join('\n'), /would stop pid 101/);
    assert.match(lines.join('\n'), /run with --stop/);
  } finally { rm(dir); }
});

test('main: sweepFn gets dryRun true without --stop and false with it; --stop holds the heavy lock around the sweep and releases it after', async () => {
  const dir = fixture([[7001, undefined, 101, String(T0)]]);
  try {
    const events = [];
    const sweepFn = async (o) => { events.push(['sweep', o.dryRun, o.dir]); return { files: 0, marked: 0, unmarked: 0, unreadable: 0, left: [], wouldStop: [], stopped: [], failed: [], unproven: [] }; };
    await main(['--dir', dir], { log() {}, sweepFn, acquireLock: () => assert.fail('no lock for a dry run') });
    await main(['--dir', dir, '--stop'], { log() {}, sweepFn, acquireLock: (o) => { events.push(['acquire', o.label]); return fakeLock(events); } });
    assert.deepStrictEqual(events, [
      ['sweep', true, path.resolve(dir)],
      ['acquire', 'sweep-orphans --stop'],
      ['sweep', false, path.resolve(dir)],
      'release',
    ]);
  } finally { rm(dir); }
});

test('main: --stop with the heavy lock busy is NOT RUN (exit 75, the lock\'s NOT RUN line last) and sweeps nothing; a sweep that throws still releases the lock', async () => {
  // #237 Miguel S5: the same contract as scripts/with-heavy-lock.js.
  const { HeavyLockError, NOT_RUN_EXIT } = require('../host/heavy-lock');
  let swept = 0;
  const lines = [];
  const busy = new HeavyLockError('busy', 'busy: npm test (pid 1 start 2)', { holder: 'npm test (pid 1 start 2)', waitedMs: 20 * 60000 });
  const code = await main(['--stop'], { log: (l) => lines.push(l), sweepFn: async () => { swept++; }, acquireLock: () => { throw busy; } });
  assert.strictEqual(code, NOT_RUN_EXIT);
  assert.strictEqual(swept, 0);
  assert.match(lines.join('\n'), /nothing was stopped/);
  assert.strictEqual(lines[lines.length - 1], '[heavy-lock] lock busy for 20 min, held by npm test (pid 1 start 2): NOT RUN');
  // A throw that isn't the lock's refusal is a bug: its stack, exit 1, never NOT RUN.
  const bug = [];
  assert.strictEqual(await main(['--stop'], { log: (l) => bug.push(l), sweepFn: async () => { swept++; }, acquireLock: () => { throw new TypeError('x is null'); } }), 1);
  assert.strictEqual(swept, 0);
  assert.ok(!bug.some(l => /NOT RUN/.test(l)));
  assert.match(bug.join('\n'), /a bug, not a busy lock.*TypeError: x is null/s);
  const events = [];
  await assert.rejects(main(['--stop'], { log() {}, sweepFn: async () => { throw new Error('boom'); }, acquireLock: () => fakeLock(events) }), /boom/);
  assert.deepStrictEqual(events, ['release']);
});

test('main: --dir with no path refuses (exit 2) instead of sweeping the checkout\'s own folder, with or without --stop', async () => {
  for (const argv of [['--stop', '--dir'], ['--dir'], ['--dir', '--stop'], ['--dir', '--other']]) {
    let swept = 0;
    let locked = 0;
    const lines = [];
    const code = await main(argv, { log: (l) => lines.push(l), sweepFn: async () => { swept++; }, acquireLock: () => { locked++; return fakeLock([]); } });
    assert.strictEqual(code, 2, argv.join(' '));
    assert.strictEqual(swept, 0, argv.join(' '));
    assert.strictEqual(locked, 0, argv.join(' '));
    assert.match(lines.join('\n'), /--dir needs a folder path/);
  }
});

test('main: with no --dir the folder is this checkout\'s own .harness', async () => {
  let seen;
  await main([], { log() {}, sweepFn: async (o) => { seen = o.dir; return { files: 0, marked: 0, unmarked: 0, unreadable: 0, left: [], wouldStop: [], stopped: [], failed: [], unproven: [] }; } });
  assert.strictEqual(seen, path.join(__dirname, '..', '.harness'));
});

test('main: a running marked host that could not be proven is not "no orphaned probe hosts": it is listed and the exit code is 3', async () => {
  const dir = fixture([[7001, MARK, 101, undefined]]);
  try {
    const lines = [];
    const sweepFn = (o) => sweep({ ...o, table: tableOf([[101, 50, T0]]), kill: () => assert.fail('no kill'), self: [], windowCountsFn: zeroCounts });
    const code = await main(['--dir', dir], { log: (l) => lines.push(l), sweepFn });
    const out = lines.join('\n');
    assert.strictEqual(code, 3);
    assert.match(out, /left   pid 101 port 7001: the host never published its start time.*RUNNING, could not be proven/);
    assert.match(out, /1 running marked host could not be proven either way/);
    assert.doesNotMatch(out, /no orphaned probe hosts/);
  } finally { rm(dir); }
});

test('main: on a folder with nothing marked it stops nothing and says so', async () => {
  const dir = fixture([[7001, undefined, 101, String(T0)]]);
  try {
    const lines = [];
    assert.strictEqual(await main(['--dir', dir], { log: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /1 unmarked \(never touched\)/);
    assert.match(lines.join('\n'), /no orphaned probe hosts; nothing stopped/);
  } finally { rm(dir); }
});

// ---- the process table read ------------------------------------------------------------------------------------------------

test('readProcessTable: parses pid / ppid / FILETIME rows; a missing END, a failed run or an empty table is null (never an empty machine)', () => {
  const ok = (stdout) => () => ({ status: 0, stdout });
  const t = readProcessTable({ run: ok('4 0 133000000000000000\r\n100 50 133000000000000001\r\nnoise\r\nEND\r\n') });
  assert.deepStrictEqual([...t.keys()], [4, 100]);
  assert.deepStrictEqual(t.get(100), { ppid: 50, created: 133000000000000001n });
  assert.strictEqual(readProcessTable({ run: ok('4 0 1\r\n') }), null, 'cut off before END');
  assert.strictEqual(readProcessTable({ run: ok('END\r\n') }), null, 'an empty table is a broken query');
  assert.strictEqual(readProcessTable({ run: () => ({ status: 1, stdout: 'END' }) }), null);
  assert.strictEqual(readProcessTable({ run: () => ({ error: new Error('x'), stdout: '' }) }), null);
  assert.strictEqual(readProcessTable({ run: () => { throw new Error('x'); } }), null);
});
