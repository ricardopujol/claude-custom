'use strict';
/**
 * One quota poller per machine, and one shared file every other host and every
 * session reads (BACKLOG #83). Each rule below fails without its line in
 * host/quota-share.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const {
  claimPoller, renewPoller, releasePoller, recordPoll, readShared, formatLine, createSharedQuota, createHostQuota,
  accountKey, quotaPath, leasePath,
  DATA_STALE_MS, LEASE_STALE_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS,
} = require('../host/quota-share');

const T0 = 1_800_000_000_000;
const WINDOWS = [
  { key: 'session', label: '5h', percent: 42, resetsAt: 'x', severity: 'normal' },
  { key: 'weekly_all', label: 'week', percent: 61, resetsAt: 'y', severity: 'normal' },
];
const GOOD = () => ({ ok: true, state: 'fresh', windows: WINDOWS, error: null });
const BAD = (error = 'usage endpoint returned 429') => ({ ok: false, state: 'absent', windows: [], error });
const dead = () => false;
const alive = () => true;

function dir() { return tmpDir('quota-share-'); }

test('the first host to ask becomes the poller; a second one does not while the lease is fresh', () => {
  const d = dir();
  assert.strictEqual(claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0, isAlive: alive }), true);
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0 + 60_000, isAlive: alive }), false);
});

test('the poller renews its own lease, which keeps it past the staleness bound', () => {
  const d = dir();
  let t = T0;
  assert.strictEqual(claimPoller({ dir: d, owner: 'a', pid: 1, now: () => t, isAlive: alive }), true);
  for (let i = 0; i < 5; i++) {
    t += 60_000;
    assert.strictEqual(claimPoller({ dir: d, owner: 'a', pid: 1, now: () => t, isAlive: alive }), true);
    renewPoller({ dir: d, owner: 'a', pid: 1, now: () => t });
    assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => t, isAlive: alive }), false);
  }
});

test('a lease whose holder pid is dead is taken over at once', () => {
  const d = dir();
  claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0, isAlive: alive });
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0 + 1000, isAlive: dead }), true);
  assert.strictEqual(claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0 + 2000, isAlive: alive }), false);
});

test('a lease older than the bound is taken over even if its pid looks alive (hung host, reused pid)', () => {
  const d = dir();
  claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0, isAlive: alive });
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0 + LEASE_STALE_MS, isAlive: alive }), false,
    'exactly at the bound is still held');
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0 + LEASE_STALE_MS + 1, isAlive: alive }), true);
});

test('a corrupt or empty lease file is taken over, not treated as held forever', () => {
  const d = dir();
  fs.writeFileSync(leasePath(d), '{not json');
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), true);
  fs.writeFileSync(leasePath(d), '');
  assert.strictEqual(claimPoller({ dir: d, owner: 'c', pid: 3, now: () => T0, isAlive: alive }), true);
});

test('release frees the lease for the next host, and only for the owner', () => {
  const d = dir();
  claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0, isAlive: alive });
  releasePoller({ dir: d, owner: 'b' });
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), false, 'not b\'s to release');
  releasePoller({ dir: d, owner: 'a' });
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), true);
});

test('a good poll is readable by anyone, with its windows and age', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  const r = readShared({ dir: d, now: () => T0 + 30_000 });
  assert.strictEqual(r.state, 'fresh');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.readAt, T0);
  assert.strictEqual(r.ageMs, 30_000);
  assert.deepStrictEqual(r.windows.map(w => [w.label, w.percent]), [['5h', 42], ['week', 61]]);
});

test('a failed poll never overwrites the last good result; it records the error beside it', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  recordPoll({ dir: d, result: BAD(), now: () => T0 + 60_000 });
  const r = readShared({ dir: d, now: () => T0 + 61_000 });
  assert.strictEqual(r.state, 'fresh');
  assert.strictEqual(r.readAt, T0, 'readAt is still the last GOOD read');
  assert.deepStrictEqual(r.windows.map(w => w.percent), [42, 61]);
  assert.match(r.lastError.message, /429/);
});

test('a failed poll with nothing good before it leaves the quota unknown, never zero', () => {
  const d = dir();
  recordPoll({ dir: d, result: BAD(), now: () => T0 });
  const r = readShared({ dir: d, now: () => T0 + 1000 });
  assert.strictEqual(r.state, 'absent');
  assert.deepStrictEqual(r.windows, []);
  assert.match(r.error, /429/);
});

test('data older than the bound reads as unknown, and the reason says how old', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 + DATA_STALE_MS }).state, 'fresh', 'at the bound');
  const r = readShared({ dir: d, now: () => T0 + DATA_STALE_MS + 1 });
  assert.strictEqual(r.state, 'absent');
  assert.deepStrictEqual(r.windows, []);
  assert.match(r.error, /stale/);
});

test('no file, an unparseable file and a wrong-shaped file are all unknown', () => {
  const d = dir();
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).state, 'absent');
  fs.writeFileSync(quotaPath(d), '{truncat');
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).state, 'absent');
  for (const body of ['null', '[]', '{}', '{"readAt":null,"windows":[]}', '{"readAt":"x","windows":[]}',
    `{"readAt":${T0},"windows":"no"}`, `{"readAt":${T0 + 10 * 60_000},"windows":[]}`]) {
    fs.writeFileSync(quotaPath(d), body);
    assert.strictEqual(readShared({ dir: d, now: () => T0 }).state, 'absent', body);
  }
});

test('a window whose percent is missing or not a number stays null, not 0', () => {
  const d = dir();
  fs.writeFileSync(quotaPath(d), JSON.stringify({
    readAt: T0, windows: [{ key: 'k', label: 'l', percent: null }, { key: 'k2', label: 'm', percent: '5' }, { key: 'k3', label: 'n' }],
  }));
  const r = readShared({ dir: d, now: () => T0 });
  assert.deepStrictEqual(r.windows.map(w => w.percent), [null, null, null]);
});

test('the write is atomic: no temp file is left and the old file is intact if the write throws', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  const before = fs.readFileSync(quotaPath(d), 'utf8');
  assert.throws(() => recordPoll({
    dir: d, now: () => T0 + 1,
    result: { ok: true, windows: [{ get percent() { throw new Error('encode failed'); } }] },
  }), /encode failed/);
  assert.strictEqual(fs.readFileSync(quotaPath(d), 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(d).filter(f => f.includes('.tmp')), []);
});

test('the one-line text: percentages, age, and unknown with its reason', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  assert.strictEqual(formatLine(readShared({ dir: d, now: () => T0 + 30_000 })), '5h 42% · week 61% · read 30 s ago');
  assert.strictEqual(formatLine(readShared({ dir: d, now: () => T0 + 150_000 })), '5h 42% · week 61% · read 2 min ago');
  const stale = formatLine(readShared({ dir: d, now: () => T0 + 3_600_000 }));
  assert.match(stale, /^unknown \(/);
  assert.match(formatLine(readShared({ dir: dir(), now: () => T0 })), /^unknown \(no quota file/);
});

test('a null percent prints as "?" in the line, never 0%', () => {
  const line = formatLine({ state: 'fresh', ageMs: 1000, windows: [{ label: '5h', percent: null }] });
  assert.strictEqual(line, '5h ? · read 1 s ago');
});

test('property: nothing but a fresh, well-formed file ever yields a window with a number', () => {
  fc.assert(fc.property(
    fc.oneof(fc.constant(undefined), fc.string(), fc.jsonValue().map(v => JSON.stringify(v)),
      fc.record({ readAt: fc.anything(), windows: fc.anything() }).map(v => JSON.stringify(v))),
    fc.integer({ min: 0, max: 10_000_000 }),
    (content, age) => {
      const d = dir();
      if (content !== undefined) fs.writeFileSync(quotaPath(d), content);
      const r = readShared({ dir: d, now: () => T0 + age });
      if (r.state === 'absent') {
        assert.deepStrictEqual(r.windows, []);
        assert.strictEqual(r.ok, false);
        return;
      }
      assert.ok(r.ageMs <= DATA_STALE_MS);
      for (const w of r.windows) assert.ok(w.percent === null || (typeof w.percent === 'number' && Number.isFinite(w.percent)));
    }), { numRuns: 150, seed: 83 });
});

test('two hosts sharing a dir: only one polls, both report the same figure, and a dead poller is replaced', async () => {
  const d = dir();
  let t = T0;
  let calls = 0;
  const readQuota = async () => { calls++; return GOOD(); };
  const mk = (owner, isAlive) => createSharedQuota({ dir: d, owner, readQuota, now: () => t, isAlive });
  const a = mk('a');
  const b = mk('b');
  const ra = await a.refresh();
  const rb = await b.refresh();
  assert.strictEqual(calls, 1, 'one poll for two hosts');
  assert.deepStrictEqual(ra.windows, rb.windows);
  t += 60_000;
  await a.refresh(); await b.refresh();
  assert.strictEqual(calls, 2);
  // a dies (its pid no longer exists); b takes over within one tick
  const b2 = createSharedQuota({ dir: d, owner: 'b', readQuota, now: () => t, isAlive: dead });
  t += 60_000;
  const r = await b2.refresh();
  assert.strictEqual(calls, 3, 'the survivor polled');
  assert.strictEqual(r.state, 'fresh');
});

test('a poller whose read throws still reports the shared file, and a 429 keeps the last good figure', async () => {
  const d = dir();
  let t = T0;
  let mode = 'good';
  const readQuota = async () => { if (mode === 'throw') throw new Error('boom'); return mode === 'good' ? GOOD() : BAD(); };
  const h = createSharedQuota({ dir: d, owner: 'a', readQuota, now: () => t, isAlive: alive });
  assert.strictEqual((await h.refresh()).state, 'fresh');
  mode = '429'; t += 60_000;
  const r = await h.refresh();
  assert.strictEqual(r.state, 'fresh');
  assert.deepStrictEqual(r.windows.map(w => w.percent), [42, 61]);
  mode = 'throw'; t += 60_000;
  assert.strictEqual((await h.refresh()).state, 'fresh');
  t += 2 * DATA_STALE_MS; // never recovered: now unknown
  assert.strictEqual((await h.refresh()).state, 'absent');
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const { MAX_FAILURES, defaultDir } = require('../host/quota-share');
const { spawnSync } = require('child_process');

const CFG = path.join(path.parse(process.cwd()).root, 'acct-kills');
// FUTURE_SKEW_MS is not exported; the module documents it as one minute.
const FUTURE_SKEW = 60_000;

function putLease(d, lease) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(leasePath(d, CFG), JSON.stringify(lease));
}
const readLease = (d) => JSON.parse(fs.readFileSync(leasePath(d, CFG), 'utf8'));

test('renewPoller refuses a non-owner and leaves the holder\'s lease exactly as it was', () => {
  const d = dir();
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'A', pid: 1, now: () => T0, isAlive: alive }), true);
  const before = fs.readFileSync(leasePath(d, CFG), 'utf8');
  assert.strictEqual(renewPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 + 50_000 }), false);
  assert.strictEqual(fs.readFileSync(leasePath(d, CFG), 'utf8'), before);
  assert.deepStrictEqual(readLease(d), { owner: 'A', pid: 1, at: T0 });
  // the owner itself does renew, and the new stamp is the one it passed
  assert.strictEqual(renewPoller({ dir: d, configDir: CFG, owner: 'A', pid: 1, now: () => T0 + 50_000 }), true);
  assert.deepStrictEqual(readLease(d), { owner: 'A', pid: 1, at: T0 + 50_000 });
});

test('renewPoller with no lease at all returns false and creates no lease file', () => {
  const d = dir();
  assert.strictEqual(renewPoller({ dir: d, configDir: CFG, owner: 'A', now: () => T0 }), false);
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), false);
});

test('releasePoller by a non-owner leaves the lease, by the owner removes it', () => {
  const d = dir();
  claimPoller({ dir: d, configDir: CFG, owner: 'A', pid: 1, now: () => T0, isAlive: alive });
  releasePoller({ dir: d, configDir: CFG, owner: 'B' });
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), true);
  releasePoller({ dir: d, configDir: CFG, owner: 'A' });
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), false);
});

test('releasePoller twice is safe: the second throws nothing and leaves a successor\'s lease (PR #217 Miguel 3)', () => {
  const d = dir();
  claimPoller({ dir: d, configDir: CFG, owner: 'A', pid: 1, now: () => T0, isAlive: alive });
  releasePoller({ dir: d, configDir: CFG, owner: 'A' });
  assert.doesNotThrow(() => releasePoller({ dir: d, configDir: CFG, owner: 'A' }));
  claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0, isAlive: alive });
  releasePoller({ dir: d, configDir: CFG, owner: 'A' });
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), true);
});

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.strictEqual(r.status, 0);
  return r.pid; // the child has exited and been reaped
}

test('with the default pid check, a lease held by a really dead pid is reclaimed at once', () => {
  const d = dir();
  putLease(d, { owner: 'A', pid: deadPid(), at: T0 });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 }), true);
  assert.strictEqual(readLease(d).owner, 'B');
});

test('with the default pid check, a lease held by a live pid is respected', () => {
  const d = dir();
  putLease(d, { owner: 'A', pid: process.pid, at: T0 });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 }), false);
  assert.strictEqual(readLease(d).owner, 'A');
});

test('with the default pid check, a pid we cannot judge counts as alive (a second poller is the 429)', () => {
  for (const pid of [undefined, null, 'abc', -5, 0]) {
    const d = dir();
    putLease(d, { owner: 'A', pid, at: T0 });
    assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 }), false,
      `pid ${String(pid)} can't be told dead`);
  }
});

test('the failure breaker holds the lease through MAX_FAILURES - 1 failures and gives it up on the next', async () => {
  const d = dir();
  let t = T0;
  let calls = 0;
  const h = createSharedQuota({
    dir: d, configDir: CFG, owner: 'h', now: () => t, isAlive: alive,
    readQuota: async () => { calls += 1; return BAD(); },
  });
  for (let i = 1; i < MAX_FAILURES; i++) {
    await h.refresh();
    t += POLL_INTERVAL_MS;
    assert.strictEqual(readLease(d).owner, 'h', `still held after ${i} failure(s)`);
  }
  await h.refresh();
  assert.strictEqual(calls, MAX_FAILURES);
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), false, 'released at exactly MAX_FAILURES');
  // sits out one lease period: no poll inside it, a poll at exactly its end
  const at = t;
  t = at + LEASE_STALE_MS - 1;
  await h.refresh();
  assert.strictEqual(calls, MAX_FAILURES, 'sitting out');
  t = at + LEASE_STALE_MS;
  await h.refresh();
  assert.strictEqual(calls, MAX_FAILURES + 1, 'polls again when the sit-out ends');
});

test('after sitting out, the failure count starts again from zero', async () => {
  const d = dir();
  let t = T0;
  const h = createSharedQuota({
    dir: d, configDir: CFG, owner: 'h', now: () => t, isAlive: alive, readQuota: failing429(),
  });
  for (let i = 0; i < MAX_FAILURES; i++) await h.refresh();
  assert.strictEqual(fs.existsSync(leasePath(d, CFG)), false);
  t += LEASE_STALE_MS;
  for (let i = 1; i < MAX_FAILURES; i++) await h.refresh();
  assert.strictEqual(readLease(d).owner, 'h', 'one failure after the sit-out does not release again');
});
function failing429() { return async () => BAD(); }

test('a good poll resets the failure count', async () => {
  const d = dir();
  let t = T0;
  let mode = 'bad';
  const h = createSharedQuota({
    dir: d, configDir: CFG, owner: 'h', now: () => t, isAlive: alive,
    readQuota: async () => (mode === 'bad' ? BAD() : GOOD()),
  });
  for (let i = 1; i < MAX_FAILURES; i++) await h.refresh();
  mode = 'good'; t += POLL_INTERVAL_MS;
  await h.refresh();
  mode = 'bad'; t += POLL_INTERVAL_MS;
  for (let i = 1; i < MAX_FAILURES; i++) await h.refresh();
  assert.strictEqual(readLease(d).owner, 'h', 'the earlier failures were forgotten');
});

test('a lease stamped exactly one skew in the future is still held, one ms more is reclaimable', () => {
  const d = dir();
  putLease(d, { owner: 'A', pid: 1, at: T0 + FUTURE_SKEW });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0, isAlive: alive }), false);
  putLease(d, { owner: 'A', pid: 1, at: T0 + FUTURE_SKEW + 1 });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0, isAlive: alive }), true);
});

test('a lease exactly LEASE_STALE_MS old is held, one ms older is taken', () => {
  const d = dir();
  putLease(d, { owner: 'A', pid: 1, at: T0 });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 + LEASE_STALE_MS, isAlive: alive }), false);
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0 + LEASE_STALE_MS + 1, isAlive: alive }), true);
});

test('a lease that is not the right shape is free to take', () => {
  for (const lease of [{ owner: 'A', pid: 1 }, { at: T0, pid: 1 }, { owner: 7, at: T0, pid: 1 },
    { owner: 'A', at: 'x', pid: 1 }, [], 'x', null]) {
    const d = dir();
    putLease(d, lease);
    assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'B', pid: 2, now: () => T0, isAlive: alive }), true,
      JSON.stringify(lease));
  }
});

test('a lease without a numeric stamp is rewritten even for the same owner', () => {
  const d = dir();
  putLease(d, { owner: 'A', pid: 1 });
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG, owner: 'A', pid: 3, now: () => T0, isAlive: alive }), true);
  assert.deepStrictEqual(readLease(d), { owner: 'A', pid: 3, at: T0 });
});

test('a figure dated exactly one skew ahead reads fresh at age 0; one ms more is dated in the future', () => {
  const d = dir();
  const write = (readAt) => {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(quotaPath(d, CFG), JSON.stringify({ version: 1, readAt, windows: WINDOWS, lastError: null }));
  };
  write(T0 + FUTURE_SKEW);
  const ok = readShared({ dir: d, configDir: CFG, now: () => T0 });
  assert.strictEqual(ok.state, 'fresh');
  assert.strictEqual(ok.ageMs, 0);
  write(T0 + FUTURE_SKEW + 1);
  const bad = readShared({ dir: d, configDir: CFG, now: () => T0 });
  assert.strictEqual(bad.state, 'absent');
  assert.strictEqual(bad.error, 'quota file is dated in the future');
});

test('defaultDir is the .claude-custom folder under home', () => {
  assert.strictEqual(path.basename(defaultDir()), '.claude-custom');
  assert.strictEqual(path.dirname(defaultDir()), require('os').homedir());
});
