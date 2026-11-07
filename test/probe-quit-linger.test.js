'use strict';
/**
 * verify/probe-quit-linger.js (BACKLOG #74 A): its pure rules in verify/lib/quit-linger.js, and the shape of the probe's own safety
 * (PR #242 review: Miguel B1, F1-F6, S2, S6, S8; Dexter 1-8). Each finding has its case here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const QL = require('../verify/lib/quit-linger');

const PROBE = fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-quit-linger.js'), 'utf8');

test('classify: a --type= switch names it; the root is the browser; the host and its watchdog are told apart; no command line is unreadable', () => {
  assert.strictEqual(QL.classify('"C:\\x\\electron.exe" --type=gpu-process --user-data-dir="C:\\u"', false), 'gpu-process');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe C:\\repo --user-data-dir=C:\\u', true), 'browser');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe C:\\repo\\host\\host.js', false), 'host');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe C:\\repo/host/host.js --port 1', false), 'host');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe C:\\repo\\host\\bounded-watchdog.js 12 45000', false), 'host-watchdog');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe C:\\repo\\verify\\lib\\thing.js', false), 'node:thing.js');
  assert.strictEqual(QL.classify('C:\\x\\electron.exe', false), 'node');
  assert.strictEqual(QL.classify('', false), 'unreadable');
  assert.strictEqual(QL.classify(null, true), 'unreadable');
  assert.strictEqual(QL.classify('electron.exe --type=utility', true), 'utility');
});

// ---- parsing: absence stays absent (Dexter 8, Miguel S6) ----
test('a blank field parses as null, never 0: a cpu reading that failed, a process with no readable threads', () => {
  const s = QL.parseSampleLine('T|1000|cpu,|5,0,0,1,8,0,0,,,,electron');
  assert.strictEqual(s.t, 1000);
  assert.strictEqual(s.cpu, null);
  const r = s.rows.get(5);
  assert.strictEqual(r.thr, 0);
  assert.strictEqual(r.minPri, null);
  assert.strictEqual(r.maxPri, null);
  assert.strictEqual(r.start, null);
  assert.strictEqual(r.name, 'electron');
  assert.strictEqual(QL.num(''), null);
  assert.strictEqual(QL.num('abc'), null);
  assert.strictEqual(QL.num(undefined), null);
  assert.strictEqual(QL.num('12.5'), 12.5);
});

test('a full row parses every field, and a line that is not a sample is null', () => {
  const s = QL.parseSampleLine('T|2000|7,47,630,150,10,25,0,1,13,134385494738070331,electron|cpu,64');
  assert.deepStrictEqual(s.rows.get(7), { thr: 47, hnd: 630, privMB: 150, base: 10, ready: 25, running: 0, minPri: 1, maxPri: 13, start: '134385494738070331', name: 'electron' });
  assert.strictEqual(s.cpu, 64);
  assert.strictEqual(QL.parseSampleLine('DONE'), null);
  assert.strictEqual(QL.parseSampleLine('T|x|1,2'), null);
  assert.strictEqual(QL.parseSampleLine(undefined), null);
});

// ---- identity: pid AND start (Dexter 2, Miguel F2) ----
const START = '134385494738070330';
const tracked = (pid, type = 'renderer') => ({ pid, start: START, name: 'electron.exe', type, privMB: 50 });
const row = (thr, hnd, extra = {}) => ({ thr, hnd, privMB: 10, base: 8, ready: 0, running: 0, minPri: 4, maxPri: 8, start: '134385494738070334', name: 'electron', ...extra });
const sample = (t, entries) => ({ t, rows: new Map(entries), cpu: null });

test('a pid listed with ANOTHER start is a stranger that took it: the tracked process is gone at that sample', () => {
  const samples = [
    sample(1250, [[1, row(40, 800)]]),
    sample(1500, [[1, row(9, 120, { start: '134385494999999990', name: 'node' })]]),   // the gpu-process left; a test runner took pid 1
    sample(9000, [[1, row(9, 120, { start: '134385494999999990', name: 'node' })]]),
  ];
  const [p] = QL.summarise([tracked(1, 'gpu-process')], samples, 1000);
  assert.strictEqual(p.goneAfterS, 0.5);
  assert.strictEqual(QL.watchState(samples.slice(0, 2), 1000, 60000, [tracked(1)]), 'gone');
});

test('a row whose start could not be read counts as the tracked process only when its name matches', () => {
  assert.strictEqual(QL.rowIsTracked(row(1, 0, { start: null, name: 'electron' }), tracked(1)), true);
  assert.strictEqual(QL.rowIsTracked(row(1, 0, { start: null, name: 'node' }), tracked(1)), false);
  assert.strictEqual(QL.rowIsTracked(row(1, 0, { start: null, name: null }), tracked(1)), false);
  assert.strictEqual(QL.rowIsTracked(undefined, tracked(1)), false);
});

test('summarise: gone at the first sample that misses it, in seconds after the close; samples before the close are ignored', () => {
  const samples = [
    sample(900, [[1, row(40, 800)], [2, row(10, 400)]]),
    sample(1250, [[1, row(40, 800)]]),
    sample(1500, [[1, row(40, 790)]]),
    sample(4000, []),
  ];
  const [b, r] = QL.summarise([tracked(1, 'browser'), tracked(2)], samples, 1000);
  assert.strictEqual(r.goneAfterS, 0.25);
  assert.strictEqual(b.goneAfterS, 3);
  assert.strictEqual(b.path.length, 2, 'one entry per change of the counts');
});

test('summarise: never missing is goneAfterS null', () => {
  const [p] = QL.summarise([tracked(7)], [sample(1100, [[7, row(1, 600)]]), sample(1350, [[7, row(1, 600)]])], 1000);
  assert.strictEqual(p.goneAfterS, null);
});

// ---- the zombie span: the LONGEST stretch (Dexter 7, Miguel F4) ----
test('the zombie span is the longest stretch, not the last: a 3 s run broken, then a shorter one, reports 3 s', () => {
  const samples = [
    sample(1000, [[3, row(1, 0)]]), sample(2000, [[3, row(1, 0)]]), sample(3000, [[3, row(1, 0)]]), sample(4000, [[3, row(1, 0)]]),
    sample(4500, [[3, row(2, 5)]]),
    sample(5000, [[3, row(1, 0)]]), sample(6000, [[3, row(1, 0)]]),
    sample(7000, []),
  ];
  const [p] = QL.summarise([tracked(3, 'utility')], samples, 1000);
  assert.strictEqual(p.zombieS, 3);
  assert.strictEqual(p.goneAfterS, 6);
});

test('a long run broken by a short later one keeps the long one (Miguel F4: 4 s then 0.25 s reports 4)', () => {
  const samples = [sample(1000, [[3, row(1, 0)]]), sample(5000, [[3, row(1, 0)]]), sample(5250, [[3, row(3, 9)]]), sample(5500, [[3, row(1, 0)]]), sample(5750, [[3, row(1, 0)]]), sample(9000, [[3, row(4, 9)]])];
  const [p] = QL.summarise([tracked(3)], samples, 1000);
  assert.strictEqual(p.zombieS, 4);
});

test('a single zombie sample before leaving counts, up to the gone time (Dexter 7 case B)', () => {
  const samples = [sample(1250, [[3, row(40, 800)]]), sample(1500, [[3, row(1, 0)]]), sample(1750, [])];
  const [p] = QL.summarise([tracked(3)], samples, 1000);
  assert.strictEqual(p.zombieSeen, true);
  assert.strictEqual(p.zombieS, 0.25);
});

test('a row with unknown counts is not zombie-shaped', () => {
  const [p] = QL.summarise([tracked(3)], [sample(1250, [[3, row(null, null)]]), sample(1500, [])], 1000);
  assert.strictEqual(p.zombieSeen, false);
});

test('the path records each change, with ? for a field that was not read', () => {
  const samples = [
    sample(1250, [[4, row(47, 630, { base: 10, minPri: 1, maxPri: 13 })]]),
    sample(1500, [[4, row(47, 630, { base: 10, minPri: 1, maxPri: 13 })]]),
    sample(3000, [[4, row(25, 587, { base: 10, ready: 25, minPri: null, maxPri: null })]]),
  ];
  const [p] = QL.summarise([tracked(4, 'gpu-process')], samples, 1000);
  assert.deepStrictEqual(p.path, ['0.25s:47t/630h/10MB/b10/r0/run0/p1-13', '2.00s:25t/587h/10MB/b10/r25/run0/p?-?']);
});

// ---- the watch: counted from the close (Dexter 4) ----
test('the watch ends at a sample at least watchMs after the CLOSE, not after the sampler started', () => {
  const t = [tracked(1)];
  const listed = (ms) => sample(ms, [[1, row(40, 800)]]);
  assert.strictEqual(QL.watchState([listed(500)], 1000, 60000, t), null, 'samples before the close decide nothing');
  assert.strictEqual(QL.watchState([listed(1000), listed(60200)], 1000, 60000, t), null, 'at 59.2 s after the close: keep watching');
  assert.strictEqual(QL.watchState([listed(1000), listed(61000)], 1000, 60000, t), 'watched');
  assert.strictEqual(QL.watchState([listed(1000), sample(60200, [])], 1000, 60000, t), 'gone');
});

// ---- order statistics over censored times (Dexter 3) ----
test('median and max count the still-running cycles as larger than every finished one: [1..7, >60 x3] is median 5, max >60', () => {
  const st = QL.censoredStats([1, 2, 3, 4, 5, 6, 7, null, null, null]);
  assert.strictEqual(st.median, 5);
  assert.strictEqual(st.max, Infinity);
  assert.strictEqual(st.still, 3);
  assert.strictEqual(QL.fmtS(st.max, 60), '>60');
  assert.strictEqual(QL.fmtS(st.median, 60), '5.00');
  assert.deepStrictEqual(QL.censoredStats([]), { n: 0, median: null, max: null, still: 0 });
  assert.strictEqual(QL.fmtS(null, 60), '-');
  assert.strictEqual(QL.censoredStats([null, null, 3]).median, Infinity, 'two of three never finished: the median did not finish either');
});

// ---- the close (Miguel F1, Dexter 5) ----
test('a close that was not done, or after which the app still answers, is not a quit', () => {
  assert.deepStrictEqual(QL.closeVerdict({ ok: true }, false), { ok: true, why: '' });
  assert.strictEqual(QL.closeVerdict({ ok: false, error: 'no reply to win-close in 15000ms' }, false).ok, false);
  assert.match(QL.closeVerdict(null, false).why, /no answer/);
  // A window hidden to the tray: the close was "ok", the app still answers.
  assert.match(QL.closeVerdict({ ok: true, destroyed: false, visible: false }, true).why, /didn't quit/);
});

// ---- the late-host adoption (Dexter 1 / Miguel F3) ----
const ROOT = path.resolve(__dirname, '..');
const HOST_SCRIPT = path.join(ROOT, 'host', 'host.js');
const TMP = path.join(require('os').tmpdir(), 'cc-probe-quit-linger-x', 'c1-y');
const MARK = 'pm1-4242-0123456789ab';
const ROOT_START = '134385000000000000';
const ROOT_EXIT_MS = 1794070000000;                                                     // the root's exit, a JS time
const EXIT_FT = QL.filetimeOfMs(ROOT_EXIT_MS);
const hostRow = (over = {}) => ({ pid: 7700, ppid: 9120, name: 'electron.exe', start: String(EXIT_FT - 50000000n), cmd: `"${path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')}" ${HOST_SCRIPT}`, ...over });
const ids = (over = {}) => [{ pid: 7700, cwd: path.join(TMP, 'proj', 'dev'), probeMark: MARK, ...over }];
const adopt = (over = {}) => QL.adoptableHosts({ rows: [hostRow(over.row)], ids: over.ids || ids(), rootPid: 9120, rootStart: ROOT_START, rootAlive: false,
  rootExitMs: ROOT_EXIT_MS, hostScript: HOST_SCRIPT, mark: MARK, insideDir: TMP, ...over.args });

test('Dexter 1: after the root exited, a host whose start is AFTER that exit is never adopted (its parent is whoever took the pid)', () => {
  assert.deepStrictEqual(adopt({ row: { start: String(EXIT_FT + 50000000n) } }), []);
  assert.deepStrictEqual(adopt({ row: { start: String(EXIT_FT) } }), [], 'the exit instant itself is already too late');
  // Started before the root's exit, a child of the root, this worktree's host, carrying this probe's mark: adopted with its start.
  assert.deepStrictEqual(adopt(), [{ pid: 7700, start: String(EXIT_FT - 50000000n) }]);
});

test('Dexter 1: another worktree\'s host.js is never adopted, whatever its parent and start', () => {
  assert.deepStrictEqual(adopt({ row: { cmd: 'electron.exe C:\\Users\\ricar\\VibeCode\\claude-custom\\dev\\host\\host.js' } }), []);
});

test('a host is adopted only with an identity file carrying THIS probe\'s mark and a cwd inside this cycle', () => {
  assert.deepStrictEqual(adopt({ ids: ids({ probeMark: 'pm1-1-ffffffffffff' }) }), [], 'another probe\'s mark');
  assert.deepStrictEqual(adopt({ ids: ids({ probeMark: undefined }) }), [], 'a person\'s host has no mark');
  assert.deepStrictEqual(adopt({ ids: ids({ cwd: 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev' }) }), [], 'a cwd outside this cycle');
  assert.deepStrictEqual(adopt({ ids: ids({ pid: 7701 }) }), [], 'the identity names another pid');
  assert.deepStrictEqual(adopt({ args: { mark: null } }), [], 'no mark in this process: nothing');
});

test('the parent and the start order are both required; a root still running makes its children provable without the exit time', () => {
  assert.deepStrictEqual(adopt({ row: { ppid: 1 } }), []);
  assert.deepStrictEqual(adopt({ row: { start: '134384000000000000' } }), [], 'started before the root: not its child');
  assert.deepStrictEqual(adopt({ row: { name: 'node.exe' } }), []);
  const live = adopt({ row: { start: String(EXIT_FT + 50000000n) }, args: { rootAlive: true, rootExitMs: null } });
  assert.strictEqual(live.length, 1, 'root still running (its handle held): its pid is nobody else\'s');
  assert.deepStrictEqual(adopt({ args: { rootExitMs: null } }), [], 'root gone with no exit time: nothing can be proven');
});

test('filetimeOfMs: the Unix epoch is FILETIME 116444736000000000', () => {
  assert.strictEqual(QL.filetimeOfMs(0), 116444736000000000n);
  assert.strictEqual(QL.filetimeOfMs(1), 116444736000010000n);
  assert.strictEqual(QL.filetimeOfMs(NaN), null);
});

// ---- the checkout's state (Miguel B1) ----
test('findForeignHost: a live host outside this run is returned; this run\'s and dead ones are not', async () => {
  const own = path.join(require('os').tmpdir(), 'cc-probe-quit-linger-own');
  const live = new Set([1, 3]);
  const isLive = async (id) => live.has(id.pid);
  assert.strictEqual(await QL.findForeignHost([{ pid: 1, cwd: path.join(own, 'c1', 'proj', 'dev') }, { pid: 2, cwd: 'C:\\x' }], own, isLive), null);
  assert.deepStrictEqual(await QL.findForeignHost([{ pid: 3, cwd: 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev' }], own, isLive), { pid: 3, cwd: 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev' });
});

const at = (needle) => { const i = PROBE.indexOf(needle); assert.ok(i >= 0, `the probe has ${needle}`); return i; };

test('Miguel B1: the probe refuses beside a live host BEFORE it touches the checkout\'s layout files', () => {
  assert.ok(at('QL.findForeignHost(readHostIds()') < at('fs.unlinkSync(f)'));
  assert.match(PROBE, /if \(foreign\) \{[\s\S]{0,400}REFUSED[\s\S]{0,300}return 2;/);
});

test('Miguel B1: the layout files are put back from process exit (Ctrl+C included), armed before the first removal', () => {
  const unlink = at('fs.unlinkSync(f)');
  assert.ok(at("process.on('exit', restoreState)") < unlink, 'the exit handler is armed before any file is removed');
  assert.ok(at('installSweep();') < unlink, 'the signal sweep (which exits, which restores) is armed before any file is removed');
  assert.match(PROBE, /const restoreState = \(\) => \{ for \(const s of snaps\) s\.restore\(\); \};/);
  assert.match(PROBE, /finally \{[\s\S]*restoreState\(\);/);
});

test('Dexter 1: hosts are ended only through adoptableHosts and a recorded start; never through a late fresh read', () => {
  assert.doesNotMatch(PROBE, /seenPids\.see\(/);
  assert.match(PROBE, /QL\.adoptableHosts\(/);
  assert.match(PROBE, /killProven\(pid, start, \{ toleranceTicks: 10 \}\)/);
});

test('Dexter 2: the booster reads a process\'s start and compares it before it touches any thread', () => {
  const b = PROBE.slice(at('function startBooster'), at('// ---- the app\'s driver'));
  assert.ok(b.indexOf('StartTime.ToFileTimeUtc()') < b.indexOf("PriorityLevel = 'Normal'"));
  assert.match(b, /\[math\]::Abs\(\$s - \$it\[1\]\) -gt 10\) \{ \$other\+\+; continue \}/);
});

test('Miguel F5: the sampler and the booster handle a failed start, and the watch is bounded from Node', () => {
  const s = PROBE.slice(at('function startSampler'), at('// ---- the :boost diagnostic'));
  assert.match(s, /child\.on\('error'/);
  assert.match(s, /setTimeout\(\(\) => done\('stalled'\)/);
  assert.match(s, /setTimeout\(\(\) => firstResolve\(\), 30000\)/);
  const b = PROBE.slice(at('function startBooster'), at('// ---- the app\'s driver'));
  assert.match(b, /child\.on\('error'/);
});

test('Miguel S2/S8: flags are checked, and a non-Windows SKIP happens, before the launcher (and its heavy lock) is required', () => {
  const launcher = at("require('./lib/launch-electron')");
  assert.ok(at("positive('watch', 60)") < launcher);
  assert.ok(at("process.platform !== 'win32'") < launcher);
});
