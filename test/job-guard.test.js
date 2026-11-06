'use strict';
/**
 * host/job-guard.js (BACKLOG #127): the PowerShell helper that keeps every process the session starts in a Job Object a stop can end.
 * Pure here: a fake spawn stands in for the helper. The real job is measured by verify/probe-kill-switch-detached.js and
 * test/job-guard-process.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createJobGuard, helperScript, splitLines, parseLine, verdict, spawnWindowOf, msToFiletime, KILL_ANSWER_MS, WINDOW_EARLY_MS, WINDOW_LATE_MS } = require('../host/job-guard');

// A fake helper: stdout/stderr/stdin are emitters, `kill()` records and exits it, `say()` prints a line.
function fakeHelper() {
  const h = new EventEmitter();
  h.pid = 4242;
  h.exitCode = null;
  h.signalCode = null;
  h.stdout = new EventEmitter();
  h.stdout.unref = () => {};
  h.stderr = new EventEmitter();
  h.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, unref() {}, write(s) { this.written.push(s); }, end() { this.ended = true; } });
  h.killed = 0;
  h.kill = () => { h.killed++; h.exit(); return true; };
  h.exit = () => { h.exitCode = 1; h.emit('exit', 1, null); };
  h.unref = () => {};
  h.say = (line) => h.stdout.emit('data', Buffer.from(line + '\n'));
  return h;
}
function guardWith(h, extra = {}) {
  const spawned = [];
  const lines = [];
  const g = createJobGuard({ spawnFn: (...a) => { spawned.push(a); return h; }, platform: 'win32', powershell: 'PS.exe', timeoutMs: 50, log: (l) => lines.push(l), ...extra });
  return { g, spawned, lines };
}
const tick = () => new Promise((r) => setImmediate(r));
// Attach with a proven start, wait for START to go out, answer READY.
async function armed(extra = {}) {
  const h = fakeHelper();
  const ctx = guardWith(h, extra);
  const p = ctx.g.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  h.say('READY 5 1234');
  const r = await p;
  return { h, ...ctx, r };
}

// --- the script -------------------------------------------------------------------------------------------------------------------

test('helperScript: binds kernel32 through Reflection.Emit, never Add-Type/csc.exe, and never sets a job limit (PR #235 Miguel B1, S3)', () => {
  const s = helperScript(777);
  assert.match(s, /\$target = 777/);
  assert.match(s, /DefinePInvokeMethod/);
  assert.doesNotMatch(s, /Add-Type/i, 'Add-Type runs csc.exe: over 30 s under load');
  assert.doesNotMatch(s, /SetInformationJobObject/, 'no limits: no kill-on-close (a tree kill of the host would end the job), no breakaway');
  for (const bad of [0, -1, 1.5, '7', null, NaN]) assert.throws(() => helperScript(bad), /pid/, String(bad));
});

test('helperScript: compares the start it was sent BEFORE assigning, so a stranger is never put in the job (PR #235 Dexter 5)', () => {
  const s = helperScript(777);
  const start = s.indexOf("-match '^START (\\d+)$'");
  const mismatch = s.indexOf("if ($got -lt $lo -or $got -gt $hi) { Say ('FAILED start-mismatch ' + $got); exit 1 }");
  const assign = s.indexOf("W 'AssignProcessToJobObject' @($j, $h)");
  assert.ok(start > 0 && mismatch > start && assign > mismatch, `START read (${start}), then the compare (${mismatch}), then the assign (${assign})`);
  assert.match(s, /\$first -match '\^START \(\\d\+\)\$'\) \{ \$lo = \[long\]\$Matches\[1\]; \$hi = \$lo \}/, 'an exact start is a window of one tick');
  assert.match(s, /elseif \(\$first -match '\^WINDOW \(\\d\+\) \(\\d\+\)\$'\) \{ \$lo = \[long\]\$Matches\[1\]; \$hi = \[long\]\$Matches\[2\] \}\nelse \{ exit 0 \}/, 'neither (DISARM, EOF): it leaves having assigned nothing');
  assert.ok(s.indexOf("Say 'UP'") > s.indexOf('CreateJobObjectW') && s.indexOf("Say 'UP'") < s.indexOf('$first = $in.ReadLine()'), 'UP once bound, before the first read');
  assert.match(s, /if \(\$line -eq 'KILL'\) \{[^\n]*TerminateJobObject/, 'only an explicit KILL ends the job');
});

test('helperScript: adopts the live descendants, skipping a child created before its parent and one whose pid changed hands (PR #235 Dexter 7, 10)', () => {
  const s = helperScript(777);
  assert.ok(s.indexOf("Say ('READY ") < s.indexOf('Get-CimInstance Win32_Process'), 'the pty is armed first, the walk after');
  assert.match(s, /if \(\$c \+ 20000 -lt \[long\]\$cur\[1\]\) \{ continue \}/, 'a child born before its parent is a stranger');
  assert.match(s, /if \(\[math\]::Abs\(\$s - \$c\) -gt 20000\) \{ continue \}/, 're-proven on a held handle');
  assert.match(s, /\$id -eq \$PID/, 'never the helper itself');
  // PowerShell names are case-insensitive: a `$k` anywhere overwrote the bound type and every call after it failed (measured).
  assert.doesNotMatch(s, /\$K\b/, 'the bound type is $JobApi; no variable may share its name in any case');
  assert.match(s, /\$JobApi = \$tb\.CreateType\(\)/);
  assert.match(s, /Say \('ADOPTED ' \+ \$n/);
});

// --- the parser (pure) --------------------------------------------------------------------------------------------------------------

test('splitLines: whole lines only; the tail waits, CRLF is trimmed (PR #235 Dexter 8, Miguel I3/S4)', () => {
  assert.deepStrictEqual(splitLines('READY 5 12'), { lines: [], rest: 'READY 5 12' });
  assert.deepStrictEqual(splitLines('READY 5 1234\r\nADOP'), { lines: ['READY 5 1234'], rest: 'ADOP' });
  assert.deepStrictEqual(splitLines('a\nb\n'), { lines: ['a', 'b'], rest: '' });
});

test('parseLine: each answer, whole-line anchored; anything else is nothing', () => {
  assert.deepStrictEqual(parseLine('UP'), { type: 'up' });
  assert.deepStrictEqual(parseLine('READY 286 134383984619939661'), { type: 'ready', ms: 286, start: '134383984619939661' });
  assert.deepStrictEqual(parseLine('ADOPTED 3 900'), { type: 'adopted', count: 3, ms: 900 });
  assert.deepStrictEqual(parseLine('KILLED'), { type: 'killed' });
  assert.deepStrictEqual(parseLine('KILL-FAILED TerminateJobObject failed'), { type: 'kill-failed', reason: 'TerminateJobObject failed' });
  assert.deepStrictEqual(parseLine('FAILED start-mismatch 999'), { type: 'failed', reason: 'start-mismatch' });
  assert.deepStrictEqual(parseLine('FAILED OpenProcess failed'), { type: 'failed', reason: 'failed: OpenProcess failed' });
  for (const junk of ['READY 5', 'READY 5 12x', ' READY 5 1', 'KILLED!', 'ADOPTED x 1', '', 'UP ', 'UPX']) assert.strictEqual(parseLine(junk), null, junk);
});

test('verdict: armed only on the start that was sent, or inside the window that was sent', () => {
  assert.strictEqual(verdict({ ready: { start: '1' }, proven: '1' }), 'arm');
  assert.strictEqual(verdict({ ready: { start: '2' }, proven: '1' }), 'start-mismatch');
  assert.strictEqual(verdict({ ready: { start: '1' }, proven: null }), 'unproven-start');
  assert.strictEqual(verdict({ ready: { start: '1' } }), 'unproven-start', 'nothing sent: nothing to believe');
  const window = { lo: '100', hi: '200' };
  assert.strictEqual(verdict({ ready: { start: '100' }, window }), 'arm');
  assert.strictEqual(verdict({ ready: { start: '200' }, window }), 'arm');
  assert.strictEqual(verdict({ ready: { start: '99' }, window }), 'start-mismatch');
  assert.strictEqual(verdict({ ready: { start: '201' }, window }), 'start-mismatch');
  assert.strictEqual(verdict({ ready: { start: '12x' }, window }), 'start-mismatch');
  assert.strictEqual(verdict({ ready: { start: '150' }, proven: '1', window }), 'start-mismatch', 'an exact start wins over the window');
});

// --- the spawn window (PR #235, the hub's option to K2) --------------------------------------------------------------------------------

test('msToFiletime: Date.now() milliseconds to FILETIME ticks, exactly (no float rounding on 18 digits)', () => {
  assert.strictEqual(msToFiletime(0), '116444736000000000');
  assert.strictEqual(msToFiletime(1), '116444736000010000');
  assert.strictEqual(msToFiletime(Date.UTC(2000, 0, 1)), '125911584000000000', 'the published FILETIME of 2000-01-01T00:00:00Z');
  assert.strictEqual(msToFiletime(1762387200123), (1762387200123n * 10000n + 116444736000000000n).toString());
});

test('spawnWindowOf: [before - 50 ms, after + 3 ms] in FILETIME; both edges are inside, a tick past either is not', () => {
  assert.strictEqual(WINDOW_EARLY_MS, 50);
  assert.strictEqual(WINDOW_LATE_MS, 3, 'the edge a stranger could come in by: 1 ms of Date.now() truncation + 2 ms (measured: at most 0.27 ms past)');
  const w = spawnWindowOf({ before: 1762387200000, after: 1762387200040 });
  assert.deepStrictEqual(w, { lo: msToFiletime(1762387199950), hi: msToFiletime(1762387200043) });
  const tick = (ft, d) => (BigInt(ft) + BigInt(d)).toString();
  assert.strictEqual(verdict({ ready: { start: w.lo }, window: w }), 'arm');
  assert.strictEqual(verdict({ ready: { start: tick(w.lo, -1) }, window: w }), 'start-mismatch');
  assert.strictEqual(verdict({ ready: { start: w.hi }, window: w }), 'arm');
  assert.strictEqual(verdict({ ready: { start: tick(w.hi, 1) }, window: w }), 'start-mismatch');
  for (const bad of [null, undefined, {}, { before: 5 }, { before: 10, after: 5 }, { before: NaN, after: 1 }, { before: '1', after: 2 }, { before: 0, after: 1 }]) {
    assert.strictEqual(spawnWindowOf(bad), null, JSON.stringify(bad));
  }
});

const WIN = { before: 1762387200000, after: 1762387200040 };
// Built inside each test, not at load: a module without msToFiletime fails these tests one by one, not the whole file.
const ft = (ms) => (BigInt(ms) * 10000n + 116444736000000000n).toString();
const inWindow = ft(1762387200039);
const reusedLater = ft(1762387201500);   // Dexter 1: a stranger that took the pid after the tree kill, 1.5 s in

// The deleted origin test, kept: a start the read could not get does not switch the guard off (it's exactly what happens under load).
test('attach: a start time that could not be read does not stop the guard: the spawn window proves the pty instead', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => null, spawnWindow: WIN });
  await tick();
  const w = spawnWindowOf(WIN);
  assert.deepStrictEqual(h.stdin.written, [`WINDOW ${w.lo} ${w.hi}\n`]);
  h.say(`READY 300 ${inWindow}`);
  assert.deepStrictEqual(await p, { ok: true, ms: 300, start: inWindow });
  assert.strictEqual(g.state(), 'armed');
  assert.ok(lines.some((l) => /armed for pid 777 \d+ ms after spawn \(helper 300 ms\), proven by the spawn window/.test(l)), lines.join(' | '));
});

test('attach: the helper is up and the read is still out: the window goes at once, the late read changes nothing', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  let release;
  const p = g.attach({ pid: 777, startOf: () => new Promise((r) => { release = r; }), spawnWindow: WIN });
  await tick();
  assert.deepStrictEqual(h.stdin.written, []);
  h.say('UP');
  const w = spawnWindowOf(WIN);
  assert.deepStrictEqual(h.stdin.written, [`WINDOW ${w.lo} ${w.hi}\n`]);
  release('999');
  await tick();
  assert.deepStrictEqual(h.stdin.written, [`WINDOW ${w.lo} ${w.hi}\n`], 'one first line only');
  h.say(`READY 5 ${inWindow}`);
  assert.strictEqual((await p).ok, true);
});

test('attach: with an exact start known, START goes, never the window', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => inWindow, spawnWindow: WIN });
  await tick();
  h.say('UP');
  assert.deepStrictEqual(h.stdin.written, [`START ${inWindow}\n`]);
  h.say(`READY 5 ${inWindow}`);
  assert.strictEqual((await p).ok, true);
});

test('a held stop with an unread start is sent once the window proved the pty: KILL', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => null, spawnWindow: WIN });
  assert.strictEqual(g.kill(), 'held');
  await tick();
  h.say(`READY 5 ${inWindow}`);
  assert.strictEqual((await p).ok, true);
  assert.ok(h.stdin.written.includes('KILL\n'), h.stdin.written.join(''));
  assert.strictEqual(g.outcome(), 'sent');
});

// Dexter 1's counterexample with the window: proc-start timed out, a stop is held, the tree kill ended claude and its pid went to a
// stranger X. X was created after the window, so the helper refuses it before assigning; a READY naming X is not believed either.
test('Dexter 1, windowed: the pid reused after the tree kill is refused, the held stop is dropped with a line, no KILL', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => null, spawnWindow: WIN });
  g.kill();
  await tick();
  h.say(`FAILED start-mismatch ${reusedLater}`);
  assert.deepStrictEqual(await p, { ok: false, reason: 'start-mismatch' });
  assert.ok(!h.stdin.written.includes('KILL\n'));
  assert.strictEqual(h.stdin.written[h.stdin.written.length - 1], 'DISARM\n');
  assert.strictEqual(g.outcome(), 'dropped: start-mismatch');
  assert.ok(lines.some((l) => /a held stop was dropped \(start-mismatch\)/.test(l)), lines.join(' | '));

  const h2 = fakeHelper();
  const { g: g2 } = guardWith(h2);
  const p2 = g2.attach({ pid: 777, startOf: async () => null, spawnWindow: WIN });
  g2.kill();
  await tick();
  h2.say(`READY 5 ${reusedLater}`);
  assert.deepStrictEqual(await p2, { ok: false, reason: 'start-mismatch' });
  assert.ok(!h2.stdin.written.includes('KILL\n'));
  assert.strictEqual(g2.outcome(), 'dropped: start-mismatch');
});

// --- attach -------------------------------------------------------------------------------------------------------------------------

test('attach: PowerShell with the script encoded, stderr piped; START goes out once the proof lands; READY with that start arms', async () => {
  const h = fakeHelper();
  const { g, spawned } = guardWith(h);
  let release;
  const proof = new Promise((r) => { release = r; });
  const p = g.attach({ pid: 777, startOf: () => proof });
  const [exe, args, opts] = spawned[0];
  assert.strictEqual(exe, 'PS.exe');
  assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.strictEqual(Buffer.from(args[3], 'base64').toString('utf16le'), helperScript(777));
  assert.deepStrictEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.strictEqual(opts.windowsHide, true);
  await tick();
  h.say('UP');
  assert.deepStrictEqual(h.stdin.written, [], 'nothing before the proof (no window given)');
  release('1234');
  await tick();
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n']);
  assert.strictEqual(h.stdin.ended, false, 'the pipe stays open for KILL');
  h.say('READY 286 1234');
  assert.deepStrictEqual(await p, { ok: true, ms: 286, start: '1234' });
  assert.strictEqual(g.state(), 'armed');
  assert.strictEqual(g.outcome(), 'armed');
});

test('attach: the helper\'s own start-mismatch, or a READY naming another start, is never armed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  h.say('FAILED start-mismatch 999');
  assert.deepStrictEqual(await p, { ok: false, reason: 'start-mismatch' });
  assert.strictEqual(g.kill(), 'not-armed');

  const h2 = fakeHelper();
  const { g: g2 } = guardWith(h2);
  const p2 = g2.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  h2.say('READY 5 999');
  assert.deepStrictEqual(await p2, { ok: false, reason: 'start-mismatch' });
  assert.deepStrictEqual(h2.stdin.written, ['START 1234\n', 'DISARM\n']);
});

// PR #235 Dexter 1: proc-start timed out (null), STOP-ALL tripped half a second in, the tree kill ended claude and its pid went to X; node-pty's
// onExit is a second late, so nothing says the pty exited. An unproven start is never sent, so the helper never opens X, and no KILL goes.
test('K2: startOf null, the pty not known to have exited, a held stop: DISARM, never START or KILL, and the drop is logged', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  let release;
  const p = g.attach({ pid: 777, startOf: () => new Promise((r) => { release = r; }) });
  assert.strictEqual(g.kill(), 'held', 'accepted, and said to be not done yet');
  await tick();
  release(null);
  assert.deepStrictEqual(await p, { ok: false, reason: 'unproven-start' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  h.say('READY 5 1234');   // a helper that answers anyway is not believed
  await tick();
  assert.ok(!h.stdin.written.includes('KILL\n'));
  assert.strictEqual(g.outcome(), 'dropped: unproven-start');
  assert.ok(lines.some((l) => /a held stop was dropped \(unproven-start\)/.test(l)), lines.join(' | '));
});

test('attach: FAILED from the helper is not armed, says why with its pid and time', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  await tick();
  h.say('FAILED AssignProcessToJobObject failed');
  assert.deepStrictEqual(await p, { ok: false, reason: 'failed: AssignProcessToJobObject failed' });
  assert.strictEqual(g.state(), 'failed');
  assert.strictEqual(g.outcome(), 'not-armed: failed: AssignProcessToJobObject failed');
  assert.ok(lines.some((l) => /^\[job-guard\] not armed for pid 777 after \d+ ms \(failed: AssignProcessToJobObject failed\)$/.test(l)), lines.join(' | '));
});

test('attach: a helper that never answers leaves the session plainly UNGUARDED in host.log, and is told DISARM, never killed (PR #235 Dexter 10c)', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const r = await g.attach({ pid: 777, startOf: async () => '1' });
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
  assert.ok(lines.some((l) => /the session is UNGUARDED: the job helper did not answer/.test(l)), lines.join(' | '));
  assert.strictEqual(h.stdin.written[h.stdin.written.length - 1], 'DISARM\n');
  assert.strictEqual(h.killed, 0);
});

test('attach: a helper that exits before it answers, or cannot start, is not armed and is logged (PR #235 Miguel I4)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  h.exit();
  assert.deepStrictEqual(await p, { ok: false, reason: 'helper-exited' });
  const lines = [];
  const g2 = createJobGuard({ spawnFn: () => { throw new Error('ENOENT'); }, platform: 'win32', log: (l) => lines.push(l), now: () => 5 });
  assert.deepStrictEqual(await g2.attach({ pid: 777 }), { ok: false, reason: 'spawn-failed' });
  assert.deepStrictEqual(lines, ['[job-guard] not armed for pid 777 after 0 ms (spawn-failed: ENOENT)']);
});

test('attach: what the helper wrote on stderr (an AMSI block, a parse error) is in the log line, bounded (PR #235 Miguel I4)', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  h.stderr.emit('data', Buffer.from('This script contains malicious content\r\nand has been blocked'));
  h.stderr.emit('data', Buffer.from('x'.repeat(5000)));
  h.exit();
  await p;
  const line = lines.find((l) => /helper stderr:/.test(l));
  assert.ok(line && /helper stderr: This script contains malicious content and has been blocked/.test(line), lines.join(' | '));
  assert.ok(line.length < 2300, `bounded (${line.length})`);
});

test('attach: off Windows, or with a bad pid, nothing is spawned', async () => {
  let spawns = 0;
  const spawnFn = () => { spawns++; return fakeHelper(); };
  assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'linux' }).attach({ pid: 5 }), { ok: false, reason: 'not-windows' });
  for (const pid of [0, -3, 2.5, '5', undefined]) assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'win32' }).attach({ pid }), { ok: false, reason: 'bad-pid' }, String(pid));
  assert.strictEqual(spawns, 0);
});

test('a READY split across chunks, even mid-FILETIME, is read once whole; a second READY changes nothing (PR #235 Dexter 8, Miguel I3)', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  h.stdout.emit('data', Buffer.from('READY 5 12'));
  await tick();
  assert.strictEqual(g.state(), 'starting', 'half a line is nothing yet');
  h.stdout.emit('data', Buffer.from('34\r\nREADY 6 1234\n'));
  assert.deepStrictEqual(await p, { ok: true, ms: 5, start: '1234' });
  assert.strictEqual(lines.filter((l) => /armed for pid/.test(l)).length, 1);
});

test('each attach owns its state: helper 1\'s late FAILED touches nothing of attach 2 (PR #235 Dexter 6, Miguel S2)', async () => {
  const first = fakeHelper();
  const second = fakeHelper();
  const helpers = [first, second];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 200 });
  const p1 = g.attach({ pid: 1, startOf: async () => '1' });
  await tick();
  const p2 = g.attach({ pid: 2, startOf: async () => '2' });
  await tick();
  assert.deepStrictEqual(first.stdin.written, ['START 1\n', 'DISARM\n'], 'the first is released, not killed');
  first.say('FAILED late');
  first.exit();
  await tick();
  assert.deepStrictEqual(second.stdin.written, ['START 2\n'], 'helper 2 untouched');
  assert.strictEqual(g.state(), 'starting');
  second.say('READY 5 2');
  assert.deepStrictEqual(await p2, { ok: true, ms: 5, start: '2' });
  assert.strictEqual(g.state(), 'armed');
  await p1;
});

// --- kill -----------------------------------------------------------------------------------------------------------------------------

test('kill: tells the helper KILL, once; the helper itself is never killed (killing it would end nothing)', async () => {
  const { h, g } = await armed();
  assert.strictEqual(g.kill(), 'sent');
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n', 'KILL\n']);
  assert.strictEqual(h.stdin.ended, true);
  assert.strictEqual(h.killed, 0);
  assert.strictEqual(g.state(), 'ended');
  assert.strictEqual(g.kill(), 'not-armed', 'a second ask (the stopper\'s retry) does nothing');
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n', 'KILL\n']);
});

test('kill while attaching: \'held\', and sent only once the helper reports the start it was sent', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  assert.strictEqual(g.kill(), 'held');
  assert.strictEqual(g.kill(), 'held', 'asking twice holds one stop');
  assert.strictEqual(g.outcome(), 'held');
  await tick();
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n']);
  h.say('READY 5 1234');
  assert.strictEqual((await p).ok, true);
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n', 'KILL\n']);
  assert.strictEqual(g.outcome(), 'sent');
  assert.ok(lines.some((l) => /a stop came before the arm: ending the job now/.test(l)));
});

test('a held stop that the helper\'s failure drops says so, and the outcome says dropped, not done (PR #235 Dexter 4, Miguel I1)', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  g.kill();
  await tick();
  h.say('FAILED OpenProcess failed');
  await p;
  assert.ok(!h.stdin.written.includes('KILL\n'));
  assert.strictEqual(g.outcome(), 'dropped: failed: OpenProcess failed');
  assert.ok(lines.some((l) => /a held stop was dropped \(failed: OpenProcess failed\): processes the session detached will survive it/.test(l)), lines.join(' | '));
});

test('kill: before anything was attached it does nothing', () => {
  assert.strictEqual(createJobGuard({ platform: 'win32' }).kill(), 'not-armed');
});

test('the helper ending on its own (a tree kill of the host reached it) leaves the guard released: no kill is sent afterwards', async () => {
  const { h, g } = await armed();
  h.exit();
  assert.strictEqual(g.state(), 'ended');
  assert.strictEqual(g.outcome(), 'released');
  assert.strictEqual(g.kill(), 'not-armed');
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n']);
});

test('disarm: writes DISARM and closes stdin, so the job lets everything live; kill after that does nothing', async () => {
  const { h, g } = await armed();
  g.disarm();
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n', 'DISARM\n']);
  assert.strictEqual(h.stdin.ended, true);
  assert.strictEqual(g.state(), 'released');
  assert.strictEqual(g.kill(), 'not-armed');
  assert.strictEqual(h.killed, 0);
});

// --- the answer (PR #235 Dexter 4, Miguel I1, S6) -------------------------------------------------------------------------------------

test('settled: waits for KILLED (or KILL-FAILED), at most ms; at once when no stop is waiting', async () => {
  const outcomes = [];
  const { h, g } = await armed({ onOutcome: (o) => outcomes.push(o) });
  assert.strictEqual(await g.settled(1000), 'armed', 'nothing asked: no wait');
  g.kill();
  const s = g.settled(5000);
  h.say('KILLED');
  assert.strictEqual(await s, 'killed');
  assert.deepStrictEqual(outcomes, ['arming', 'armed', 'sent', 'killed']);

  const b = await armed();
  b.g.kill();
  const t0 = Date.now();
  assert.strictEqual(await b.g.settled(80), 'sent', 'no answer: the outcome says the kill was sent, not done');
  assert.ok(Date.now() - t0 >= 70);
  b.h.say('KILL-FAILED TerminateJobObject failed');
  await tick();
  assert.strictEqual(b.g.outcome(), 'kill-failed: TerminateJobObject failed');

  const c = await armed();
  c.g.kill();
  const sc = c.g.settled(5000);
  c.h.exit();
  assert.strictEqual(await sc, 'kill-unanswered', 'a helper that left without answering');
});

test('KILL_ANSWER_MS is a few seconds: long enough for a loaded PowerShell to answer, short enough not to hold a host up', () => {
  assert.ok(KILL_ANSWER_MS >= 1000 && KILL_ANSWER_MS <= 10000, String(KILL_ANSWER_MS));
});

test('the log says how long after attach (the pty\'s spawn) the job armed, and how many descendants it adopted', async () => {
  let clock = 1000;
  const h = fakeHelper();
  const { g, lines } = guardWith(h, { now: () => clock });
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  await tick();
  clock = 1830;
  h.say('READY 286 1');
  await p;
  assert.ok(lines.includes('[job-guard] armed for pid 777 830 ms after spawn (helper 286 ms)'), lines.join(' | '));
  clock = 2500;
  h.say('ADOPTED 3 1400');
  await tick();
  assert.ok(lines.includes('[job-guard] 3 descendant(s) of pid 777 alive at the arm are in the job too (1500 ms after spawn)'), lines.join(' | '));
});

test('a logger or an onOutcome that throws never breaks the guard', async () => {
  const { r, g } = await armed({ log: () => { throw new Error('log'); }, onOutcome: () => { throw new Error('o'); } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.kill(), 'sent');
});
