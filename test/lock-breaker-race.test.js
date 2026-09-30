'use strict';
/**
 * host/lock-breaker.js against REAL processes: N of them wake at once and
 * break one dead lock. Split from lock-breaker.test.js because it takes
 * seconds, and stryker.conf.json re-runs its whole command for every mutant --
 * the mutants this catches (unlink by path, no .break) also die in the unit
 * tests there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const lockIn = dir => path.join(dir, 'thing.lock');

function deadPid() {
  for (const pid of [999999, 999998, 999997]) {
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return pid; }
  }
  throw new Error('could not find a dead pid to test with');
}

// --- many processes, one dead lock -------------------------------------------
//
// The three-waiter window, for real. N processes wake at the same instant, each
// breaks the dead lock (if it still judges it stale) and then tries to take it.
// Exactly one may end up holding it, and its lock must still be on disk at the
// end: a late breaker that deletes the winner's fresh lock is PR #57 Finding 1
// (High) all over again.

const CHILD = `
const fs = require('fs');
const { breakIfStale } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'lock-breaker'))});
const [lock, goAt, hold] = [process.argv[1], Number(process.argv[2]), process.argv[3]];
while (Date.now() < goAt) {}
const dead = raw => { try { const p = JSON.parse(raw).pid; process.kill(p, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
breakIfStale(lock, s => (s.parsed && dead(s.raw) ? 'stale' : 'live'), { breakWaitMs: 2000 });
let won = false;
try { const fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd); won = true; } catch {}
process.stdout.write(won ? 'WON' : 'lost');
// Stay alive until every child has reported, so the winner's pid is live while
// the others judge -- a winner that had exited would be fair game to break.
const t = setInterval(() => { if (!fs.existsSync(hold)) clearInterval(t); }, 20);
`;

// Resolves on the child's verdict (not its exit): the children stay alive
// until the parent removes `hold`.
function runChild(lock, goAt, hold) {
  let exited;
  const done = new Promise(r => { exited = r; });
  const verdict = new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, ['-e', CHILD, lock, String(goAt), hold], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; if (/WON|lost/.test(out)) resolve({ pid: child.pid, out }); });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('exit', () => { resolve({ pid: child.pid, out }); exited(); });
  });
  return { verdict, done };
}

test('N processes breaking one dead lock: exactly one takes it, and its lock survives', async () => {
  for (let round = 0; round < 4; round++) {
    const dir = tmpDir('cc-breaker-race-');
    const lock = lockIn(dir);
    const hold = path.join(tmpDir('cc-breaker-hold-'), 'hold');
    fs.writeFileSync(hold, '');
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
    const goAt = Date.now() + 700;
    const children = Array.from({ length: 6 }, () => runChild(lock, goAt, hold));
    const results = await Promise.all(children.map(c => c.verdict));
    fs.unlinkSync(hold);
    await Promise.all(children.map(c => c.done));
    const winners = results.filter(r => r.out === 'WON');
    assert.strictEqual(winners.length, 1, `round ${round}: ${JSON.stringify(results.map(r => r.out))}`);
    const onDisk = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.strictEqual(onDisk.pid, winners[0].pid, `round ${round}: the winner's lock was deleted or replaced`);
    assert.deepStrictEqual(fs.readdirSync(dir), ['thing.lock'], `round ${round}: litter left behind`);
  }
});
