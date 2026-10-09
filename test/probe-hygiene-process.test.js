'use strict';
// Split out of test/probe-hygiene.test.js (release-gate lane, 2026-10-09): the tests below run real processes, so they stay out of Stryker's command.
/**
 * Process hygiene for verify/ probes that suspend a real process or spawn a
 * real `claude` session (probe-pause.js, probe-local-model.js).
 *
 * Written against Miguel's PR #61 review (H1/H2/H3): a probe's own `finally`
 * block is not enough, because Node's default SIGINT handling terminates
 * immediately and skips every pending `finally` -- exactly the moment an
 * operator watching a ~20s suspend window is most likely to press Ctrl+C.
 * These pin the three things the review asked to be pinned:
 *   1. the emergency-cleanup registry resumes every recorded suspended pid
 *      and kills every recorded spawned tree (createHygieneRegistry).
 *   2. a spawn timeout kills the whole process tree, not just the top pid
 *      (spawnWithTimeout, the fix for H3).
 *   3. a bind failure on the fake Anthropic-compatible server yields a
 *      rejected promise (a SKIP line), not an uncaught 'error' throw (L1).
 *
 * None of these spawn a real `claude` session or the real Windows
 * NtSuspendProcess/pssuspend primitives -- those are exercised by actually
 * running the probes (see their own RESULTS blocks). This file is scoped to
 * the pure, injectable cleanup/kill logic around them.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createHygieneRegistry } = require('../verify/lib/process-hygiene');
const { spawnWithTimeout } = require('../verify/lib/spawn-with-timeout');
const { startFakeServer } = require('../verify/probe-local-model');
const { killTree } = require('../host/kill-tree');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- H3: the spawn-timeout path tree-kills, it does not bare-kill ------------

test('spawnWithTimeout, with NO killFn passed, actually kills the hung child via the real default (host/kill-tree.js killPidTree)', async () => {
  // No injected killFn here -- this is the exact call shape
  // probe-local-model.js's runClaudeAttempt uses. Pins that the DEFAULT is
  // the real tree-kill helper end to end: the child must actually be dead
  // afterward, not just that some callback fired.
  const r = await spawnWithTimeout({
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 300,
  });
  assert.strictEqual(r.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 300)); // taskkill/SIGTERM needs a moment to land
  assert.throws(() => process.kill(r.pid, 0), /ESRCH|No such process/,
    'the hung child should be dead after the default kill path ran');
});

test('spawnWithTimeout does not force-kill a recycled pid when the direct child exits fast but a detached grandchild keeps stdio open (Dexter finding 1 + 2)', async () => {
  // Dexter's exact counterexample: a direct child that exits almost
  // immediately after spawning a DETACHED grandchild that inherits its
  // stdio pipes. The old code only settled/cleared its timer on stdio
  // 'close', which that grandchild holds open forever -- so at timeoutMs it
  // force-killed `child.pid`, a pid the OS may have already recycled for an
  // unrelated process (finding 1), and the promise would never have settled
  // at all if the child hadn't happened to also outlive long enough for
  // 'close' (finding 2 -- reverting the fix makes THIS test hang for the
  // full timeoutMs and then fail with timedOut:true and a non-empty
  // killedPids, instead of settling almost immediately with neither).
  const killedPids = [];
  const gcMarker = path.join(os.tmpdir(), `hygiene-gc-marker-${crypto.randomBytes(4).toString('hex')}.txt`);
  let gcPid = null;
  try {
    const r = await spawnWithTimeout({
      cmd: process.execPath,
      args: ['-e', `
        const { spawn } = require('child_process');
        const fs = require('fs');
        // kill-test-ok: reaped by the pid it reports (the finally below), and it expires by itself after two minutes
        const gc = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(), 120000); setInterval(()=>{},1000)'], { stdio: 'inherit', detached: true });
        fs.writeFileSync(process.argv[1], String(gc.pid));
        gc.unref();
      `, gcMarker],
      timeoutMs: 3000,
      killFn: (pid) => killedPids.push(pid),
    });
    assert.strictEqual(r.timedOut, false, 'the direct child exits on its own well before the 3s timeout');
    assert.deepStrictEqual(killedPids, [],
      'nothing should be killed -- the child already exited, so its pid must not be treated as still-owned');
    try { gcPid = parseInt(fs.readFileSync(gcMarker, 'utf8').trim(), 10); } catch { /* not written in time */ }
    assert.ok(gcPid, 'the grandchild should have reported its pid before its parent exited');
  } finally {
    // The grandchild is a REAL orphaned process on this machine now --
    // exactly the scenario the finding describes. Clean it up by its own
    // pid, which is independent of whatever this test is proving unsafe.
    if (gcPid) { try { process.kill(gcPid, 'SIGTERM'); } catch { /* already gone */ } }
    try { fs.unlinkSync(gcMarker); } catch { /* never written */ }
  }
});

test('spawnWithTimeout, with the REAL default killFn, kills the entire process tree -- not just the top pid -- when both the child and a grandchild are hung', {
  skip: process.platform !== 'win32' && 'taskkill /T tree-kill is Windows-only (host/kill-tree.js killPidTree, finding 5); off-Windows this function is documented as single-process',
}, async () => {
  // Dexter finding 6: the old test 8 used a childless process, so it passed
  // even if killPidTree's body were replaced with a bare single-process
  // process.kill(pid) -- the "tree" in "guarantee the WHOLE tree dies" was
  // never actually observed. This spawns a REAL grandchild and asserts IT is
  // also dead, which a single-process kill cannot achieve (taskkill /T on a
  // still-LIVE parent walks to its live children; that is the property being
  // pinned here, distinct from the fast-exit case above).
  const gcMarker = path.join(os.tmpdir(), `hygiene-tree-marker-${crypto.randomBytes(4).toString('hex')}.txt`);
  let parentPid = null;
  let gcPid = null;
  try {
    const resultPromise = spawnWithTimeout({
      cmd: process.execPath,
      args: ['-e', `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        fs.writeFileSync(process.argv[1], String(gc.pid));
        setInterval(() => {}, 1000); // the parent itself also hangs
      `, gcMarker],
      timeoutMs: 1500,
      // No killFn override: this must exercise the real default (killPidTree).
    });

    for (let i = 0; i < 20 && !gcPid; i++) {
      await sleep(50);
      try { gcPid = parseInt(fs.readFileSync(gcMarker, 'utf8').trim(), 10); } catch { /* not written yet */ }
    }
    assert.ok(gcPid, 'the grandchild should have reported its pid while the parent was still alive');

    const result = await resultPromise;
    parentPid = result.pid;
    assert.strictEqual(result.timedOut, true);

    await sleep(400); // taskkill's cascade needs a moment to actually land
    assert.throws(() => process.kill(parentPid, 0), /ESRCH|No such process/, 'the parent should be dead');
    assert.throws(() => process.kill(gcPid, 0), /ESRCH|No such process/,
      'the GRANDCHILD should also be dead -- this is the actual tree-kill property, not just "the top pid died"');
  } finally {
    if (parentPid) { try { process.kill(parentPid, 'SIGTERM'); } catch { /* already gone */ } }
    if (gcPid) { try { process.kill(gcPid, 'SIGTERM'); } catch { /* already gone */ } }
    try { fs.unlinkSync(gcMarker); } catch { /* never written */ }
  }
});

// --- Finding 6: killTree itself was never directly unit-tested --------------

// --- L1: a fake-server bind failure is a SKIP, not a crash -------------------

// requiring verify/probe-pause.js (above, for the resumeFn wiring test)
// writes its NT_HELPER_PS1 temp file as a module-load side effect, which
// that module only cleans up under its own require.main === module guard --
// never reached when this test file requires it as a library. Small and
// harmless either way, but this is the file this whole PR is about not
// leaving stray artifacts behind.
test.after(() => {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('claude-custom-probe-pause-nt-')) fs.unlinkSync(path.join(os.tmpdir(), f));
    }
  } catch { /* best effort */ }
});
