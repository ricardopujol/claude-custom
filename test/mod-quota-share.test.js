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

// =====================================================================================================================================
// PR #197 review (Dexter 1-5): the timelines as he gave them, a fake clock throughout.
// =====================================================================================================================================

const { createQuotaAnnouncer } = require('../host/quota');
const failPoll = (d, t) => recordPoll({ dir: d, result: { ok: false, error: '429' }, now: () => t });
// Exactly what develop's recordPoll writes on a failed poll: readAt and windows kept, lastError set, and NO provenance fields (a host on an old build).
const failOld = (d, t) => {
  const f = fileOf(d);
  fs.writeFileSync(quotaPath(d, undefined), JSON.stringify({ version: 1, readAt: f.readAt, windows: f.windows, lastError: { message: '429', at: t } }, null, 2));
};

test('Dexter 1: two mod writes with no good poll never mark the file complete, and the poller keeps asking', async () => {
  const d = dir();
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 3000 });
  assert.strictEqual(fileOf(d).complete, false);
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 4000 }), false);
  let calls = 0;
  const q = createSharedQuota({ dir: d, owner: 'a', now: () => T0 + 4000, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; } });
  await q.refresh();
  assert.strictEqual(calls, 1);
});

test('Dexter 1: the same when the file holds only failed polls (readAt null)', async () => {
  const d = dir();
  failPoll(d, T0 - 1000);
  assert.strictEqual(fileOf(d).readAt, null);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 });
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 3000 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 4000 }), false);
  let calls = 0;
  const q = createSharedQuota({ dir: d, owner: 'a', now: () => T0 + 4000, isAlive: () => true, readQuota: async () => { calls++; return { ok: true, windows: POLLED }; } });
  await q.refresh();
  assert.strictEqual(calls, 1);
});

test('Dexter 1: a good poll that found no windows names none, so it does not make the file complete either', () => {
  const d = dir();
  poll(d, []);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 1 });
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 2 });
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 3 }), false);
});

test('Dexter 1: a file an earlier build wrote (complete true, pollKeys []) is not trusted to make the poller yield', () => {
  const d = dir();
  fs.writeFileSync(quotaPath(d, undefined), JSON.stringify({ version: 1, readAt: T0, windows: FROM_MOD, lastError: null, source: 'mod', complete: true, pollKeys: [], carriedReadAt: null }));
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 1 }), false);
});

test('Dexter 2: a 429 between mod writes does not make the mod stamp the poll age: Fable is gone at T0+250 s, not carried for ever', () => {
  const d = dir();
  poll(d, POLLED, T0);                                                                       // 1. a good poll: Fable 10
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 5_000 });                    // 2. a mod write
  failPoll(d, T0 + 60_000);                                                                  // 3. the poll fails
  assert.strictEqual(fileOf(d).source, 'mod', 'the failed poll keeps the file provenance');
  assert.strictEqual(fileOf(d).carriedReadAt, T0);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 65_000 });                   // 4. a mod write
  assert.strictEqual(fileOf(d).carriedReadAt, T0, 'still the poll time, not the mod time');
  failPoll(d, T0 + 120_000);                                                                 // 5. a second failure
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 125_000 });                  // 6. a mod write
  assert.ok(fileOf(d).windows.some(w => w.key === 'weekly_scoped:Fable'), 'still inside the bound');
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 250_000 });                  // 7. past DATA_STALE_MS since the poll
  assert.ok(!fileOf(d).windows.some(w => w.key === 'weekly_scoped:Fable'));
  assert.ok(!readShared({ dir: d, now: () => T0 + 250_000 }).windows.some(w => w.key === 'weekly_scoped:Fable'), 'and the header would not show it');
});

test('Dexter 2: a carried window says how old it really is', () => {
  const d = dir();
  poll(d, POLLED, T0);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 90_000 });
  const fable = readShared({ dir: d, now: () => T0 + 90_000 }).windows.find(w => w.key === 'weekly_scoped:Fable');
  assert.strictEqual(fable.carriedAt, T0);
});

test('Dexter 2: a failed poll on a plain poll file still keeps readAt and windows, and adds no provenance', () => {
  const d = dir();
  poll(d, POLLED, T0);
  failPoll(d, T0 + 60_000);
  const f = fileOf(d);
  assert.strictEqual(f.readAt, T0);
  assert.strictEqual(f.source, undefined);
  assert.strictEqual(f.windows.length, 3);
});

test('property: across any interleaving of good polls, failed polls and mod writes, a carried window poll is never older than the stale bound', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.array(fc.record({ who: fc.constantFrom('poll', 'fail', 'failOld', 'mod'), dt: fc.integer({ min: 1, max: 120 }) }), { minLength: 1, maxLength: 25 }), (ops) => {
    const d = dir();
    let t = T0;
    let lastGoodPoll = null;
    for (const { who, dt } of ops) {
      t += dt * 1000;
      if (who === 'poll') { poll(d, POLLED, t); lastGoodPoll = t; }
      else if (who === 'fail') failPoll(d, t);
      else if (who === 'failOld') { try { failOld(d, t); } catch { /* no file yet */ } }
      else {
        recordModWindows({ dir: d, windows: FROM_MOD, now: () => t });
        const fable = fileOf(d).windows.find(w => w.key === 'weekly_scoped:Fable');
        if (fable) assert.ok(lastGoodPoll !== null && t - lastGoodPoll <= DATA_STALE_MS, `carried ${t - lastGoodPoll} ms after the poll`);
      }
    }
  }), { numRuns: 150 });
});

test('Dexter 3: the 80% warning is announced once per window instance, whichever spelling of the reset arrives', () => {
  const d = dir();
  const P = '2026-10-20T05:10:00.006953+00:00';
  const M = '2026-10-20T05:10:00.000Z';
  const announcer = createQuotaAnnouncer();
  let said = 0;
  const check = (t) => { if (announcer.check(readShared({ dir: d, now: () => t }).windows)) said++; };
  poll(d, [win('session', '5h', 82, { resetsAt: P })], T0);                                                  check(T0);
  recordModWindows({ dir: d, windows: [win('session', '5h', 82, { resetsAt: M })], now: () => T0 + 10_000 }); check(T0 + 10_000);
  poll(d, [win('session', '5h', 83, { resetsAt: P })], T0 + 60_000);                                         check(T0 + 60_000);
  recordModWindows({ dir: d, windows: [win('session', '5h', 84, { resetsAt: M })], now: () => T0 + 70_000 }); check(T0 + 70_000);
  assert.strictEqual(said, 1);
});

test('Dexter 3: a real roll-over (another instant) is announced again; the announcer sees the minute, not the text', () => {
  const a = createQuotaAnnouncer();
  const w = (resetsAt, percent) => [{ key: 'session', label: '5h', percent, resetsAt }];
  assert.ok(a.check(w('2026-10-20T05:10:00.006953+00:00', 82)));
  assert.strictEqual(a.check(w('2026-10-20T05:10:00.000Z', 82)), null);
  assert.ok(a.check(w('2026-10-20T10:10:00.000Z', 85)), 'a new window instance announces afresh');
});

test('Dexter 4: a mod figure for an OLDER reset never overwrites the rolled-over poll figure', () => {
  const d = dir();
  poll(d, [win('session', '5h', 2, { resetsAt: '2026-10-20T10:10:00+00:00' })], T0);
  assert.strictEqual(recordModWindows({ dir: d, windows: [win('session', '5h', 90, { resetsAt: '2026-10-20T05:10:00.000Z' })], now: () => T0 + 1000 }), false);
  assert.strictEqual(readShared({ dir: d, now: () => T0 + 1000 }).windows[0].percent, 2);
});

test('Dexter 4: the older window is dropped, the others written, and the file is not complete (the poller keeps asking)', () => {
  const d = dir();
  poll(d, [win('session', '5h', 2, { resetsAt: '2026-10-20T10:10:00+00:00' }), win('weekly_all', 'week', 60, { resetsAt: '2026-10-26T18:00:00+00:00' })], T0);
  recordModWindows({ dir: d, windows: [win('session', '5h', 90, { resetsAt: '2026-10-20T05:10:00.000Z' }), win('weekly_all', 'week', 61, { resetsAt: '2026-10-26T18:00:00.000Z' })], now: () => T0 + 1000 });
  const w = readShared({ dir: d, now: () => T0 + 1000 }).windows;
  assert.deepStrictEqual(w.map(x => [x.key, x.percent]), [['session', 2], ['weekly_all', 61]]);
  assert.strictEqual(modCovers({ dir: d, now: () => T0 + 1500 }), false);
});

test('Dexter 4: the forward roll still lands: a LATER reset takes the lower mod figure', () => {
  const d = dir();
  poll(d, [win('session', '5h', 90, { resetsAt: '2026-10-20T05:10:00+00:00' })], T0);
  recordModWindows({ dir: d, windows: [win('session', '5h', 2, { resetsAt: '2026-10-20T10:10:00.000Z' })], now: () => T0 + 1000 });
  assert.strictEqual(readShared({ dir: d, now: () => T0 + 1000 }).windows[0].percent, 2);
});

test('Dexter 5 (A): the ratchet raises 5h to the poll 61, and 5h, not the week at 60.5, is the binding window', () => {
  const d = dir();
  const R1 = '2026-10-20T05:10:00+00:00';
  const R7 = '2026-10-26T18:00:00+00:00';
  poll(d, [win('session', '5h', 61, { resetsAt: R1 }), win('weekly_all', 'week', 60, { resetsAt: R7 })], T0);
  recordModWindows({ dir: d, windows: [win('session', '5h', 60, { resetsAt: R1 }), win('weekly_all', 'week', 60.5, { resetsAt: R7 })], now: () => T0 + 1000 });
  const w = readShared({ dir: d, now: () => T0 + 1000 }).windows;
  assert.deepStrictEqual(w.map(x => [x.key, x.percent, x.isActive]), [['session', 61, true], ['weekly_all', 60.5, false]]);
});

test('Dexter 5 (B): a carried Fable row never keeps the poll binding flag: exactly one window is binding, the fullest', () => {
  const d = dir();
  poll(d, [win('session', '5h', 30), win('weekly_all', 'week', 60), win('weekly_scoped:Fable', 'Fable', 70, { isActive: true })], T0);
  recordModWindows({ dir: d, windows: [win('session', '5h', 35, { isActive: true }), win('weekly_all', 'week', 61)], now: () => T0 + 1000 });
  const w = readShared({ dir: d, now: () => T0 + 1000 }).windows;
  assert.strictEqual(w.filter(x => x.isActive).length, 1);
  assert.deepStrictEqual(w.map(x => x.isActive), [false, false, true]);
  assert.strictEqual(w.find(x => x.isActive).key, 'weekly_scoped:Fable');
});

test('Dexter 5: with no known percent nothing is binding', () => {
  const d = dir();
  recordModWindows({ dir: d, windows: [win('session', '5h', null, { isActive: true })], now: () => T0 });
  assert.deepStrictEqual(readShared({ dir: d, now: () => T0 }).windows.map(x => x.isActive), [false]);
});

test('property: after any mod write exactly one window is binding and it is the fullest', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 4 }), (ps) => {
    const d = dir();
    recordModWindows({ dir: d, windows: ps.map((p, i) => win('k' + i, 'k' + i, p, { isActive: i === 0 })), now: () => T0 });
    const w = fileOf(d).windows;
    assert.strictEqual(w.filter(x => x.isActive).length, 1);
    assert.strictEqual(w.find(x => x.isActive).percent, Math.max(...ps));
  }));
});

test('Dexter 9, pinned: a kind the CLI names beyond five_hour and seven_day stays its own row (rename it here the day a scoped kind appears)', () => {
  const { windowsFromRateLimits } = require('../host/mod-feed');
  assert.deepStrictEqual(windowsFromRateLimits([{ kind: 'seven_day_opus', percentUsed: 5 }]).map(x => x.key), ['seven_day_opus']);
});

test('CLAUDE_CUSTOM_QUOTA_DIR moves the quota folder, for probes that must not touch the real one', () => {
  const { defaultDir } = require('../host/quota-share');
  const was = process.env.CLAUDE_CUSTOM_QUOTA_DIR;
  try {
    process.env.CLAUDE_CUSTOM_QUOTA_DIR = 'C:/private/quota';
    assert.strictEqual(defaultDir(), 'C:/private/quota');
    process.env.CLAUDE_CUSTOM_QUOTA_DIR = '';
    assert.match(defaultDir(), /\.claude-custom$/);
  } finally { if (was === undefined) delete process.env.CLAUDE_CUSTOM_QUOTA_DIR; else process.env.CLAUDE_CUSTOM_QUOTA_DIR = was; }
});

test('PR 197 Dexter r2 N1: a failed poll written by an OLD build between two mod writes cannot launder the age: Fable is gone at T0+250 s', () => {
  const d = dir();
  poll(d, POLLED, T0);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 5_000 });
  failOld(d, T0 + 60_000);
  assert.strictEqual(fileOf(d).source, undefined, 'the old writer dropped the provenance');
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 65_000 });
  assert.strictEqual(fileOf(d).carriedReadAt, T0, 'the carried row own carriedAt is the age, not the mod stamp');
  failOld(d, T0 + 120_000);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 125_000 });
  assert.ok(fileOf(d).windows.some(w => w.key === 'weekly_scoped:Fable'), 'inside the bound');
  failOld(d, T0 + 200_000);
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 250_000 });
  assert.ok(!fileOf(d).windows.some(w => w.key === 'weekly_scoped:Fable'));
});

test('PR 197 Dexter r2 N1: after an old-build failure the file with no carried row still uses its readAt as the poll time', () => {
  const d = dir();
  poll(d, POLLED, T0);
  failOld(d, T0 + 60_000);                               // a plain poll file the old writer touched: readAt is the poll's
  recordModWindows({ dir: d, windows: FROM_MOD, now: () => T0 + 250_000 });
  assert.ok(!fileOf(d).windows.some(w => w.key === 'weekly_scoped:Fable'), 'a poll 250 s old is past the bound');
});
