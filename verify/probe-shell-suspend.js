'use strict';
/* How long can a background shell stay OS-suspended before the CLI does anything about it? (BACKLOG #19, PR #61 left this open:
   it measured 20 s only.)

   One real `claude` session in a pty, NO model turn and so no tokens: a shell command typed in bash mode (`! <cmd>`) and sent
   to the background with Ctrl+B is a background task exactly like one the model starts, and the CLI's own /tasks panel
   lists it. Three such shells are started (each appends a counter line to its own heartbeat file every 500 ms), their leaf
   processes are proven (token in the command line, ancestry reaches this session's pty, start time recorded), and all
   three are suspended at once with NtSuspendProcess. Each is resumed after its own time (default 2, 10 and 30 minutes).
   Before each resume, and 10 s after it, the probe records:
     - the /tasks panel text (Status, Runtime): what the CLI SAYS,
     - the heartbeat count (frozen while suspended, growing again after): what is ACTUALLY happening,
     - whether the process is still alive and still the same one (pid + start time).
   The table at the end is what goes in the PR body.

     node verify/probe-shell-suspend.js            (2, 10 and 30 minutes: about 35 minutes of wall clock, nearly all of it idle)
     node verify/probe-shell-suspend.js 1,2,3      (minutes, comma separated, for a quick run)

   Safety: every suspended pid is registered with the hygiene registry (Ctrl+C or a crash resumes it), the shells are ended
   through killProven (pid + start time re-proved on a held handle), and the session through its held pty handle. Nothing is
   ever killed or suspended by name. Run it under ~/.claude/scripts/heavy-lock.ps1.

   RESULTS: filled in below after the run. */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { createSeenPids } = require('./lib/seen-pids');
const { killChildTree } = require('../host/kill-tree');
const { startTimes } = require('../host/proc-start');
const pause = require('./probe-pause');   // the helpers only; its main() runs under require.main === module

const { hygiene, ntAction, ancestryChain, resolveClaudeExe, cleanEnv } = pause;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${((Date.now() - T0) / 60000).toFixed(1)}min`;

const MINUTES = (process.argv[2] || '2,10,30').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
const CWD = process.env.PROBE_CWD || path.join(__dirname, '..', '..', 'dev');   // a folder claude already trusts

function processTable() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  hygiene.install();
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const seen = createSeenPids();
  const rows = [];
  const shells = MINUTES.map((minutes, i) => {
    const token = crypto.randomBytes(5).toString('hex');
    return { i, minutes, token, file: path.join(os.tmpdir(), `claude-custom-probe-shell-${token}.txt`).replace(/\\/g, '/'), pid: null, start: null };
  });
  const lines = s => { try { return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

  const term = pty.spawn(resolveClaudeExe(), ['--permission-mode', 'default'], {
    name: 'xterm-256color', cols: 140, rows: 50, cwd: CWD, env: { ...cleanEnv(), TERM: 'xterm-256color' },
  });
  hygiene.registerChild(term);
  const xterm = new Terminal({ cols: 140, rows: 50, allowProposedApi: true });
  term.onData(d => xterm.write(d));
  const screen = () => {
    const b = xterm.buffer.active; const out = [];
    for (let y = 0; y < 50; y++) { const l = b.getLine(b.baseY + y); if (l) { const t = l.translateToString(true).trimEnd(); if (t) out.push(t); } }
    return out;
  };
  const until = async (pred, ms, step = 500) => { for (let t = 0; t < ms; t += step) { const v = pred(); if (v) return v; await sleep(step); } return null; };
  const panel = async () => {
    term.write('/tasks'); await sleep(700); term.write('\r'); await sleep(1500);
    const s = screen();
    term.write('\x1b'); await sleep(600);
    return s;
  };
  const panelFor = s => panel().then(p => p.filter(l => /running|Running|killed|failed|stopped|completed|Runtime|Status|node -e/.test(l)).map(l => l.trim()));

  try {
    console.log(`[${at()}] claude in ${CWD}; ${shells.length} shell(s): ${MINUTES.join(', ')} min`);
    if (!(await until(() => /Try "|❯|>/.test(screen().join('\n')) && screen().length > 3, 30000))) throw new Error('claude did not come up:\n' + screen().join('\n'));
    await sleep(2000);

    for (const s of shells) {
      const cmd = `! node -e "const f=require('fs');let n=0;setInterval(()=>f.appendFileSync('${s.file}',(++n)+' '+Date.now()+'\\n'),500)" # ${s.token}`;
      term.write(cmd); await sleep(800); term.write('\r');
      if (!(await until(() => lines(s) >= 3, 20000))) throw new Error(`shell ${s.i} never wrote its heartbeat:\n` + screen().join('\n'));
      // Ctrl+B only takes while the CLI shows its hint (measured: it appears about 5 s into the command; sent earlier the key is ignored and
      // the next command queues behind the one still running in the foreground).
      const hint = () => /ctrl\+b to run in background/.test(screen().join('\n'));
      if (!(await until(hint, 30000))) throw new Error(`shell ${s.i} never offered ctrl+b:\n` + screen().join('\n'));
      term.write('\x02');   // Ctrl+B: send the running command to the background
      if (!(await until(() => /manually backgrounded/.test(screen().join('\n')) && !hint(), 15000))) throw new Error(`shell ${s.i} was not backgrounded:\n` + screen().join('\n'));
      await sleep(1500);
      console.log(`[${at()}] shell ${s.i} (${s.minutes} min) started; heartbeat ${lines(s)}`);
    }
    const bgOk = screen().join('\n');
    console.log(`[${at()}] screen after backgrounding:\n  ${screen().slice(-6).join('\n  ')}`);

    const table = processTable();
    for (const s of shells) {
      const cands = table.filter(p => p.CommandLine && p.CommandLine.includes(s.token) && /node\.exe$/i.test(p.Name));
      const leaf = cands.find(c => !cands.some(o => o.ParentProcessId === c.ProcessId)) || cands[0];
      if (!leaf) throw new Error(`no process carries the token of shell ${s.i}`);
      const chain = ancestryChain(table, leaf.ProcessId, term.pid);
      if (!chain.some(c => c.pid === term.pid)) throw new Error(`shell ${s.i}: pid ${leaf.ProcessId} does not descend from this session`);
      s.pid = leaf.ProcessId;
      const st = (await startTimes([s.pid])).get(s.pid);
      s.start = typeof st === 'string' ? st : null;
      seen.add(s.pid, s.start);
      console.log(`[${at()}] shell ${s.i}: leaf pid ${s.pid} (${chain.map(c => c.name).join(' <- ')}) start ${s.start}`);
    }

    const before = await panelFor();
    console.log(`[${at()}] /tasks before suspend:\n  ${before.join('\n  ')}`);

    // Suspend all, together; then wait for each one's time.
    for (const s of shells) {
      hygiene.registerSuspended(s.pid);
      const r = ntAction('Suspend', s.pid);
      s.suspendedAt = Date.now(); s.frozen = lines(s);
      console.log(`[${at()}] suspend shell ${s.i}: ${r.out || r.err}`);
      s.row = { minutes: s.minutes, suspendRc: r.code };
    }
    for (const s of shells.slice().sort((a, b) => a.minutes - b.minutes)) {
      const wait = s.suspendedAt + s.minutes * 60000 - Date.now();
      if (wait > 0) await sleep(wait);
      const pre = await panelFor();
      const flat = lines(s) <= s.frozen + 1;
      const alive = (await startTimes([s.pid])).get(s.pid);
      console.log(`[${at()}] shell ${s.i} before resume (${s.minutes} min suspended): heartbeat ${s.frozen} -> ${lines(s)} (flat ${flat}), alive ${alive === s.start}`);
      console.log(`  /tasks: ${pre.join(' | ')}`);
      const r = ntAction('Resume', s.pid);
      if (r.code === 0) hygiene.clearSuspended(s.pid);
      await sleep(10000);
      const grew = lines(s) > s.frozen + 3;
      const alive2 = (await startTimes([s.pid])).get(s.pid);
      const post = await panelFor();
      console.log(`[${at()}] shell ${s.i} 10 s after resume: heartbeat ${lines(s)} (grew ${grew}), alive ${alive2 === s.start}`);
      console.log(`  /tasks: ${post.join(' | ')}`);
      rows.push({ minutes: s.minutes, frozenWhileSuspended: flat, aliveBeforeResume: alive === s.start, resumeRc: r.code, grewAfterResume: grew,
        aliveAfterResume: alive2 === s.start, tasksBefore: pre, tasksAfter: post });
    }
    console.log('\n=== TABLE ===');
    console.log('| suspended | frozen | alive at resume | resumed (rc) | counting again | alive +10 s | CLI said before resume |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows.sort((a, b) => a.minutes - b.minutes)) {
      console.log(`| ${r.minutes} min | ${r.frozenWhileSuspended} | ${r.aliveBeforeResume} | ${r.resumeRc} | ${r.grewAfterResume} | ${r.aliveAfterResume} | ${r.tasksBefore.slice(0, 3).join(' / ')} |`);
    }
    console.log('\n=== RESULTS ===\n' + JSON.stringify({ rows, bgOk: /Try "|❯/.test(bgOk) }, null, 2));
  } finally {
    // Every suspended pid is resumed first; then the shells (re-proved), then the session through its held handle.
    for (const s of shells) if (s.pid && hygiene._suspendedPids.has(s.pid)) { const r = ntAction('Resume', s.pid); if (r.code === 0) hygiene.clearSuspended(s.pid); }
    const left = seen.endAll();
    killChildTree(term);
    hygiene.unregisterSpawnedTree(term.pid);
    for (const s of shells) { try { fs.unlinkSync(s.file); } catch { /* not there */ } }
    if (left.left.length) console.log(`LEFT RUNNING (could not be proved or ended): ${left.left.join(', ')}`);
  }
}

if (require.main === module) main().then(() => process.exit(0)).catch((err) => { console.error('probe failed:', err && err.stack); process.exit(1); });
