'use strict';
/**
 * Every process the session starts dies with the session when the kill switch trips (BACKLOG #127, Dexter F2, PR #210).
 *
 * THE GAP. `taskkill /T` from claude's pid walks the parent links, and Windows keeps a process's ParentProcessId after the parent
 * has exited. A grandchild whose parent already exited (`Start-Process -WindowStyle Hidden npx stryker run`, `nohup x & disown`)
 * has no live path back to claude, so STOP-ALL ended claude and left that process running with no host that knew its pid.
 *
 * WHY A JOB OBJECT, NOT A SNAPSHOT (measured, verify/probe-kill-switch-detached.js). A snapshot of claude's descendants kept while
 * the session runs cannot see a grandchild whose parent exits before the next sample: with the process table sampled back to back
 * (about 670 ms apart, one PowerShell + CIM call each) a parent that exited at once was never recorded, and a sampler that costs
 * that much is not one to run every few seconds anyway. A Windows Job Object does not look at parent links: every process started
 * by a member joins the job, and TerminateJobObject ends all of them, orphans included.
 *
 * HOW. One PowerShell helper per session (no native build: Add-Type compiles a few P/Invoke lines, ~300 ms). It creates the job,
 * puts claude's pid in it, prints `READY <ms> <claude's start FILETIME>`, then waits for ONE line on stdin:
 *   `KILL`                              TerminateJobObject: Windows ends every process in the job. Sent by guard.kill(), the stop.
 *   anything else, or stdin closing     the helper leaves and its handle closes: nothing dies (the job has no kill-on-close).
 * Processes claude started in the ~half second before the helper put it in the job are not members (claude's own start-up).
 *
 * ONLY A STOP ENDS THE JOB, so nothing but the stop changes (BACKLOG #127 is about STOP-ALL). An earlier cut set KILL_ON_JOB_CLOSE
 * and stopped by killing the helper; but the helper is a child of the host, so every `taskkill /T` of the HOST (the shutdown
 * watchdog, *Stop that session*'s last resort, the sweep of a dead host) reached it and ended the whole job as well: a hard kill of
 * a host would have ended the session's detached processes, which before it left running. Measured in test/job-guard.test.js's
 * real-process test ('helper-killed'): with kill-on-close the grandchild died, without it it lives.
 *
 * NO BREAKAWAY. The job does not set JOB_OBJECT_LIMIT_BREAKAWAY_OK. Measured 2026-11-05: with it, Git Bash's `nohup x & disown`
 * child left the job (Cygwin breaks away whenever the job allows it) and survived the stop; without it, Git Bash and PowerShell's
 * `Start-Process` both start their children normally, inside the job. A program that insists on CREATE_BREAKAWAY_FROM_JOB gets
 * access denied from CreateProcess while the session is in the job; none of the session's usual tools was seen to.
 *
 * NO STRANGER. The helper opens claude by pid (and holds that handle, so the pid can't be reused while it runs); if the pid were
 * reused before the helper opened it, the helper would jail a stranger. So the helper reports the start time of the process it
 * opened and attach() compares it with the pty's start (kill-tree's proof): a mismatch, or an unproven start with a pty that has
 * already exited, lets the job go at once (DISARM: the helper leaves, nothing is ended). A stop that comes while the helper is still
 * starting is held, and sent only once the start is proven (a proven start means the helper holds our pty's own process, even if
 * the tree kill has already ended it). A helper that never answers is told to DISARM and left to leave.
 *
 *   createJobGuard({ spawnFn, platform, powershell, log, timeoutMs }) -> { attach({ pid, startOf, exited }) -> Promise<result>, kill() -> bool, disarm(), state() }
 *       result  { ok: true, ms, start } | { ok: false, reason }      reason: 'not-windows' | 'bad-pid' | 'spawn-failed' | 'failed: <why>' |
 *                                                                    'timeout' | 'helper-exited' | 'target-exited' | 'start-mismatch'
 *   helperScript(pid) -> the PowerShell text      (exported for the tests)
 */
const { spawn } = require('child_process');
const path = require('path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const READY_TIMEOUT_MS = 15000;

const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class CcJob {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint acc, bool inh, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr p, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  public static long Start;
  // No limits are set: no kill-on-close (only Kill ends the job), no breakaway (see the header).
  public static IntPtr Make(int pid) {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    IntPtr p = OpenProcess(0x0100 | 0x0001 | 0x1000, false, pid);
    if (p == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    long e1, k, u;
    if (!GetProcessTimes(p, out Start, out e1, out k, out u)) throw new Exception("GetProcessTimes " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(j, p)) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    return j;
  }
  public static void Kill(IntPtr j) { if (!TerminateJobObject(j, 1)) throw new Exception("TerminateJobObject " + Marshal.GetLastWin32Error()); }
}
`;

function helperScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('job guard: pid must be a positive integer');
  return [
    "$ErrorActionPreference = 'Stop'",
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'try {',
    `  Add-Type -TypeDefinition @'${CSHARP}\n'@`,
    `  $j = [CcJob]::Make(${pid})`,
    "  [Console]::Out.WriteLine('READY ' + $sw.ElapsedMilliseconds + ' ' + [CcJob]::Start)",
    '  [Console]::Out.Flush()',
    "} catch { [Console]::Out.WriteLine('FAILED ' + (($_.Exception.Message -replace '\\s+', ' '))); exit 1 }",
    '$line = [Console]::In.ReadLine()',
    "if ($line -eq 'KILL') { try { [CcJob]::Kill($j); [Console]::Out.WriteLine('KILLED') } catch { [Console]::Out.WriteLine('KILL-FAILED ' + (($_.Exception.Message -replace '\\s+', ' '))) } }",
  ].join('\n');
}

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function createJobGuard({ spawnFn = spawn, platform = process.platform, powershell = POWERSHELL, log = () => {}, timeoutMs = READY_TIMEOUT_MS, now = Date.now } = {}) {
  let helper = null;
  let st = 'idle';                  // idle | attaching | armed | released | ended | failed
  let pendingKill = false;          // a stop came while attaching: sent once the helper's start is proven
  const say = (line) => { try { log(`[job-guard] ${line}`); } catch { /* the guard never breaks the host */ } };
  const running = () => !!helper && helper.exitCode === null && helper.signalCode === null;

  // The helper reads one line: KILL ends the job, anything else (or the pipe closing) lets it leave with the job untouched.
  function send(line) {
    if (!running()) return false;
    try { helper.stdin.write(`${line}\n`); helper.stdin.end(); return true; } catch { return false; /* it leaves on its own when the pipe closes */ }
  }
  const sendDisarm = () => { pendingKill = false; send('DISARM'); };

  function sendKill() {
    st = 'ended';
    pendingKill = false;
    const child = helper;
    if (child && child.stdout) {
      let said = '';
      child.stdout.on('data', (d) => {
        said += String(d);
        const m = /^(KILLED|KILL-FAILED.*)$/m.exec(said);
        if (m) { said = ''; say(m[1] === 'KILLED' ? 'the job was ended' : `the job could not be ended (${m[1]})`); }
      });
    }
    return send('KILL');
  }

  function disarm() {
    if (st === 'armed' || st === 'attaching') st = 'released';
    sendDisarm();
  }

  // pid: the pty's pid. startOf(): Promise<FILETIME string | null> (kill-tree's proof of the pty's start). exited(): has the pty ended.
  function attach({ pid, startOf = async () => null, exited = () => false } = {}) {
    if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'not-windows' });
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, reason: 'bad-pid' });
    if (helper !== null) disarm();                       // one helper at a time: an earlier session's job is released, not killed
    pendingKill = false;
    // host.js attaches right after pty.spawn, so this is how long the session ran outside the job: anything it started and
    // detached in that time is not a member (PR #235 hub H1). host.log gets the number either way.
    const t0 = now();
    const since = () => { try { return Math.max(0, Math.round(now() - t0)); } catch { return null; } };
    let child;
    try {
      child = spawnFn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(helperScript(pid))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) { st = 'failed'; say(`not armed for pid ${pid} after ${since()} ms (spawn-failed)`); return Promise.resolve({ ok: false, reason: 'spawn-failed' }); }
    helper = child;
    st = 'attaching';
    for (const s of [child.stdin, child.stdout]) { try { if (s && typeof s.unref === 'function') s.unref(); } catch { /* optional */ } }
    try { if (typeof child.unref === 'function') child.unref(); } catch { /* optional */ }
    if (child.stdin) child.stdin.on('error', () => {});

    return new Promise((resolve) => {
      let out = '';
      let done = false;
      let timer = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (!r.ok) { if (st === 'attaching' || st === 'armed') st = 'failed'; sendDisarm(); say(`not armed for pid ${pid} after ${since()} ms (${r.reason})`); }
        resolve(r);
      };
      child.on('error', () => finish({ ok: false, reason: 'spawn-failed' }));
      child.on('exit', () => {
        if (child !== helper) return;
        if (st === 'armed') { st = 'ended'; say('the helper ended before any stop; nothing in its job was ended, and the job no longer guards'); }
        finish({ ok: false, reason: 'helper-exited' });
      });
      if (child.stdout) {
        child.stdout.on('data', async (d) => {
          if (done) return;
          out += String(d);
          const failed = /^FAILED (.*)$/m.exec(out);
          if (failed) { finish({ ok: false, reason: `failed: ${failed[1].trim()}` }); return; }
          const ready = /^READY (\d+) (\d+)\s*$/m.exec(out);
          if (!ready) return;
          const ms = Number(ready[1]);
          const start = ready[2];
          // A stop that is waiting may go ahead on a PROVEN start even though the tree kill has just ended the pty: the helper holds
          // that very process. Otherwise a pty that has exited may have handed its pid to a stranger, so the job is let go.
          let proven = null;
          const exitedNow = () => exited() && !(pendingKill && typeof proven === 'string' && proven === start);
          if (exited() && !pendingKill) { finish({ ok: false, reason: 'target-exited' }); return; }
          try { proven = await startOf(); } catch { proven = null; }
          if (done) return;
          if (typeof proven === 'string' && proven !== start) { finish({ ok: false, reason: 'start-mismatch' }); return; }
          if (exitedNow()) { finish({ ok: false, reason: 'target-exited' }); return; }
          if (st === 'attaching') st = 'armed';
          say(`armed for pid ${pid} ${since()} ms after spawn (helper ${ms} ms)${typeof proven === 'string' ? '' : ' (its start time was not proven)'}`);
          done = true;
          if (timer) clearTimeout(timer);
          if (st === 'armed' && pendingKill) { say('a stop came while it was starting: ending the job now'); sendKill(); }
          resolve({ ok: true, ms, start });
        });
      }
      // A helper that never answers is not killed (killing it would end nothing either way): it is told to DISARM and left to leave.
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  // Ends every process in the job: the helper is told KILL and calls TerminateJobObject. Never a name, never a stranger: the job
  // holds only what descends from the pty the helper proved it opened. While attaching, the stop is held until that proof (true:
  // accepted). The helper itself is never killed: ending it ends nothing.
  function kill() {
    if (!running()) return false;
    if (st === 'armed') return sendKill();
    if (st === 'attaching' && !pendingKill) { pendingKill = true; return true; }
    return false;
  }

  return { attach, kill, disarm, state: () => st };
}

module.exports = { createJobGuard, helperScript, READY_TIMEOUT_MS };
