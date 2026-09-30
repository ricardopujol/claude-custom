'use strict';
/**
 * Breaking a stale lock, one breaker at a time (backlog #22).
 *
 * PR #57 shipped host/file-lock.js with three accepted residuals from Dexter's
 * re-review, all in the stale-lock BREAK: the three-waiter window, Finding A
 * (an empty lock whose stat failed was broken at once) and Finding B (a holder
 * releasing while its lock sat in a waiter's tomb left an orphan lock with a
 * live pid). Every one of them needs two breakers in the break at once. This
 * serialises them behind `<lock>.break`, and under it re-reads and re-judges
 * the lock before removing exactly the file it judged.
 *
 * The session lock (Extension X1) uses the same breaker, which is why it is its
 * own module: its holders live for days, so a wrong break there is a second
 * `claude` in the same worktree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { breakIfStale, readLock, BREAK_STALE_MS } = require('../host/lock-breaker');
const { tmpDir } = require('./tmp-dir');

const lockIn = dir => path.join(dir, 'thing.lock');

function deadPid() {
  for (const pid of [999999, 999998, 999997]) {
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return pid; }
  }
  throw new Error('could not find a dead pid to test with');
}

const stale = () => 'stale';
const live = () => 'live';

test('a lock the judge calls stale is removed, and nothing is left behind', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  const { outcome } = breakIfStale(lock, stale);
  assert.strictEqual(outcome, 'freed');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'no lock, no .break, no tomb');
});

test('a lock the judge calls live is left alone', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  const raw = JSON.stringify({ pid: process.pid });
  fs.writeFileSync(lock, raw);
  assert.strictEqual(breakIfStale(lock, live).outcome, 'held');
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), raw);
  assert.deepStrictEqual(fs.readdirSync(dir), ['thing.lock'], 'the .break was released');
});

test('"unknown" is not "stale": the lock stays', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  fs.writeFileSync(lock, '');
  assert.strictEqual(breakIfStale(lock, () => 'unknown').outcome, 'held');
  assert.ok(fs.existsSync(lock));
});

test('anything but the exact string "stale" keeps the lock', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  fs.writeFileSync(lock, '{}');
  for (const verdict of [true, 'STALE', undefined, null, 1]) {
    assert.strictEqual(breakIfStale(lock, () => verdict).outcome, 'held', String(verdict));
  }
  assert.ok(fs.existsSync(lock));
});

test('a lock that is already gone is free, and the judge is not asked', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  let asked = 0;
  assert.strictEqual(breakIfStale(lock, () => { asked++; return 'stale'; }).outcome, 'freed');
  assert.strictEqual(asked, 0);
});

test('a lock that cannot be read is not judged, so it is not broken', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  fs.mkdirSync(lock);                                   // EISDIR on read
  let asked = 0;
  assert.strictEqual(breakIfStale(lock, () => { asked++; return 'stale'; }).outcome, 'held');
  assert.strictEqual(asked, 0);
  assert.ok(fs.statSync(lock).isDirectory());
});

test('the judge sees the bytes, the stat and the parsed content', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  const raw = JSON.stringify({ pid: 12, extra: 'x' });
  fs.writeFileSync(lock, raw);
  let seen = null;
  breakIfStale(lock, s => { seen = s; return 'live'; });
  assert.strictEqual(seen.raw, raw);
  assert.deepStrictEqual(seen.parsed, { pid: 12, extra: 'x' });
  assert.ok(seen.st && Number.isFinite(seen.st.mtimeMs));
});

test('unparseable content reaches the judge as parsed: null', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  fs.writeFileSync(lock, '{"pid":1');
  let seen = null;
  breakIfStale(lock, s => { seen = s; return 'live'; });
  assert.strictEqual(seen.parsed, null);
  assert.strictEqual(seen.raw, '{"pid":1');
});

test('the outcome carries what was judged, so a caller can name the holder', () => {
  const lock = lockIn(tmpDir('cc-breaker-'));
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242 }));
  const { seen } = breakIfStale(lock, live);
  assert.strictEqual(seen.parsed.pid, 4242);
});

test('a lock replaced between being judged and being removed survives', () => {
  // The judge runs on L0; before the removal, L0's holder is replaced by a
  // fresh L1 (simulated inside the judge). Only L0 may go.
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  const fresh = JSON.stringify({ pid: process.pid, fresh: true });
  const { outcome } = breakIfStale(lock, () => {
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, fresh);
    return 'stale';
  });
  assert.strictEqual(outcome, 'held');
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), fresh);
  assert.deepStrictEqual(fs.readdirSync(dir), ['thing.lock'], 'no tomb, no .break');
});

test('Finding B: a holder that releases during the break leaves no orphan behind', () => {
  // PR #57's orphan: a waiter moved a LIVE lock aside, its holder released
  // (unlinking an empty path), and the waiter put it back -- a lock nobody
  // held, with a live pid, stalling every writer for STALE_MS. Here the holder
  // releases after the judgement and before the removal.
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
  const { outcome } = breakIfStale(lock, () => { fs.unlinkSync(lock); return 'stale'; });
  assert.strictEqual(outcome, 'freed');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a live breaker holding .break makes the caller wait, then report busy', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  const breakRaw = JSON.stringify({ pid: process.ppid, at: Date.now() });
  fs.writeFileSync(`${lock}.break`, breakRaw);
  let asked = 0;
  const { outcome } = breakIfStale(lock, () => { asked++; return 'stale'; }, { breakWaitMs: 60 });
  assert.strictEqual(outcome, 'busy');
  assert.strictEqual(asked, 0, 'nothing is judged without .break');
  assert.ok(fs.existsSync(lock), 'the lock was not touched');
  assert.strictEqual(fs.readFileSync(`${lock}.break`, 'utf8'), breakRaw, 'the other breaker keeps .break');
});

test('a .break left by a dead breaker is cleared and the break goes ahead', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: deadPid(), at: Date.now() }));
  assert.strictEqual(breakIfStale(lock, stale, { breakWaitMs: 60 }).outcome, 'freed');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a .break older than BREAK_STALE_MS is cleared even with a live pid', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: process.ppid, at: Date.now() - BREAK_STALE_MS - 1000 }));
  assert.strictEqual(breakIfStale(lock, stale, { breakWaitMs: 60 }).outcome, 'freed');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a young, unreadable-content .break is waited on; an old one is cleared by its mtime', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
  const brk = `${lock}.break`;
  fs.writeFileSync(brk, '');
  assert.strictEqual(breakIfStale(lock, stale, { breakWaitMs: 40 }).outcome, 'busy');
  const old = new Date(Date.now() - BREAK_STALE_MS - 5000);
  fs.utimesSync(brk, old, old);
  assert.strictEqual(breakIfStale(lock, stale, { breakWaitMs: 40 }).outcome, 'freed');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('the .break is released even when the judge throws', () => {
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, '{}');
  assert.throws(() => breakIfStale(lock, () => { throw new Error('judge blew up'); }), /judge blew up/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['thing.lock']);
});

test('a .break that is no longer ours is not deleted on release', () => {
  // Ours was taken over (we stalled past BREAK_STALE_MS, say) and another
  // breaker now holds a fresh one. Releasing by path would free it under them.
  const dir = tmpDir('cc-breaker-');
  const lock = lockIn(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const theirs = JSON.stringify({ pid: process.ppid, at: Date.now(), theirs: true });
  breakIfStale(lock, () => {
    fs.unlinkSync(`${lock}.break`);
    fs.writeFileSync(`${lock}.break`, theirs);
    return 'live';
  });
  assert.strictEqual(fs.readFileSync(`${lock}.break`, 'utf8'), theirs);
});

test('readLock tells gone, unreadable and present apart', () => {
  const dir = tmpDir('cc-breaker-');
  assert.deepStrictEqual(readLock(path.join(dir, 'nope')), { gone: true });
  fs.mkdirSync(path.join(dir, 'isdir'));
  assert.deepStrictEqual(readLock(path.join(dir, 'isdir')), { unreadable: true });
  fs.writeFileSync(path.join(dir, 'ok'), '[1]');
  const ok = readLock(path.join(dir, 'ok'));
  assert.strictEqual(ok.raw, '[1]');
  assert.strictEqual(ok.parsed, null, 'an array is not a lock object');
});

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
