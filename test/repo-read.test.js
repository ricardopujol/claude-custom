'use strict';
/**
 * The reader's file read (#32): size cap, binary check, and the stat the Reload bar compares.
 * Over 2 MB, or NUL in the first 8 KB, opens nothing: the page offers Show in Explorer instead.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { readRepoFile, statRepoFile, MAX_BYTES, SNIFF_BYTES } = require('../host/repo-read');

const dir = tmpDir('cc-read-');
const put = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };

test('the limits are the design\'s: 2 MB and the first 8 KB', () => {
  assert.strictEqual(MAX_BYTES, 2 * 1024 * 1024);
  assert.strictEqual(SNIFF_BYTES, 8 * 1024);
});

test('a text file is read whole, with its size and mtime', async () => {
  const p = put('a.js', 'const a = 1;\nconst b = "caf\u00e9";\n');
  const r = await readRepoFile(p);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'const a = 1;\nconst b = "caf\u00e9";\n');
  assert.strictEqual(r.size, Buffer.byteLength(r.text));
  assert.strictEqual(r.mtimeMs, fs.statSync(p).mtimeMs);
});

test('an empty file is ok and empty, not "binary" and not an error', async () => {
  const r = await readRepoFile(put('empty.txt', ''));
  assert.deepStrictEqual({ ok: r.ok, text: r.text, size: r.size }, { ok: true, text: '', size: 0 });
});

test('a UTF-8 BOM is not shown as a character', async () => {
  const r = await readRepoFile(put('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])));
  assert.strictEqual(r.text, 'hi');
});

test('exactly 2 MB opens; one byte more is "too large" and nothing is read into text', async () => {
  const exact = await readRepoFile(put('exact.txt', Buffer.alloc(MAX_BYTES, 0x61)));
  assert.strictEqual(exact.ok, true);
  assert.strictEqual(exact.text.length, MAX_BYTES);
  const over = await readRepoFile(put('over.txt', Buffer.alloc(MAX_BYTES + 1, 0x61)));
  assert.deepStrictEqual(over, { ok: false, why: 'too-large', size: MAX_BYTES + 1, limit: MAX_BYTES });
});

test('a NUL byte inside the first 8 KB means binary; the very first byte and the very last sniffed byte both count', async () => {
  const first = Buffer.from('abc'); first[0] = 0;
  assert.strictEqual((await readRepoFile(put('b1.bin', first))).why, 'binary');
  const edge = Buffer.alloc(SNIFF_BYTES + 10, 0x61); edge[SNIFF_BYTES - 1] = 0;
  const r = await readRepoFile(put('b2.bin', edge));
  assert.deepStrictEqual({ ok: r.ok, why: r.why, size: r.size }, { ok: false, why: 'binary', size: SNIFF_BYTES + 10 });
});

test('a NUL byte AFTER the first 8 KB is not looked for: the design says the first 8 KB', async () => {
  const late = Buffer.alloc(SNIFF_BYTES + 10, 0x61); late[SNIFF_BYTES] = 0;
  assert.strictEqual((await readRepoFile(put('late.txt', late))).ok, true);
});

test('invalid UTF-8 does not throw: it shows replacement characters', async () => {
  const r = await readRepoFile(put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])));
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.startsWith('caf'));
});

test('a folder is "not a file", a missing path is "gone"', async () => {
  assert.strictEqual((await readRepoFile(dir)).why, 'not-a-file');
  assert.strictEqual((await readRepoFile(path.join(dir, 'nope.txt'))).why, 'gone');
});

test('any other failure is "unreadable" and carries the reason', async () => {
  const fsApi = { open: async () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; } };
  const r = await readRepoFile('C:\\x\\a.txt', { fsApi });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'unreadable');
  assert.match(r.error, /EBUSY/);
});

test('the file handle is closed, on success and on every refusal', async () => {
  const closed = [];
  const mk = (stat, bytes) => ({ open: async () => ({
    stat: async () => stat,
    read: async (buf, off, len, pos) => { const n = Math.max(0, Math.min(len, bytes.length - pos)); bytes.copy(buf, off, pos, pos + n); return { bytesRead: n }; },
    close: async () => { closed.push(1); },
  }) });
  const file = (size) => ({ isFile: () => true, size, mtimeMs: 5 });
  await readRepoFile('x', { fsApi: mk(file(3), Buffer.from('abc')) });
  await readRepoFile('x', { fsApi: mk(file(MAX_BYTES + 1), Buffer.alloc(1)) });
  await readRepoFile('x', { fsApi: mk(file(3), Buffer.from([0, 1, 2])) });
  await readRepoFile('x', { fsApi: mk({ isFile: () => false, size: 0, mtimeMs: 5 }, Buffer.alloc(0)) });
  assert.strictEqual(closed.length, 4);
});

test('a file that grew past the cap between the stat and the read is "too large", not truncated text', async () => {
  const fsApi = { open: async () => ({
    stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 }),
    read: async (buf, off, len) => { buf.fill(0x61, off, off + len); return { bytesRead: len }; },
    close: async () => {},
  }) };
  const r = await readRepoFile('x', { fsApi, maxBytes: 100 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'too-large');
});

// ---- stat, for the Reload bar ----

test('statRepoFile answers size and mtime, or why not', async () => {
  const p = put('s.txt', 'abcd');
  const s = await statRepoFile(p);
  assert.deepStrictEqual(s, { ok: true, size: 4, mtimeMs: fs.statSync(p).mtimeMs });
  assert.strictEqual((await statRepoFile(path.join(dir, 'gone.txt'))).why, 'gone');
  assert.strictEqual((await statRepoFile(dir)).why, 'not-a-file');
});
