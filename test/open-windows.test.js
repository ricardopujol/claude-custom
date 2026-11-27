'use strict';
/**
 * host/open-windows.js (single-instance PR 3 step 12): the crash-restore record `<UI state dir>\open-windows.json`
 * = { owner: { pid, start }, at, clean, restoring, windows: [{ root, cwd, hidden }] }, written only by the process app.json names.
 * restoreDecision says which windows come back after a crash of the one process; the writer keeps the file equal to the open windows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const { samePath } = require('../host/project-layout');

const load = () => require('../host/open-windows');
const A = path.resolve('/p/alpha'); const B = path.resolve('/p/beta'); const C = path.resolve('/p/gamma');
const win = (root, hidden = false) => ({ root, cwd: path.join(root, 'dev'), hidden });
const rec = (over = {}) => ({ owner: { pid: 10, start: 'S10' }, at: 5000, clean: false, restoring: false, windows: [win(A), win(B, true), win(C)], ...over });
const decide = (over = {}) => load().restoreDecision({ record: rec(), proof: 'dead', bootAt: 1000, launchRoot: A, exists: () => true, samePath, ...over });

test('restoreDecision: no file, unreadable, half-written -> nothing', () => {
  for (const record of [null, undefined, 'garbage', 7, [], {}]) assert.deepStrictEqual(decide({ record }).restore, [], String(record));
  assert.deepStrictEqual(decide({ record: null }).reason, 'no record');
});

test('restoreDecision: a clean quit -> nothing; owner live or unknown -> nothing', () => {
  assert.deepStrictEqual(decide({ record: rec({ clean: true }) }), { restore: [], skipped: [], reason: 'the last quit was clean' });
  for (const proof of ['live', 'unknown', null]) assert.deepStrictEqual(decide({ proof }).restore, [], String(proof));
});

test('restoreDecision: not clean with a dead owner -> every window except the launched root, in order, with its hidden state', () => {
  const d = decide();
  assert.deepStrictEqual(d.restore, [win(B, true), win(C)]);
  assert.strictEqual(d.reason, 'restore');
});

test('restoreDecision: a folder that is gone is skipped with a reason', () => {
  const d = decide({ exists: (p) => !p.startsWith(C) });
  assert.deepStrictEqual(d.restore, [win(B, true)]);
  assert.deepStrictEqual(d.skipped, [{ root: C, reason: 'the folder is gone' }]);
});

test('restoreDecision: restoring: true with a dead owner -> nothing ("the last restore did not finish")', () => {
  assert.deepStrictEqual(decide({ record: rec({ restoring: true }) }), { restore: [], skipped: [], reason: 'the last restore did not finish' });
});

test('restoreDecision: a record older than the machine\'s boot -> nothing (Q2 default: no restore after a restart)', () => {
  assert.deepStrictEqual(decide({ bootAt: 6000 }), { restore: [], skipped: [], reason: 'older than this boot' });
});

test('restoreDecision: wrong shapes dropped; hidden only on a real true', () => {
  const windows = [win(B), { root: 7, cwd: 'x' }, { root: C }, null, { root: C, cwd: path.join(C, 'dev'), hidden: 'yes' }];
  assert.deepStrictEqual(decide({ record: rec({ windows }) }).restore, [win(B), win(C, false)]);
});

test('P-O2: restoreDecision never throws on any JSON; its output is a subset of record.windows, never the launched root, empty unless not clean, owner dead, not restoring, not older than boot', () => {
  fc.assert(fc.property(
    fc.oneof(fc.jsonValue(), fc.record({
      owner: fc.anything(), at: fc.oneof(fc.integer(), fc.constant(null)), clean: fc.anything(), restoring: fc.anything(),
      windows: fc.array(fc.record({ root: fc.constantFrom(A, B, C, 7), cwd: fc.constantFrom(path.join(A, 'dev'), path.join(B, 'x'), null), hidden: fc.anything() }, { requiredKeys: [] })),
    })),
    fc.constantFrom('dead', 'live', 'unknown'), fc.integer({ min: -10, max: 10_000 }), fc.constantFrom(A, B, C),
    (record, proof, bootAt, launchRoot) => {
      const d = load().restoreDecision({ record, proof, bootAt, launchRoot, exists: () => true, samePath });
      const src = record && typeof record === 'object' && Array.isArray(record.windows) ? record.windows : [];
      for (const w of d.restore) {
        assert.ok(src.some((s) => s && s.root === w.root && s.cwd === w.cwd), 'a subset');
        assert.ok(!samePath(w.root, launchRoot), 'never the launched root');
        assert.strictEqual(typeof w.hidden, 'boolean');
      }
      if (d.restore.length) {
        assert.strictEqual(record.clean === true, false);
        assert.strictEqual(proof, 'dead');
        assert.strictEqual(record.restoring === true, false);
        assert.ok(Number.isFinite(record.at) && record.at >= bootAt);
      }
    }), { numRuns: 300 });
});

// ---- the writer ---------------------------------------------------------------------------------------------------------------------

function writer({ owns = () => true } = {}) {
  const dir = tmpDir('cc-open-windows-');
  const file = path.join(dir, 'open-windows.json');
  let t = 100;
  const writes = [];
  const w = load().createOpenWindowsWriter({ file, owner: { pid: 20, start: 'S20' }, owns, now: () => ++t, onWrite: (doc) => writes.push(doc) });
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  return { w, file, read, writes };
}

test('writer: begin writes the owner, not clean, restoring as told, and keeps the list it was handed', () => {
  const { w, read } = writer();
  w.begin({ restoring: true, keep: [win(B, true)] });
  const doc = read();
  assert.deepStrictEqual({ ...doc, at: 0 }, { owner: { pid: 20, start: 'S20' }, at: 0, clean: false, restoring: true, windows: [win(B, true)] });
});

test('writer: sync is a no-op until endRestore(); then it writes only on a change', () => {
  const { w, read, writes } = writer();
  w.begin({ restoring: true, keep: [win(B)] });
  const n = writes.length;
  w.sync([win(A)]);
  assert.strictEqual(writes.length, n, 'no write during the restore');
  w.endRestore([win(A), win(B)]);
  assert.deepStrictEqual(read().windows, [win(A), win(B)]);
  assert.strictEqual(read().restoring, false);
  const m = writes.length;
  w.sync([win(A), win(B)]);
  assert.strictEqual(writes.length, m, 'no change, no write');
  w.sync([win(A), win(B, true)]);
  assert.deepStrictEqual(read().windows, [win(A), win(B, true)]);
});

test('writer: never writes when owns() is false (a displaced process: plan risk 2)', () => {
  const { w, read, writes } = writer({ owns: () => false });
  w.begin({ restoring: false, keep: [] });
  w.endRestore([win(A)]);
  w.sync([win(B)]);
  w.markClean();
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(read(), null);
});

test('writer: markClean() writes clean: true synchronously, with the last list', () => {
  const { w, read } = writer();
  w.begin({ restoring: false, keep: [] });
  w.endRestore([win(A, true)]);
  w.markClean();
  const doc = read();
  assert.strictEqual(doc.clean, true);
  assert.deepStrictEqual(doc.windows, [win(A, true)]);
});

test('P-O1: after any open/close/hide/show sequence, the file lists exactly the windows open at that moment with their hidden state', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ k: fc.constantFrom('open', 'close', 'hide', 'show'), r: fc.constantFrom(A, B, C) }), { maxLength: 25 }),
    fc.boolean(),
    (ops, owner) => {
      const { w, read } = writer({ owns: () => owner });
      w.begin({ restoring: false, keep: [] });
      w.endRestore([]);
      const open = [];
      for (const o of ops) {
        const at = open.findIndex((x) => x.root === o.r);
        if (o.k === 'open' && at < 0) open.push(win(o.r));
        else if (o.k === 'close' && at >= 0) open.splice(at, 1);
        else if ((o.k === 'hide' || o.k === 'show') && at >= 0) open[at] = { ...open[at], hidden: o.k === 'hide' };
        w.sync(open.map((x) => ({ ...x })));
        if (owner) assert.deepStrictEqual(read().windows, open);
        else assert.strictEqual(read(), null, 'a process that does not own the lock writes nothing');
      }
    }), { numRuns: 60 });
});

test('readRecord: the parsed file, or null (no file, not JSON)', () => {
  const { readRecord } = load();
  const dir = tmpDir('cc-open-windows-read-');
  assert.strictEqual(readRecord(path.join(dir, 'none.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"owner":');
  assert.strictEqual(readRecord(path.join(dir, 'bad.json')), null);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(rec()));
  assert.deepStrictEqual(readRecord(path.join(dir, 'ok.json')), rec());
});
