'use strict';
/**
 * The probe PID ledger (BACKLOG #74 B): which Electron roots a probe launched, proven by start time, and which of
 * them the reaper may kill. The rule is host/background-hosts.js's: a pid alone proves nothing on Windows (it is
 * reused -- measured on 2026-10-06, a root this work had launched was a different node.exe an hour later), so a
 * process is ours only if its CURRENT start time is the one written at launch.
 */
const test = require('node:test');
const assert = require('node:assert');
const { tmpDir } = require('./tmp-dir');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('fast-check');
const ledger = require('../host/pid-ledger');

const entry = (over = {}) => ({ pid: 100, start: '134000000000000000', launcher: { pid: 50, start: '133999999000000000' }, kind: 'probe-window', label: 'probe-x', createdAt: 1000, ...over });

test('an entry survives serialize -> parse', () => {
  const e = entry();
  assert.deepStrictEqual(ledger.parseLedger(ledger.serializeEntry(e) + '\n'), [e]);
});

test('parse skips junk lines, half-written lines and entries without a usable pid or start', () => {
  const good = ledger.serializeEntry(entry({ pid: 7 }));
  const text = [
    'not json', '{"pid":', good,
    JSON.stringify({ pid: 0, start: '1', launcher: { pid: 1, start: '1' } }),
    JSON.stringify({ pid: -4, start: '1', launcher: { pid: 1, start: '1' } }),
    JSON.stringify({ pid: 1.5, start: '1', launcher: { pid: 1, start: '1' } }),
    JSON.stringify({ pid: 8, start: 12345, launcher: { pid: 1, start: '1' } }),
    JSON.stringify({ pid: 9, start: 'abc', launcher: { pid: 1, start: '1' } }),
    '', '   ',
  ].join('\n');
  assert.deepStrictEqual(ledger.parseLedger(text).map(e => e.pid), [7]);
});

test('an entry without a launcher parses, with the launcher null (unknown: the reaper keeps it, see below)', () => {
  const e = ledger.parseLedger(JSON.stringify({ pid: 5, start: '9' }))[0];
  assert.strictEqual(e.pid, 5);
  assert.strictEqual(e.launcher, null);
  assert.strictEqual(e.kind, 'probe-window');
  assert.strictEqual(e.createdAt, null);
});

test('an unknown kind reads as probe-window; agent-shell is kept', () => {
  assert.strictEqual(ledger.parseLedger(ledger.serializeEntry(entry({ kind: 'agent-shell' })))[0].kind, 'agent-shell');
  assert.strictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '9', kind: 'wat' }))[0].kind, 'probe-window');
});

test('reapable with an age floor: only entries created at least minAgeMs before now; no createdAt never qualifies', () => {
  const starts = new Map([[100, '134000000000000000'], [101, '134000000000000000']]);
  const old = entry({ pid: 100, createdAt: 1000 });
  const young = entry({ pid: 101, createdAt: 1000 + 14 * 60_000 });
  const undated = entry({ pid: 100, createdAt: null });
  const now = 1000 + 15 * 60_000;
  assert.deepStrictEqual(ledger.selectReapable([old, young], starts, { now, minAgeMs: 15 * 60_000 }).map(e => e.pid), [100]);
  assert.deepStrictEqual(ledger.selectReapable([undated], starts, { now, minAgeMs: 15 * 60_000 }), []);
  assert.deepStrictEqual(ledger.selectReapable([undated], starts, { now }).map(e => e.pid), [100]);
  // exactly at the floor qualifies
  assert.deepStrictEqual(ledger.selectReapable([entry({ pid: 100, createdAt: 0 })], starts, { now: 60_000, minAgeMs: 60_000 }).map(e => e.pid), [100]);
});

test('reapable: a running process whose start time matches and whose launcher is gone', () => {
  const starts = new Map([[100, '134000000000000000']]);
  assert.deepStrictEqual(ledger.selectReapable([entry()], starts).map(e => e.pid), [100]);
});

test('reapable: not when the pid now has a DIFFERENT start time (reused pid)', () => {
  const starts = new Map([[100, '134000000000000001']]);
  assert.deepStrictEqual(ledger.selectReapable([entry()], starts), []);
});

test('reapable: not when the start time cannot be read (running, unknown: never "ours")', () => {
  assert.deepStrictEqual(ledger.selectReapable([entry()], new Map([[100, null]])), []);
});

test('reapable: not when the pid is not running at all', () => {
  assert.deepStrictEqual(ledger.selectReapable([entry()], new Map()), []);
});

test('reapable: not while the launcher is still the same running process', () => {
  const starts = new Map([[100, '134000000000000000'], [50, '133999999000000000']]);
  assert.deepStrictEqual(ledger.selectReapable([entry()], starts), []);
});

test('reapable: the launcher pid reused by another process (start differs) counts as gone', () => {
  const starts = new Map([[100, '134000000000000000'], [50, '999']]);
  assert.deepStrictEqual(ledger.selectReapable([entry()], starts).map(e => e.pid), [100]);
});

test('reapable: a launcher that is running with an unreadable start counts as ALIVE (doubt keeps the process)', () => {
  const starts = new Map([[100, '134000000000000000'], [50, null]]);
  assert.deepStrictEqual(ledger.selectReapable([entry()], starts), []);
});

test('reapable: a failed start-time query (null) selects nothing', () => {
  assert.deepStrictEqual(ledger.selectReapable([entry()], null), []);
});

// PR #130 review, Dexter #3 = Miguel M1: a launcher that could not be read is UNKNOWN, and doubt keeps the process.
// Before the fix this test pinned the opposite ("no launcher is reaped once its own proof holds"), so a probe whose
// selfStart() timed out under load had its live window reapable mid-run.
test('reapable: an entry with no launcher at all is NOT reaped (unknown launcher counts as alive)', () => {
  const starts = new Map([[100, '134000000000000000']]);
  assert.deepStrictEqual(ledger.selectReapable([entry({ launcher: null })], starts), []);
});

test('reapable: a launcher with a known pid and an unread start is alive while that pid is listed, gone once it is not', () => {
  const e = entry({ launcher: { pid: 900, start: null } });
  assert.deepStrictEqual(ledger.selectReapable([e], new Map([[100, '134000000000000000'], [900, '5']])), [],
    'the pid is running: it may be the launcher, so the Electron is kept');
  assert.deepStrictEqual(ledger.selectReapable([e], new Map([[100, '134000000000000000'], [900, null]])), []);
  assert.deepStrictEqual(ledger.selectReapable([e], new Map([[100, '134000000000000000']])).map(x => x.pid), [100],
    'the pid is not running: whatever launched it is gone');
});

test('parse: a launcher with a valid pid and a null start round-trips as { pid, start: null }', () => {
  const line = ledger.serializeEntry({ pid: 5, start: '9', launcher: { pid: 6, start: null } });
  assert.deepStrictEqual(ledger.parseLedger(line)[0].launcher, { pid: 6, start: null });
});

test('stale: an entry whose process is gone or was replaced is dropped from the ledger; a live one and an unreadable one are kept', () => {
  const es = [entry({ pid: 1 }), entry({ pid: 2 }), entry({ pid: 3 }), entry({ pid: 4 })];
  const starts = new Map([[2, '134000000000000000'], [3, 'other'], [4, null]]);
  // 1 not running -> stale; 2 matches -> kept; 3 reused -> stale; 4 unreadable -> kept (doubt)
  assert.deepStrictEqual(ledger.staleEntries(es, starts).map(e => e.pid), [1, 3]);
  assert.deepStrictEqual(ledger.staleEntries(es, null), []);
});

test('PROPERTY: the reaper never selects a pid whose start time does not match the ledger', () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      pid: fc.integer({ min: 1, max: 40 }), start: fc.bigInt({ min: 1n, max: 10n ** 18n }).map(String),
      launcherPid: fc.integer({ min: 41, max: 80 }), launcherStart: fc.bigInt({ min: 1n, max: 10n ** 18n }).map(String),
    }), { maxLength: 12 }),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 80 }), fc.oneof(fc.constant(null), fc.bigInt({ min: 1n, max: 10n ** 18n }).map(String))), { maxLength: 40 }),
    (raw, startPairs) => {
      const es = raw.map(r => ({ pid: r.pid, start: r.start, launcher: { pid: r.launcherPid, start: r.launcherStart }, label: 'p' }));
      const starts = new Map(startPairs);
      for (const sel of ledger.selectReapable(es, starts)) {
        assert.strictEqual(starts.get(sel.pid), sel.start, 'selected a pid whose current start time is not the recorded one');
      }
    },
  ), { numRuns: 300 });
});

test('PROPERTY: an entry whose launcher still matches is never selected', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1001, max: 2000 }), (pid, lpid) => {
    const e = entry({ pid, launcher: { pid: lpid, start: 'L' } });
    const starts = new Map([[pid, e.start], [lpid, 'L']]);
    assert.deepStrictEqual(ledger.selectReapable([e], starts), []);
  }));
});

test('append and read: the ledger file is JSON lines, appended, tolerant of a missing file', () => {
  const dir = tmpDir('cc-ledger-test-');
  try {
    const file = path.join(dir, 'ledger.jsonl');
    assert.deepStrictEqual(ledger.readLedger(file), []);
    ledger.appendEntry(file, entry({ pid: 1 }));
    ledger.appendEntry(file, entry({ pid: 2 }));
    assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [1, 2]);
    ledger.removePids(file, [1]);
    assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [2]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default ledger lives under the OS temp dir', () => {
  assert.ok(ledger.defaultLedgerFile().toLowerCase().startsWith(os.tmpdir().toLowerCase()));
});
