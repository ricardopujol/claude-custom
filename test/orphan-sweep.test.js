'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { MARK_VAR, makeMark, parseMark, markFromEnv, markEnv } = require('../host/probe-mark');
const { writeIdentity, readIdentity } = require('../host/host-identity');
const { readIdentities, readProcessTable, judge, sweep } = require('../verify/lib/orphan-sweep');
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

test('a probe\'s launcher marks process.env and the mark survives the env stripping; a unit test run marks nothing', () => {
  const probeFile = path.join(__dirname, '..', 'verify', 'probe-dock-tree.js');
  const code = `process.argv[1] = ${JSON.stringify(probeFile)};
    const le = require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'launch-electron.js'))});
    const mark = process.env.${MARK_VAR};
    const kept = le.cleanElectronEnv({ ...process.env }).${MARK_VAR};
    const probe = le.probeEnv({ ...process.env, CLAUDE_CUSTOM_X: '1' }, { ...process.env, CLAUDE_CUSTOM_X: '1' }).${MARK_VAR};
    console.log(JSON.stringify({ mark, kept, probe }));`;
  const env = { ...process.env, HEAVY_LOCK_HELD: '1' };   // no real machine lock for this child
  delete env[MARK_VAR];
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(parseMark(out.mark), 'a probe process carries a valid mark');
  assert.strictEqual(parseMark(out.mark).pid > 0, true);
  assert.strictEqual(out.kept, out.mark, 'cleanElectronEnv keeps it');
  assert.strictEqual(out.probe, out.mark, 'probeEnv keeps it');
  const notProbe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'launch-electron.js'))}); console.log(String(process.env.${MARK_VAR}))`], { encoding: 'utf8', env });
  assert.strictEqual(notProbe.stdout.trim(), 'undefined', 'not a probe: no mark');
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

test('judge: parent and launcher both gone, host proven: stop', () => {
  assert.strictEqual(judge(entry(), base()).action, 'stop');
});

test('judge: a parent still running keeps the host; so does a launcher still running', () => {
  assert.match(judge(entry(), base([[50, 1, T0 - 1000n]])).why, /parent 50 is still running/);
  assert.match(judge(entry(), base([[LAUNCHER, 1, T0 - 1000n]])).why, /probe 4000 is still running/);
  assert.strictEqual(judge(entry(), base([[50, 1, T0 - 1n], [LAUNCHER, 1, T0 - 1n]])).action, 'leave');
});

test('judge: a parent or launcher pid reused AFTER the host started is not alive (it cannot be the original)', () => {
  assert.strictEqual(judge(entry(), base([[50, 1, T0 + 1n], [LAUNCHER, 1, T0 + 5000000n]])).action, 'stop');
  assert.strictEqual(judge(entry(), base([[50, 1, T0], [LAUNCHER, 1, T0 + 5000000n]])).action, 'leave', 'started at the same instant: could be the original, doubt keeps it');
});

test('judge: the host pid must be the process the file names: absent, or another start time, is left alone', () => {
  assert.match(judge(entry(), tableOf([])).why, /not running/);
  assert.match(judge(entry(), tableOf([[100, 50, T0 + 30000n]])).why, /another process/);
  assert.match(judge(entry(), tableOf([[100, 50, T0 - 30000n]])).why, /another process/);
  assert.strictEqual(judge(entry(), tableOf([[100, 50, T0 + 20000n]])).action, 'stop', 'inside the 2 ms the table\'s precision allows');
});

test('judge: no start time, no pid, or the sweep\'s own pid: left alone', () => {
  assert.match(judge(entry({ start: null }), base()).why, /never published its start time/);
  assert.match(judge(entry({ pid: null }), base()).why, /no usable pid/);
  assert.match(judge(entry(), base(), { self: [100] }).why, /own process/);
});

test('judge: a parent pid of 0 (no parent) counts as gone', () => {
  assert.strictEqual(judge(entry(), tableOf([[100, 0, T0]])).action, 'stop');
});

// ---- the sweep ---------------------------------------------------------------------------------------------------------------

function fixture(rows) {
  const dir = tmpDir();
  for (const [port, mark, pid, start] of rows) writeIdentity({ dir, port, cwd: 'C:/x', pid, processStartedAt: start, probeMark: mark });
  return dir;
}

test('sweep: stops exactly the marked orphan, by pid with its recorded start; leaves unmarked, live-owner, reused and unproven alike', () => {
  const live = makeMark(4001, '111111111111');
  const dir = fixture([
    [7001, MARK, 101, String(T0)],          // orphan
    [7002, undefined, 102, String(T0)],     // unmarked: a person's window, parent dead too
    [7003, live, 103, String(T0)],          // its launcher 4001 is running
    [7004, MARK, 104, String(T0)],          // pid reused (another start)
    [7005, MARK, 105, undefined],           // never published its start
  ]);
  try {
    const table = tableOf([[101, 50, T0], [102, 50, T0], [103, 50, T0], [104, 50, T0 + 99999999n], [105, 50, T0], [4001, 1, T0 - 10n]]);
    const killed = [];
    const dry = sweep({ dir, table, dryRun: true, kill: (...a) => { killed.push(a); return 'killed'; }, self: [] });
    assert.deepStrictEqual(dry.wouldStop.map(x => x.pid), [101]);
    assert.deepStrictEqual(killed, [], 'a dry run kills nothing');
    const r = sweep({ dir, table, dryRun: false, kill: (...a) => { killed.push(a); return 'killed'; }, self: [] });
    assert.deepStrictEqual(killed, [[101, String(T0)]], 'one kill, with the recorded start for the proof');
    assert.deepStrictEqual(r.stopped.map(x => x.pid), [101]);
    assert.strictEqual(r.unmarked, 1);
    assert.deepStrictEqual(r.left.map(x => x.pid).sort(), [103, 104, 105]);
  } finally { rm(dir); }
});

test('sweep: a kill that answers gone / mismatch is "left", unknown / failed / a throw is "failed"; none is "stopped"', () => {
  const dir = fixture([[7001, MARK, 101, String(T0)], [7002, MARK, 102, String(T0)], [7003, MARK, 103, String(T0)], [7004, MARK, 104, String(T0)]]);
  try {
    const table = tableOf([101, 102, 103, 104].map(p => [p, 50, T0]));
    const answers = { 101: 'gone', 102: 'mismatch', 103: 'unknown', 104: () => { throw new Error('boom'); } };
    const r = sweep({ dir, table, dryRun: false, self: [], kill: (pid) => { const a = answers[pid]; return typeof a === 'function' ? a() : a; } });
    assert.deepStrictEqual(r.stopped, []);
    assert.deepStrictEqual(r.left.map(x => x.pid).sort(), [101, 102]);
    assert.deepStrictEqual(r.failed.map(x => x.pid).sort(), [103, 104]);
  } finally { rm(dir); }
});

test('sweep: a process table that could not be read stops nothing and says unknown', () => {
  const dir = fixture([[7001, MARK, 101, String(T0)]]);
  try {
    let called = 0;
    const r = sweep({ dir, table: null, dryRun: false, kill: () => { called++; return 'killed'; }, self: [] });
    assert.strictEqual(r.unknown, true);
    assert.strictEqual(called, 0);
  } finally { rm(dir); }
});

test('sweep: no identity files, or none marked, is a clean "nothing"; the table is not even read', () => {
  const dir = fixture([[7001, undefined, 101, String(T0)]]);
  try {
    const r = sweep({ dir, table: null, dryRun: false, kill: () => assert.fail('no kill'), self: [] });
    assert.strictEqual(r.unknown, false, 'nothing to judge, so an unreadable table does not matter');
    assert.deepStrictEqual([r.wouldStop, r.stopped, r.failed], [[], [], []]);
    assert.strictEqual(r.unmarked, 1);
  } finally { rm(dir); }
});

test('main: on a folder with nothing marked it stops nothing and says so; --stop is needed to stop', () => {
  const dir = fixture([[7001, undefined, 101, String(T0)]]);
  try {
    const lines = [];
    assert.strictEqual(main(['--dir', dir], { log: (l) => lines.push(l) }), 0);
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

test('readProcessTable: the real machine\'s table has this process, started before now, with its parent', () => {
  const t = readProcessTable();
  if (!t) return;   // off Windows, or PowerShell unavailable here: nothing to measure
  const me = t.get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.strictEqual(me.ppid, process.ppid);
  assert.ok(me.created > 0n);
});
