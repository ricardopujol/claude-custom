'use strict';
/* FF9 Q2 — what does emitting the updatedInput stdout JSON actually cost
   against the 23ms/hook budget verify/measure-hook-latency.js already
   measured?

   Same method as measure-hook-latency.js, on purpose: a SEPARATE bridge
   process (see that file's header for why an inline bridge lies -- spawnSync
   blocks the event loop and produces a benchmark that measures its own
   connect timeout), spawnSync'ing the candidate exactly as Claude Code would
   block on a hook, N warm trials after a discarded warmup, delivery to the
   bridge confirmed so a fast-but-lossy candidate cannot look good.

   Candidates:
     - "no hook"                 -- not spawned. If no PreToolUse hook is
       configured, Claude Code pays nothing: this is a definitional 0ms
       reference, not a measurement, and is reported as such rather than
       faked with an empty spawn.
     - "helper as today"         -- helper/hook-helper.js: connect, write the
       payload, exit. What every matched Task/Bash call already pays.
     - "helper + updatedInput"   -- verify/updated-input-helper.js: identical,
       plus printing the hookSpecificOutput JSON to stdout before exit --
       what an FF9 item-rewriting hook would additionally cost. */
const { spawnSync, fork } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PIPE_PREFIX = ['', '', '.', 'pipe', ''].join('\\');   // \\.\pipe\
const PIPE = PIPE_PREFIX + 'claude-custom-ff9-bench-' + process.pid;
const N = Number(process.env.N) || 30;
const WARMUP = 5;

const PAYLOAD = JSON.stringify({
  session_id: 'ff9-bench',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type: 'general-purpose', prompt: 'reply with the single word OK' },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sorted = xs => xs.slice().sort((a, b) => a - b);
const pct = (xs, p) => sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

const child = fork(path.join(__dirname, 'bridge-server.js'), [PIPE], { stdio: 'inherit' });
const ask = msg => new Promise(resolve => {
  child.once('message', resolve);
  child.send(msg);
});

function bench(cmd, args) {
  for (let i = 0; i < WARMUP; i++) spawnSync(cmd, args, { input: PAYLOAD, windowsHide: true });
  const times = [];
  let lastStdout = '';
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(cmd, args, { input: PAYLOAD, windowsHide: true, encoding: 'utf8' });
    const t1 = process.hrtime.bigint();
    if (r.error) return { error: r.error.message };
    times.push(Number(t1 - t0) / 1e6);
    lastStdout = r.stdout || '';
  }
  return { times, lastStdout };
}

(async () => {
  await new Promise(resolve => child.once('message', resolve));   // ready

  const NODE_HELPER = path.join(REPO, 'helper', 'hook-helper.js');
  const UPDATED_HELPER = path.join(REPO, 'verify', 'updated-input-helper.js');
  const NATIVE_TODAY = path.join(REPO, '.harness', 'hook-helper.exe');
  const NATIVE_UPDATED = path.join(REPO, '.harness', 'updated-input', 'hook-helper-updated-input.exe');
  const haveNative = require('fs').existsSync(NATIVE_TODAY) && require('fs').existsSync(NATIVE_UPDATED);

  const candidates = [
    // Floor: same native binary with no --pipe, so it parses args and
    // returns immediately -- Windows process creation + AOT runtime startup,
    // paid by EVERY candidate below regardless of what it does with a pipe.
    ...(haveNative ? [['floor (native, spawn only)', NATIVE_TODAY, ['--event', 'PreToolUse']]] : []),
    ...(haveNative ? [['native helper as today', NATIVE_TODAY, ['--pipe', PIPE, '--event', 'PreToolUse']]] : []),
    ...(haveNative ? [['native helper + updatedInput', NATIVE_UPDATED, ['--pipe', PIPE, '--event', 'PreToolUse']]] : []),
    ['node helper as today', process.execPath, [NODE_HELPER, '--pipe', PIPE, '--event', 'PreToolUse']],
    ['node helper + updatedInput', process.execPath, [UPDATED_HELPER, '--pipe', PIPE, '--event', 'PreToolUse']],
  ];
  if (!haveNative) {
    console.log('NOTE: .harness/hook-helper.exe or the updated-input native build is missing --');
    console.log('      run helper/build.ps1 and the verify/native-updated-input-helper publish');
    console.log('      step first for the native (production-shape) comparison. Reporting the');
    console.log('      Node-only candidates in the meantime.');
  }

  const results = [];
  for (const [label, cmd, args] of candidates) {
    await ask('reset');
    const r = bench(cmd, args);
    await sleep(400);
    const stats = await ask('stats');
    if (r.error) { console.log(`  ${label}: SPAWN ERROR ${r.error}`); continue; }
    const isFloor = label.startsWith('floor');
    results.push({
      label, times: r.times, lastStdout: r.lastStdout, isFloor,
      delivered: stats.events, expected: isFloor ? 0 : N + WARMUP,
    });
  }

  console.log('\n=== FF9 Q2: updatedInput stdout cost (n=' + N + ' timed, ' + WARMUP + ' warmup discarded) ===\n');
  console.log('  candidate                 mean     p50     p95     max   delivered');
  console.log('  ' + '-'.repeat(68));
  console.log('  ' + 'no hook (reference)'.padEnd(24) + '0.0ms'.padStart(7)
    + '0.0ms'.padStart(8) + '0.0ms'.padStart(8) + '0.0ms'.padStart(8)
    + '   n/a (not spawned -- nothing runs if no hook is configured)');
  for (const r of results) {
    console.log(
      '  ' + r.label.padEnd(24) +
      (mean(r.times).toFixed(1) + 'ms').padStart(7) +
      (pct(r.times, 0.5).toFixed(1) + 'ms').padStart(8) +
      (pct(r.times, 0.95).toFixed(1) + 'ms').padStart(8) +
      (Math.max(...r.times).toFixed(1) + 'ms').padStart(8) +
      `   ${r.delivered}/${r.expected}`
    );
  }

  const printDelta = (todayLabel, updatedLabel, heading) => {
    const today = results.find(r => r.label === todayLabel);
    const updated = results.find(r => r.label === updatedLabel);
    if (!today || !updated) return;
    const delta = mean(updated.times) - mean(today.times);
    console.log(`\n  ${heading}: ${delta.toFixed(2)}ms`);
  };
  printDelta('native helper as today', 'native helper + updatedInput',
    'delta attributable to the updatedInput stdout write (NATIVE, production shape)');
  printDelta('node helper as today', 'node helper + updatedInput',
    'delta attributable to the updatedInput stdout write (Node baseline, not shipped)');

  const nativeToday = results.find(r => r.label === 'native helper as today');
  const floor = results.find(r => r.isFloor);
  if (floor && nativeToday) {
    console.log(`\n  Windows process creation + AOT runtime startup : ${mean(floor.times).toFixed(1)}ms`);
    console.log(`  attributable to the pipe round-trip (as today)  : ${(mean(nativeToday.times) - mean(floor.times)).toFixed(1)}ms`);
  }

  const nativeUpdated = results.find(r => r.label === 'native helper + updatedInput');
  if (nativeUpdated) {
    console.log('\n  last stdout captured from "native helper + updatedInput":');
    console.log('   ' + nativeUpdated.lastStdout.slice(0, 220));
  }

  await ask('quit').catch(() => {});
  child.kill();
  process.exit(0);
})();
