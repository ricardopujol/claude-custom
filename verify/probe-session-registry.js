'use strict';
/* What does the CLI's session registry (`~/.claude/sessions/<pid>.json`) hold,
   and can a live session be told from a leftover file? Read-only: it reads the
   registry and asks the OS about the pids in it. No `claude` is spawned, nothing
   is written, no tokens are spent.

     node verify/probe-session-registry.js

   Extension X1 (PLAN_WORKTREE_TABS.md) warns when a TERMINAL `claude` is live in
   a worktree a tab is about to open. The plan reads that off this registry
   instead of transcript recency, and the session lock needs the same primitive
   for its own stale check: "is pid P still the process that started at T?".
   The registry is undocumented, so this pins the three things both rely on:
     1. the fields and their types (pid, sessionId, cwd, procStart, status, kind);
     2. procStart's unit, and whether the OS reports the SAME value for a live
        pid (exact match = pid reuse is detectable without a tolerance);
     3. whether files outlive their session (if they do, the pid check is
        load-bearing, not belt and braces).

   NEVER reads `<pid>.<hash>.key`: it holds a peer token. Only `*.json`.

   MEASURED 2026-09-30, claude 2.1.284 / 2.1.285, Windows 11, 5 live sessions:
   1. One `<pid>.json` per session (plus its `.key`). Fields: pid (number),
      sessionId, cwd, procStart (STRING), startedAt (ms epoch), version, kind
      ("interactive"), entrypoint ("cli"), status ("idle" | "busy"), pidDomain
      ("win32:<host>"), name, updatedAt, statusUpdatedAt, and peer and messaging fields.
      `cwd` is the native path, backslashes and on-disk case, so compare it
      through project-layout's normPath, never as a string.
   2. procStart is a FILETIME (100 ns ticks since 1601, UTC) as a decimal
      string. `(Get-Process -Id P).StartTime.ToFileTimeUtc()` returned the SAME
      string for all 5 live pids: exact equality, no tolerance needed, so a
      reused pid is detectable. Cost: one powershell.exe call for every pid,
      ~250 ms. `Date.now() - process.uptime()*1000` is 12 ms off the OS value,
      so a lock must record the OS FILETIME for itself too, or its own start
      time never matches what a competitor reads back.
   3. NOT MEASURED: whether a clean exit deletes the file (0 leftovers were
      present, and killing a live session to find out isn't read-only). The
      session lock and the terminal warning both check pid + procStart
      against the OS, so they don't depend on it either way.
   Every session in the registry is entrypoint "cli", harness-hosted or not:
   the registry can't tell a terminal `claude` from another host's. The lock
   separates those (another host holds it; a terminal session doesn't). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');

// FILETIME: 100 ns ticks since 1601-01-01 UTC. BigInt, because a FILETIME is
// ~1.3e17 and a double only holds integers exactly up to 2^53 (~9e15).
const EPOCH_DIFF_MS = 11644473600000n;
const fileTimeToIso = ft => new Date(Number(BigInt(ft) / 10000n - EPOCH_DIFF_MS)).toISOString();

// One PowerShell call for every pid: start times as FILETIME UTC, keyed by pid.
// Returns { starts: Map<pid, string>, ms }.
function osStartTimes(pids) {
  const t0 = Date.now();
  if (!pids.length) return { starts: new Map(), ms: 0 };
  const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`;
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    out = String(err.stdout || '');   // exits non-zero when some pid is gone
  }
  const starts = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(line.trim());
    if (m) starts.set(Number(m[1]), m[2]);
  }
  return { starts, ms: Date.now() - t0 };
}

function main() {
  let names;
  try {
    names = fs.readdirSync(DIR);
  } catch (err) {
    console.log(`no registry at ${DIR}: ${err.code}`);
    return;
  }
  const others = names.filter(n => !n.endsWith('.json'));
  console.log(`registry: ${DIR}`);
  console.log(`files: ${names.length} (${names.length - others.length} .json, others by extension: ` +
    JSON.stringify(others.reduce((a, n) => { const e = path.extname(n) || '(none)'; a[e] = (a[e] || 0) + 1; return a; }, {})) + ')');

  const entries = [];
  for (const n of names.filter(x => x.endsWith('.json'))) {
    try {
      entries.push({ file: n, doc: JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')) });
    } catch (err) {
      entries.push({ file: n, error: err.message });
    }
  }

  // 1. Field inventory: every key, with the set of types it was seen with.
  const types = {};
  for (const { doc } of entries) {
    if (!doc) continue;
    for (const [k, v] of Object.entries(doc)) {
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      (types[k] = types[k] || new Set()).add(t);
    }
  }
  console.log('\nfields (types seen):');
  for (const [k, s] of Object.entries(types)) console.log(`  ${k}: ${[...s].join('|')}`);

  const vals = k => [...new Set(entries.map(e => e.doc && e.doc[k]).filter(v => v !== undefined))];
  console.log(`\nkind values: ${JSON.stringify(vals('kind'))}`);
  console.log(`status values: ${JSON.stringify(vals('status'))}`);
  console.log(`entrypoint values: ${JSON.stringify(vals('entrypoint'))}`);
  console.log(`pidDomain values: ${JSON.stringify(vals('pidDomain'))}`);
  console.log(`version values: ${JSON.stringify(vals('version'))}`);

  // 2 + 3. procStart vs the OS, and live vs leftover.
  const pids = entries.map(e => e.doc && e.doc.pid).filter(p => Number.isInteger(p) && p > 0);
  const { starts, ms } = osStartTimes(pids);
  console.log(`\nOS start-time query: ${pids.length} pids in ${ms} ms (one powershell.exe call)`);

  let live = 0, exact = 0, dead = 0, reused = 0;
  console.log('\nper file:');
  for (const { file, doc, error } of entries) {
    if (error) { console.log(`  ${file}: UNPARSEABLE (${error})`); continue; }
    const fileNamePid = Number(path.basename(file, '.json'));
    const os = starts.get(doc.pid);
    const reg = doc.procStart === undefined ? undefined : String(doc.procStart);
    let verdict;
    if (os === undefined) { verdict = 'DEAD pid (leftover file)'; dead++; }
    else if (reg === os) { verdict = 'LIVE, procStart == OS start (exact)'; live++; exact++; }
    else {
      const deltaMs = reg ? Number((BigInt(os) - BigInt(reg)) / 10000n) : NaN;
      verdict = `pid ALIVE but start differs by ${deltaMs} ms (reused pid, or unit mismatch)`;
      reused++;
    }
    console.log(`  ${file}: pid=${doc.pid}${fileNamePid === doc.pid ? '' : ` (file name says ${fileNamePid})`} ` +
      `kind=${doc.kind} status=${doc.status} cwd=${JSON.stringify(doc.cwd)}`);
    console.log(`      procStart=${reg} (${reg ? fileTimeToIso(reg) : '-'}) startedAt=${doc.startedAt}` +
      `${typeof doc.startedAt === 'number' ? ` (${new Date(doc.startedAt).toISOString()})` : ''} ` +
      `updatedAt=${doc.updatedAt}`);
    console.log(`      -> ${verdict}`);
  }
  console.log(`\nsummary: ${live} live (${exact} exact procStart match), ${dead} leftover, ${reused} mismatched`);

  // Our own process through the same query: is the value a host would write into
  // its lock the same one a competitor would read back from the OS?
  const self = osStartTimes([process.pid]).starts.get(process.pid);
  const fromUptime = Math.round(Date.now() - process.uptime() * 1000);
  console.log(`\nself: OS start ${self} (${self ? fileTimeToIso(self) : '-'}); ` +
    `Date.now()-uptime = ${new Date(fromUptime).toISOString()} ` +
    `(${self ? fromUptime - Number(BigInt(self) / 10000n - EPOCH_DIFF_MS) : '?'} ms apart)`);
}

main();
