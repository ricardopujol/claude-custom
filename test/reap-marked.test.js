'use strict';
/**
 * BACKLOG #74 G: the #72 test's spawner left 9,287 detached `node -e setInterval` sleepers behind a killed `npm test`.
 * Every test that spawns detached children tags them with a per-run marker in argv (`<prefix>-<owner pid>-<time>`) and
 * reaps them in `finally`, on process exit, and (the leftovers of a run that was itself killed) at the next run's start.
 * A process is ended only after its start time is proven against the process table's creation time, on a held handle.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { reapMarked, reapDeadOwners, markedPids, SLEEPER_SRC } = require('./helpers/reap-marked');

const onWin = process.platform === 'win32';
const opts = { skip: !onWin, timeout: 120000 };

function sleeper(marker) {
  const c = spawn(process.execPath, ['-e', SLEEPER_SRC, marker], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(f, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 100)); } return f(); }

test('reapMarked ends the processes carrying the marker, and only those', opts, async () => {
  const mine = `ccreap-${process.pid}-${Date.now()}a`;
  const other = `ccreap-${process.pid}-${Date.now()}b`;
  const a = sleeper(mine); const b = sleeper(mine); const o = sleeper(other);
  try {
    assert.ok(await until(() => markedPids(mine).length === 2 && markedPids(other).length === 1), 'the scan does not see the sleepers it just started');
    assert.strictEqual(reapMarked(mine), 2);
    assert.ok(await until(() => !alive(a.pid) && !alive(b.pid)), 'a marked sleeper survived');
    assert.ok(alive(o.pid), 'a sleeper with another marker was ended');
  } finally { reapMarked(mine); reapMarked(other); }
});

test('reapDeadOwners ends a killed run\'s leftovers, and leaves a live owner\'s alone', opts, async () => {
  const prefix = `ccdead${Date.now()}`;
  const gone = spawnSync(process.execPath, ['-e', '0']);           // a pid that has exited
  const deadMarker = `${prefix}-${gone.pid}-1`;
  const liveMarker = `${prefix}-${process.pid}-1`;
  const d = sleeper(deadMarker); const l = sleeper(liveMarker);
  try {
    assert.ok(await until(() => markedPids(deadMarker).length === 1 && markedPids(liveMarker).length === 1));
    assert.strictEqual(reapDeadOwners(prefix), 1);
    assert.ok(await until(() => !alive(d.pid)), 'a dead owner\'s sleeper survived');
    assert.ok(alive(l.pid), 'a live owner\'s sleeper was ended');
  } finally { reapMarked(deadMarker); reapMarked(liveMarker); }
});

test('a marker that could match more than itself is refused (no wildcard widening of the kill)', () => {
  for (const bad of ['', 'a b', "x'y", 'a%b', '*', 'a;b']) assert.throws(() => reapMarked(bad), /marker/, JSON.stringify(bad));
});

test('the sleeper expires by itself, so even a reaper that never runs cannot leave one for good', () => {
  assert.match(SLEEPER_SRC, /setTimeout\(\(\) => process\.exit\(\), \d+\)/);
});

// The rule: a test file that spawns detached children must use the reaper.
test('rule: every test that spawns detached children reaps them through test/helpers/reap-marked (or pids it holds)', () => {
  const dir = __dirname;
  const bad = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const spawnsDetached = [...src.matchAll(/\bdetached:\s*true/g)].some(m => src.slice(Math.max(0, m.index - 300), m.index).includes('spawn('));
    if (spawnsDetached && !/reap-marked/.test(src) && !/kill-test-ok:/.test(src)) bad.push(f);
  }
  assert.deepStrictEqual(bad, []);
});
