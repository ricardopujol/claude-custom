'use strict';
/**
 * host/session-lock.js against REAL processes: three hosts race for a dead
 * host's worktree, with real OS start times (one powershell.exe each). Split
 * from session-lock.test.js because it takes seconds, and stryker.conf.json
 * re-runs its whole command for every mutant -- the identity-binding mutant
 * this catches also dies in the unit tests there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const LOCK_NAME = 'claude-session.lock';
const lockFile = () => path.join(tmpDir('session-lock-'), LOCK_NAME);
const holder = (pid, processStartedAt, extra = {}) =>
  ({ pid, processStartedAt, startedAt: 1790000000000, port: 7710, claudePid: 555, ...extra });

// --- real processes ---------------------------------------------------------------

const CHILD = `
const { acquire } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'session-lock'))});
const { createSelfStartTime } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'proc-start'))});
const fs = require('fs');
const [lock, goAt, hold] = [process.argv[1], Number(process.argv[2]), process.argv[3]];
(async () => {
  const owner = { pid: process.pid, processStartedAt: await createSelfStartTime()(), startedAt: Date.now(), port: 1, claudePid: null };
  while (Date.now() < goAt) {}
  const r = await acquire(lock, owner);
  process.stdout.write(r.state === 'held' ? 'WON' : 'lost:' + r.state);
  const t = setInterval(() => { if (!fs.existsSync(hold)) clearInterval(t); }, 20);
})();
`;

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

test('real processes racing for a dead host\'s worktree: exactly one gets it', { skip: process.platform !== 'win32' }, async () => {
  for (let round = 0; round < 3; round++) {
    const lock = lockFile();
    fs.writeFileSync(lock, JSON.stringify(holder(999999, '1')));
    const hold = path.join(tmpDir('session-lock-hold-'), 'hold');
    fs.writeFileSync(hold, '');
    const goAt = Date.now() + 2500;               // after every child has its start time
    const children = Array.from({ length: 3 }, () => runChild(lock, goAt, hold));
    const results = await Promise.all(children.map(c => c.verdict));
    fs.unlinkSync(hold);
    await Promise.all(children.map(c => c.done));
    const winners = results.filter(r => r.out === 'WON');
    assert.strictEqual(winners.length, 1, `round ${round}: ${JSON.stringify(results.map(r => r.out))}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, winners[0].pid, `round ${round}`);
  }
});
