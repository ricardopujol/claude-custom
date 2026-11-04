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
 * by a member joins the job, and closing a job that has KILL_ON_JOB_CLOSE ends all of them, orphans included.
 *
 * HOW. One PowerShell helper per session (no native build: Add-Type compiles a few P/Invoke lines, ~300 ms). It creates the job,
 * puts claude's pid in it, prints `READY <ms> <claude's start FILETIME>`, then waits on stdin:
 *   stdin closes, or a `DISARM` line   the kill-on-close flag is cleared and the helper leaves: nothing dies. This is every
 *                                       ordinary end (claude exits, the host exits, a crash): the guard never ends anything on its own.
 *   guard.kill()                        the helper is ended by its own pid (a ChildProcess this module spawned), its job handle
 *                                       closes with it, and Windows ends every process in the job.
 * Processes claude started in the ~half second before the helper put it in the job are not members (claude's own start-up).
 *
 * NO STRANGER. The helper opens claude by pid; if that pid were reused in that window the helper would jail a stranger. So the
 * helper reports the start time of the process it opened and attach() compares it with the pty's start (kill-tree's proof): a
 * mismatch, or a pty that has already exited, disarms the job at once (nothing is ever killed by a disarmed job).
 * A helper that never answers is not killed either (it might have armed already): it is told to DISARM and left to leave.
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
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWS, MaxWS; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Sched; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcMem, JobMem, PeakProc, PeakJob; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint acc, bool inh, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr p, out long c, out long e, out long k, out long u);
  public static long Start;
  static void Limit(IntPtr j, uint flags) {
    EXT e = new EXT(); e.Basic.LimitFlags = flags;
    if (!SetInformationJobObject(j, 9, ref e, Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
  }
  public static IntPtr Make(int pid) {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    Limit(j, 0x2000);
    IntPtr p = OpenProcess(0x0100 | 0x0001 | 0x1000, false, pid);
    if (p == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    long e1, k, u;
    if (!GetProcessTimes(p, out Start, out e1, out k, out u)) throw new Exception("GetProcessTimes " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(j, p)) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    return j;
  }
  public static void Disarm(IntPtr j) { Limit(j, 0); }
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
    "if ($null -eq $line -or $line -eq 'DISARM') { try { [CcJob]::Disarm($j) } catch { } }",
  ].join('\n');
}

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function createJobGuard({ spawnFn = spawn, platform = process.platform, powershell = POWERSHELL, log = () => {}, timeoutMs = READY_TIMEOUT_MS } = {}) {
  let helper = null;
  let st = 'idle';                  // idle | attaching | armed | released | ended | failed
  const say = (line) => { try { log(`[job-guard] ${line}`); } catch { /* the guard never breaks the host */ } };
  const running = () => !!helper && helper.exitCode === null && helper.signalCode === null;

  function sendDisarm() {
    if (!running()) return;
    try { helper.stdin.write('DISARM\n'); helper.stdin.end(); } catch { /* the helper leaves on its own when the pipe closes */ }
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
    let child;
    try {
      child = spawnFn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(helperScript(pid))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) { st = 'failed'; return Promise.resolve({ ok: false, reason: 'spawn-failed' }); }
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
        if (!r.ok) { if (st === 'attaching' || st === 'armed') st = 'failed'; sendDisarm(); say(`not armed (${r.reason})`); }
        resolve(r);
      };
      child.on('error', () => finish({ ok: false, reason: 'spawn-failed' }));
      child.on('exit', () => {
        if (child !== helper) return;
        if (st === 'armed') { st = 'ended'; say('the helper ended; its job closed'); }
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
          if (exited()) { finish({ ok: false, reason: 'target-exited' }); return; }
          let proven = null;
          try { proven = await startOf(); } catch { proven = null; }
          if (done) return;
          if (typeof proven === 'string' && proven !== start) { finish({ ok: false, reason: 'start-mismatch' }); return; }
          if (exited()) { finish({ ok: false, reason: 'target-exited' }); return; }
          if (st === 'attaching') st = 'armed';
          say(`armed for pid ${pid} in ${ms} ms${typeof proven === 'string' ? '' : ' (its start time was not proven)'}`);
          done = true;
          if (timer) clearTimeout(timer);
          resolve({ ok: true, ms, start });
        });
      }
      // A helper that never answers is not killed (it may already have armed the job): it is asked to disarm and left to leave.
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  // Ends every process in the job: the helper is ended by its own pid, so its job handle closes with it. Never a name, never a stranger:
  // `helper` is the ChildProcess this module spawned, and ChildProcess.kill() does nothing once it has exited.
  function kill() {
    if (!running() || (st !== 'armed' && st !== 'attaching')) return false;
    st = 'ended';
    try { return helper.kill() === true; } catch { return false; }
  }

  return { attach, kill, disarm, state: () => st };
}

module.exports = { createJobGuard, helperScript, READY_TIMEOUT_MS };
