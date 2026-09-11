'use strict';
/* Checklist item: "Real round-trip latency of the native hook helper."
   The design doc estimates the native helper at ~5ms, Node at 60-100ms and
   PowerShell at ~200ms, and says explicitly: measure, don't trust estimates.

   What is measured is the SYNCHRONOUS cost Claude Code pays -- full process
   lifetime, spawn to exit, exactly as a hook blocks a tool call. Delivery is
   confirmed on the bridge so a fast-but-lossy helper cannot look good.

   The bridge runs in a SEPARATE PROCESS. An earlier version ran it inline and
   measured its own blocked event loop: spawnSync stalls the server, connects
   past libuv's pre-created pipe instances time out, and the result was 4/35
   delivery with timings that were really the helper's connect timeout. */
const { spawnSync, fork } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PIPE_PREFIX = ['', '', '.', 'pipe', ''].join('\\');   // \\.\pipe\
const PIPE = PIPE_PREFIX + 'claude-custom-bench-' + process.pid;
const N = Number(process.env.N) || 30;
const WARMUP = 5;

const PAYLOAD = JSON.stringify({
  session_id: 'bench',
  tool_name: 'Task',
  tool_input: { subagent_type: 'code-reviewer', description: 'review the diff' },
});

const BARE_PIPE = PIPE.split('\\').pop();
const PS_SCRIPT =
  "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.','" + BARE_PIPE + "','Out'); " +
  '$c.Connect(200); $w = New-Object System.IO.StreamWriter($c); ' +
  '$w.WriteLine(\'{"event":"PreToolUse","payload":{}}\'); $w.Flush(); $c.Dispose()';

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
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(cmd, args, { input: PAYLOAD, windowsHide: true });
    const t1 = process.hrtime.bigint();
    if (r.error) return { error: r.error.message };
    times.push(Number(t1 - t0) / 1e6);
  }
  return { times };
}

(async () => {
  await new Promise(resolve => child.once('message', resolve));   // ready

  const NATIVE = path.join(REPO, '.harness', 'hook-helper.exe');
  const NODE_HELPER = path.join(REPO, 'helper', 'hook-helper.js');

  const candidates = [
    // Floor: the same binary with no --pipe, so it parses args and returns
    // immediately. Isolates Windows process creation + runtime startup, which
    // EVERY hook implementation pays, from the pipe work this helper adds.
    ['floor (spawn only)', NATIVE, ['--event', 'PreToolUse']],
    ['native C# .exe', NATIVE, ['--pipe', PIPE, '--event', 'PreToolUse']],
    ['node script', process.execPath, [NODE_HELPER, '--pipe', PIPE, '--event', 'PreToolUse']],
    ['powershell', 'powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]],
  ];

  const results = [];
  for (const [label, cmd, args] of candidates) {
    await ask('reset');
    const r = bench(cmd, args);
    await sleep(400);
    const stats = await ask('stats');
    if (r.error) { console.log(`  ${label}: SPAWN ERROR ${r.error}`); continue; }
    const isFloor = label.startsWith('floor');
    results.push({
      label, times: r.times, last: stats.lastPayload, isFloor,
      delivered: stats.events, expected: isFloor ? 0 : N + WARMUP,
    });
  }

  console.log(`\n=== hook helper latency (n=${N} timed, ${WARMUP} warmup discarded) ===\n`);
  console.log('  helper            mean     p50     p95     max   delivered');
  console.log('  ' + '-'.repeat(62));
  for (const r of results) {
    console.log(
      '  ' + r.label.padEnd(16) +
      (mean(r.times).toFixed(1) + 'ms').padStart(7) +
      (pct(r.times, 0.5).toFixed(1) + 'ms').padStart(8) +
      (pct(r.times, 0.95).toFixed(1) + 'ms').padStart(8) +
      (Math.max(...r.times).toFixed(1) + 'ms').padStart(8) +
      `   ${r.delivered}/${r.expected}`
    );
  }

  const floor = results.find(r => r.isFloor);
  const nativeR = results.find(r => r.label.startsWith('native'));
  if (floor && nativeR) {
    const f = mean(floor.times), n = mean(nativeR.times);
    console.log(`\n  Windows process creation + runtime startup : ${f.toFixed(1)}ms`);
    console.log(`  attributable to the pipe round-trip         : ${(n - f).toFixed(1)}ms`);
    console.log('  The floor is paid by ANY hook implementation and cannot be');
    console.log('  optimised away in the helper -- only by hooking less often.');
  }

  const native = nativeR;
  if (native) {
    console.log('\n  payload round-tripped:', JSON.stringify(native.last).slice(0, 120));
    console.log(`\n  Every matched Task/Bash call pays this once, synchronously.`);
    if (native.delivered < native.expected) {
      console.log(`  WARNING: ${native.expected - native.delivered} invocations were NOT delivered.`);
    } else {
      console.log('  Delivery complete for the native helper.');
    }
  }

  await ask('quit').catch(() => {});
  child.kill();
  process.exit(0);
})();
