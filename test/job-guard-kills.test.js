'use strict';
/**
 * Kill tests for host/job-guard.js (BACKLOG #228; Mortimer's 2026-11-23 audit: 71.0%, 203 survivors).
 *
 * THE HELPER SCRIPT IS PINNED WHOLE. Stryker mutates each of helperScript's plain string lines to "", and only a real PowerShell run
 * (test/job-guard-process.test.js, outside the mutation command) can see most of them. Every line of that script is behaviour handed
 * to another interpreter (what is compared, what is assigned, what is said back), so the script for pid 777 is pinned line by line
 * below. A deliberate change to the script changes HELPER_777 in the same commit, and the reviewer reads that diff as the script's.
 *
 * Equivalent mutants, not killed and not claimed:
 *   - validMs `typeof v === 'number'` -> true: Number.isFinite is already false for every non-number.
 *   - setOutcome `if (s !== cur) return` -> false: every setOutcome runs on the current session (release() of the old one runs
 *     before `cur` moves, and an old session's settle finds it 'released', so it sets nothing).
 *   - running() `!!s` / `!!s.child` -> true: send() is only reached for a session whose spawn returned a child.
 *   - send()'s `catch { return false }` -> `{}`: undefined is as falsy as false for its one caller that reads it.
 *   - sendKill `s.pendingKill = false` -> true, and release's: after either, the session is 'ended'/'released', and pendingKill is
 *     read only while 'starting' or 'armed'.
 *   - attach `startOf = async () => null` -> `() => undefined`: a missing proof is null either way (`typeof p === 'string'`).
 *   - the session's `up: false` -> true: offer() runs only from UP or the read's landing, and with up already true on the read's
 *     landing the window goes out at that same moment either way.
 *   - attach's stream-unref loop guard `st && typeof st.unref === 'function'` -> true (and `st ||`): it sits in a try, so a missing
 *     unref throws into the catch, which is what skipping it does.
 *   - the stderr bound `s.stderr.length < STDERR_LIMIT` -> true / `<=`: the concatenation is sliced to the limit either way.
 *   - attach's `typeof child.unref === 'function'` -> true: in a try, as above.
 *   - setOutcome's `!WAITING.has(o)` -> true: once a waiter waits, the next outcome set is never a waiting one ('held' and 'sent'
 *     are each entered once, from a non-waiting outcome), so waking on every outcome wakes on the same ones.
 *   - settle's `if (s.settled) return` -> false, `s.settled = true` -> false, and its `if (timer) clearTimeout(timer)` mutants: after
 *     the first settle the session is no longer 'starting', so a second settle changes nothing and resolve() is idempotent; the
 *     timer is unref'd.
 *   - settle's `s.pendingKill = false` -> true: the session is 'failed' right after, where pendingKill is never read.
 *   - offer's `s.proven === null` -> true: offer runs only once the read has landed (proven set) or on UP (up already true).
 *   - handle's `if (s.readySeen) return` -> false and `s.readySeen = true` -> false: a second READY meets a settled session that
 *     is no longer 'starting', so it arms nothing and resolves nothing new.
 *   - handle's last `msg.type === 'failed'` -> true: parseLine only makes the six known types, and the five others are matched
 *     before it.
 *   - the read's `.catch(() => null)` -> `() => undefined`: a non-string proof is null either way.
 *   - the read's `if (s.settled || s.st !== 'starting') return` mutants: offer() makes the same check before it sends anything.
 *   - the timer's `timer && typeof timer.unref === 'function'` -> true (and `timer ||`): Node's timers are objects with unref.
 *   - settled()'s `waiters.delete(done)` removed, `if (t)` -> true/false, `clearTimeout(t)` removed: a second done() resolves an
 *     already resolved promise; the only cost is a live timer for at most `ms`, which no outcome shows.
 * Measured (one Stryker run on this file, 2026-11-28, with job-guard.test.js, bounded-shutdown.test.js and this file): 78.60% (the
 * same command without this file) -> 94.72% (654 killed, 10 timeouts: each a mutant that leaves an attach or settled promise
 * unresolved; 37 survived). 36 survivors are the equivalents above; the 37th (the KILL-FAILED log line's text) is killed by the
 * 'KILL-FAILED is logged with its reason' test, added after that run and not counted in the number.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MODULE = require.resolve('../host/job-guard');
const { createJobGuard, helperScript, splitLines, parseLine, verdict, spawnWindowOf } = require('../host/job-guard');

// A fake helper like job-guard.test.js's, with every unref / listener recorded.
function fakeHelper({ stdin = true, stderr = true } = {}) {
  const h = new EventEmitter();
  h.pid = 4242; h.exitCode = null; h.signalCode = null; h.unrefs = [];
  h.stdout = new EventEmitter(); h.stdout.unref = () => h.unrefs.push('stdout');
  if (stderr) { h.stderr = new EventEmitter(); h.stderr.unref = () => h.unrefs.push('stderr'); } else h.stderr = null;
  if (stdin) {
    h.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, throwOnWrite: false,
      unref() { h.unrefs.push('stdin'); },
      write(s) { if (this.throwOnWrite) throw new Error('EPIPE'); this.written.push(s); }, end() { this.ended = true; } });
  } else h.stdin = null;
  h.killed = 0;
  h.kill = () => { h.killed++; return true; };
  h.unref = () => h.unrefs.push('child');
  h.exit = () => { h.exitCode = 1; h.emit('exit', 1, null); };
  h.say = (line) => h.stdout.emit('data', Buffer.from(line + '\n'));
  return h;
}
function guardWith(h, extra = {}) {
  const lines = []; const outcomes = [];
  const g = createJobGuard({ spawnFn: () => h, platform: 'win32', powershell: 'PS.exe', timeoutMs: 50, log: (l) => lines.push(l), onOutcome: (o) => outcomes.push(o), ...extra });
  return { g, lines, outcomes };
}
const tick = () => new Promise((r) => setImmediate(r));
async function armed(extra = {}, helperOpts) {
  const h = fakeHelper(helperOpts);
  const ctx = guardWith(h, extra);
  const p = ctx.g.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  h.say('READY 5 1234');
  const r = await p;
  return { h, ...ctx, r };
}

// --- the helper script, pinned --------------------------------------------------------------------------------------------------------

const HELPER_777 = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$sw = [Diagnostics.Stopwatch]::StartNew()",
  "function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }",
  "function Why($e) { ($e.Exception.Message -replace '\\s+', ' ').Trim() }",
  "function W($name, $a) { $JobApi.GetMethod($name).Invoke($null, $a) }",
  "function StartOfPid($id) { $p = [Diagnostics.Process]::GetProcessById($id); try { $v = $p.StartTime.ToFileTimeUtc(); [long]$v } finally { $p.Dispose() } }",
  "$target = 777",
  "try {",
  "  $tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'CcJobAsm'), [Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('m').DefineType('CcJob', 'Public,Class')",
  "foreach ($d in @(",
  "    @('CreateJobObjectW', [IntPtr], @([IntPtr], [IntPtr])),",
  "    @('OpenProcess', [IntPtr], @([uint32], [bool], [int])),",
  "    @('AssignProcessToJobObject', [bool], @([IntPtr], [IntPtr])),",
  "    @('TerminateJobObject', [bool], @([IntPtr], [uint32])),",
  "    @('CloseHandle', [bool], @(,[IntPtr]))",
  "  )) {",
  "    $m = $tb.DefinePInvokeMethod($d[0], 'kernel32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $d[1], [Type[]]$d[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)",
  "    $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)",
  "  }",
  "  $JobApi = $tb.CreateType()",
  "  $j = [IntPtr](W 'CreateJobObjectW' @([IntPtr]::Zero, [IntPtr]::Zero))",
  "  if ($j -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }",
  "} catch { Say ('FAILED bind: ' + (Why $_)); exit 1 }",
  "Say 'UP'",
  "$in = New-Object IO.StreamReader([Console]::OpenStandardInput())",
  "$first = $in.ReadLine()",
  "if ($first -match '^START (\\d+)$') { $lo = [long]$Matches[1]; $hi = $lo }",
  "elseif ($first -match '^WINDOW (\\d+) (\\d+)$') { $lo = [long]$Matches[1]; $hi = [long]$Matches[2] }",
  "else { exit 0 }",
  "try {",
  "  $h = [IntPtr](W 'OpenProcess' @([uint32]0x1101, $false, [int]$target))",
  "  if ($h -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }",
  "  $got = StartOfPid $target",
  "  if ($got -lt $lo -or $got -gt $hi) { Say ('FAILED start-mismatch ' + $got); exit 1 }",
  "  if (-not (W 'AssignProcessToJobObject' @($j, $h))) { throw 'AssignProcessToJobObject failed' }",
  "  Say ('READY ' + $sw.ElapsedMilliseconds + ' ' + $got)",
  "} catch { Say ('FAILED ' + (Why $_)); exit 1 }",
  "$n = 0",
  "try {",
  "  $kids = @{}",
  "  foreach ($r in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)) {",
  "    if (-not $r.CreationDate) { continue }",
  "    $k = [int]$r.ParentProcessId",
  "    if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }",
  "    [void]$kids[$k].Add($r)",
  "  }",
  "  $queue = New-Object System.Collections.Queue",
  "  $queue.Enqueue(@($target, $got))",
  "  $seen = @{}",
  "  $seen[$target] = 1",
  "  while ($queue.Count -gt 0 -and $n -lt 500) {",
  "    $cur = $queue.Dequeue()",
  "    if (-not $kids.ContainsKey([int]$cur[0])) { continue }",
  "    foreach ($r in $kids[[int]$cur[0]]) {",
  "      $id = [int]$r.ProcessId",
  "      if ($seen.ContainsKey($id) -or $id -eq $PID) { continue }",
  "      $seen[$id] = 1",
  "      $c = [long]$r.CreationDate.ToFileTimeUtc()",
  "      if ($c + 20000 -lt [long]$cur[1]) { continue }",
  "      $hc = [IntPtr](W 'OpenProcess' @([uint32]0x1101, $false, $id))",
  "      if ($hc -eq [IntPtr]::Zero) { continue }",
  "      try {",
  "        $s = StartOfPid $id",
  "        if ([math]::Abs($s - $c) -gt 20000) { continue }",
  "        if (W 'AssignProcessToJobObject' @($j, $hc)) { $n++; $queue.Enqueue(@($id, $s)) }",
  "      } catch { } finally { [void](W 'CloseHandle' @(,$hc)) }",
  "    }",
  "  }",
  "} catch { }",
  "Say ('ADOPTED ' + $n + ' ' + $sw.ElapsedMilliseconds)",
  "$line = $in.ReadLine()",
  "if ($line -eq 'KILL') { try { if (W 'TerminateJobObject' @($j, [uint32]1)) { Say 'KILLED' } else { Say 'KILL-FAILED TerminateJobObject failed' } } catch { Say ('KILL-FAILED ' + (Why $_)) } }",
];

test('helperScript(777) is exactly the reviewed script, line by line', () => {
  const got = helperScript(777).split('\n');
  for (let i = 0; i < Math.max(got.length, HELPER_777.length); i++) {
    assert.strictEqual(got[i], HELPER_777[i], `line ${i + 1} of the helper script`);
  }
});

test('helperScript: the pid is the only thing that varies', () => {
  const a = helperScript(777).split('\n');
  const b = helperScript(31337).split('\n');
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.deepStrictEqual(diff.map((i) => [a[i], b[i]]), [['$target = 777', '$target = 31337']]);
});

// --- the PowerShell path ----------------------------------------------------------------------------------------------------------------

function defaultExeWith(systemRoot) {
  const saved = process.env.SystemRoot;
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SystemRoot');
  if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
  delete require.cache[MODULE];
  try {
    const fresh = require(MODULE);
    const seen = [];
    fresh.createJobGuard({ spawnFn: (exe) => { seen.push(exe); throw new Error('no'); }, platform: 'win32', log: () => {} }).attach({ pid: 5 });
    return seen[0];
  } finally {
    if (had) process.env.SystemRoot = saved; else delete process.env.SystemRoot;
    delete require.cache[MODULE];
  }
}

test('the default PowerShell is the system one, under SystemRoot, or C:\\Windows when that is unset', () => {
  assert.strictEqual(defaultExeWith('D:\\WinX'), path.join('D:\\WinX', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.strictEqual(defaultExeWith(undefined), path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

// --- the parser -------------------------------------------------------------------------------------------------------------------------

test('splitLines trims only a CR at the END of a line', () => {
  assert.deepStrictEqual(splitLines('a\rb\r\nc'), { lines: ['a\rb'], rest: 'c' });
});

test('parseLine: every answer is anchored at both ends and its numbers may have many digits', () => {
  assert.deepStrictEqual(parseLine('ADOPTED 12 345'), { type: 'adopted', count: 12, ms: 345 });
  for (const junk of ['xADOPTED 1 2', 'ADOPTED 1 2x', 'xKILL-FAILED a', 'KILL-FAILEDx', 'xFAILED start-mismatch 1', 'xFAILED a', 'FAILEDx']) {
    assert.strictEqual(parseLine(junk), null, junk);
  }
});

test('parseLine: KILL-FAILED and FAILED with no reason (or only spaces) say unknown; the reason is trimmed', () => {
  assert.deepStrictEqual(parseLine('KILL-FAILED'), { type: 'kill-failed', reason: 'unknown' });
  assert.deepStrictEqual(parseLine('KILL-FAILED    '), { type: 'kill-failed', reason: 'unknown' });
  assert.deepStrictEqual(parseLine('KILL-FAILED  why  '), { type: 'kill-failed', reason: 'why' });
  assert.deepStrictEqual(parseLine('FAILED'), { type: 'failed', reason: 'failed: unknown' });
  assert.deepStrictEqual(parseLine('FAILED    '), { type: 'failed', reason: 'failed: unknown' });
  assert.deepStrictEqual(parseLine('FAILED  why  '), { type: 'failed', reason: 'failed: why' });
});

test('parseLine: start-mismatch with or without its number; anything after the number is a plain FAILED', () => {
  assert.deepStrictEqual(parseLine('FAILED start-mismatch'), { type: 'failed', reason: 'start-mismatch' });
  assert.deepStrictEqual(parseLine('FAILED start-mismatch 12'), { type: 'failed', reason: 'start-mismatch' });
  assert.deepStrictEqual(parseLine('FAILED start-mismatch 12x'), { type: 'failed', reason: 'failed: start-mismatch 12x' });
});

// --- the window and the verdict ---------------------------------------------------------------------------------------------------------

test('spawnWindowOf: an infinite read is no window; before === after is one', () => {
  assert.strictEqual(spawnWindowOf({ before: 1, after: Infinity }), null);
  assert.strictEqual(spawnWindowOf({ before: Infinity, after: Infinity }), null);
  assert.notStrictEqual(spawnWindowOf({ before: 1762387200000, after: 1762387200000 }), null);
});

test('verdict: a READY start that is not all digits is refused, never parsed', () => {
  const window = { lo: '100', hi: '200' };
  for (const start of ['x150', '1 50', '-150', '']) assert.strictEqual(verdict({ ready: { start }, window }), 'start-mismatch', start);
});

// --- the outcome and its waiters --------------------------------------------------------------------------------------------------------

test('settled: a HELD stop is waited for (held is not an answer), and its drop wakes the wait at once', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { timeoutMs: 5000 });
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  assert.strictEqual(g.kill(), 'held');
  const t0 = Date.now();
  const s = g.settled(4000);
  await tick();
  h.say('FAILED OpenProcess failed');
  await p;
  assert.strictEqual(await s, 'dropped: failed: OpenProcess failed', 'not "held"');
  assert.ok(Date.now() - t0 < 2000, `woken by the drop, not by the 4 s limit (${Date.now() - t0} ms)`);
});

test('settled: an unanswered SENT stop is waited for until the answer, which wakes it at once', async () => {
  const { h, g } = await armed();
  g.kill();
  const t0 = Date.now();
  const s = g.settled(4000);
  await new Promise((r) => setTimeout(r, 30));
  h.say('KILLED');
  assert.strictEqual(await s, 'killed');
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

// Q (BACKLOG #228, found by this lane, NOT fixed here: product code): a stop held before the arm, and then sent AT the arm while the
// host waits in leave(), is not waited for. setOutcome(s, 'armed') wakes the waiters ('armed' is not a waiting outcome), and sendKill
// runs in the same tick, so leave's .then sees 'sent' and calls it 'kill-unanswered' about 2 ms after KILL went out. The host then
// exits, and the helper dies with it (it is in libuv's kill-on-close job: PR #235 K4), so the KILL can be lost. Measured in memory
// 2026-11-28: leave -> 'kill-unanswered' after 2 ms, KILLED arrived 200 ms later. Un-skip once the hub decides the fix.
test('leave: a held stop sent at the arm is waited for until its answer', { skip: 'BACKLOG #228 open question: held stop at the arm is not waited for' }, async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { timeoutMs: 5000 });
  let release;
  g.attach({ pid: 777, startOf: () => new Promise((r) => { release = r; }) });
  assert.strictEqual(g.kill(), 'held');
  const lv = g.leave(4000);
  await tick();
  release('1234');
  await tick();
  h.say('READY 5 1234');
  setTimeout(() => h.say('KILLED'), 100);
  assert.strictEqual(await lv, 'killed');
});

test('settled: KILL-FAILED and a helper leaving also wake the wait at once', async () => {
  for (const answer of ['KILL-FAILED nope', null]) {
    const { h, g } = await armed();
    g.kill();
    const t0 = Date.now();
    const s = g.settled(4000);
    if (answer) h.say(answer); else h.exit();
    assert.strictEqual(await s, answer ? 'kill-failed: nope' : 'kill-unanswered');
    assert.ok(Date.now() - t0 < 2000, String(answer));
  }
});

test('settled: with nothing attached it answers null at once', async () => {
  assert.strictEqual(await createJobGuard({ platform: 'win32' }).settled(5000), null);
});

test('settled: two waiters on one stop both hear the answer, and a waiter that timed out is gone', async () => {
  const { h, g } = await armed();
  g.kill();
  const early = await g.settled(10);
  assert.strictEqual(early, 'sent');
  const a = g.settled(4000); const b = g.settled(4000);
  h.say('KILLED');
  assert.deepStrictEqual(await Promise.all([a, b]), ['killed', 'killed']);
});

// --- sending ----------------------------------------------------------------------------------------------------------------------------

test('a helper that has exited (by code or by signal) without its exit event yet is not written to: the stop says the helper is gone', async () => {
  for (const gone of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
    const { h, g, lines } = await armed();
    Object.assign(h, gone);
    assert.strictEqual(g.kill(), 'sent');
    assert.deepStrictEqual(h.stdin.written, ['START 1234\n'], JSON.stringify(gone));
    assert.strictEqual(g.outcome(), 'kill-failed: the helper is gone');
    assert.ok(lines.includes('[job-guard] the job could not be told to end: its helper is gone'), lines.join(' | '));
  }
});

test('a write that throws is a stop not delivered', async () => {
  const { h, g } = await armed();
  h.stdin.throwOnWrite = true;
  g.kill();
  assert.strictEqual(g.outcome(), 'kill-failed: the helper is gone');
});

test('release: an ended or failed session is not released again (no DISARM after a KILL, the outcome stays)', async () => {
  const { h, g } = await armed();
  g.kill();
  g.disarm();
  assert.deepStrictEqual(h.stdin.written, ['START 1234\n', 'KILL\n']);
  assert.strictEqual(g.outcome(), 'sent');
  assert.strictEqual(g.state(), 'ended');
});

test('release: a disarm with no stop held is "released", never "dropped"', async () => {
  const { g, outcomes, lines } = await armed();
  g.disarm();
  assert.strictEqual(g.outcome(), 'released');
  assert.strictEqual(outcomes[outcomes.length - 1], 'released');
  assert.ok(!lines.some((l) => /dropped/.test(l)), lines.join(' | '));
  const h = fakeHelper();
  const c = guardWith(h, { timeoutMs: 5000 });
  c.g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  c.g.disarm();
  assert.strictEqual(c.g.outcome(), 'released', 'while starting too');
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
});

test('a new attach drops the earlier session\'s held stop and says why', async () => {
  const first = fakeHelper(); const second = fakeHelper();
  const helpers = [first, second];
  const outcomes = []; const lines = [];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 5000, log: (l) => lines.push(l), onOutcome: (o) => outcomes.push(o) });
  g.attach({ pid: 1, startOf: () => new Promise(() => {}) });
  g.kill();
  g.attach({ pid: 2, startOf: () => new Promise(() => {}) });
  assert.ok(outcomes.includes('dropped: a new session'), outcomes.join(','));
  assert.ok(lines.includes('[job-guard] a held stop was dropped (a new session): processes the session detached will survive it'), lines.join(' | '));
});

// --- attach: spawn and wiring -----------------------------------------------------------------------------------------------------------

test('attach: a spawn that throws is state "failed", outcome "not-armed: spawn-failed", and an error with no message says unknown', async () => {
  const lines = []; const outcomes = [];
  const g = createJobGuard({ spawnFn: () => { throw new Error(''); }, platform: 'win32', log: (l) => lines.push(l), onOutcome: (o) => outcomes.push(o), now: () => 5 });
  assert.deepStrictEqual(await g.attach({ pid: 777 }), { ok: false, reason: 'spawn-failed' });
  assert.strictEqual(g.state(), 'failed');
  assert.strictEqual(g.outcome(), 'not-armed: spawn-failed');
  assert.deepStrictEqual(outcomes, ['arming', 'not-armed: spawn-failed']);
  assert.deepStrictEqual(lines, ['[job-guard] not armed for pid 777 after 0 ms (spawn-failed: unknown)']);
});

test('attach: a clock that throws after the first read logs "null ms", never breaks the guard', async () => {
  let calls = 0;
  const lines = [];
  const g = createJobGuard({ spawnFn: () => { throw new Error('x'); }, platform: 'win32', log: (l) => lines.push(l), now: () => { if (calls++ > 0) throw new Error('clock'); return 1; } });
  await g.attach({ pid: 777 });
  assert.deepStrictEqual(lines, ['[job-guard] not armed for pid 777 after null ms (spawn-failed: x)']);
});

test('attach: every pipe and the child are unref\'d, and stdin has an error listener', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  assert.deepStrictEqual(h.unrefs.sort(), ['child', 'stderr', 'stdin', 'stdout']);
  assert.strictEqual(h.stdin.listenerCount('error'), 1);
  assert.doesNotThrow(() => h.stdin.emit('error', new Error('EPIPE')), 'a broken pipe is heard, not thrown');
  await p;
});

test('attach: a helper with no stdin or no stderr (or ones without on/unref) still attaches', async () => {
  for (const opts of [{ stdin: false }, { stderr: false }]) {
    const h = fakeHelper(opts);
    const { g } = guardWith(h);
    const p = g.attach({ pid: 777, startOf: async () => '1' });
    await tick();
    h.say('READY 5 1');
    assert.strictEqual((await p).ok, true, JSON.stringify(opts));
  }
  const bare = fakeHelper();
  bare.stdin = { written: [], write(s) { this.written.push(s); }, end() {} };
  bare.stderr = {};
  delete bare.unref;
  const { g } = guardWith(bare);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  await tick();
  bare.say('READY 5 1');
  assert.strictEqual((await p).ok, true);
});

test('attach: the stderr note folds every run of whitespace into one space', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  h.stderr.emit('data', Buffer.from('  a\r\n\tb  \n'));
  h.exit();
  await p;
  assert.ok(lines.some((l) => l.endsWith('; helper stderr: a b')), lines.join(' | '));
});

test('attach: a helper with no stdout still attaches and times out plainly', async () => {
  const h = fakeHelper();
  h.stdout = null;
  const { g } = guardWith(h);
  assert.deepStrictEqual(await g.attach({ pid: 777, startOf: async () => '1' }), { ok: false, reason: 'timeout' });
});

test('attach: a line that is not an answer is ignored, never thrown', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  assert.doesNotThrow(() => h.say('WARNING: something PowerShell printed'));
  await tick();
  h.say('READY 5 1');
  assert.strictEqual((await p).ok, true);
});

test('attach: a spawn error event is "spawn-failed"', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  h.emit('error', new Error('ENOENT'));
  assert.deepStrictEqual(await p, { ok: false, reason: 'spawn-failed' });
  assert.strictEqual(g.outcome(), 'not-armed: spawn-failed');
});

test('attach: the timeout line names the limit in whole seconds', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h, { timeoutMs: 1000 });
  await g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  assert.ok(lines.includes('[job-guard] the session is UNGUARDED: the job helper did not answer within 1 s, so processes it detaches will survive a stop'), lines.join(' | '));
});

test('attach: the ready timer is unref\'d, so a silent helper never holds a host open', () => {
  const realSet = global.setTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { const t = realSet(fn, ms); const u = t.unref.bind(t); t.unref = () => { timers.push(ms); return u(); }; return t; };
  let g;
  try {
    g = createJobGuard({ spawnFn: () => fakeHelper(), platform: 'win32', timeoutMs: 60000 });
    g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  } finally { global.setTimeout = realSet; }
  assert.deepStrictEqual(timers, [60000]);
  g.disarm();
});

test('attach: a proof that is not a digit string is no proof: unproven-start, nothing sent', async () => {
  for (const bad of [1234, '12x', 'x12', '', '1 2']) {
    const h = fakeHelper();
    const { g } = guardWith(h, { timeoutMs: 2000 });
    assert.deepStrictEqual(await g.attach({ pid: 777, startOf: async () => bad }), { ok: false, reason: 'unproven-start' }, JSON.stringify(bad));
    assert.deepStrictEqual(h.stdin.written, ['DISARM\n'], JSON.stringify(bad));
  }
});

test('attach: the WINDOW line keeps stdin open for the KILL that may follow', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { timeoutMs: 2000 });
  const p = g.attach({ pid: 777, startOf: async () => null, spawnWindow: { before: 1762387200000, after: 1762387200040 } });
  await tick();
  assert.match(h.stdin.written[0], /^WINDOW \d+ \d+\n$/);
  assert.strictEqual(h.stdin.ended, false);
  h.say('READY 5 ' + (1762387200039n * 10000n + 116444736000000000n).toString());
  assert.strictEqual((await p).ok, true);
});

test('a READY that lands after a disarm resolves ok but does not arm: the session stays released', async () => {
  const h = fakeHelper();
  const { g, lines, outcomes } = guardWith(h, { timeoutMs: 2000 });
  const p = g.attach({ pid: 777, startOf: async () => '1234' });
  await tick();
  g.disarm();
  h.say('READY 5 1234');
  assert.deepStrictEqual(await p, { ok: true, ms: 5, start: '1234' });
  assert.strictEqual(g.state(), 'released');
  assert.strictEqual(g.outcome(), 'released');
  assert.ok(!outcomes.includes('armed'));
  assert.ok(!lines.some((l) => /armed for pid/.test(l)), lines.join(' | '));
});

test('a disarmed helper that then exits changes nothing: still released, no "ended before any stop" line', async () => {
  const { h, g, lines } = await armed();
  g.disarm();
  h.exit();
  assert.strictEqual(g.state(), 'released');
  assert.strictEqual(g.outcome(), 'released');
  assert.ok(!lines.some((l) => /ended before any stop/.test(l)), lines.join(' | '));
  const h2 = fakeHelper();
  const c = guardWith(h2, { timeoutMs: 5000 });
  const p2 = c.g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  c.g.disarm();
  h2.exit();
  await p2;
  assert.strictEqual(c.g.outcome(), 'released', 'a release while starting is not turned into not-armed by the exit');
  assert.deepStrictEqual(h2.stdin.written, ['DISARM\n'], 'and DISARM is not sent twice');
});

test('an armed helper that exits on its own says so, exactly', async () => {
  const { h, lines } = await armed();
  h.exit();
  assert.ok(lines.includes('[job-guard] the helper ended before any stop; nothing in its job was ended, and the job no longer guards'), lines.join(' | '));
});

test('KILL-FAILED is logged with its reason, exactly', async () => {
  const { h, g, lines } = await armed();
  g.kill();
  h.say('KILL-FAILED TerminateJobObject failed');
  assert.ok(lines.includes('[job-guard] the job could not be ended (TerminateJobObject failed)'), lines.join(' | '));
});

test('KILLED is logged as the job ended', async () => {
  const { h, g, lines } = await armed();
  g.kill();
  h.say('KILLED');
  assert.ok(lines.includes('[job-guard] the job was ended'), lines.join(' | '));
});

test('an EARLIER helper exiting after a new attach is not heard: no "left before it answered" line for a session that is gone', async () => {
  const first = fakeHelper(); const second = fakeHelper();
  const helpers = [first, second];
  const lines = [];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 2000, log: (l) => lines.push(l) });
  const p1 = g.attach({ pid: 1, startOf: async () => '1' });
  await tick();
  first.say('READY 5 1');
  await p1;
  g.kill();
  g.attach({ pid: 2, startOf: () => new Promise(() => {}) });
  first.exit();
  assert.ok(!lines.some((l) => /left before it answered/.test(l)), lines.join(' | '));
  g.disarm();
});

test('settled: no stop waiting answers at once, not after its limit', async () => {
  const { g } = await armed();
  const t0 = Date.now();
  assert.strictEqual(await g.settled(4000), 'armed');
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test('with nothing attached: state "idle", leave null, disarm a no-op', async () => {
  const g = createJobGuard({ platform: 'win32' });
  assert.strictEqual(g.state(), 'idle');
  assert.strictEqual(g.outcome(), null);
  assert.doesNotThrow(() => g.disarm());
  assert.strictEqual(await g.leave(10), null);
});

test('a failed arm tells the helper DISARM and closes its stdin', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1' });
  await tick();
  h.say('FAILED OpenProcess failed');
  await p;
  assert.deepStrictEqual(h.stdin.written, ['START 1\n', 'DISARM\n']);
  assert.strictEqual(h.stdin.ended, true);
});

test('an UP after a disarm sends nothing: no WINDOW to a released helper', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { timeoutMs: 2000 });
  g.attach({ pid: 777, startOf: () => new Promise(() => {}), spawnWindow: { before: 1762387200000, after: 1762387200040 } });
  await tick();
  g.disarm();
  h.say('UP');
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
});

test('a helper that leaves after the KILL went out, before answering, says so exactly', async () => {
  const { h, g, lines } = await armed();
  g.kill();
  h.exit();
  assert.strictEqual(g.outcome(), 'kill-unanswered');
  assert.ok(lines.includes('[job-guard] the helper left before it answered the stop'), lines.join(' | '));
});

test('an EARLIER helper\'s answer after a new attach is not heard: no "the job was ended" line for a session that is gone', async () => {
  const first = fakeHelper(); const second = fakeHelper();
  const helpers = [first, second];
  const lines = [];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 2000, log: (l) => lines.push(l) });
  const p1 = g.attach({ pid: 1, startOf: async () => '1' });
  await tick();
  first.say('READY 5 1');
  await p1;
  g.kill();
  g.attach({ pid: 2, startOf: () => new Promise(() => {}) });
  first.say('KILLED');
  assert.ok(!lines.includes('[job-guard] the job was ended'), lines.join(' | '));
  g.disarm();
});

test('kill while starting, asked twice: one held stop, said once, exactly', async () => {
  const h = fakeHelper();
  const { g, lines, outcomes } = guardWith(h, { timeoutMs: 2000 });
  g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  g.kill(); g.kill();
  assert.deepStrictEqual(lines.filter((l) => /a stop came before the job was armed/.test(l)),
    ['[job-guard] a stop came before the job was armed: held until the helper proves it holds this pty']);
  assert.deepStrictEqual(outcomes.filter((o) => o === 'held'), ['held']);
  g.disarm();
});

test('disarm with a stop held: the drop names the disarm', async () => {
  const h = fakeHelper();
  const { g, lines } = guardWith(h, { timeoutMs: 2000 });
  g.attach({ pid: 777, startOf: () => new Promise(() => {}) });
  g.kill();
  g.disarm();
  assert.strictEqual(g.outcome(), 'dropped: disarmed');
  assert.ok(lines.includes('[job-guard] a held stop was dropped (disarmed): processes the session detached will survive it'), lines.join(' | '));
});
