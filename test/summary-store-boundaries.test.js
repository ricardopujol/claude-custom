'use strict';
/**
 * Boundary kill tests for host/summary-store.js, from Mortimer's gate on release PR #109 (survivor 9, "other survivors"):
 * the text and file size caps are inclusive, a summary read from disk is then held in memory, and the sweep keeps what is
 * exactly at its age limit, ranks equal ages by name, reports what it removed and treats temp files as temp files.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSummaryStore, TEXT_MAX, FILE_MAX } = require('../host/summary-store');

const REC = { text: 'Working on: x', model: 'llama3.2:3b', turnsSeen: 3, newestKey: 'k1' };
const rec = (extra = {}) => ({ ...REC, at: 5000, ...extra });
const body = (o = rec()) => JSON.stringify(o) + '\n';
const NOW = 1_700_000_000_000;                                    // whole seconds, so utimes is exact
const setAge = (file, ms) => { const s = (NOW - ms) / 1000; fs.utimesSync(file, s, s); };

test('a text of exactly TEXT_MAX chars is kept, one more is refused (put and disk)', () => {
  const dir = tmpDir('sumstore-bounds-');
  const s = createSummaryStore({ dir });
  assert.strictEqual(s.put('a', { ...REC, text: 'x'.repeat(TEXT_MAX) }, 1).ok, true);
  assert.strictEqual(s.put('b', { ...REC, text: 'x'.repeat(TEXT_MAX + 1) }, 1).ok, false);

  fs.writeFileSync(path.join(dir, 'c.json'), body(rec({ text: 'x'.repeat(TEXT_MAX) })));
  fs.writeFileSync(path.join(dir, 'd.json'), body(rec({ text: 'x'.repeat(TEXT_MAX + 1) })));
  const fresh = createSummaryStore({ dir });
  assert.strictEqual(fresh.get('c').text.length, TEXT_MAX);
  assert.strictEqual(fresh.get('d'), null);
});

test('a file of exactly FILE_MAX bytes is read, one byte more reads as nothing', () => {
  const dir = tmpDir('sumstore-bounds-');
  const pad = (n) => { const b = body(); return b + ' '.repeat(n - Buffer.byteLength(b)); };
  fs.writeFileSync(path.join(dir, 'fit.json'), pad(FILE_MAX));
  fs.writeFileSync(path.join(dir, 'big.json'), pad(FILE_MAX + 1));
  assert.strictEqual(fs.statSync(path.join(dir, 'fit.json')).size, FILE_MAX);
  const s = createSummaryStore({ dir });
  assert.strictEqual(s.get('fit').text, REC.text);
  assert.strictEqual(s.get('big'), null);
});

test('a summary read from disk is held in memory: it still answers after the file is deleted', () => {
  const dir = tmpDir('sumstore-bounds-');
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, body());
  const s = createSummaryStore({ dir });
  assert.strictEqual(s.get('a').text, REC.text);
  fs.unlinkSync(file);
  assert.deepStrictEqual(s.get('a'), { ...REC, at: 5000, stale: true });
  assert.strictEqual(createSummaryStore({ dir }).get('a'), null, 'while a fresh store really finds nothing');
});

test('sweep: a summary exactly maxAgeMs old is kept, one ms older goes, and the removal is reported', async () => {
  const dir = tmpDir('sumstore-bounds-');
  const at = path.join(dir, 'at.json');
  const over = path.join(dir, 'over.json');
  fs.writeFileSync(at, body());
  fs.writeFileSync(over, body());
  setAge(at, 10_000);
  const s = createSummaryStore({ dir });
  setAge(over, 11_000);
  const r = await s.sweep({ now: NOW, maxAgeMs: 10_000 });
  assert.deepStrictEqual(r.removed, ['over.json']);
  assert.strictEqual(fs.existsSync(at), true);
  assert.strictEqual(fs.existsSync(over), false);
  const r2 = await s.sweep({ now: NOW + 1, maxAgeMs: 10_000 });
  assert.deepStrictEqual(r2.removed, ['at.json'], 'a ms later the same file is past the limit');
});

test('sweep: a temp file exactly tmpMaxAgeMs old is kept, an older one goes, and neither counts as a summary', async () => {
  const dir = tmpDir('sumstore-bounds-');
  const t1 = path.join(dir, 'a.json.123.abcd.tmp');
  const t2 = path.join(dir, 'b.json.123.abcd.tmp');
  const sum = path.join(dir, 's.json');
  for (const f of [t1, t2, sum]) fs.writeFileSync(f, body());
  setAge(t1, 3_000);
  setAge(t2, 4_000);
  setAge(sum, 0);
  const s = createSummaryStore({ dir });
  // maxFiles 0 removes every summary in the ranking, so a temp file wrongly ranked as one would go with them.
  const r = await s.sweep({ now: NOW, maxAgeMs: 1e12, tmpMaxAgeMs: 3_000, maxFiles: 0 });
  assert.deepStrictEqual(r.removed.sort(), ['b.json.123.abcd.tmp', 's.json']);
  assert.strictEqual(fs.existsSync(t1), true, 'exactly at the temp limit: kept, and not ranked as a summary');
});

test('sweep: equal ages are ranked by name whatever order the directory lists them in, so the cap keeps the alphabetically first', async (t) => {
  const dir = tmpDir('sumstore-bounds-');
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) { fs.writeFileSync(path.join(dir, n + '.json'), body()); setAge(path.join(dir, n + '.json'), 1_000); }
  const s = createSummaryStore({ dir });
  const real = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', async (...a) => (await real(...a)).reverse());   // NTFS lists alphabetically; do not rely on it
  const r = await s.sweep({ now: NOW, maxAgeMs: 1e12, maxFiles: 1 });
  assert.deepStrictEqual(r.removed.sort(), ['b.json', 'c.json', 'd.json', 'e.json', 'f.json']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'a.json')), true);
});

test('sweep: the cap keeps the newest and reports each removal', async () => {
  const dir = tmpDir('sumstore-bounds-');
  ['old', 'mid', 'new'].forEach((n, i) => { const f = path.join(dir, n + '.json'); fs.writeFileSync(f, body()); setAge(f, 3_000 - i * 1_000); });
  const r = await createSummaryStore({ dir }).sweep({ now: NOW, maxAgeMs: 1e12, maxFiles: 2 });
  assert.deepStrictEqual(r.removed, ['old.json']);
});
