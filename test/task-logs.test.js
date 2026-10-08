'use strict';
/**
 * host/task-logs.js (BACKLOG #74 F(3)): which Claude Code task-output files the Leftovers readout lists, and which of
 * them are provably abandoned. The decision to delete is the dangerous one, so it is pinned by examples and by a property.
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
const classify = (files, reg, listed = [], extra = {}) => T.classify({ files, registry: reg, listedPids: new Set(listed), now: NOW, ...extra });

test('a big file, idle 20 min, whose session has no live process is deletable', () => {
  const [r] = classify([file()], registry([{ pid: 5, sessionId: 'other' }]), [5]);
  assert.strictEqual(r.deletable, true);
  assert.strictEqual(r.bytes, 200 * MB);
  assert.strictEqual(r.ageMs, 20 * 60_000);
  assert.deepStrictEqual(r.sessions, ['s1']);
  assert.strictEqual(r.name, 'a1.output');
});

test('files under 100 MB are not listed at all', () => {
  assert.deepStrictEqual(classify([file({ bytes: 100 * MB - 1 })], registry([{ pid: 5, sessionId: 'x' }])), []);
  assert.strictEqual(classify([file({ bytes: 100 * MB })], registry([{ pid: 5, sessionId: 'x' }])).length, 1);
});

test('written within 15 minutes: shown, not deletable (the boundary is inclusive of exactly 15)', () => {
  const reg = registry([{ pid: 5, sessionId: 'x' }]);
  assert.strictEqual(classify([file({ mtimeMs: NOW - MIN + 1 })], reg)[0].deletable, false);
  assert.strictEqual(classify([file({ mtimeMs: NOW - MIN })], reg)[0].deletable, true);
});

test('a session whose registry file names a listed pid is alive: shown only', () => {
  const [r] = classify([file()], registry([{ pid: 7, sessionId: 's1' }]), [7]);
  assert.strictEqual(r.deletable, false);
});

test('a registry entry for the session whose pid is not listed does not keep it', () => {
  assert.strictEqual(classify([file()], registry([{ pid: 7, sessionId: 's1' }]), [])[0].deletable, true);
});

test('doubt keeps: an unreadable or empty registry, a future mtime, an unreadable size or time', () => {
  assert.strictEqual(classify([file()], registry([{ pid: 5, sessionId: 'x' }], false))[0].deletable, false);
  assert.strictEqual(classify([file()], registry([]))[0].deletable, false);
  assert.strictEqual(classify([file()], null)[0].deletable, false);
  assert.strictEqual(classify([file({ mtimeMs: NOW + 5000 })], registry([{ pid: 5, sessionId: 'x' }]))[0].deletable, false);
  assert.strictEqual(classify([file({ mtimeMs: NaN })], registry([{ pid: 5, sessionId: 'x' }]))[0].deletable, false);
});

test('a hard-linked file (one task output shared by several session folders) is one row, deletable only when EVERY session is gone', () => {
  const a = file({ session: 'sa', nlink: 2, path: 'C:\\t\\claude\\p\\sa\\tasks\\a1.output' });
  const b = file({ session: 'sb', nlink: 2, path: 'C:\\t\\claude\\p\\sb\\tasks\\a1.output' });
  const rows = classify([a, b], registry([{ pid: 5, sessionId: 'zz' }]), [5]);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].sessions.sort(), ['sa', 'sb']);
  assert.deepStrictEqual(rows[0].paths.sort(), [a.path, b.path].sort());
  assert.strictEqual(rows[0].deletable, true);
  const alive = classify([a, b], registry([{ pid: 9, sessionId: 'sb' }]), [9]);
  assert.strictEqual(alive[0].deletable, false);
});

test('a link the scan did not see (nlink above the links found) keeps the file', () => {
  const a = file({ nlink: 3 });
  assert.strictEqual(classify([a], registry([{ pid: 5, sessionId: 'x' }]))[0].deletable, false);
});

test('rows are ordered biggest first', () => {
  const rows = classify([file({ ino: '1', bytes: 150 * MB }), file({ ino: '2', bytes: 900 * MB, name: 'b.output' })], registry([{ pid: 5, sessionId: 'x' }]));
  assert.deepStrictEqual(rows.map(r => r.bytes), [900 * MB, 150 * MB]);
});

test('PROPERTY: deletable implies every condition; and every condition together implies deletable', () => {
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
  fc.assert(fc.property(fc.tuple(inoArb, inoArb), fc.array(fileArb, { maxLength: 6 }), regArb, fc.array(fc.integer({ min: 1, max: 4 })), (props, fs0, reg, listed) => {
    const files = fs0.map((f, i) => ({ ...props[f.ino], dev: '1', session: f.session, ino: String(f.ino), path: `C:\\t\\claude\\p\\${f.session}\\tasks\\f${i}.output`, project: 'p', name: `f${i}` }));
    const rows = classify(files, reg, listed);
    const live = new Set(listed);
    for (const r of rows) {
      const members = files.filter(f => r.paths.includes(f.path));
      const registryOk = !!reg && reg.ok === true && reg.entries.length > 0;
      const gone = s => registryOk && !reg.entries.some(e => e.sessionId === s && live.has(e.pid));
      const m = members[0];
      const expected = registryOk
        && Number.isFinite(m.mtimeMs) && NOW - m.mtimeMs >= MIN
        && members.every(x => gone(x.session))
        && members.length === m.nlink;
      assert.strictEqual(r.deletable, expected);
      if (r.deletable) {
        assert.ok(NOW - m.mtimeMs >= MIN, 'never a file written within 15 minutes');
        assert.ok(members.every(x => !reg.entries.some(e => e.sessionId === x.session && live.has(e.pid))), 'never a live session');
      }
    }
  }), { numRuns: 300 });
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
  assert.strictEqual(classify([file()], reg, [])[0].why, 'delete');
  assert.strictEqual(classify([file()], reg, [7])[0].why, 'alive');
  assert.strictEqual(classify([file({ mtimeMs: NOW - 60_000 })], reg, [])[0].why, 'young');
  assert.strictEqual(classify([file({ mtimeMs: NOW - 60_000 })], reg, [7])[0].why, 'alive', 'a live session with a recent write is alive, not young');
  assert.strictEqual(classify([file()], null)[0].why, 'unknown');
  assert.strictEqual(classify([file({ mtimeMs: NOW + 1 })], reg, [])[0].why, 'unknown');
});
