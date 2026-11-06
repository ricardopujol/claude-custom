'use strict';
/**
 * Every process the session starts dies with the session when a stop asks (BACKLOG #127, Dexter F2, PR #210).
 *
 * THE GAP. `taskkill /T` from claude's pid walks the parent links, and Windows keeps a process's ParentProcessId after the parent
 * has exited. A grandchild whose parent already exited (`Start-Process -WindowStyle Hidden npx stryker run`, `nohup x & disown`)
 * has no live path back to claude, so a stop ended claude and left that process running with no host that knew its pid.
 *
 * WHY A JOB OBJECT, NOT A SNAPSHOT (measured, verify/probe-kill-switch-detached.js). A snapshot of claude's descendants kept while
 * the session runs cannot see a grandchild whose parent exits before the next sample (about 670 ms per sample). A Windows Job Object
 * does not look at parent links: every process started by a member joins the job, and TerminateJobObject ends all of them.
 *
 * HOW. One PowerShell helper per session. Its Win32 calls are bound in memory through Reflection.Emit (as host/process-suspend.js
 * does), never `Add-Type`: Add-Type runs csc.exe, which took over 30 s on a loaded machine (PR #158, PR #235 Miguel B1). The helper
 * is spawned at once and creates the job while the pty's start time is being read; then:
 *   stdin `START <FILETIME>`   the helper opens the pty by pid (and keeps that handle, so the pid can't be reused while it runs),
 *                              reads the opened process's start time, and only if it equals the one sent assigns it to the job
 *                              (`READY <ms> <start>`); a different start is `FAILED start-mismatch`, BEFORE any assignment, so a
 *                              stranger is never put in a job (PR #235 Dexter 5). A start that could not be proven is never sent:
 *                              the guard tells the helper DISARM and the session runs unguarded (Dexter 1).
 *   at once after READY         the pty's descendants alive at that moment are put in the job too (`ADOPTED <n> <ms>`): a child is
 *                              followed only when it was not created before its parent (a reused parent pid can't adopt a stranger)
 *                              and its start, read on a held handle, is still the one the process table had (Dexter 7, 10).
 *   stdin `KILL`               TerminateJobObject: Windows ends every process in the job (`KILLED` / `KILL-FAILED <why>`).
 *   anything else, or EOF      the helper leaves and its handle closes: nothing dies. The job sets NO limits at all:
 *     - no KILL_ON_JOB_CLOSE: the helper is a child of the host, so every `taskkill /T` of the HOST (the shutdown watchdog, *Stop that
 *       session*'s last resort, the sweep) reaches it; with kill-on-close that ended the whole job. Measured (job-guard-process test,
 *       'helper-killed'): with it the grandchild died, without it it lives.
 *     - no BREAKAWAY_OK. Measured 2026-11-05: with it, Git Bash's `nohup x & disown` child left the job (Cygwin breaks away whenever
 *       the job allows it); without it Git Bash and `Start-Process` start their children normally, inside the job. A program that
 *       insists on CREATE_BREAKAWAY_FROM_JOB gets access denied from CreateProcess while the session is in the job.
 *
 * WHICH STOPS END THE JOB: decided in ONE place, host/kill-switch.js jobEndsFor(). As built, every stop of the kill switch does
 * (STOP-ALL, the project's STOP, the night budget); an ordinary end (claude exits, the window closes, the host is killed) never does.
 *
 * WHAT STILL ESCAPES (stated on purpose, pinned by test/job-guard-process.test.js). The pty joins the job only once the helper has
 * assigned it, about 0.5 s after spawn idle and over 1 s under load (measured: verify/README.md). A process the session started in
 * that time that is still alive at the arm is adopted, and everything it starts later joins with it (MCP servers, hooks). A process
 * that was started AND orphaned before the arm (its parent exited before the arm) is not reached: nothing links it to the pty any
 * more. Nor is anything outside the pty's tree (a process started through COM, the Task Scheduler or Explorer).
 *
 * A STOP BEFORE THE ARM is held, and sent only once the helper reports the start it was sent (kill() answers 'held'); a held stop
 * that can't be sent (no proof, a failure, a timeout) is dropped and says so. THE ANSWER IS WAITED FOR: the helper is in libuv's
 * kill-on-close job, so it dies with the host, and a host that exits right after KILL loses it (measured, PR #235 K4). The host
 * waits for settled(KILL_ANSWER_MS) before it exits.
 *
 *   createJobGuard({ spawnFn, platform, powershell, log, timeoutMs, now, onOutcome })
 *     -> { attach({ pid, startOf }) -> Promise<result>, kill() -> 'sent' | 'held' | 'not-armed', disarm(), state(), outcome(),
 *          settled(ms) -> Promise<outcome> }
 *       result   { ok: true, ms, start } | { ok: false, reason }    reason: 'not-windows' | 'bad-pid' | 'spawn-failed' | 'unproven-start' |
 *                                                                   'start-mismatch' | 'failed: <why>' | 'timeout' | 'helper-exited'
 *       outcome  null | 'arming' | 'armed' | 'held' | 'sent' | 'killed' | 'kill-failed: <why>' | 'kill-unanswered' |
 *                'not-armed: <reason>' | 'dropped: <reason>' | 'released'
 *   helperScript(pid), splitLines(buffer), parseLine(line), verdict({ ready, proven })   (pure, exported for the tests)
 */
const { spawn } = require('child_process');
const path = require('path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const READY_TIMEOUT_MS = 15000;
// How long the host waits for the helper's answer to a KILL before it exits. Well under the shutdown watchdog's bound
// (test/bounded-shutdown.test.js pins it).
const KILL_ANSWER_MS = 10000;
const ADOPT_LIMIT = 500;
const CIM_SLACK_TICKS = 20000;   // 2 ms: the process table's CreationDate is microseconds, a handle's StartTime 100 ns ticks
const STDERR_LIMIT = 2000;

// The kernel32 calls, bound in memory (no csc.exe). SetLastError isn't available this way, so a failure names the call, not the code.
const BIND = `$tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'CcJobAsm'), [Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('m').DefineType('CcJob', 'Public,Class')
foreach ($d in @(
    @('CreateJobObjectW', [IntPtr], @([IntPtr], [IntPtr])),
    @('OpenProcess', [IntPtr], @([uint32], [bool], [int])),
    @('AssignProcessToJobObject', [bool], @([IntPtr], [IntPtr])),
    @('TerminateJobObject', [bool], @([IntPtr], [uint32])),
    @('CloseHandle', [bool], @(,[IntPtr]))
  )) {
    $m = $tb.DefinePInvokeMethod($d[0], 'kernel32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $d[1], [Type[]]$d[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $JobApi = $tb.CreateType()`;   // not $K: PowerShell variables are case-insensitive, and the walk below uses $k

// PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION: what AssignProcessToJobObject needs.
const ACCESS = '0x1101';

function helperScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('job guard: pid must be a positive integer');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",   // no CLIXML progress records on stderr: stderr is for real errors (host.log)
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }',
    "function Why($e) { ($e.Exception.Message -replace '\\s+', ' ').Trim() }",
    'function W($name, $a) { $JobApi.GetMethod($name).Invoke($null, $a) }',
    // The start of the process a HELD handle names: the same source as host/proc-start.js (Get-Process StartTime).
    // (Not named Ft: `ft` is PowerShell's alias for Format-Table, and an alias wins over a function.)
    'function StartOfPid($id) { $p = [Diagnostics.Process]::GetProcessById($id); try { $v = $p.StartTime.ToFileTimeUtc(); [long]$v } finally { $p.Dispose() } }',
    `$target = ${pid}`,
    'try {',
    `  ${BIND}`,
    "  $j = [IntPtr](W 'CreateJobObjectW' @([IntPtr]::Zero, [IntPtr]::Zero))",
    "  if ($j -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }",
    "} catch { Say ('FAILED bind: ' + (Why $_)); exit 1 }",
    // ONE reader for all of stdin, so no line can sit in a buffer the next read doesn't see.
    '$in = New-Object IO.StreamReader([Console]::OpenStandardInput())',
    // The first line: the pty's proven start, or anything else (DISARM, EOF): then nothing was ever assigned.
    '$first = $in.ReadLine()',
    "if (-not ($first -match '^START (\\d+)$')) { exit 0 }",
    '$want = [long]$Matches[1]',
    'try {',
    `  $h = [IntPtr](W 'OpenProcess' @([uint32]${ACCESS}, $false, [int]$target))`,
    "  if ($h -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }",
    '  $got = StartOfPid $target',
    // Compared BEFORE the assignment: a stranger is never put in the job (PR #235 Dexter 5).
    "  if ($got -ne $want) { Say ('FAILED start-mismatch ' + $got); exit 1 }",
    "  if (-not (W 'AssignProcessToJobObject' @($j, $h))) { throw 'AssignProcessToJobObject failed' }",
    "  Say ('READY ' + $sw.ElapsedMilliseconds + ' ' + $got)",
    "} catch { Say ('FAILED ' + (Why $_)); exit 1 }",
    // The pty's descendants alive now (PR #235 Dexter 7, 10): followed down the parent links; a child created before its parent is a
    // stranger under a reused pid and is skipped, and each is re-proven on a held handle before it is assigned.
    // The walk runs to the end even when a KILL is already waiting: a stop that cut it short would leave the descendants alive at the
    // arm out of the job (measured: a KILL at the arm, 0 adopted, the pre-arm child survived). The host waits KILL_ANSWER_MS for the
    // answer, above the slowest walk measured (the process table took 4.6 s under load).
    '$n = 0',
    'try {',
    '  $kids = @{}',
    '  foreach ($r in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)) {',
    '    if (-not $r.CreationDate) { continue }',
    '    $k = [int]$r.ParentProcessId',
    '    if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }',
    '    [void]$kids[$k].Add($r)',
    '  }',
    '  $queue = New-Object System.Collections.Queue',
    '  $queue.Enqueue(@($target, $got))',
    '  $seen = @{}',
    '  $seen[$target] = 1',
    `  while ($queue.Count -gt 0 -and $n -lt ${ADOPT_LIMIT}) {`,
    '    $cur = $queue.Dequeue()',
    '    if (-not $kids.ContainsKey([int]$cur[0])) { continue }',
    '    foreach ($r in $kids[[int]$cur[0]]) {',
    '      $id = [int]$r.ProcessId',
    '      if ($seen.ContainsKey($id) -or $id -eq $PID) { continue }',
    '      $seen[$id] = 1',
    '      $c = [long]$r.CreationDate.ToFileTimeUtc()',
    `      if ($c + ${CIM_SLACK_TICKS} -lt [long]$cur[1]) { continue }`,
    `      $hc = [IntPtr](W 'OpenProcess' @([uint32]${ACCESS}, $false, $id))`,
    '      if ($hc -eq [IntPtr]::Zero) { continue }',
    '      try {',
    '        $s = StartOfPid $id',
    `        if ([math]::Abs($s - $c) -gt ${CIM_SLACK_TICKS}) { continue }`,
    "        if (W 'AssignProcessToJobObject' @($j, $hc)) { $n++; $queue.Enqueue(@($id, $s)) }",
    "      } catch { } finally { [void](W 'CloseHandle' @(,$hc)) }",
    '    }',
    '  }',
    '} catch { }',
    "Say ('ADOPTED ' + $n + ' ' + $sw.ElapsedMilliseconds)",
    '$line = $in.ReadLine()',
    "if ($line -eq 'KILL') { try { if (W 'TerminateJobObject' @($j, [uint32]1)) { Say 'KILLED' } else { Say 'KILL-FAILED TerminateJobObject failed' } } catch { Say ('KILL-FAILED ' + (Why $_)) } }",
  ].join('\n');
}

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

// Whole lines only (PR #235 Dexter 8, Miguel I3): a chunk can end mid-line, even mid-FILETIME, so the tail waits for the next chunk.
function splitLines(buffer) {
  const parts = String(buffer).split('\n');
  const rest = parts.pop();
  return { lines: parts.map((l) => l.replace(/\r$/, '')), rest };
}

function parseLine(line) {
  let m;
  if ((m = /^READY (\d+) (\d+)$/.exec(line))) return { type: 'ready', ms: Number(m[1]), start: m[2] };
  if ((m = /^ADOPTED (\d+) (\d+)$/.exec(line))) return { type: 'adopted', count: Number(m[1]), ms: Number(m[2]) };
  if (line === 'KILLED') return { type: 'killed' };
  if ((m = /^KILL-FAILED(?: (.*))?$/.exec(line))) return { type: 'kill-failed', reason: (m[1] || '').trim() || 'unknown' };
  if ((m = /^FAILED start-mismatch(?: (\d+))?$/.exec(line))) return { type: 'failed', reason: 'start-mismatch' };
  if ((m = /^FAILED(?: (.*))?$/.exec(line))) return { type: 'failed', reason: `failed: ${(m[1] || '').trim() || 'unknown'}` };
  return null;
}

// The helper only assigns the start it was sent, so a READY naming another one is a helper that can't be believed.
function verdict({ ready, proven }) {
  if (typeof proven !== 'string') return 'unproven-start';
  return ready && ready.start === proven ? 'arm' : 'start-mismatch';
}

const WAITING = new Set(['held', 'sent']);   // a stop asked for and not yet answered

function createJobGuard({ spawnFn = spawn, platform = process.platform, powershell = POWERSHELL, log = () => {}, timeoutMs = READY_TIMEOUT_MS, now = Date.now, onOutcome = () => {} } = {}) {
  let cur = null;   // the current attach's session; callbacks of an earlier one are ignored (PR #235 Dexter 6, Miguel S2)
  const say = (line) => { try { log(`[job-guard] ${line}`); } catch { /* the guard never breaks the host */ } };
  const waiters = new Set();

  function setOutcome(s, o) {
    s.outcome = o;
    if (s !== cur) return;
    try { onOutcome(o); } catch { /* the guard never breaks the host */ }
    if (!WAITING.has(o)) for (const w of [...waiters]) w(o);
  }
  const running = (s) => !!s && !!s.child && s.child.exitCode === null && s.child.signalCode === null;
  function send(s, line, final) {
    if (!running(s)) return false;
    try { s.child.stdin.write(`${line}\n`); if (final) s.child.stdin.end(); return true; } catch { return false; }
  }

  function sendKill(s) {
    s.st = 'ended';
    s.pendingKill = false;
    setOutcome(s, 'sent');
    if (!send(s, 'KILL', true)) { say('the job could not be told to end: its helper is gone'); setOutcome(s, 'kill-failed: the helper is gone'); }
    return 'sent';
  }

  function release(s, why) {
    if (s.st !== 'starting' && s.st !== 'armed') return;
    if (s.pendingKill) { s.pendingKill = false; say(`a held stop was dropped (${why}): processes the session detached will survive it`); setOutcome(s, `dropped: ${why}`); }
    else setOutcome(s, 'released');
    s.st = 'released';
    send(s, 'DISARM', true);
  }

  function attach({ pid, startOf = async () => null } = {}) {
    if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'not-windows' });
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, reason: 'bad-pid' });
    if (cur) release(cur, 'a new session');      // one helper at a time: an earlier session's job is released, not ended
    // host.js attaches right after pty.spawn, so this is how long the session ran outside the job (PR #235 hub H1).
    const t0 = now();
    const since = () => { try { return Math.max(0, Math.round(now() - t0)); } catch { return null; } };
    const s = { child: null, st: 'starting', pendingKill: false, outcome: null, proven: undefined, settled: false, readySeen: false, stderr: '' };
    cur = s;
    setOutcome(s, 'arming');
    try {
      s.child = spawnFn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(helperScript(pid))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      s.st = 'failed';
      say(`not armed for pid ${pid} after ${since()} ms (spawn-failed: ${(err && err.message) || 'unknown'})`);
      setOutcome(s, 'not-armed: spawn-failed');
      return Promise.resolve({ ok: false, reason: 'spawn-failed' });
    }
    const child = s.child;
    for (const st of [child.stdin, child.stdout, child.stderr]) { try { if (st && typeof st.unref === 'function') st.unref(); } catch { /* optional */ } }
    try { if (typeof child.unref === 'function') child.unref(); } catch { /* optional */ }
    if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
    // What PowerShell says on stderr (an AMSI or ASR block, a parse error) goes to host.log, bounded (PR #235 Miguel I4).
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (d) => { if (s.stderr.length < STDERR_LIMIT) s.stderr = (s.stderr + String(d)).slice(0, STDERR_LIMIT); });
    }
    const stderrNote = () => { const t = s.stderr.replace(/\s+/g, ' ').trim(); return t ? `; helper stderr: ${t}` : ''; };

    return new Promise((resolve) => {
      let timer = null;
      const settle = (r) => {
        if (s.settled) return;
        s.settled = true;
        if (timer) clearTimeout(timer);
        if (!r.ok && s.st === 'starting') {
          s.st = 'failed';
          if (r.reason === 'timeout') say(`the session is UNGUARDED: the job helper did not answer within ${Math.round(timeoutMs / 1000)} s, so processes it detaches will survive a stop${stderrNote()}`);
          else say(`not armed for pid ${pid} after ${since()} ms (${r.reason})${stderrNote()}`);
          if (s.pendingKill) { s.pendingKill = false; say(`a held stop was dropped (${r.reason}): processes the session detached will survive it`); setOutcome(s, `dropped: ${r.reason}`); }
          else setOutcome(s, `not-armed: ${r.reason}`);
          send(s, 'DISARM', true);
        }
        resolve(r);
      };
      const handle = (msg) => {
        if (msg.type === 'ready') {
          if (s.readySeen) return;
          s.readySeen = true;
          const v = verdict({ ready: msg, proven: s.proven });
          if (v !== 'arm') { settle({ ok: false, reason: v }); return; }
          if (s.st !== 'starting') { settle({ ok: true, ms: msg.ms, start: msg.start }); return; }   // released meanwhile
          s.st = 'armed';
          say(`armed for pid ${pid} ${since()} ms after spawn (helper ${msg.ms} ms)`);
          setOutcome(s, 'armed');
          const held = s.pendingKill;
          settle({ ok: true, ms: msg.ms, start: msg.start });
          if (held) { say('a stop came before the arm: ending the job now'); sendKill(s); }
        } else if (msg.type === 'adopted') {
          say(`${msg.count} descendant(s) of pid ${pid} alive at the arm are in the job too (${since()} ms after spawn)`);
        } else if (msg.type === 'killed') {
          say('the job was ended');
          setOutcome(s, 'killed');
        } else if (msg.type === 'kill-failed') {
          say(`the job could not be ended (${msg.reason})`);
          setOutcome(s, `kill-failed: ${msg.reason}`);
        } else if (msg.type === 'failed') {
          settle({ ok: false, reason: msg.reason });
        }
      };
      child.on('error', () => settle({ ok: false, reason: 'spawn-failed' }));
      child.on('exit', () => {
        if (s !== cur) return;
        if (s.outcome === 'sent') { say(`the helper left before it answered the stop${stderrNote()}`); setOutcome(s, 'kill-unanswered'); }
        else if (s.st === 'armed') { s.st = 'ended'; say(`the helper ended before any stop; nothing in its job was ended, and the job no longer guards${stderrNote()}`); setOutcome(s, 'released'); }
        settle({ ok: false, reason: 'helper-exited' });
      });
      if (child.stdout) {
        let buf = '';
        child.stdout.on('data', (d) => {
          const { lines, rest } = splitLines(buf + String(d));
          buf = rest;
          if (s !== cur) return;
          for (const line of lines) { const msg = parseLine(line); if (msg) handle(msg); }
        });
      }
      // The proof runs while PowerShell starts: only a proven start is ever sent (PR #235 Dexter 1, 5).
      Promise.resolve()
        .then(() => startOf())
        .catch(() => null)
        .then((p) => {
          if (s.settled || s.st !== 'starting') return;
          s.proven = typeof p === 'string' && /^\d+$/.test(p) ? p : null;
          if (s.proven === null) settle({ ok: false, reason: 'unproven-start' });
          else send(s, `START ${s.proven}`, false);
        });
      timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  // Ends every process in the job, once: the helper is told KILL and calls TerminateJobObject. Never a name, never a stranger: the
  // job holds only the pty the helper proved it opened and what descends from it. Before the arm the stop is HELD ('held': not done
  // yet) and sent once the proof lands, or dropped with a line in host.log. The helper itself is never killed: that ends nothing.
  function kill() {
    const s = cur;
    if (!s) return 'not-armed';
    if (s.st === 'armed') return sendKill(s);
    if (s.st === 'starting') {
      if (!s.pendingKill) { s.pendingKill = true; say('a stop came before the job was armed: held until the helper proves it holds this pty'); setOutcome(s, 'held'); }
      return 'held';
    }
    return 'not-armed';
  }

  function disarm() { if (cur) release(cur, 'disarmed'); }

  // Resolves with the outcome once no stop is waiting for an answer, or after ms, whichever is first.
  function settled(ms) {
    const s = cur;
    if (!s || !WAITING.has(s.outcome)) return Promise.resolve(s ? s.outcome : null);
    return new Promise((resolve) => {
      let t = null;
      const done = (o) => { waiters.delete(done); if (t) clearTimeout(t); resolve(o); };
      waiters.add(done);
      t = setTimeout(() => done(s.outcome), ms);
    });
  }

  return { attach, kill, disarm, settled, state: () => (cur ? cur.st : 'idle'), outcome: () => (cur ? cur.outcome : null) };
}

module.exports = { createJobGuard, helperScript, splitLines, parseLine, verdict, READY_TIMEOUT_MS, KILL_ANSWER_MS };
