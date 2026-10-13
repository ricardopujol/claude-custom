'use strict';
/**
 * PR #165 review fixes (Dexter 1-6, Miguel 1-5, El Gordo 1-5) for host/quota-share.js.
 * Each test fails without its fix; the base rules live in quota-share.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const {
  claimPoller, recordPoll, readShared, createSharedQuota, createHostQuota,
  accountKey, quotaPath, leasePath,
  DATA_STALE_MS, LEASE_STALE_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS,
} = require('../host/quota-share');

const T0 = 1_800_000_000_000;
const ROOT = path.parse(process.cwd()).root;
const CFG_X = path.join(ROOT, 'acct-x');
const CFG_Y = path.join(ROOT, 'acct-y');
const WINDOWS = [
  { key: 'session', label: '5h', percent: 42, resetsAt: 'x', severity: 'normal' },
  { key: 'weekly_all', label: 'week', percent: 61, resetsAt: 'y', severity: 'normal' },
];
const GOOD = () => ({ ok: true, state: 'fresh', windows: WINDOWS, error: null });
const BAD = (error = 'usage endpoint returned 429') => ({ ok: false, state: 'absent', windows: [], error });
const alive = () => true;
const dir = () => tmpDir('quota-share-review-');
const okWith = (percent) => async () => ({
  ok: true, state: 'fresh', windows: [{ key: 'session', label: '5h', percent }], error: null,
});
const failing = (error) => async () => BAD(error);

test('Dexter 1: the lease and the file are keyed by account; the same config dir shares, a different one never does', () => {
  assert.strictEqual(accountKey(CFG_X), accountKey(CFG_X));
  assert.notStrictEqual(accountKey(CFG_X), accountKey(CFG_Y));
  assert.notStrictEqual(quotaPath('d', CFG_X), quotaPath('d', CFG_Y));
  assert.notStrictEqual(leasePath('d', CFG_X), leasePath('d', CFG_Y));
  assert.strictEqual(quotaPath('d', CFG_X), quotaPath('d', CFG_X));
});

test('Dexter 1: two hosts on different accounts sharing one base dir each see only their own figure', async () => {
  const d = dir();
  const t = () => T0;
  const x = createSharedQuota({ dir: d, configDir: CFG_X, owner: 'x', readQuota: okWith(42), now: t, isAlive: alive });
  const y = createSharedQuota({ dir: d, configDir: CFG_Y, owner: 'y', readQuota: okWith(7), now: t, isAlive: alive });
  const rx = await x.refresh();
  const ry = await y.refresh();
  assert.deepStrictEqual(rx.windows.map(w => w.percent), [42]);
  assert.deepStrictEqual(ry.windows.map(w => w.percent), [7], 'y polled for itself, not x\'s figure');
  assert.deepStrictEqual(readShared({ dir: d, configDir: CFG_X, now: t }).windows.map(w => w.percent), [42]);
  assert.strictEqual(readShared({ dir: d, configDir: path.join(CFG_X, 'z'), now: t }).state, 'absent',
    'a third account that never polled reads unknown');
});

test('Dexter 1: a host with no configDir option keys by the live CLAUDE_CONFIG_DIR, resolved at call time', async () => {
  const d = dir();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    const host = createSharedQuota({ dir: d, owner: 'h', readQuota: okWith(11), now: () => T0, isAlive: alive });
    process.env.CLAUDE_CONFIG_DIR = CFG_X;
    await host.refresh();
    assert.strictEqual(readShared({ dir: d, configDir: CFG_X, now: () => T0 }).state, 'fresh');
    assert.strictEqual(readShared({ dir: d, configDir: CFG_Y, now: () => T0 }).state, 'absent');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('Dexter 2: a holder whose polls keep failing does not hold the lease forever; a peer gets to poll', async () => {
  const d = dir();
  let t = T0;
  let peerCalls = 0;
  const holder = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'holder', readQuota: failing(), now: () => t, isAlive: alive,
  });
  const peer = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'peer', now: () => t, isAlive: alive,
    readQuota: async () => { peerCalls++; return GOOD(); },
  });
  for (let i = 0; i < 10; i++) {
    t += 30_000;
    await (i % 2 === 0 ? holder : peer).refresh();
  }
  assert.ok(peerCalls > 0, 'the healthy peer polled');
  assert.strictEqual(readShared({ dir: d, configDir: CFG_X, now: () => t }).state, 'fresh');
});

test('Dexter 2: a failing holder backs off for a lease period, so a 429 is not hammered every tick', async () => {
  const d = dir();
  let t = T0;
  let calls = 0;
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => t, isAlive: alive,
    readQuota: async () => { calls++; return BAD(); },
  });
  for (let i = 0; i < 6; i++) { await h.refresh(); t += POLL_INTERVAL_MS; }
  assert.ok(calls <= 4, `6 ticks of 429 made ${calls} calls`);
});

test('Dexter 3: a successor has polled before a hung holder\'s figure goes unknown', async () => {
  const d = dir();
  let t = T0;
  const a = createSharedQuota({ dir: d, configDir: CFG_X, owner: 'a', readQuota: okWith(42), now: () => t, isAlive: alive });
  const hung = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'a', now: () => t, isAlive: alive, pollTimeoutMs: Infinity,
    readQuota: () => new Promise(() => {}),
  });
  const b = createSharedQuota({ dir: d, configDir: CFG_X, owner: 'b', readQuota: okWith(43), now: () => t, isAlive: alive });
  await a.refresh();
  t = T0 + 60_000;
  hung.refresh(); // never settles: the holder's poll hangs
  const seen = [];
  for (const dt of [90_000, 150_000, 210_000]) { t = T0 + dt; seen.push((await b.refresh()).state); }
  assert.deepStrictEqual(seen, ['fresh', 'fresh', 'fresh'], 'never unknown while handing over');
});

test('Dexter 3: the bounds keep the header\'s promise: data outlives lease + one tick + one poll', () => {
  assert.ok(DATA_STALE_MS >= LEASE_STALE_MS + POLL_INTERVAL_MS + POLL_TIMEOUT_MS,
    'a successor has polled before the last figure goes unknown');
});

test('Dexter 3: a poll that hangs is cut off at the timeout and counted as a failure', async () => {
  const d = dir();
  const logs = [];
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, pollTimeoutMs: 20,
    readQuota: () => new Promise(() => {}), log: (m) => logs.push(m),
  });
  const r = await h.refresh();
  assert.strictEqual(r.state, 'absent');
  assert.ok(logs.some(m => /timed out/.test(m)), logs.join('|'));
  assert.match(readShared({ dir: d, configDir: CFG_X, now: () => T0 }).error, /timed out/);
});

test('Dexter 3: the lease is stamped after a good poll, not before it', async () => {
  const d = dir();
  let t = T0;
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => t, isAlive: alive,
    readQuota: async () => { t += 10_000; return GOOD(); },
  });
  await h.refresh();
  const lease = JSON.parse(fs.readFileSync(leasePath(d, CFG_X), 'utf8'));
  assert.strictEqual(lease.at, T0 + 10_000);
});

test('Dexter 4: a lease dated far in the future is not evidence of a live holder; a slightly future one still is', () => {
  const d = dir();
  fs.writeFileSync(leasePath(d), JSON.stringify({ owner: 'a', pid: 1, at: T0 + 7_200_000 }));
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), true);
  fs.writeFileSync(leasePath(d), JSON.stringify({ owner: 'a', pid: 1, at: T0 + 30_000 }));
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), false);
});

test('Dexter 5: a lease that is unreadable right now (EBUSY) is not taken over; a missing one still is', () => {
  const d = dir();
  claimPoller({ dir: d, owner: 'a', pid: 1, now: () => T0, isAlive: alive });
  const busy = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive, readFile: busy }), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(leasePath(d), 'utf8')).owner, 'a', 'the lease is untouched');
  fs.rmSync(leasePath(d));
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), true);
});

test('Dexter 6: a late failure from an ex-poller does not touch a newer good write', async () => {
  const d = dir();
  let t = T0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const a = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'a', now: () => t, isAlive: alive,
    readQuota: async () => { await gate; return BAD(); },
  });
  const pending = a.refresh(); // a holds the lease and is mid-poll
  await new Promise(r => setImmediate(r));
  // meanwhile b took the lease over and wrote a newer good result
  t = T0 + 200_000;
  const b = createSharedQuota({ dir: d, configDir: CFG_X, owner: 'b', readQuota: okWith(9), now: () => t, isAlive: alive });
  await b.refresh();
  release();
  await pending;
  const r = readShared({ dir: d, configDir: CFG_X, now: () => t });
  assert.strictEqual(r.readAt, T0 + 200_000);
  assert.strictEqual(r.lastError, null, 'a\'s late 429 was not written beside b\'s good data');
});

test('Miguel 1: a host that can\'t claim the lease says so once and polls for itself, not "no host has polled"', async () => {
  const d = path.join(dir(), 'a-file-not-a-folder');
  fs.writeFileSync(d, 'x'); // mkdir of this path fails
  const logs = [];
  let calls = 0;
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, log: (m) => logs.push(m),
    readQuota: async () => { calls++; return GOOD(); },
  });
  const r1 = await h.refresh();
  const r2 = await h.refresh();
  assert.strictEqual(r1.state, 'fresh');
  assert.deepStrictEqual(r1.windows.map(w => w.percent), [42, 61]);
  assert.strictEqual(r2.state, 'fresh');
  assert.strictEqual(calls, 2, 'polled directly each tick');
  assert.strictEqual(logs.filter(m => /lease unavailable/.test(m)).length, 1, `logged once: ${logs.join('|')}`);
});

test('Miguel 1: a direct fallback whose poll fails reports the poll\'s error and logs it', async () => {
  const d = path.join(dir(), 'a-file-not-a-folder');
  fs.writeFileSync(d, 'x');
  const logs = [];
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, log: (m) => logs.push(m),
    readQuota: failing('no credentials'),
  });
  const r = await h.refresh();
  assert.strictEqual(r.state, 'absent');
  assert.match(r.error, /no credentials/);
  assert.ok(logs.some(m => /quota poll failed: no credentials/.test(m)));
});

test('Miguel 2: an ok:false poll (429, 401, no credentials) is logged', async () => {
  const logs = [];
  const h = createSharedQuota({
    dir: dir(), configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, log: (m) => logs.push(m), readQuota: failing(),
  });
  await h.refresh();
  assert.ok(logs.some(m => /quota poll failed: usage endpoint returned 429/.test(m)), logs.join('|'));
});

test('Miguel 2/5: a throwing poll is logged and reads as a failure', async () => {
  const logs = [];
  const h = createSharedQuota({
    dir: dir(), configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, log: (m) => logs.push(m),
    readQuota: async () => { throw new Error('boom'); },
  });
  const r = await h.refresh();
  assert.strictEqual(r.state, 'absent');
  assert.ok(logs.some(m => /boom/.test(m)), logs.join('|'));
});

test('Miguel 3: a rename that fails leaves no temp file behind (the shared writeFileAtomic cleans up)', () => {
  const d = dir();
  fs.mkdirSync(quotaPath(d)); // a folder where the file goes: the rename can't succeed
  assert.throws(() => recordPoll({ dir: d, result: GOOD(), now: () => T0 }));
  assert.deepStrictEqual(fs.readdirSync(d).filter(f => f.endsWith('.tmp')), []);
  assert.ok(fs.statSync(quotaPath(d)).isDirectory());
});

test('Miguel 4: an ok result without a windows array is not written as a good read', () => {
  const d = dir();
  recordPoll({ dir: d, result: GOOD(), now: () => T0 });
  recordPoll({ dir: d, result: { ok: true }, now: () => T0 + 60_000 });
  const r = readShared({ dir: d, now: () => T0 + 61_000 });
  assert.strictEqual(r.state, 'fresh');
  assert.strictEqual(r.readAt, T0, 'the good read stands');
  assert.match(r.lastError.message, /no windows/);
  const d2 = dir();
  recordPoll({ dir: d2, result: { ok: true }, now: () => T0 });
  assert.match(readShared({ dir: d2, now: () => T0 }).error, /no windows/);
});

test('El Gordo 2: a pid that can\'t be judged keeps the lease (proc-start\'s null); it is not "dead"', () => {
  const d = dir();
  fs.writeFileSync(leasePath(d), JSON.stringify({ owner: 'a', pid: -1, at: T0 }));
  assert.strictEqual(claimPoller({ dir: d, owner: 'b', pid: 2, now: () => T0 + 1000 }), false);
});

test('El Gordo 3: a field quota.js adds to a window reaches the readers (the shape is not re-declared)', () => {
  const d = dir();
  fs.writeFileSync(quotaPath(d), JSON.stringify({
    readAt: T0, windows: [{ key: 'k', label: 'l', percent: 5, brandNewField: 'kept', lockedReason: 'why' }],
  }));
  const w = readShared({ dir: d, now: () => T0 }).windows[0];
  assert.strictEqual(w.brandNewField, 'kept');
  assert.strictEqual(w.lockedReason, 'why');
  assert.strictEqual(w.percent, 5);
});

test('El Gordo 5: a poller whose own write fails still shows the fresh result it holds, and logs the failure', async () => {
  const d = dir();
  fs.mkdirSync(quotaPath(d, CFG_X)); // the quota file can't be written; the lease can
  const logs = [];
  const h = createSharedQuota({
    dir: d, configDir: CFG_X, owner: 'h', now: () => T0, isAlive: alive, log: (m) => logs.push(m), readQuota: okWith(42),
  });
  const r = await h.refresh();
  assert.strictEqual(r.state, 'fresh');
  assert.deepStrictEqual(r.windows.map(w => w.percent), [42]);
  assert.ok(logs.some(m => /record failed/.test(m)), logs.join('|'));
});

// ---- the host wiring (Miguel 5d, El Gordo 4) ----

test('wiring: createHostQuota refreshes through the shared module, one poll for two hosts, and tells onQuota', async () => {
  const d = dir();
  let calls = 0;
  const seen = [];
  const mk = (owner) => createHostQuota({
    dir: d, configDir: CFG_X, owner, now: () => T0, isAlive: alive,
    readQuota: async () => { calls++; return GOOD(); }, onQuota: (q) => seen.push([owner, q.state]),
  });
  const a = mk('a'); const b = mk('b');
  await a.refresh(); await b.refresh();
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(seen, [['a', 'fresh'], ['b', 'fresh']]);
});

test('wiring: overlapping refreshes coalesce into one', async () => {
  let calls = 0;
  const h = createHostQuota({
    dir: dir(), configDir: CFG_X, owner: 'a', now: () => T0, isAlive: alive,
    readQuota: async () => { calls++; return GOOD(); },
  });
  const p1 = h.refresh();
  const p2 = h.refresh();
  assert.strictEqual(p1, p2);
  await p1;
  assert.strictEqual(calls, 1);
  await h.refresh();
  assert.strictEqual(calls, 2);
});

test('wiring: release() frees the lease for the next host', async () => {
  const d = dir();
  const a = createHostQuota({ dir: d, configDir: CFG_X, owner: 'a', now: () => T0, isAlive: alive, readQuota: okWith(1) });
  await a.refresh();
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG_X, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), false);
  a.release();
  assert.strictEqual(claimPoller({ dir: d, configDir: CFG_X, owner: 'b', pid: 2, now: () => T0, isAlive: alive }), true);
});

test('wiring: host.js polls only through createHostQuota and releases the lease on exit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  assert.match(src, /createHostQuota\(\{[^}]*\breadQuota\b/s, 'the shared module is built with readQuota');
  assert.match(src, /function refreshQuota\(\)\s*\{\s*return hostQuota\.refresh\(\);?\s*\}/, 'refreshQuota goes through it');
  assert.doesNotMatch(src, /\breadQuota\(\{/, 'no direct poll');
  assert.doesNotMatch(src, /sharedQuota\b/);
  const exit = src.indexOf('process.on(\'exit\', () => { hostQuota.release(); })');
  assert.ok(exit > src.indexOf('process.on(\'SIGTERM\''), 'the release sits with the other exit cleanup');
});
