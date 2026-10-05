'use strict';
/**
 * The Resources panel's kill (BACKLOG #63, PR #113 Dexter findings 1, 4, 5). Not `taskkill /T`: the caller hands over
 * the exact set of processes to end (host/resource-tree.js killSet, start-time guarded, ROOT FIRST) and each one is
 * ended by its own pid after being re-proved at that moment.
 *
 * ONE PowerShell call for the whole set. For each target it opens the process (`Get-Process -Id`, then `.Handle`,
 * which opens a real handle with full access and keeps it on the object), THEN reads the start time through that
 * handle and compares it with the one the panel proved, and only then `Kill()`s through the same handle. A pid that was
 * reused between the proof and now is refused ("reused"); one that exited is "gone"; one that refuses ("denied", an
 * elevated process) is "failed" with the reason. The window between the proof and the kill is therefore the
 * microseconds inside this script, not the 1.7-11 s of the sample that produced the proof.
 *
 * The result is REAL: a kill that did not end the process is not reported as one.
 */

const START_SLACK = 100000;      // 10 ms in 100 ns ticks: CIM and Get-Process start times differ by a tick (host/resource-tree.js)

const PID_MAX = 4294967295;                    // a Windows pid is a DWORD
const START_MAX = '9223372036854775807';       // the script casts the start to [long]; FILETIMEs are 18 digits
// `pid` and `start` are written raw into PowerShell source, so each must be exactly a number the script can read back:
// digits only, in range (1e21 is an integer to JS but prints as 1e+21), and a start that fits a signed 64-bit integer.
const startFits = s => /^\d{1,19}$/.test(s) && (s.length < START_MAX.length || s <= START_MAX);
const validTarget = t => !!t && Number.isInteger(t.pid) && t.pid > 0 && t.pid <= PID_MAX && typeof t.start === 'string' && startFits(t.start);

function killScript(targets) {
  const [root, ...rest] = targets;
  const calls = rest.map(t => `K ${t.pid} ${t.start}`).join('\n');
  // The protected roles by image, as host/resource-tree.js roleOf names them (claude, Electron, a session host's host.js).
  return `$ErrorActionPreference='SilentlyContinue'
$done = @{}
function K($id, [long]$want) {
  $script:done[$id] = $want
  $p = Get-Process -Id $id
  if (-not $p) { return "$id gone" }
  try { $null = $p.Handle } catch { return "$id failed could not open it: $($_.Exception.Message)" }
  if ($p.HasExited) { return "$id gone" }
  $got = $p.StartTime.ToFileTimeUtc()
  if ([math]::Abs($got - $want) -gt ${START_SLACK}) { return "$id reused" }
  try { $p.Kill() } catch { return "$id failed $($_.Exception.Message)" }
  [void]$p.WaitForExit(3000)
  if ($p.HasExited) { return "$id killed" }
  return "$id failed it is still running"
}
function Below($seeds) {
  $t = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ id=[int]$_.ProcessId; pp=[int]$_.ParentProcessId; name=[string]$_.Name; cmd=[string]$_.CommandLine; st=$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { [long]0 }) } })
  $queue = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($k in $seeds.Keys) { [void]$queue.Add(@([int]$k, [long]$seeds[$k])); $seen[[int]$k] = 1 }
  $found = @()
  for ($i = 0; $i -lt $queue.Count; $i++) {
    $cur = $queue[$i][0]; $curStart = $queue[$i][1]
    foreach ($c in $t) {
      if ($c.pp -ne $cur -or $c.id -eq $cur -or $seen.ContainsKey($c.id)) { continue }
      if ($curStart -le 0 -or $c.st -lt $curStart) { continue }
      $seen[$c.id] = 1
      [void]$queue.Add(@($c.id, $c.st))
      $found += $c
    }
  }
  $found
}
function Prot($c) { ($c.name -like 'claude*') -or ($c.name -eq 'electron.exe') -or ($c.cmd -match 'host[\\\\/]host\\.js') }
function Own($c) { ($c.name -eq 'conhost.exe') -or ($c.name -eq 'OpenConsole.exe') }
$rootId = ${root.pid}
$bad = @(Below @{ ${root.pid} = ${root.start} } | Where-Object { Prot $_ })
if ($bad.Count -gt 0) {
  "$rootId failed a protected process (PID $($bad[0].id)) was started under it since the list was read"
} else {
  $r = K ${root.pid} ${root.start}
  $r
${calls}
  if ($r -like '* killed') {
    for ($pass = 0; $pass -lt 3; $pass++) {
      $more = @(Below $done | Where-Object { -not (Own $_) -and -not (Prot $_) -and -not $done.ContainsKey($_.id) })
      if ($more.Count -eq 0) { break }
      foreach ($c in $more) { if (-not $done.ContainsKey($c.id)) { K $c.id $c.st } }
    }
  }
}
'END'`;
}

/** [{ pid, status: 'killed' | 'gone' | 'reused' | 'failed', text? }] in the order asked, then any `extra: true` ones the script found; anything not reported is a failure. */
function parseKillOutput(text, targets) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  const finished = lines.includes('END');
  const said = new Map();
  for (const l of lines) {
    const m = /^(\d+) (killed|gone|reused|failed)(?: (.*))?$/.exec(l);
    if (m) said.set(Number(m[1]), { status: m[2], text: m[3] || '' });
  }
  const asked = new Set(targets.map(t => t.pid));
  const out = targets.map((t) => {
    const s = said.get(t.pid);
    if (!s || !finished) return { pid: t.pid, status: 'failed', text: 'no answer from the kill' };
    return { pid: t.pid, status: s.status, ...(s.text ? { text: s.text } : {}) };
  });
  // Processes the script found itself (started since the list was read) and ended or failed to end: said, never dropped.
  if (finished) {
    for (const [pid, s] of said) if (!asked.has(pid)) out.push({ pid, status: s.status, extra: true, ...(s.text ? { text: s.text } : {}) });
  }
  return out;
}

/** killVerified(targets, { exec }) -> results. `exec(script)` runs it and resolves with stdout. Never throws. */
async function killVerified(targets, { exec }) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0 || !list.every(validTarget)) {
    return list.map(t => ({ pid: t && t.pid, status: 'failed', text: 'not a valid target' }));
  }
  let out;
  try { out = await exec(killScript(list)); } catch (err) {
    return list.map(t => ({ pid: t.pid, status: 'failed', text: (err && err.message) || 'the kill could not be run' }));
  }
  return parseKillOutput(out, list);
}

module.exports = { killVerified, killScript, parseKillOutput };
