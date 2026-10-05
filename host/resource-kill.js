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

const validTarget = t => !!t && Number.isInteger(t.pid) && t.pid > 0 && typeof t.start === 'string' && /^\d+$/.test(t.start);

function killScript(targets) {
  const calls = targets.map(t => `K ${t.pid} ${t.start}`).join('\n');
  return `$ErrorActionPreference='SilentlyContinue'
function K($id, [long]$want) {
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
${calls}
'END'`;
}

/** [{ pid, status: 'killed' | 'gone' | 'reused' | 'failed', text? }] in the order asked; anything not reported is a failure. */
function parseKillOutput(text, targets) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  const finished = lines.includes('END');
  const said = new Map();
  for (const l of lines) {
    const m = /^(\d+) (killed|gone|reused|failed)(?: (.*))?$/.exec(l);
    if (m) said.set(Number(m[1]), { status: m[2], text: m[3] || '' });
  }
  return targets.map((t) => {
    const s = said.get(t.pid);
    if (!s || !finished) return { pid: t.pid, status: 'failed', text: 'no answer from the kill' };
    return { pid: t.pid, status: s.status, ...(s.text ? { text: s.text } : {}) };
  });
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
