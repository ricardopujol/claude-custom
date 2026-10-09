'use strict';
/**
 * host/task-logs.js (BACKLOG #74 F(3)): which Claude Code task-output files the Leftovers readout lists, and which of
 * them are provably abandoned. The decision to delete is the dangerous one, so it is pinned by examples and by a property.
 *
 * RICARDO'S RULE (2026-10-08, PR #133 review): a file is deleted AUTOMATICALLY only when the app SAW its session alive
 * (a registry entry whose pid was running) and later saw it end. A session never seen is "unknown": kept, with a manual
 * Delete once the file has been idle. Absence from a registry is never proof of death.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const T = require('../host/task-logs');

const MB = 1024 * 1024;
const MIN = 15 * 60_000;
const NOW = 1_800_000_000_000;

const file = (o = {}) => ({
  path: `C:\\t\\claude\\proj\\${o.session || 's1'}\\tasks\\${o.name || 'a1.output'}`, project: 'proj', session: 's1', name: 'a1.output',
  bytes: 200 * MB, mtimeMs: NOW - 20 * 60_000, dev: '1', ino: '10', nlink: 1, ...o,
});
const registry = (entries, ok = true) => ({ ok, entries });
// `seen` defaults to "the app saw every session of these files alive earlier"; a test about never-seen passes its own.
// `listed` defaults to a non-empty table (a real process table is never empty; an empty one means the read failed).
const classify = (files, reg, listed = [1], extra = {}) => T.classify({
  files, registry: reg, listedPids: listed instanceof Map ? listed : new Set(listed), now: NOW, seen: new Set(files.map(f => f.session)), ...extra,
});
const other = registry([{ pid: 5, sessionId: 'other' }]);

test('a big file, idle 20 min, whose session was seen alive and has no live process now is deletable', () => {
  const [r] = classify([file()], other, [5]);
  assert.strictEqual(r.deletable, true);
  assert.strictEqual(r.bytes, 200 * MB);
  assert.strictEqual(r.ageMs, 20 * 60_000);
  assert.deepStrictEqual(r.sessions, ['s1']);
  assert.strictEqual(r.name, 'a1.output');
});

test('REGRESSION (Dexter #1, Miguel B1): a session that is in no registry we read, while another session is live, is UNKNOWN, never deletable by itself', () => {
  const [r] = classify([file({ session: 'other' })], registry([{ pid: 5, sessionId: 'tab' }]), [5], { seen: new Set(['tab']) });
  assert.strictEqual(r.deletable, false);
  assert.strictEqual(r.why, 'unknown');
  assert.strictEqual(r.manualDelete, true, 'idle 20 min, no live session in what we read: the person may decide');
});

test('a session seen alive earlier and now absent from the registry (its file removed on exit) is ended: deletable', () => {
  assert.strictEqual(classify([file()], other, [5], { seen: new Set(['s1']) })[0].why, 'delete');
});

test('a session never seen: unknown, kept, with the manual Delete only once the file is idle', () => {
  const old = classify([file()], other, [5], { seen: new Set() })[0];
  assert.deepStrictEqual([old.why, old.deletable, old.manualDelete], ['unknown', false, true]);
  const young = classify([file({ mtimeMs: NOW - 60_000 })], other, [5], { seen: new Set() })[0];
  assert.deepStrictEqual([young.why, young.deletable, young.manualDelete], ['young', false, false]);
});

test('files under 100 MB are not listed at all', () => {
  assert.deepStrictEqual(classify([file({ bytes: 100 * MB - 1 })], other), []);
  assert.strictEqual(classify([file({ bytes: 100 * MB })], other).length, 1);
});

test('written within 15 minutes: shown, not deletable, no manual Delete (the boundary is inclusive of exactly 15)', () => {
  const young = classify([file({ mtimeMs: NOW - MIN + 1 })], other)[0];
  assert.deepStrictEqual([young.deletable, young.manualDelete], [false, false]);
  assert.strictEqual(classify([file({ mtimeMs: NOW - MIN })], other)[0].deletable, true);
});

test('a session whose registry file names a listed pid is alive: shown only, no manual Delete either', () => {
  const [r] = classify([file()], registry([{ pid: 7, sessionId: 's1' }]), [7]);
  assert.deepStrictEqual([r.deletable, r.manualDelete, r.why], [false, false, 'alive']);
});

test('a registry entry for the session whose pid is not listed does not keep it', () => {
  assert.strictEqual(classify([file()], registry([{ pid: 7, sessionId: 's1' }]), [99])[0].deletable, true);
});

test('doubt keeps: an unreadable or empty registry, an empty or missing process table, a future mtime, an unreadable time', () => {
  const del = (reg, listed, f = file()) => classify([f], reg, listed)[0];
  for (const r of [
    del(registry([{ pid: 5, sessionId: 'x' }], false)), del(registry([])), del(null),
    del(other, []), del(other, [], file()), del(other, [5], file({ mtimeMs: NOW + 5000 })), del(other, [5], file({ mtimeMs: NaN })),
  ]) assert.deepStrictEqual([r.deletable, r.manualDelete, r.why], [false, false, 'unknown']);
  const bad = T.classify({ files: [file()], registry: other, listedPids: null, now: NOW, seen: new Set(['s1']) })[0];
  assert.deepStrictEqual([bad.deletable, bad.manualDelete], [false, false], 'a null process table never reads as "everything is gone"');
});

test('a hard-linked file (one task output shared by several session folders) is one row, deletable only when EVERY session was seen and ended', () => {
  const a = file({ session: 'sa', nlink: 2, path: 'C:\\t\\claude\\p\\sa\\tasks\\a1.output' });
  const b = file({ session: 'sb', nlink: 2, path: 'C:\\t\\claude\\p\\sb\\tasks\\a1.output' });
  const rows = classify([a, b], registry([{ pid: 5, sessionId: 'zz' }]), [5]);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].sessions.sort(), ['sa', 'sb']);
  assert.deepStrictEqual(rows[0].paths.sort(), [a.path, b.path].sort());
  assert.strictEqual(rows[0].deletable, true);
  assert.strictEqual(classify([a, b], registry([{ pid: 9, sessionId: 'sb' }]), [9])[0].deletable, false);
  assert.strictEqual(classify([a, b], registry([{ pid: 5, sessionId: 'zz' }]), [5], { seen: new Set(['sa']) })[0].deletable, false, 'sb was never seen');
});

test('a link the scan did not see (nlink above the links found) keeps the file, with no manual Delete', () => {
  const r = classify([file({ nlink: 3 })], other)[0];
  assert.deepStrictEqual([r.deletable, r.manualDelete], [false, false]);
});

test('rows are ordered biggest first', () => {
  const rows = classify([file({ ino: '1', bytes: 150 * MB }), file({ ino: '2', bytes: 900 * MB, name: 'b.output' })], other);
  assert.deepStrictEqual(rows.map(r => r.bytes), [900 * MB, 150 * MB]);
});

test('PROPERTY: auto-delete implies seen-then-ended, idle, links all seen and a readable registry; manual implies idle with nobody alive', () => {
  const sessionIds = ['s1', 's2', 's3'];
  const inoArb = fc.record({
    nlink: fc.integer({ min: 0, max: 3 }), bytes: fc.oneof(fc.integer({ min: 0, max: 300 * MB }), fc.constant(NaN)),
    mtimeMs: fc.oneof(fc.integer({ min: NOW - 3 * MIN, max: NOW + MIN }), fc.constant(NaN), fc.constant(undefined)),
  });
  const fileArb = fc.record({ session: fc.constantFrom(...sessionIds), ino: fc.constantFrom(0, 1) });
  const regArb = fc.oneof(fc.constant(null), fc.record({
    ok: fc.boolean(),
    entries: fc.array(fc.record({ pid: fc.integer({ min: 1, max: 4 }), sessionId: fc.constantFrom(...sessionIds, 'q') }), { maxLength: 5 }),
  }));
  const seenArb = fc.subarray([...sessionIds, 'q']);
  fc.assert(fc.property(fc.tuple(inoArb, inoArb), fc.array(fileArb, { maxLength: 6 }), regArb, fc.array(fc.integer({ min: 1, max: 4 })), seenArb, (props, fs0, reg, listed, seen) => {
    const files = fs0.map((f, i) => ({ ...props[f.ino], dev: '1', session: f.session, ino: String(f.ino), path: `C:\\t\\claude\\p\\${f.session}\\tasks\\f${i}.output`, project: 'p', name: `f${i}` }));
    const rows = classify(files, reg, listed, { seen: new Set(seen) });
    const live = new Set(listed);
    for (const r of rows) {
      const members = files.filter(f => r.paths.includes(f.path));
      const m = members[0];
      const ctxOk = !!reg && reg.ok === true && reg.entries.length > 0 && listed.length > 0;
      const aliveS = s => reg.entries.some(e => e.sessionId === s && live.has(e.pid));
      const base = ctxOk && Number.isFinite(m.mtimeMs) && NOW - m.mtimeMs >= MIN && members.length === m.nlink && !members.some(x => aliveS(x.session));
      assert.strictEqual(r.manualDelete, base);
      assert.strictEqual(r.deletable, base && members.every(x => seen.includes(x.session)));
      if (r.deletable) {
        assert.ok(NOW - m.mtimeMs >= MIN, 'never a file written within 15 minutes');
        assert.ok(members.every(x => !aliveS(x.session)), 'never a live session');
        assert.ok(members.every(x => seen.includes(x.session)), 'never a session the app did not see alive first');
      }
    }
  }), { numRuns: 400 });
});

test('parseTaskPath: only root/<project>/<session>/tasks/<id>.output, nothing deeper, nothing else', () => {
  const root = 'C:\\t\\claude';
  assert.deepStrictEqual(T.parseTaskPath(root, 'C:\\t\\claude\\p\\s\\tasks\\a1.output'), { project: 'p', session: 's', name: 'a1.output' });
  assert.deepStrictEqual(T.parseTaskPath(root, 'C:\\t\\claude\\p\\s\\tasks\\a1.output'.replace(/\\/g, '/')), { project: 'p', session: 's', name: 'a1.output' });
  for (const bad of [
    'C:\\t\\claude\\p\\s\\tasks\\a1.txt', 'C:\\t\\claude\\p\\s\\tasks\\sub\\a1.output', 'C:\\t\\claude\\p\\s\\other\\a1.output',
    'C:\\t\\claude\\p\\tasks\\a1.output', 'C:\\t\\claude\\..\\x\\s\\tasks\\a1.output', 'C:\\t\\claude\\p\\..\\tasks\\a1.output',
    'C:\\t\\other\\p\\s\\tasks\\a1.output', 'C:\\t\\claude\\p\\s\\tasks\\.output', 'C:\\t\\claude\\p\\s\\tasks\\a1.output\\', '', null, 5,
  ]) assert.strictEqual(T.parseTaskPath(root, bad), null, String(bad));
});

test('why: delete, alive, young or unknown, in that order of what the readout tells the person', () => {
  const reg = registry([{ pid: 7, sessionId: 's1' }]);
  assert.strictEqual(classify([file()], reg, [99])[0].why, 'delete');
  assert.strictEqual(classify([file()], reg, [7])[0].why, 'alive');
  assert.strictEqual(classify([file({ mtimeMs: NOW - 60_000 })], reg, [99])[0].why, 'young');
  assert.strictEqual(classify([file({ mtimeMs: NOW - 60_000 })], reg, [7])[0].why, 'alive', 'a live session with a recent write is alive, not young');
  assert.strictEqual(classify([file()], null)[0].why, 'unknown');
  assert.strictEqual(classify([file({ mtimeMs: NOW + 1 })], reg, [99])[0].why, 'unknown');
});

test('"over 100 MB" is exact in the panel own unit: MIN_BYTES is 100 MB of 1 048 576 bytes, the MB every figure in the panel uses', () => {
  assert.strictEqual(T.MIN_BYTES, 100 * 1024 * 1024);
  assert.strictEqual(T.IDLE_MS, 15 * 60_000);
});

test('procStart (Dexter #6): a registry entry whose pid now runs a process with ANOTHER start is not alive, but not "ended" either: unknown, with a manual Delete', () => {
  const reg = registry([{ pid: 7, sessionId: 's1', procStart: '134000000000000000' }]);
  const at = start => classify([file()], reg, new Map([[7, start], [1, '1']]))[0];
  const alive = at('134000000000000050');
  assert.deepStrictEqual([alive.why, alive.manualDelete], ['alive', false], 'within the 10 ms slack: the same process');
  const reused = at('134000000600000000');
  assert.deepStrictEqual([reused.why, reused.deletable, reused.manualDelete], ['unknown', false, true], 'a reused pid: the session is not alive, and its end was not observed');
  assert.strictEqual(at(null).why, 'alive', 'a table start that cannot be read: doubt keeps');
  assert.strictEqual(classify([file()], registry([{ pid: 7, sessionId: 's1' }]), new Map([[7, '5'], [1, '1']]))[0].why, 'alive', 'an entry with no procStart: doubt keeps');
});

test('monoAge (Dexter #4): when given, the app deletes only a file that was idle on the monotonic clock too; the person\'s Delete is not held back', () => {
  const run = monoAge => classify([file()], other, [5], { monoAge })[0];
  const settled = run(() => 16 * 60_000);
  assert.deepStrictEqual([settled.deletable, settled.why], [true, 'delete']);
  for (const v of [null, undefined, 14 * 60_000]) {
    const r = run(() => v);
    assert.deepStrictEqual([r.deletable, r.manualDelete, r.why], [false, true, 'settling'], String(v));
  }
});
