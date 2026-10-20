'use strict';
/**
 * The mod's rate limits reach the SHARED quota file through the same writer the poller uses (BACKLOG #119 A2), and the poller
 * yields while the mod's figure is fresh. Each rule below fails without its line in host/quota-share.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { tmpDir } = require('./tmp-dir');

const {
  recordPoll, recordModWindows, modCovers, readShared, createSharedQuota, createHostQuota, quotaPath,
  DATA_STALE_MS, MOD_FRESH_MS,
} = require('../host/quota-share');

const T0 = 1_800_000_000_000;
const dir = () => tmpDir('mod-quota-');
const win = (key, label, percent, extra = {}) => ({ key, label, percent, resetsAt: 'r', severity: 'normal', isActive: false, usedDollars: null, remainingDollars: null, lockedReason: null, ...extra });
const POLLED = [win('session', '5h', 30), win('weekly_all', 'week', 60), win('weekly_scoped:Fable', 'Fable', 10)];
const FROM_MOD = [win('session', '5h', 35), win('weekly_all', 'week', 61)];
const fileOf = (d) => JSON.parse(fs.readFileSync(quotaPath(d, undefined), 'utf8'));
const poll = (d, windows, t = T0) => recordPoll({ dir: d, result: { ok: true, windows }, now: () => t });

test('the mod fresh time is shorter than the data stale bound and is two minutes', () => {
  assert.strictEqual(MOD_FRESH_MS, 120_000);
  assert.ok(MOD_FRESH_MS < DATA_STALE_MS);
});

test('a mod record is written through the shared file and every host reads it', () => {
  const d = dir();
  poll(d, [win('session', '5h', 30), win('weekly_all', 'week', 60)]);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 1000 });
  const shared = readShared({ dir: d, now: () => T0 + 2000 });
  assert.strictEqual(shared.state, 'fresh');
  assert.deepStrictEqual(shared.windows.map(w => [w.key, w.percent]), [['session', 35], ['weekly_all', 61]]);
  assert.strictEqual(shared.readAt, T0 + 1000);
});

test('with no earlier file the mod still writes one', () => {
  const d = dir();
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows.length, 2);
});

test('windows the mod does not report (the model-scoped one) are carried from the last poll, in their place', () => {
  const d = dir();
  poll(d, POLLED);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 1000 });
  const w = readShared({ dir: d, now: () => T0 + 1000 }).windows;
  assert.deepStrictEqual(w.map(x => [x.key, x.percent]), [['session', 35], ['weekly_all', 61], ['weekly_scoped:Fable', 10]]);
});

test('a carried window older than the stale bound is dropped, never shown as fresh', () => {
  const d = dir();
  poll(d, POLLED, T0);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 1000 });
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + DATA_STALE_MS + 1000 });
  const w = readShared({ dir: d, now: () => T0 + DATA_STALE_MS + 1000 }).windows;
  assert.deepStrictEqual(w.map(x => x.key), ['session', 'weekly_all']);
});

test('a later mod write keeps the carried window and the age of the poll it came from', () => {
  const d = dir();
  poll(d, POLLED, T0);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 1000 });
  recordModWindows({ dir: d, windows: [win('session', '5h', 40), win('weekly_all', 'week', 62)], now: () => T0 + 60_000 });
  const f = fileOf(d);
  assert.strictEqual(f.windows.find(x => x.key === 'weekly_scoped:Fable').percent, 10);
  assert.strictEqual(f.carriedReadAt, T0);
});

test('a mod window with a non-numeric percent stays unknown (null), never 0', () => {
  const d = dir();
  recordModWindows({ dir: d, windows: [win('session', '5h', null)], now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows[0].percent, null);
});

test('an empty list writes nothing: absence is not a figure', () => {
  const d = dir();
  poll(d, POLLED);
  const before = fs.readFileSync(quotaPath(d, undefined), 'utf8');
  assert.strictEqual(recordModWindows({ dir: d, windows: [], now: () => T0 + 1 }), false);
  assert.strictEqual(fs.readFileSync(quotaPath(d, undefined), 'utf8'), before);
});

test('modCovers: fresh, from the mod, and covering every window the last poll found', () => {
  const d = dir();
  poll(d, [win('session', '5h', 30), win('weekly_all', 'week', 60)]);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + MOD_FRESH_MS - 1 }), true);
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + MOD_FRESH_MS }), false, 'at the bound it is stale');
});

test('modCovers is false when the last poll found a window the mod does not report', () => {
  const d = dir();
  poll(d, POLLED);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 1 }), false);
});

test('modCovers is false when no poll ever succeeded: the poller must learn what windows exist', () => {
  const d = dir();
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 1 }), false);
});

test('modCovers is false for a polled file, a missing file, a corrupt file and a future-dated one', () => {
  const d = dir();
  assert.strictEqual(modCovers({ dir: d, now: () => T0 }), false);
  poll(d, FROM_MOD);
  assert.strictEqual(modCovers({ dir: d, now: () => T0 }), false);
  fs.writeFileSync(quotaPath(d, undefined), '{nope');
  assert.strictEqual(modCovers({ dir: d, now: () => T0 }), false);
  poll(d, FROM_MOD);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 10 * 60_000 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 }), false, 'a stamp far in the future is a clock fault');
});

test('a poll after a mod write replaces the file wholesale and ends the yield', () => {
  const d = dir();
  poll(d, FROM_MOD);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 1 }), true);
  poll(d, FROM_MOD, T0 + 2);
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 3 }), false);
});

test('the poller yields while the mod covers every window: no network call, the shared figure is returned', async () => {
  const d = dir();
  poll(d, FROM_MOD);
  recordModWindows({ dir: d, windows: [win('session', '5h', 44), win('weekly_all', 'week', 62)], now: () => T0 });
  let calls = 0;
  const q = createSharedQuota({ dir: d, owner: 'a', now: () => T0 + 30_000, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; } });
  const got = await q.refresh();
  assert.strictEqual(calls, 0);
  assert.strictEqual(got.windows[0].percent, 44);
});

test('the poller polls again once the mod has gone quiet for two minutes', async () => {
  const d = dir();
  poll(d, FROM_MOD);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  let calls = 0;
  const q = createSharedQuota({ dir: d, owner: 'a', now: () => T0 + MOD_FRESH_MS + 1, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; } });
  await q.refresh();
  assert.strictEqual(calls, 1);
});

test('the poller keeps polling while the mod leaves a window out (the Fable meter must not freeze)', async () => {
  const d = dir();
  poll(d, POLLED);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  let calls = 0;
  const q = createSharedQuota({ dir: d, owner: 'a', now: () => T0 + 30_000, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; } });
  await q.refresh();
  assert.strictEqual(calls, 1);
});

test('readNow on the host quota reads the shared file with no poll and reports it to onQuota', () => {
  const d = dir();
  poll(d, FROM_MOD);
  recordModWindows({ dir: d, windows: [win('session', '5h', 50), win('weekly_all', 'week', 62)], now: () => T0 });
  let calls = 0;
  const seen = [];
  const hq = createHostQuota({ dir: d, now: () => T0 + 1000, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; }, onQuota: (q) => seen.push(q) });
  const q = hq.readNow();
  assert.strictEqual(calls, 0);
  assert.strictEqual(q.windows[0].percent, 50);
  assert.deepStrictEqual(seen, [q]);
});

test('readNow with no file is absent, never a set of zeros', () => {
  const hq = createHostQuota({ dir: dir(), now: () => T0, readQuota: async () => { throw new Error('no poll'); } });
  const q = hq.readNow();
  assert.strictEqual(q.state, 'absent');
  assert.deepStrictEqual(q.windows, []);
});

// --- a window never moves backwards inside one reset: the mod's figure is the CLI's last response, the poll's is the account's now ---

test('a mod figure below the file\'s for the same window and the same reset is not written: the percent only goes up inside one window', () => {
  const d = dir();
  poll(d, [win('session', '5h', 18, { resetsAt: '2026-10-20T05:10:00.123456+00:00' }), win('weekly_all', 'week', 7, { resetsAt: '2026-10-26T18:00:00+00:00' })]);
  recordModWindows({ dir: d, windows: [win('session', '5h', 17, { resetsAt: '2026-10-20T05:10:00.000Z' }), win('weekly_all', 'week', 8, { resetsAt: '2026-10-26T18:00:00.000Z' })], now: () => T0 + 1000 });
  const w = readShared({ dir: d, now: () => T0 + 1000 }).windows;
  assert.deepStrictEqual(w.map(x => [x.key, x.percent]), [['session', 18], ['weekly_all', 8]]);
});

test('a lower figure for a NEW reset instance is written: the window rolled over', () => {
  const d = dir();
  poll(d, [win('session', '5h', 90, { resetsAt: '2026-10-20T05:10:00+00:00' })]);
  recordModWindows({ dir: d, windows: [win('session', '5h', 2, { resetsAt: '2026-10-20T10:10:00.000Z' })], now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows[0].percent, 2);
});

test('with no reset time on either side the lower figure is written: nothing proves it is the same window', () => {
  const d = dir();
  poll(d, [win('session', '5h', 50, { resetsAt: null })]);
  recordModWindows({ dir: d, windows: [win('session', '5h', 40, { resetsAt: null })], now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows[0].percent, 40);
});

test('an unknown (null) percent on either side never wins by comparison', () => {
  const d = dir();
  poll(d, [win('session', '5h', null, { resetsAt: '2026-10-20T05:10:00Z' })]);
  recordModWindows({ dir: d, windows: [win('session', '5h', 3, { resetsAt: '2026-10-20T05:10:00Z' })], now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows[0].percent, 3);
  recordModWindows({ dir: d, windows: [win('session', '5h', null, { resetsAt: '2026-10-20T05:10:00Z' })], now: () => T0 + 1 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 + 1 }).windows[0].percent, 3, 'an unknown mod figure does not erase a known one for the same window');
});

test('resets within a minute of each other are the same instance; a minute or more apart are not', () => {
  const d = dir();
  poll(d, [win('session', '5h', 50, { resetsAt: '2026-10-20T05:10:00Z' })]);
  recordModWindows({ dir: d, windows: [win('session', '5h', 40, { resetsAt: '2026-10-20T05:10:59Z' })], now: () => T0 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 }).windows[0].percent, 50);
  const e = dir();
  poll(e, [win('session', '5h', 50, { resetsAt: '2026-10-20T05:10:00Z' })]);
  recordModWindows({ dir: e, windows: [win('session', '5h', 40, { resetsAt: '2026-10-20T05:11:00Z' })], now: () => T0 + 1 });
  assert.strictEqual(readShared({ dir: e, now: () => T0 + 1 }).windows[0].percent, 40);
});

test('property: a mod write never lowers a window\'s percent inside one reset, whatever the poll and the mod said before', () => {
  const fc = require('fast-check');
  const op = fc.record({ who: fc.constantFrom('poll', 'mod'), pct: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(null)) });
  fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 12 }), (ops) => {
    const d = dir();
    let t = T0;
    for (const { who, pct } of ops) {
      t += 1000;
      const before = (() => { try { return fileOf(d).windows.find(w => w.key === 'session'); } catch { return null; } })();
      const w = win('session', '5h', pct, { resetsAt: '2026-10-20T05:10:00.000Z' });
      if (who === 'poll') recordPoll({ dir: d, result: { ok: true, windows: [w] }, now: () => t });
      else {
        recordModWindows({ dir: d, windows: [w], now: () => t });
        const after = fileOf(d).windows.find(x => x.key === 'session');
        if (before && typeof before.percent === 'number') assert.ok(typeof after.percent === 'number' && after.percent >= before.percent, `${before.percent} -> ${after.percent}`);
      }
    }
  }), { numRuns: 100 });
});
