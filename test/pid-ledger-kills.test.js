'use strict';
/**
 * Kill tests for the release-gate survivor S10 in host/pid-ledger.js (Mortimer, 2026-10-09): the ledger must not be corrupted by a
 * compaction, one bad line must not empty it, and the caller's lock deadline must be honoured.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const ledger = require('../host/pid-ledger');

const withDir = (fn) => { const dir = tmpDir('cc-ledger-kills-'); try { return fn(path.join(dir, 'l.jsonl'), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
const mk = (pid, start, extra = {}) => ({ pid, start, launcher: null, ...extra });
const holdLock = (file) => fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
const timed = (fn) => { const t = Date.now(); let out; try { out = fn(); } catch (e) { out = e; } return { out, ms: Date.now() - t }; };

test('S10: compact, then append, then read gives every entry back (the file keeps its newlines)', () => withDir((file) => {
  ledger.appendEntry(file, mk(1, '10', { createdAt: 1 }));
  ledger.appendEntry(file, mk(2, '20', { createdAt: 2 }));
  assert.deepStrictEqual(ledger.compact(file), { ok: true });
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text, [ledger.serializeEntry(mk(1, '10', { createdAt: 1 })), ledger.serializeEntry(mk(2, '20', { createdAt: 2 }))].join('\n') + '\n');
  ledger.appendEntry(file, mk(3, '30', { createdAt: 3 }));
  assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [1, 2, 3]);
}));

test('S10: compacting a ledger whose every entry was removed leaves an empty file, and an append after it still reads back', () => withDir((file) => {
  ledger.appendEntry(file, mk(1, '10'));
  ledger.removeEntries(file, [mk(1, '10')]);
  assert.deepStrictEqual(ledger.compact(file), { ok: true });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
  ledger.appendEntry(file, mk(2, '20'));
  assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [2]);
}));

test('S10: compact of a missing file is ok and creates nothing; of a directory it reports EISDIR', () => withDir((file, dir) => {
  assert.deepStrictEqual(ledger.compact(file), { ok: true });
  assert.strictEqual(fs.existsSync(file), false);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => !n.endsWith('.lock')), [], 'no temp file either');
  const asDir = path.join(dir, 'a-dir');
  fs.mkdirSync(asDir);
  const r = ledger.compact(asDir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'EISDIR');
}));

test('S10: one junk line (null, a number, a string, an array) is skipped, it does not empty the ledger', () => {
  const good = ledger.serializeEntry(mk(7, '70'));
  const parsed = ledger.parseLedger(`null\n5\n"x"\ntrue\n[]\n${good}\n`);
  assert.deepStrictEqual(parsed.map(e => e.pid), [7]);
  assert.deepStrictEqual(ledger.parseLedger(`null\n${good}`).map(e => e.pid), [7]);
});

test('S10: a start must be ALL digits, for an entry and for its launcher', () => {
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: 'x1' })), []);
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1x' })), []);
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: "1'x" })), []);
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1\n' })), []);
  assert.strictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1', launcher: { pid: 2, start: 'x1' } }))[0].launcher, null);
  assert.strictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1', launcher: { pid: 2, start: '1x' } }))[0].launcher, null);
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1', launcher: { pid: 2, start: null } }))[0].launcher, { pid: 2, start: null });
  assert.deepStrictEqual(ledger.parseLedger(JSON.stringify({ pid: 5, start: '1', launcher: { pid: 2, start: '7' } }))[0].launcher, { pid: 2, start: '7' });
});

test('S10: a rename refused EPERM twice then allowed is ok with retries 2; EACCES once then allowed is ok; another error is not retried', () => withDir((file, dir) => {
  ledger.appendEntry(file, mk(1, '10'));
  const flaky = (code, times) => { let n = 0; return { fn: (a, b) => { if (++n <= times) { const e = new Error(code); e.code = code; throw e; } fs.renameSync(a, b); }, tries: () => n }; };
  const twice = flaky('EPERM', 2);
  assert.deepStrictEqual(ledger.compact(file, { renameFn: twice.fn, retries: 2, retryMs: 1 }), { ok: true });
  assert.strictEqual(twice.tries(), 3);
  const acc = flaky('EACCES', 1);
  assert.deepStrictEqual(ledger.compact(file, { renameFn: acc.fn, retries: 2, retryMs: 1 }), { ok: true });
  assert.strictEqual(acc.tries(), 2);
  const busy = flaky('EBUSY', 1);
  assert.deepStrictEqual(ledger.compact(file, { renameFn: busy.fn, retries: 1, retryMs: 1 }), { ok: true });
  const hard = flaky('EXDEV', 99);
  const r = ledger.compact(file, { renameFn: hard.fn, retries: 5, retryMs: 1 });
  assert.deepStrictEqual([r.ok, r.error, hard.tries()], [false, 'EXDEV', 1], 'a non-lock error is final and named');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
  const forever = flaky('EPERM', 99);
  const g = ledger.compact(file, { renameFn: forever.fn, retries: 2, retryMs: 1 });
  assert.deepStrictEqual([g.ok, g.error, forever.tries()], [false, 'EPERM', 3], 'retries + 1 attempts, then reported');
  const nameless = ledger.compact(file, { renameFn: () => { throw new Error('plain'); }, retries: 1, retryMs: 1 });
  assert.deepStrictEqual([nameless.ok, nameless.error], [false, 'plain'], 'an error without a code reports its message');
}));

test('S10: removeEntries writes only valid tombstones, and nothing at all when none is valid', () => withDir((file) => {
  assert.deepStrictEqual(ledger.removeEntries(file, []), { ok: true });
  assert.deepStrictEqual(ledger.removeEntries(file, [null, undefined, { pid: 0, start: '1' }, { pid: 3, start: 'x' }, { pid: 3 }]), { ok: true });
  assert.strictEqual(fs.existsSync(file), false, 'nothing valid: no file written');
  assert.deepStrictEqual(ledger.removeEntries(file, [null, { pid: 0, start: '1' }, { pid: 4, start: '40' }, { pid: 5, start: '50' }]), { ok: true });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"pid":4,"start":"40","removed":true}\n{"pid":5,"start":"50","removed":true}\n');
}));

test('S10: the caller\'s lock deadline is honoured by append, remove and compact (well under the 3 s default)', () => withDir((file) => {
  holdLock(file);
  const a = timed(() => ledger.appendEntry(file, mk(3, '30'), { deadlineMs: 20 }));
  assert.ok(a.out instanceof Error, 'append throws');
  assert.ok(a.ms < 1500, `append gave up in ${a.ms} ms`);
  const r = timed(() => ledger.removeEntries(file, [mk(3, '30')], { deadlineMs: 20 }));
  assert.strictEqual(r.out.ok, false);
  assert.ok(r.ms < 1500, `remove gave up in ${r.ms} ms`);
  fs.writeFileSync(file, ledger.serializeEntry(mk(1, '10')) + '\n');
  const c = timed(() => ledger.compact(file, { deadlineMs: 20 }));
  assert.strictEqual(c.out.ok, false);
  assert.ok(c.ms < 1500, `compact gave up in ${c.ms} ms`);
  assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [1], 'nothing was written');
}));
