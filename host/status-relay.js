'use strict';
/**
 * The harness's statusLine command. Claude Code runs it with a JSON document
 * on stdin; this forwards that document to the host as a `Status` event, then
 * runs the USER's own statusLine command on the same stdin and passes its
 * output through as the status line.
 *
 *   node status-relay.js --pipe <bare pipe name> [--then <base64 command>]
 *                        [--quiet-when <chrome-global.json>]
 *
 * --quiet-when (BACKLOG #27): when that file says `statusInHeader: true`, the
 * user's command doesn't run and nothing is printed, so the CLI drops its
 * status row (MEASURED, verify/probe-footer-rows.js) and the tab header draws
 * the fields instead. The document is still forwarded either way.
 *
 * Hidden is the DEFAULT (BACKLOG #67), but not decided here: the relay is
 * re-read from disk on every fire while a running Electron main keeps its old
 * code, so the two must never disagree about a missing key. Main writes
 * `statusInHeader: true` into the file when none is chosen
 * (app/window-chrome-bridge.js ensureStatusDefault), and this stays strict.
 *
 * Why it exists: the document carries model.id and effort.level and re-fires
 * ~1s after /model and /effort with no turn (verify/probe-top-bar-truth.js),
 * the truth FF12's top bar resolves a switch against. `--settings` replaces
 * the user's statusLine wholesale, so without the chain their status line
 * would vanish. See host/settings-writer.js.
 *
 * Written to fail QUIETLY in both directions: no host listening must not
 * stall or blank the user's status line, and a user command that fails must
 * not stop the host hearing the truth. The two run concurrently.
 */
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { killProvenBatch } = require('./kill-tree');

const FORWARD_TIMEOUT_MS = 300;
// How long the user's own statusLine command may run (Dexter r2 N6). Without
// a bound a hung command (a network call, say) was awaited forever, and each
// re-fire left one more of it behind.
const USER_TIMEOUT_MS = 5000;
// A sweep that has not finished by then gives way to a plain taskkill: the
// relay must exit, and a missed straggler beats a status line that never ends.
const SWEEP_TIMEOUT_MS = 20000;

// The whole tree on Windows: with shell:true the user's command runs UNDER
// cmd.exe, and killing only cmd.exe leaves the command itself running. On
// POSIX the child stays in the relay's own process group (Dexter #51 F7), so
// a CLI that kills the group still reaches it; `sh -c` execs a single command,
// so killing the child is killing the command.
//
// Not `taskkill /T` (BACKLOG #72): it reads the tree once and then ends it, so
// a process the tree starts after that read -- cmd.exe still creating the
// user's command, which a loaded machine stretches past the timeout -- outlives
// the kill, holding the relay's stdout open, so the CLI waited on it (MEASURED:
// 2 of 21 kills straddling the creation left it running, one relay was waited
// on for 685 s). libuv's job doesn't catch it either: it lets grandchildren
// break away. So each process is ended BEFORE its children are read: a dead
// process starts nothing, so once a read finds no children the tree is gone.
// The parent link decides what is a child, never a wall clock (PR #126 F4, BACKLOG #73 S7-2): a row is a child of P only if its
// ParentProcessId is P's pid AND it started no earlier than P (a pid reused since has a LATER start than the stale child that still
// names it: that child is not adopted) AND, once P is ended, no later than P's exit (a process that started after P died is not
// P's child). Each pid to end is checked against the start the sweep read for it, so a pid reused since is skipped, not killed.
// The root's own pid is held by libuv until `close`, so it needs no such check.
//
// The sweep can fail after it has killed the root, and then a plain
// `taskkill /pid <root> /T` is a no-op (the root is gone: "not found"; Dexter
// F1 / Miguel Y1). So the sweep reports what it still has to end on stdout as
// `ALIVE <pid>:<start> ...`, taken from a snapshot BEFORE the first kill and
// shrinking as pids are ended (S7-1: a pid the sweep already ended may belong to a
// stranger by now, so it is never re-killed). The fallback ends the root by number
// and every other pending pid through killProven(pid, start). A failed or stalled
// query (-OperationTimeoutSec), the iteration cap and a failed snapshot all
// exit non-zero for that reason. A root that has already exited is left alone,
// as `taskkill /pid <exited root> /T` always did ("not found", MEASURED
// 2026-10-06: a background child of a finished command survives it).
const SWEEP_MAX_LEVELS = 50;
// One tick is 100 ns. The sweep reads starts from the process TABLE (CIM, microsecond precision); the proof that follows reads
// them from a handle. 2 ms covers that rounding and cannot confuse two processes that held one pid.
const START_TOLERANCE_TICKS = 20000;
// The fallback proves and ends every pending pid in ONE PowerShell call (PR #145 Y2): one timeout for the whole batch.
const FALLBACK_BATCH_TIMEOUT_MS = 10000;
const sweepScript = (pid) => `$ErrorActionPreference='Stop'
$root=${pid}
function Ftime($d){$d.ToFileTimeUtc()}
# K1 proves and kills one process, K2 waits for it; together they answer @{ended;exit}.
#   ended  true when it is no longer the process we meant: killed by us, already gone, or its pid belongs to another process now.
#          false when we could not tell or could not kill it (it stays pending, and the fallback tries it with a proof).
#   exit   the LATEST moment the process we meant can have exited: its own ExitTime when we killed it; when its pid was reused, the
#          start of the process holding it now (it died before that); $null when unknown (gone, or unreadable).
function K1($o,$isRoot){
  try{$p=[Diagnostics.Process]::GetProcessById($o.id)}catch{return @{ended=$true;exit=$null;p=$null}}
  try{
    $null=$p.Handle
    $st=$p.StartTime.ToFileTimeUtc()
    if(-not $isRoot -and [math]::Abs($st-$o.start) -gt ${START_TOLERANCE_TICKS}){return @{ended=$true;exit=$st;p=$null}}
    $p.Kill()
    return @{ended=$false;exit=$null;p=$p}
  }catch{}
  return @{ended=$false;exit=$null;p=$null}
}
function K2($r){
  if($null -eq $r.p){return $r}
  try{
    [void]$r.p.WaitForExit(2000)
    if($r.p.HasExited){$x=$null;try{$x=$r.p.ExitTime.ToFileTimeUtc()}catch{};return @{ended=$true;exit=$x;p=$null}}
  }catch{}
  return @{ended=$false;exit=$null;p=$null}
}
# Is it still the process we listed? Gone or another process: no. Unreadable (access denied): assume yes, the fallback will judge it.
function Alive($o){
  try{$p=[Diagnostics.Process]::GetProcessById($o.id)}catch{return $false}
  try{if($p.HasExited){return $false};return ([math]::Abs($p.StartTime.ToFileTimeUtc()-$o.start) -le ${START_TOLERANCE_TICKS})}catch{return $true}
}
function ReadProcs{Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8}
function Say($pend){[Console]::Out.WriteLine('ALIVE '+(($pend | ForEach-Object { [string]$_.id+':'+[string]$_.start }) -join ' '))}
# The children of $parents in $rows. A row is P's child only if it names P's pid and started no earlier than P, and:
#   P alive (a snapshot parent, or one we could not kill): that is enough.
#   P ended with a known exit bound: it started no later than that bound.
#   P gone and the table shows a process that started after P holding its pid now: it started before that holder did.
#   no bound at all: only a row the snapshot already showed under this parent ($known), never a new one -- a stranger that reused the
#   pid and started a child would be adopted otherwise.
# A row with no CreationDate (System Idle Process) is skipped.
function Kids($rows,$parents,$known){
  $holder=@{}
  foreach($r in $rows){if($null -ne $r.CreationDate){$holder[[int]$r.ProcessId]=Ftime $r.CreationDate}}
  $byId=@{}
  foreach($p in $parents){if(-not $byId.ContainsKey($p.id)){$byId[$p.id]=New-Object System.Collections.ArrayList};[void]$byId[$p.id].Add($p)}
  $out=@()
  foreach($r in $rows){
    if($null -eq $r.CreationDate){continue}
    $pp=[int]$r.ParentProcessId;$cs=Ftime $r.CreationDate;$k=[int]$r.ProcessId
    if(-not $byId.ContainsKey($pp)){continue}
    foreach($p in $byId[$pp]){
      if($cs -lt $p.start){continue}
      $ub=$p.exit
      if((-not $p.alive) -and ($null -eq $ub) -and $holder.ContainsKey($p.id) -and ($holder[$p.id] -gt $p.start+${START_TOLERANCE_TICKS})){$ub=$holder[$p.id]}
      if($p.alive){$take=$true}
      elseif($null -ne $ub){$take=($cs -le $ub)}
      else{$take=($known.ContainsKey($k) -and [math]::Abs($known[$k]-$cs) -le ${START_TOLERANCE_TICKS})}
      if($take){$out+=[pscustomobject]@{id=$k;start=$cs;exit=$null;alive=$true};break}
    }
  }
  $out
}
function Desc($rows,$rootObj){
  $out=@();$f=@($rootObj);$seen=@{};$seen[$root]=1
  while($f.Count){$n=@(Kids $rows $f @{} | Where-Object { -not $seen.ContainsKey($_.id) });foreach($x in $n){$seen[$x.id]=1};$out+=$n;$f=$n}
  $out
}
try{[void][Diagnostics.Process]::GetProcessById($root)}catch{exit 0}
try{$snap=@(ReadProcs)}catch{exit 3}
$rr=@($snap | Where-Object { ([int]$_.ProcessId -eq $root) -and ($null -ne $_.CreationDate) })
if(-not $rr.Count){exit 0}
$rootObj=[pscustomobject]@{id=$root;start=(Ftime $rr[0].CreationDate);exit=$null;alive=$true}
$pending=@($rootObj)+@(Desc $snap $rootObj)
$known=@{};foreach($o in $pending){$known[$o.id]=$o.start}
$endedIds=@{}
Say $pending
$kill=@($rootObj)
for($i=0;$i -lt ${SWEEP_MAX_LEVELS} -and $kill.Count;$i++){
  $parents=@()
  # One level is ended together, then waited on: 200 sleepers are one wait, not 200. A sequential Kill + WaitForExit took 17 s
  # unloaded, close to the 20 s the relay gives the sweep, and a sweep cut off there has not yet listed the level below.
  $first=@($kill | ForEach-Object { ,@{o=$_;r=(K1 $_ ($_.id -eq $root))} })
  foreach($e in $first){
    $o=$e.o
    $res=K2 $e.r
    if($res.ended){$endedIds[$o.id]=1}
    $parents+=[pscustomobject]@{id=$o.id;start=$o.start;exit=$res.exit;alive=(-not $res.ended)}
  }
  # Filtered once per level, by a table: a Where-Object per ended process was 200 x 200 script blocks (6 s of a 20 s budget).
  $pending=@($pending | Where-Object { -not $endedIds.ContainsKey($_.id) })
  $rows=$null
  for($a=0;$a -lt 2 -and $null -eq $rows;$a++){try{$rows=@(ReadProcs)}catch{Start-Sleep -Milliseconds 200}}
  if($null -eq $rows){Say $pending;exit 4}
  $kill=@(Kids $rows $parents $known | Where-Object { -not $endedIds.ContainsKey($_.id) })
  $have=@{};foreach($o in $pending){$have[$o.id]=1}
  $pending=[System.Collections.ArrayList]@($pending)
  foreach($o in $kill){if(-not $have.ContainsKey($o.id)){$have[$o.id]=1;[void]$pending.Add($o)}}
  Say $pending
}
$pending=@($pending | Where-Object { Alive $_ })
Say $pending
if($kill.Count -or $pending.Count){exit 5}`;

// What the sweep still had to end when it stopped: its LAST `ALIVE <pid>:<start> ...` line. A pid the sweep already ended is
// NOT in it (BACKLOG #73, Dexter S7-1: it may belong to a stranger by now), and every pid carries the start the sweep read, so
// the fallback can prove the process is still that one before it ends it.
const PID_LIST = /^ALIVE((?: \d+:\d+)*)\s*$/;
function sweepPids(stdout) {
  // Only COMPLETE lines: a sweep cut off mid-write could leave "ALIVE 10:5 1", which names some other process.
  const lines = String(stdout || '').split(/\r?\n/).slice(0, -1).filter((l) => PID_LIST.test(l));
  if (!lines.length) return [];
  return PID_LIST.exec(lines[lines.length - 1])[1].split(' ').filter(Boolean).slice(0, 200).map((pair) => {
    const [pid, start] = pair.split(':');
    return { pid: Number(pid), start };
  });
}

// `run`, `proveBatch` and `sweepTimeoutMs` are seams for the tests, which break the sweep on purpose. `_since` is DEPRECATED and unread:
// the sweep decides what is a child by the parent link and the parent's start, never by a wall clock (PR #126 Dexter F4); the
// parameter stays only so the callers' argument lists do not change.
function killTree(child, _since, { run = spawnSync, proveBatch = killProvenBatch, sweepTimeoutMs = SWEEP_TIMEOUT_MS } = {}) {
  try {
    if (process.platform === 'win32') {
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', sweepScript(child.pid)],
        { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: sweepTimeoutMs });
      if (r.error || r.status !== 0) {
        // The root is our own child (libuv holds its pid until `close`), so it is ended by number: the sweep may never have said anything.
        run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        // Every other pid the sweep had still to end is proven by its start and ended in ONE call (host/kill-tree.js killProvenBatch):
        // a pid reused since is not ours, and a pid per PowerShell start would hold the relay for minutes.
        const pending = sweepPids(r.stdout).filter((t) => t.pid !== child.pid);
        if (pending.length) {
          try { proveBatch(pending.map((t) => ({ pid: t.pid, start: t.start })), { toleranceTicks: START_TOLERANCE_TICKS, timeoutMs: FALLBACK_BATCH_TIMEOUT_MS }); } catch { /* best effort */ }
        }
      }
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function parseArgs(argv) {
  const out = { pipe: null, then: null, quietWhen: null };
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--pipe') out.pipe = argv[i + 1];
    else if (argv[i] === '--then') out.then = argv[i + 1];
    else if (argv[i] === '--quiet-when') out.quietWhen = argv[i + 1];
  }
  return out;
}

// BACKLOG #27: the person moved the status line into the tab header. Read on
// EVERY fire, so the toggle needs no session restart. Only an exact `true`
// quiets the row: a missing, unreadable or corrupt file prints the row as
// before, because failing toward a duplicate row beats failing toward a
// missing one.
const choseHeader = (value) => !!value && value.statusInHeader === true;

function quiet(file) {
  if (!file) return false;
  try {
    return choseHeader(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

// The bare name, rebuilt into a pipe path here -- the same division of labour
// as the native hook helper, and for the same shell-escaping reason.
function pipePath(name) {
  if (/^\\\\/.test(name)) return name;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : name;
}

function forward(pipe, input) {
  return new Promise((resolve) => {
    let doc;
    try { doc = JSON.parse(input); } catch { resolve(); return; }
    if (!pipe) { resolve(); return; }
    const sock = net.connect(pipePath(pipe), () => {
      sock.end(JSON.stringify({ event: 'Status', payload: doc }) + '\n');
    });
    const done = () => { try { sock.destroy(); } catch {} resolve(); };
    sock.on('error', done);
    sock.on('close', done);
    setTimeout(done, FORWARD_TIMEOUT_MS).unref();
  });
}

function runUser(encoded, input, { timeoutMs = USER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!encoded) { resolve(0); return; }
    let command;
    try { command = Buffer.from(encoded, 'base64').toString('utf8'); } catch { resolve(0); return; }
    if (!command) { resolve(0); return; }
    let child;
    const since = Date.now();
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    } catch {
      resolve(1);
      return;
    }
    const timer = setTimeout(() => { killTree(child, since); resolve(1); }, timeoutMs);
    timer.unref();
    child.on('error', () => { clearTimeout(timer); resolve(1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(typeof code === 'number' ? code : 1); });
    child.stdin.on('error', () => { /* the user command may not read stdin */ });
    child.stdin.end(input);
  });
}

async function relay(argv, input) {
  const { pipe, then, quietWhen } = parseArgs(argv);
  const [, code] = await Promise.all([
    forward(pipe, input),
    quiet(quietWhen) ? Promise.resolve(0) : runUser(then, input),
  ]);
  return code;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    // Exit explicitly: if killTree failed, the child would otherwise hold the
    // event loop and the relay would hang with it (Miguel #51 2).
    relay(process.argv.slice(2), input).then((code) => { process.exit(code); });
  });
}

module.exports = { parseArgs, relay, forward, runUser, quiet, killTree, sweepPids, USER_TIMEOUT_MS };
