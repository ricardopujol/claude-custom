'use strict';
/**
 * Reap the detached helper processes a test started (BACKLOG #74 G).
 *
 * A test that spawns detached children tags each with a marker in argv: `<prefix>-<owner pid>-<time>`. They are found by
 * that marker, never by the process name, and each is ended only after its start time is PROVEN: the process table's
 * creation time must equal the StartTime read on a handle held across the kill, so a pid reused since the listing is
 * left alone. One PowerShell call does the listing, the proof and the kill, and it is synchronous so it can run from
 * `process.on('exit')`.
 *
 *   reapMarked(marker)        every process whose command line carries exactly this marker
 *   reapDeadOwners(prefix)    the leftovers of earlier runs of the suite: markers `<prefix>-<pid>-...` whose owner pid
 *                             is no longer running (a live, or reused, owner pid is skipped: doubt keeps it safe)
 *   markedPids(marker)        the same match, listing only
 *
 * Both reapers return how many they ended. Off Windows they do nothing (the detached helpers are Windows-only tests).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SAFE = /^[A-Za-z0-9.-]+$/;

// The helper the tests spawn: sleeps, and exits on its own after two minutes, so a run nobody ever reaps still ends.
const SLEEPER_SRC = 'setTimeout(() => process.exit(), 120000); setInterval(() => {}, 1000)';

function ps(script) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  // A failed read is an error, never an empty list: "nothing left" must not be what a broken query says.
  if (r.error || r.status !== 0) throw new Error(`process query failed: ${r.error ? r.error.message : `exit ${r.status}`}`);
  return r.stdout || '';
}

const rowsScript = (token) => `$ErrorActionPreference='Stop'
$tok='(?<![\\w.-])'+${token}+'(?![\\w.-])'
$rows=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -Property ProcessId,CommandLine,CreationDate -OperationTimeoutSec 20 | Where-Object { $_.CommandLine -and ($_.CommandLine -match $tok) })`;

function checkMarker(marker) {
  if (typeof marker !== 'string' || !SAFE.test(marker)) throw new Error(`unsafe marker ${JSON.stringify(marker)}: letters, digits, '.' and '-' only`);
  return marker;
}

// Ends $rows[i] only if the process holding its pid started when the table says (within 2 ms).
// `forgeTicks` is a seam for the tests: it shifts the table's creation time so the proof can be shown to refuse a mismatch.
const killProven = (forgeTicks = 0) => `$n=0
foreach($r in $rows){
  $p=Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
  if(-not $p -or $p.ProcessName -ne 'node'){continue}
  try{$null=$p.Handle;$s=$p.StartTime.ToFileTimeUtc()}catch{continue}
  if([math]::Abs($s-($r.CreationDate.ToFileTimeUtc()+${Number(forgeTicks) || 0})) -gt 20000){continue}
  try{$p.Kill();$n++}catch{}
}
'REAPED '+$n`;

const count = (out) => { const m = /REAPED (\d+)/.exec(out); if (!m) throw new Error('the reaper did not answer'); return Number(m[1]); };

function markedPids(marker) {
  if (process.platform !== 'win32') return [];
  checkMarker(marker);
  const out = ps(`${rowsScript(`[regex]::Escape('${marker}')`)}\n$rows | ForEach-Object { $_.ProcessId }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function reapMarked(marker, { forgeTicks = 0 } = {}) {
  checkMarker(marker);
  if (process.platform !== 'win32') return 0;
  return count(ps(`${rowsScript(`[regex]::Escape('${marker}')`)}\n${killProven(forgeTicks)}`));
}

function reapDeadOwners(prefix, { forgeTicks = 0 } = {}) {
  checkMarker(prefix);
  if (process.platform !== 'win32') return 0;
  const script = `${rowsScript(`[regex]::Escape('${prefix}')+'-\\d+-[\\w.]+'`)}
function Dead($v){$id=0;if(-not [int]::TryParse($v,[ref]$id)){return $false};-not (Get-Process -Id $id -ErrorAction SilentlyContinue)}
$own=[regex]::new('(?<![\\w.-])'+[regex]::Escape('${prefix}')+'-(\\d+)-')
$rows=@($rows | Where-Object { $m=$own.Match($_.CommandLine); $m.Success -and (Dead $m.Groups[1].Value) })
${killProven(forgeTicks)}`;
  return count(ps(script));
}

module.exports = { reapMarked, reapDeadOwners, markedPids, SLEEPER_SRC };
