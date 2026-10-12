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
