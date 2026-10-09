'use strict';
/**
 * Pause / Resume for a process of the Resources panel (BACKLOG #19). The same shape as the kill (host/resource-kill.js) and
 * the same care: the caller hands over the exact set (host/resource-tree.js killSet, start-time guarded, ROOT FIRST) and ONE
 * PowerShell call opens each process (`Get-Process -Id`, then `.Handle`, which keeps a full-access handle on the object),
 * reads its start time through that handle, compares it with the one the panel proved, and only then calls
 * NtSuspendProcess / NtResumeProcess on that same handle. A pid reused since the proof is "reused"; one that exited is
 * "gone"; one that refuses is "failed" with the reason. The answer is REAL: a process that was not suspended is not
 * reported as one.
 *
 * MEASURED (verify/probe-pause.js, PR #61): NtSuspendProcess on the leaf of a background shell freezes it byte for byte, and
 * the CLI keeps showing "running" with a wall-clock Runtime. verify/probe-shell-suspend.js measures the longer times.
 *
 * A suspend also checks, before it touches anything, that nothing protected (claude, Electron, a session host) was started
 * under the root since the list was read, and afterwards suspends whatever the root's subtree grew in the meantime (a
 * process that started between the list and the suspend). A resume is simpler: waking a process is harmless, so it has no
 * protected scan and always tries every target it is given.
 *
 * UNKNOWN IS NOT "NOT SUSPENDED" (PR #158 Dexter 2). The script prints each `<pid> done` the moment it suspends it, and the proved start
 * right after it, so an answer cut off by the exec timeout still says what it suspended: a `done` line is believed with or without END
 * (for a suspend, the safe reading is the one that records or wakes the process). A target the script said nothing about, or a run that
 * threw, is `unknown: true`: it MAY have been suspended, and the caller must wake it, never forget it.
 *
 * THE SUSPEND COUNT (PR #158 Dexter 8). NtSuspendProcess nests, so a process already frozen (an earlier window that crashed) would reach
 * count 2 and one Resume would leave it frozen. A suspend refuses a process whose threads are all already suspended ("already suspended"),
 * and a resume repeats NtResumeProcess until the threads are no longer all suspended (at most 8 times).
 */

const { validTarget, BELOW_PROT_OWN } = require('./resource-kill');

const START_SLACK = 100000;      // 10 ms in 100 ns ticks: CIM and Get-Process start times differ by a tick (host/resource-tree.js)
const ACTIONS = { suspend: 'NtSuspendProcess', resume: 'NtResumeProcess' };

// Are all of the process's threads suspended? (WaitReason is only meaningful for a thread in the Wait state.)
const SUSP = `function Susp($p) {
  try { $p.Refresh(); $t = @($p.Threads); return (($t.Count -gt 0) -and (@($t | Where-Object { $_.ThreadState -ne 'Wait' -or $_.WaitReason -ne 'Suspended' }).Count -eq 0)) } catch { return $false }
}`;

const PASS_SUSPEND = `  if (Susp $p) { return "$id failed already suspended" }
  try { $rc = [NtPause]::NtSuspendProcess($p.Handle) } catch { return "$id failed $($_.Exception.Message)" }
  if ($rc -ne 0) { return "$id failed NtSuspendProcess returned $rc" }`;
const PASS_RESUME = `  for ($i = 0; $i -lt 8; $i++) {
    try { $rc = [NtPause]::NtResumeProcess($p.Handle) } catch { return "$id failed $($_.Exception.Message)" }
    if ($rc -ne 0) { return "$id failed NtResumeProcess returned $rc" }
    Start-Sleep -Milliseconds 100
    if (-not (Susp $p)) { break }
  }
  if (Susp $p) { return "$id failed still suspended after 8 resumes" }`;

const HELPER = `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NtPause {
  [DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr h);
}
"@`;

function suspendScript(action, targets) {
  const PASS = action === 'resume' ? PASS_RESUME : PASS_SUSPEND;
  const [root, ...rest] = targets;
  const head = `$ErrorActionPreference='SilentlyContinue'
${HELPER}
${SUSP}
$done = @{}
$tried = @{}
function P($id, [long]$want) {
  $script:tried[$id] = 1
  $p = Get-Process -Id $id
  if (-not $p) { return "$id gone" }
  try { $null = $p.Handle } catch { return "$id failed could not open it: $($_.Exception.Message)" }
  if ($p.HasExited) { return "$id gone" }
  $got = $p.StartTime.ToFileTimeUtc()
  if ([math]::Abs($got - $want) -gt ${START_SLACK}) { return "$id reused" }
${PASS}
  $script:done[$id] = $want
  # the proved start, printed at once (not at the end): an answer cut off by the timeout still names what it suspended
  [Console]::Out.WriteLine("$id start $want")
  return "$id done"
}
`;
  if (action === 'resume') {
    return `${head}${targets.map(t => `P ${t.pid} ${t.start}`).join('\n')}\n'END'`;
  }
  const calls = rest.map(t => `  P ${t.pid} ${t.start}`).join('\n');
  return `${head}${BELOW_PROT_OWN}
$rootId = ${root.pid}
$bad = @(Below @{ ${root.pid} = ${root.start} } | Where-Object { Prot $_ })
if ($bad.Count -gt 0) {
  "$rootId failed a protected process (PID $($bad[0].id)) was started under it since the list was read"
} else {
  $r = P ${root.pid} ${root.start}
  $r
  if ($r -match '^\d+ done') {
${calls}
    for ($pass = 0; $pass -lt 3; $pass++) {
      $more = @(Below $done | Where-Object { -not (Own $_) -and -not (Prot $_) -and -not $tried.ContainsKey($_.id) })
      if ($more.Count -eq 0) { break }
      foreach ($c in $more) { if (-not $tried.ContainsKey($c.id)) { P $c.id $c.st } }
    }
  }
}
'END'`;
}

/** [{ pid, status: 'done' | 'gone' | 'reused' | 'failed', text? }] in the order asked, then any `extra: true` ones the script found; anything not reported is a failure. */
function parseSuspendOutput(text, targets) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  const finished = lines.includes('END');
  const said = new Map();
  const starts = new Map();
  for (const l of lines) {
    const m = /^(\d+) (done|gone|reused|failed)(?: (.*))?$/.exec(l);
    if (m) said.set(Number(m[1]), { status: m[2], text: m[3] || '' });
    const st = /^(\d+) start (\d+)$/.exec(l);
    if (st) starts.set(Number(st[1]), st[2]);
  }
  const asked = new Set(targets.map(t => t.pid));
  const startOf = (pid, s) => (s.status === 'done' && starts.has(pid) ? { start: starts.get(pid) } : {});
  // A `done` is believed with or without END; every other answer needs END (a cut-off run says nothing about the rest: UNKNOWN).
  const believed = s => !!s && (finished || s.status === 'done');
  const out = targets.map((t) => {
    const s = said.get(t.pid);
    if (!believed(s)) return { pid: t.pid, status: 'failed', unknown: true, text: 'no answer from the suspend' };
    return { pid: t.pid, status: s.status, ...startOf(t.pid, s), ...(s.text ? { text: s.text } : {}) };
  });
  for (const [pid, s] of said) if (!asked.has(pid) && believed(s)) out.push({ pid, status: s.status, extra: true, ...startOf(pid, s), ...(s.text ? { text: s.text } : {}) });
  return out;
}

/** suspendVerified('suspend' | 'resume', targets, { exec }) -> results. `exec(script)` runs it and resolves with stdout. Never throws. */
async function suspendVerified(action, targets, { exec }) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return [];
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return list.map(t => ({ pid: t && t.pid, status: 'failed', text: 'not a valid action' }));
  }
  if (!list.every(validTarget)) {
    return list.map(t => ({ pid: t && t.pid, status: 'failed', text: 'not a valid target' }));
  }
  let out;
  try { out = await exec(suspendScript(action, list)); } catch (err) {
    return list.map(t => ({ pid: t.pid, status: 'failed', unknown: true, text: (err && err.message) || 'the suspend could not be run' }));
  }
  return parseSuspendOutput(out, list);
}

module.exports = { suspendVerified, suspendScript, parseSuspendOutput, validTarget };
