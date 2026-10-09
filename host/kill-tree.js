'use strict';
/**
 * Kill a process tree, not just its top pid.
 *
 * Extracted from host/host.js (Miguel, PR #61 review, finding H3): the only
 * vetted implementation of this lived inline in the host, and a probe that
 * needs the same guarantee (a `child.kill()`/`term.kill()` on Windows kills
 * ONE process, not the tree beneath it -- verify/probe-pause.js's own
 * findings show the real CLI's Bash tool nests three nested bash.exe layers
 * before the real leaf) was about to reimplement a thinner, unguarded copy
 * of it. This is the single source of truth both host/host.js and verify/
 * probes require.
 *
 * Dexter, PR #61 review round 2: confirmed this extraction is
 * behaviour-preserving for `killTree`/host.js (no finding there). `spawnFn`
 * below is an ADDITIVE optional parameter (default unchanged) purely so
 * test/probe-hygiene.test.js can inject a fake `spawn` and exercise the
 * 'error'-listener fallback without actually depending on `taskkill` being
 * absent from this machine's PATH.
 */
const { spawn, spawnSync, execFile } = require('child_process');

/*
 * Has this child ended? (PR #130 review, Dexter #1.) Once a child's exit has been handled its pid is free and may
 * already name another process, so a kill BY PID is only safe before that. A Node ChildProcess says so itself
 * (exitCode or signalCode set); a node-pty IPty does not, so its exit is recorded by trackExit() from the moment it
 * is spawned. An IPty nobody tracked cannot be judged: childExited() then answers "ended" (doubt keeps the stranger
 * safe), and killChildTree says why it did nothing.
 *
 * node-pty's onExit IS LATE (PR #130 review round 2, Dexter #1): conpty.cc closes the process handle the moment the
 * shell exits, and onExit fires only after a >= 1 s flush timer, so the pid is free a second before any JS knows. So
 * for an IPty, trackExit also reads its start time at spawn, and killChildTree kills it through killProven (the start
 * proven again on a held handle) once that is known. And a kill site runs at most once per child: the second
 * killed() of a probe (its finally, then its process 'exit' handler) is a no-op.
 */
const EXITED = Symbol.for('claude-custom.child.exited');
const TRACKED = Symbol.for('claude-custom.child.tracked');
const KILLED = Symbol.for('claude-custom.child.killed');
const START = Symbol.for('claude-custom.child.start');
const START_READ = Symbol.for('claude-custom.child.startRead');

function trackExit(child, { startTimes } = {}) {
  if (!child || child[TRACKED]) return child;
  child[TRACKED] = true;
  const mark = () => { child[EXITED] = true; };
  if (typeof child.once === 'function') child.once('exit', mark);
  else if (typeof child.onExit === 'function') child.onExit(mark);
  if (!('exitCode' in child) && child.pid) {
    const read = startTimes || require('./proc-start').startTimes;
    child[START_READ] = Promise.resolve()
      .then(() => read([child.pid]))
      .then((m) => { const s = m && m.get(child.pid); if (typeof s === 'string') child[START] = s; })
      .catch(() => { /* unknown: the kill falls back to the pid, once */ });
  }
  return child;
}

function childExited(child) {
  if (!child) return true;
  if (child[EXITED] === true) return true;
  if ('exitCode' in child) return child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined);
  return !child[TRACKED];
}

// Kill a child's tree by its pid, but only while the child is provably still running, and only once. An IPty whose
// start is known is killed through killProven. True if a kill was sent.
function killChildTree(child, { killFn = killPidTree, provenKill = killProven } = {}) {
  if (!child || !child.pid || child[KILLED]) return false;
  if (childExited(child)) {
    if (!('exitCode' in child) && !child[TRACKED]) console.log(`[kill-tree] pid ${child.pid}: not killed, its exit was never tracked (call trackExit at spawn)`);
    return false;
  }
  child[KILLED] = true;
  if (!('exitCode' in child) && typeof child[START] === 'string') provenKill(child.pid, child[START]);
  else killFn(child.pid);
  return true;
}

// child is a Node ChildProcess (has .pid, .exitCode, .kill()) -- the shape
// host/host.js's own spawned children (the health runner, the launcher) have.
function killTree(child, { spawnFn = spawn } = {}) {
  if (!child || childExited(child)) return;
  if (process.platform === 'win32') {
    // The try/catch below does NOT catch this: a ChildProcess reports a failed
    // spawn through an ASYNC 'error' event, and an EventEmitter with no 'error'
    // listener THROWS -- an uncaught exception that kills the host (or a probe)
    // and any live Claude session with it. Reproduced: taskkill missing from
    // PATH exits the host with ENOENT.
    try {
      const killer = spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', (err) => {
        console.log('[kill-tree] taskkill failed:', err.code || err.message, '- falling back');
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      });
      return;
    } catch { /* fall through to the portable kill */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// killPidTree is the same primitive for callers that only have a raw pid --
// a Win32_Process table row, or a node-pty IPty's .pid -- not a Node
// ChildProcess object. Synchronous (spawnSync, not spawn+'error' listener):
// callers needing this are cleanup paths (SIGINT handlers, `finally` blocks)
// where "did it actually finish before we exit" matters more than not
// blocking the event loop for the ~50-100ms taskkill takes.
//
// Windows only: taskkill /T walks the tree. Off Windows this sends SIGTERM to
// the single given pid -- NOT a tree kill (Dexter, PR #61 review, finding 5).
// No shipped caller relies on tree semantics off Windows today: probe-pause.js
// gates its whole suspend/resume path on win32, and probe-local-model.js only
// sets `shell: true` (the thing that makes a tree possible in the first
// place) on win32. A future non-Windows caller that needs a real tree kill
// must not assume this function gives it one.
function killPidTree(pid, { run = spawnSync, fallback = (p) => process.kill(p, 'SIGTERM'), platform = process.platform } = {}) {
  if (!pid) return;
  if (platform === 'win32') {
    try {
      const r = run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (r.error) {
        console.log('[kill-tree] taskkill could not be run:', r.error.code || r.error.message, '- falling back');
      } else if (r.status === 128) {
        // "Not found": the pid is already gone. Final (PR #130 review, Dexter #2): a process.kill on it now could only
        // reach a process that took the freed pid since, which nobody proved is ours.
        return;
      } else if (r.status !== 0) {
        // Finding 3 (Dexter, PR #61 review): `r.error` is only set when
        // taskkill itself couldn't be spawned. When it runs and FAILS --
        // status 128 "process not found" (already dead, or a stale pid) or
        // 1 "Access is denied" (an elevated process, or a partial tree
        // failure) -- the old code treated that as success and returned
        // silently, leaving the target alive with no fallback attempted.
        const detail = (r.stderr || '').toString().trim();
        console.log(`[kill-tree] taskkill exited ${r.status} for pid ${pid}${detail ? ` (${detail})` : ''} - falling back`);
      } else {
        return; // genuine success: status 0, no spawn error
      }
    } catch (err) { console.log('[kill-tree] taskkill threw:', err.message, '- falling back'); }
  }
  try { fallback(pid); } catch { /* already gone */ }
}

/*
 * A kill that cannot land on a reused pid (PR #130 review, Dexter #2). Proving a start time and killing in two round
 * trips leaves a window in which the process exits and its pid is handed to another; so both happen in ONE PowerShell
 * call that holds the process handle across them (an open handle keeps Windows from reusing the pid): open it, read
 * StartTime ON that handle, compare with the recorded FILETIME (host/proc-start.js reads the same source), and only
 * then taskkill /T while the handle is still held. Outcomes: 'killed', 'gone' (not running, or exited first),
 * 'mismatch' (the pid is another process), 'failed' (taskkill refused), 'unknown' (could not be judged: nothing done).
 */
const POWERSHELL = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function parseProvenKill(r) {
  if (!r || r.error || typeof r.stdout !== 'string') return 'unknown';
  const m = /^(GONE|UNKNOWN|MISMATCH|KILLED (-?\d+))\s*$/m.exec(r.stdout);
  if (!m) return 'unknown';
  if (m[1] === 'GONE') return 'gone';
  if (m[1] === 'MISMATCH') return 'mismatch';
  if (m[1] === 'UNKNOWN') return 'unknown';
  const code = Number(m[2]);
  return code === 0 ? 'killed' : code === 128 ? 'gone' : 'failed';
}

// The one script, shared by the sync and async callers: they can never disagree on what is proven.
// `toleranceTicks` (100 ns ticks, default 0 = an exact string compare): for a start read from the process TABLE (CIM, microsecond
// precision) rather than from a handle; the status relay's sweep passes 20000 (2 ms).
function provenScript(pid, start, toleranceTicks = 0) {
  return [
    `try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch { 'GONE'; exit }`,
    "try { $null = $p.Handle; $s = $p.StartTime.ToFileTimeUtc() } catch { 'UNKNOWN'; exit }",
    toleranceTicks > 0
      ? `if ([math]::Abs([long]$s - ${start}) -gt ${toleranceTicks}) { 'MISMATCH'; exit }`
      : `if ([string]$s -ne '${start}') { 'MISMATCH'; exit }`,
    "if ($p.HasExited) { 'GONE'; exit }",
    `& taskkill.exe /PID ${pid} /T /F *> $null; 'KILLED ' + $LASTEXITCODE`,
  ].join('; ');
}
const validProof = (pid, start, tol = 0) => Number.isInteger(pid) && pid > 0 && typeof start === 'string' && /^\d+$/.test(start) && Number.isSafeInteger(tol) && tol >= 0;

function killProven(pid, start, { run = spawnSync, powershell = POWERSHELL, toleranceTicks = 0 } = {}) {
  if (!validProof(pid, start, toleranceTicks)) return 'unknown';
  return parseProvenKill(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', provenScript(pid, start, toleranceTicks)], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
}

/**
 * killProven for MANY pids in ONE PowerShell call (PR #145 Miguel Y2 / Dexter F3): the status relay's fallback runs in a timer on
 * a path that must give way quickly, and one PowerShell start per pending pid was up to 30 s each. Same proof per pid (open the
 * process, hold its handle, compare StartTime on it within `toleranceTicks`, only then taskkill /T), one timeout for the batch.
 * Returns Map<pid, outcome> in item order, outcomes as killProven's; a pid the script did not answer for (a cut-off or failed
 * run) is 'unknown'. Bad items are skipped. At most 200 items.
 */
function killProvenBatch(items, { run = spawnSync, powershell = POWERSHELL, toleranceTicks = 0, timeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(toleranceTicks) || toleranceTicks < 0) throw new Error('killProvenBatch: toleranceTicks must be a non-negative safe integer');
  const valid = (Array.isArray(items) ? items : []).filter((t) => t && validProof(t.pid, t.start, toleranceTicks) && BigInt(t.start) < 2n ** 62n).slice(0, 200);
  const out = new Map(valid.map((t) => [t.pid, 'unknown']));
  if (!valid.length) return out;
  const script = [
    `$items = @(${valid.map((t) => `@(${t.pid}, ${t.start})`).join(', ')})`,
    'foreach ($t in $items) {',
    '  $id = $t[0]',
    '  try { $p = Get-Process -Id $id -ErrorAction Stop } catch { "$id GONE"; continue }',
    '  try { $null = $p.Handle; $s = $p.StartTime.ToFileTimeUtc() } catch { "$id UNKNOWN"; continue }',
    `  if ([math]::Abs([long]$s - $t[1]) -gt ${toleranceTicks}) { "$id MISMATCH"; continue }`,
    '  if ($p.HasExited) { "$id GONE"; continue }',
    '  & taskkill.exe /PID $id /T /F *> $null; "$id KILLED $LASTEXITCODE"',
    '}',
  ].join('\n');
  const r = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  const text = r && typeof r.stdout === 'string' ? r.stdout : '';
  for (const m of text.matchAll(/^(\d+) (GONE|UNKNOWN|MISMATCH|KILLED (-?\d+))\s*$/gm)) {
    const pid = Number(m[1]);
    if (!out.has(pid)) continue;
    out.set(pid, m[2] === 'GONE' ? 'gone' : m[2] === 'MISMATCH' ? 'mismatch' : m[2] === 'UNKNOWN' ? 'unknown' : (Number(m[3]) === 0 ? 'killed' : Number(m[3]) === 128 ? 'gone' : 'failed'));
  }
  return out;
}

const execFileAsync = (exe, args, opts) => new Promise((resolve) => {
  execFile(exe, args, opts, (error, stdout) => resolve({ error, stdout: typeof stdout === 'string' ? stdout : '' }));
});

/**
 * killProven without blocking the caller (PR #132 Dexter F2 + Miguel I1: the Resources panel's auto-stop runs in the main
 * process, and a spawnSync there freezes every window for the length of a PowerShell start-up). The same script and the same
 * answers. A run that fails or throws is 'unknown': nothing was judged, nothing is assumed.
 */
async function killProvenAsync(pid, start, { runAsync = execFileAsync, powershell = POWERSHELL, toleranceTicks = 0 } = {}) {
  if (!validProof(pid, start, toleranceTicks)) return 'unknown';
  try {
    const r = await runAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', provenScript(pid, start, toleranceTicks)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    // A run that errored AFTER printing its answer (a timeout kill) still printed it; parseProvenKill reads stdout, and refuses a bare error.
    return parseProvenKill(r && r.stdout ? { stdout: r.stdout } : { error: (r && r.error) || new Error('no output') });
  } catch { return 'unknown'; }
}

module.exports = { killTree, killPidTree, killChildTree, trackExit, childExited, killProven, killProvenBatch, killProvenAsync, parseProvenKill };
