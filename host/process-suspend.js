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
 */

const { validTarget, BELOW_PROT_OWN } = require('./resource-kill');

const START_SLACK = 100000;      // 10 ms in 100 ns ticks: CIM and Get-Process start times differ by a tick (host/resource-tree.js)
const ACTIONS = { suspend: 'NtSuspendProcess', resume: 'NtResumeProcess' };

const HELPER = `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NtPause {
  [DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr h);
}
"@`;

// After the answers: the start time each "done" process was proved by, so a process the script found itself (an `extra`) can be
// woken later through the same proof.
const STARTS = 'foreach ($k in $done.Keys) { "$k start $($done[$k])" }';

function suspendScript(action, targets) {
  const nt = ACTIONS[action];
  const [root, ...rest] = targets;
  const head = `$ErrorActionPreference='SilentlyContinue'
${HELPER}
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
  try { $rc = [NtPause]::${nt}($p.Handle) } catch { return "$id failed $($_.Exception.Message)" }
  if ($rc -ne 0) { return "$id failed ${nt} returned $rc" }
  $script:done[$id] = $want
  return "$id done"
}
`;
  if (action === 'resume') {
    return `${head}${targets.map(t => `P ${t.pid} ${t.start}`).join('\n')}\n${STARTS}\n'END'`;
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
  if ($r -like '* done') {
${calls}
    for ($pass = 0; $pass -lt 3; $pass++) {
      $more = @(Below $done | Where-Object { -not (Own $_) -and -not (Prot $_) -and -not $tried.ContainsKey($_.id) })
      if ($more.Count -eq 0) { break }
      foreach ($c in $more) { if (-not $tried.ContainsKey($c.id)) { P $c.id $c.st } }
    }
  }
}
${STARTS}
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
  const out = targets.map((t) => {
    const s = said.get(t.pid);
    if (!s || !finished) return { pid: t.pid, status: 'failed', text: 'no answer from the suspend' };
    return { pid: t.pid, status: s.status, ...startOf(t.pid, s), ...(s.text ? { text: s.text } : {}) };
  });
  if (finished) {
    for (const [pid, s] of said) if (!asked.has(pid)) out.push({ pid, status: s.status, extra: true, ...startOf(pid, s), ...(s.text ? { text: s.text } : {}) });
  }
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
    return list.map(t => ({ pid: t.pid, status: 'failed', text: (err && err.message) || 'the suspend could not be run' }));
  }
  return parseSuspendOutput(out, list);
}

module.exports = { suspendVerified, suspendScript, parseSuspendOutput, validTarget };
