'use strict';
/**
 * One live `claude` per worktree (Extension X1, PLAN_WORKTREE_TABS.md).
 *
 * `<git-dir>/claude-session.lock` = {pid, processStartedAt, startedAt, port,
 * claudePid}, where pid is the HOST (it owns the pty and dies with it). A
 * holder is stale when its pid is dead, or alive with another start time (a
 * reused pid). Its holders live for days, so there is no age rule: a wrong
 * break is a second `claude` in the same worktree.
 *
 * OS facts are injected (a fake process table), so the judge's rules are
 * testable anywhere; the last test races real processes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { lockPathFor, judgeHolder, acquire, release, updateOwn, GRACE_MS, LOCK_NAME } =
  require('../host/session-lock');
const { readLock } = require('../host/lock-breaker');
const { tmpDir } = require('./tmp-dir');

// --- where the lock lives ------------------------------------------------------

function makeContainer() {
  const base = tmpDir('session-lock-layout-');
  const devGit = path.join(base, 'dev', '.git');
  fs.mkdirSync(devGit, { recursive: true });
  fs.writeFileSync(path.join(devGit, 'HEAD'), 'ref: refs/heads/develop\n');
  const wtGit = path.join(devGit, 'worktrees', 'feat-x');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/x\n');
  const wt = path.join(base, 'feat-x');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  return { base, devGit, wtGit, wt };
}

test('dev keeps its lock in dev\\.git, a sibling worktree in its own git-dir', () => {
  const { base, devGit, wtGit, wt } = makeContainer();
  assert.strictEqual(lockPathFor(path.join(base, 'dev')), path.join(devGit, LOCK_NAME));
  assert.strictEqual(lockPathFor(wt), path.join(wtGit, LOCK_NAME));
  assert.strictEqual(LOCK_NAME, 'claude-session.lock');
});

test('a subfolder of a worktree shares the worktree\'s lock', () => {
  const { wtGit, wt } = makeContainer();
  assert.strictEqual(lockPathFor(path.join(wt, 'sub')), path.join(wtGit, LOCK_NAME));
});

test('a folder that is not in a repo has no lock', () => {
  assert.strictEqual(lockPathFor(tmpDir('session-lock-plain-')), null);
  assert.strictEqual(lockPathFor(''), null);
  assert.strictEqual(lockPathFor(null), null);
});

// --- a fake process table -------------------------------------------------------

function table(entries = {}) {
  const procs = new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
  const calls = { isAlive: [], startTimes: [] };
  return {
    procs,
    calls,
    deps: {
      isAlive: pid => {
        calls.isAlive.push(pid);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        return procs.has(pid);
      },
      startTimes: async pids => {
        calls.startTimes.push(pids);
        const m = new Map();
        for (const pid of pids) if (procs.has(pid)) m.set(pid, procs.get(pid));
        return m;
      },
    },
  };
}

const seenOf = (parsed, { raw, mtimeMs = Date.now() } = {}) => ({
  raw: raw === undefined ? JSON.stringify(parsed) : raw,
  st: mtimeMs === null ? null : { mtimeMs, ino: 1, size: 1 },
  parsed,
});

const holder = (pid, processStartedAt, extra = {}) =>
  ({ pid, processStartedAt, startedAt: 1790000000000, port: 7710, claudePid: 555, ...extra });

// --- the judge ------------------------------------------------------------------

test('a dead holder is stale, and the OS start time is not even asked', async () => {
  const t = table({});
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'stale');
  assert.strictEqual(t.calls.startTimes.length, 0);
});

test('a live holder with the start time it wrote is live', async () => {
  const t = table({ 101: '5' });
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'live');
});

test('a live pid with ANOTHER start time is a reused pid: stale', async () => {
  const t = table({ 101: '6' });
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'stale');
});

test('when the start time cannot be asked at all, the holder is live (fail closed)', async () => {
  const t = table({ 101: '6' });
  t.deps.startTimes = async () => null;
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'live');
});

test('a live pid whose start time the OS will not tell us is live', async () => {
  const t = table({ 101: null });
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'live');
});

test('a holder that wrote no start time is judged on its pid alone', async () => {
  for (const processStartedAt of [null, undefined, 5, '']) {
    const t = table({ 101: '6' });
    const verdict = await judgeHolder(seenOf(holder(101, processStartedAt)), t.deps);
    if (processStartedAt === '') {
      // An empty string IS a string and differs from the OS value: reused.
      assert.strictEqual(verdict, 'stale');
    } else {
      assert.strictEqual(verdict, 'live', String(processStartedAt));
      assert.strictEqual(t.calls.startTimes.length, 0);
    }
  }
});

test('a pid that died between the liveness check and the start-time query is stale', async () => {
  const t = table({ 101: '5' });
  t.deps.startTimes = async () => new Map();
  assert.strictEqual(await judgeHolder(seenOf(holder(101, '5')), t.deps), 'stale');
});

test('content that is not a usable lock is aged by its mtime', async () => {
  const t = table({});
  const young = seenOf(null, { raw: 'garbage', mtimeMs: Date.now() - 100 });
  const old = seenOf(null, { raw: 'garbage', mtimeMs: Date.now() - GRACE_MS - 1000 });
  const ageless = seenOf(null, { raw: '', mtimeMs: null });
  assert.strictEqual(await judgeHolder(young, t.deps), 'unknown');
  assert.strictEqual(await judgeHolder(old, t.deps), 'stale');
  assert.strictEqual(await judgeHolder(ageless, t.deps), 'unknown');
});

test('a pid that is not a positive integer is never probed; the lock is aged like garbage', async () => {
  for (const pid of [0, -1, 1.5, '101', null, undefined]) {
    const t = table({ 101: '5' });
    const verdict = await judgeHolder(seenOf(holder(pid, '5'), { mtimeMs: Date.now() }), t.deps);
    assert.strictEqual(verdict, 'unknown', `pid ${String(pid)}`);
    assert.deepStrictEqual(t.calls.isAlive, [], `pid ${String(pid)} was probed`);
  }
});

test('GRACE_MS is a few seconds: longer than a write, far shorter than a session', () => {
  assert.ok(GRACE_MS >= 2000 && GRACE_MS <= 30000, String(GRACE_MS));
});

// --- acquire / release / updateOwn ----------------------------------------------

const lockFile = () => path.join(tmpDir('session-lock-'), LOCK_NAME);
const me = (extra = {}) => ({ pid: 201, processStartedAt: '9', startedAt: 1790000001000, port: 7711, claudePid: null, ...extra });
const fast = t => ({ ...t.deps, unknownWaitMs: 150, retryMs: 10 });

test('a free worktree is taken, and the lock names this host', async () => {
  const lock = lockFile();
  const t = table({ 201: '9' });
  assert.deepStrictEqual(await acquire(lock, me(), fast(t)), { state: 'held' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), me());
});

test('no repo, no lock: the session runs unlocked', async () => {
  const t = table({});
  assert.deepStrictEqual(await acquire(null, me(), fast(t)), { state: 'unlocked', reason: 'not-a-repo' });
});

test('a live holder blocks, and says who it is, since when and where', async () => {
  const lock = lockFile();
  const theirs = JSON.stringify(holder(101, '5'));
  fs.writeFileSync(lock, theirs);
  const t = table({ 101: '5', 201: '9' });
  const r = await acquire(lock, me(), fast(t));
  assert.deepStrictEqual(r, { state: 'blocked', holder: { pid: 101, startedAt: 1790000000000, port: 7710, claudePid: 555 } });
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), theirs, 'the live lock was touched');
});

test('a dead holder\'s lock is taken over silently', async () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(holder(101, '5')));
  const t = table({ 201: '9' });
  assert.deepStrictEqual(await acquire(lock, me(), fast(t)), { state: 'held' });
  assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, 201);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lock)), [LOCK_NAME], 'no .break or tomb left');
});

test('a reused pid\'s lock is taken over too', async () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(holder(101, '5')));
  const t = table({ 101: '77', 201: '9' });
  assert.deepStrictEqual(await acquire(lock, me(), fast(t)), { state: 'held' });
});

test('a lock being written right now is waited on, then reported blocked by an unknown holder', async () => {
  const lock = lockFile();
  fs.writeFileSync(lock, '');
  const t = table({ 201: '9' });
  const started = Date.now();
  const r = await acquire(lock, me(), fast(t));
  assert.deepStrictEqual(r, { state: 'blocked', holder: { pid: null, startedAt: null, port: null, claudePid: null } });
  assert.ok(Date.now() - started >= 140, 'it waited for the writer');
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), '');
});

test('a lock whose writer finishes during the wait is judged on what it wrote', async () => {
  const lock = lockFile();
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.writeFileSync(lock, JSON.stringify(holder(101, '5'))), 40);
  const t = table({ 201: '9' });                // 101 is dead by the time it is read
  assert.deepStrictEqual(await acquire(lock, me(), fast(t)), { state: 'held' });
});

test('holder fields of the wrong type come back as null, never coerced', async () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify({ pid: 101, processStartedAt: '5', startedAt: '1790', port: null, claudePid: '555' }));
  const t = table({ 101: '5' });
  const r = await acquire(lock, me(), fast(t));
  assert.deepStrictEqual(r.holder, { pid: 101, startedAt: null, port: null, claudePid: null });
});

test('a lock replaced while its holder was being judged is not broken', async () => {
  // The judge is async (it asks the OS). A verdict of "stale" is about the file
  // it read; if a live host replaced that file meanwhile, the break must not
  // remove the replacement.
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(holder(101, '5')));
  const fresh = JSON.stringify(holder(102, '8'));
  const t = table({ 101: '6', 102: '8', 201: '9' });   // 101 reused -> stale
  const realStartTimes = t.deps.startTimes;
  let replaced = false;
  t.deps.startTimes = async pids => {
    if (!replaced) { replaced = true; fs.unlinkSync(lock); fs.writeFileSync(lock, fresh); }
    return realStartTimes(pids);
  };
  const r = await acquire(lock, me(), fast(t));
  assert.strictEqual(r.state, 'blocked');
  assert.strictEqual(r.holder.pid, 102);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), fresh);
});

test('a lock that cannot be created for another reason runs the session unlocked, with the code', async () => {
  const lock = path.join(tmpDir('session-lock-'), 'missing-dir', LOCK_NAME);
  const t = table({ 201: '9' });
  const r = await acquire(lock, me(), fast(t));
  assert.strictEqual(r.state, 'unlocked');
  assert.strictEqual(r.reason, 'error');
  assert.strictEqual(r.code, 'ENOENT');
});

test('release removes our lock and nothing else', () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(me()));
  assert.strictEqual(release(lock, me()), true);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lock)), []);
});

test('release leaves a lock that is not ours', () => {
  const lock = lockFile();
  for (const other of [holder(101, '5'), me({ processStartedAt: '10' }), me({ startedAt: 1 })]) {
    fs.writeFileSync(lock, JSON.stringify(other));
    assert.strictEqual(release(lock, me()), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), other);
  }
});

test('release of a lock that is already gone is quiet', () => {
  assert.strictEqual(release(lockFile(), me()), false);
  assert.strictEqual(release(null, me()), false);
});

test('updateOwn adds the claude pid to our lock, atomically, without litter', () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(me()));
  assert.strictEqual(updateOwn(lock, me(), { claudePid: 4321 }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), me({ claudePid: 4321 }));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(lock)), [LOCK_NAME]);
});

test('updateOwn refuses a lock that is not ours', () => {
  const lock = lockFile();
  const theirs = JSON.stringify(holder(101, '5'));
  fs.writeFileSync(lock, theirs);
  assert.strictEqual(updateOwn(lock, me(), { claudePid: 4321 }), false);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), theirs);
});

test('updateOwn can never change who holds the lock', () => {
  const lock = lockFile();
  fs.writeFileSync(lock, JSON.stringify(me()));
  updateOwn(lock, me(), { pid: 999, processStartedAt: 'x', startedAt: 0, claudePid: 4 });
  const onDisk = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.deepStrictEqual([onDisk.pid, onDisk.processStartedAt, onDisk.startedAt, onDisk.claudePid],
    [201, '9', 1790000001000, 4]);
});

// --- PROPERTY: never two live holders -------------------------------------------
//
// Simulated hosts over one lock file and a fake process table. Commands: open
// (a new host process, possibly on a reused pid), two opens at once (their
// judges interleave at the OS query), clean close, crash. After every command,
// at most one LIVE host believes it holds the lock, and if one does, the file
// names it.

const PIDS = [101, 102, 103];

test('PROPERTY: no sequence of open / close / crash / takeover leaves two live holders', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.oneof(
      fc.record({ op: fc.constant('open'), pid: fc.constantFrom(...PIDS) }),
      fc.record({ op: fc.constant('pair'), a: fc.constantFrom(...PIDS), b: fc.constantFrom(...PIDS) }),
      fc.record({ op: fc.constant('close'), pid: fc.constantFrom(...PIDS) }),
      fc.record({ op: fc.constant('crash'), pid: fc.constantFrom(...PIDS) }),
    ), { minLength: 1, maxLength: 14 }),
    async cmds => {
      const lock = lockFile();
      const procs = new Map();               // pid -> start time of the live process
      const hosts = new Map();               // pid -> { owner, holds }
      let clock = 0;
      const deps = {
        isAlive: pid => (Number.isInteger(pid) && pid > 0 ? procs.has(pid) : null),
        startTimes: async pids => {
          await new Promise(r => setImmediate(r));   // let a concurrent judge run
          return new Map(pids.filter(p => procs.has(p)).map(p => [p, procs.get(p)]));
        },
        unknownWaitMs: 20,
        retryMs: 1,
      };
      const spawnHost = pid => {
        if (procs.has(pid)) return null;          // that pid is taken by a live process
        const start = String(++clock);
        procs.set(pid, start);
        const owner = { pid, processStartedAt: start, startedAt: clock, port: 7700 + pid, claudePid: null };
        const h = { owner, holds: false };
        hosts.set(pid, h);
        return h;
      };
      const open = async h => { if (h) h.holds = (await acquire(lock, h.owner, deps)).state === 'held'; };

      for (const c of cmds) {
        if (c.op === 'open') await open(spawnHost(c.pid));
        else if (c.op === 'pair') {
          const a = spawnHost(c.a);
          const b = c.b === c.a ? null : spawnHost(c.b);
          await Promise.all([open(a), open(b)]);
        } else if (c.op === 'close' || c.op === 'crash') {
          const h = hosts.get(c.pid);
          if (!h || !procs.has(c.pid)) continue;
          if (c.op === 'close' && h.holds) release(lock, h.owner);
          procs.delete(c.pid);
          hosts.delete(c.pid);
        }

        const liveHolders = [...hosts.values()].filter(h => h.holds && procs.get(h.owner.pid) === h.owner.processStartedAt);
        assert.ok(liveHolders.length <= 1, `two live holders after ${JSON.stringify(c)}`);
        if (liveHolders.length === 1) {
          const seen = readLock(lock);
          assert.ok(seen.parsed && seen.parsed.pid === liveHolders[0].owner.pid &&
            seen.parsed.processStartedAt === liveHolders[0].owner.processStartedAt,
            `the live holder's lock is not on disk after ${JSON.stringify(c)}`);
        }
      }
    }), { numRuns: 150 });
});
