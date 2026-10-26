'use strict';
/**
 * The reader's file read at its edges (backlog #60, Mortimer's release-#101 part 2): the size gate and the
 * one-byte-past-the-cap stream, short reads, the BOM sniff for UTF-16 / UTF-32, and the error mapping. Driven
 * through a fake `fsApi`, so what the module asks the disk for is visible.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { readRepoFile, statRepoFile, MAX_BYTES } = require('../host/repo-read');

const CHUNK = 256 * 1024;

/**
 * A fake fs/promises: `content` is what the "file" holds, `size` what its stat claims, `perRead` the most one
 * read call returns (a short read). `log` records every read request as [length, position].
 */
function fakeFs(content, { size = content.length, perRead = Infinity, isFile = true, readError, statError, closeError } = {}) {
  const log = { reads: [], closed: 0, opened: [] };
  const fh = {
    stat: async () => { if (statError) throw statError; return { isFile: () => isFile, size, mtimeMs: 123 }; },
    read: async (buf, off, len, pos) => {
      log.reads.push([len, pos]);
      if (readError) throw readError;
      const n = Math.min(len, perRead, Math.max(0, content.length - pos));
      content.copy(buf, off, pos, pos + n);
      return { bytesRead: n };
    },
    close: async () => { log.closed += 1; if (closeError) throw closeError; },
  };
  return { api: { open: async (p) => { log.opened.push(p); return fh; } }, log };
}

const errWith = (code, message) => Object.assign(new Error(message), code ? { code } : {});

// ---- the size gate ----

// #50 added the edit fields (hash, bom, eol, editable); these tests pin the original ones.
const core = ({ ok, text, size, mtimeMs }) => ({ ok, text, size, mtimeMs });

test('a file bigger than the cap is refused from its stat alone, with its true size and the limit, without a read', async () => {
  const { api, log } = fakeFs(Buffer.alloc(40, 0x61), { size: 1000 });
  const r = await readRepoFile('f', { fsApi: api, maxBytes: 10 });
  assert.deepStrictEqual(r, { ok: false, why: 'too-large', size: 1000, limit: 10 });
  assert.deepStrictEqual(log.reads, []);
  assert.strictEqual(log.closed, 1);
});

test('a file of exactly the cap reads whole; the stream is never asked for more than cap + 1 bytes in all', async () => {
  const body = Buffer.from('abcdefghij');
  const { api, log } = fakeFs(body);
  const r = await readRepoFile('f', { fsApi: api, maxBytes: 10 });
  assert.deepStrictEqual(core(r), { ok: true, text: 'abcdefghij', size: 10, mtimeMs: 123 });
  const asked = log.reads.reduce((n, [len]) => n + len, 0);
  assert.ok(asked <= 10 + 1 + 1, `asked for ${asked} bytes`);
  assert.deepStrictEqual(log.reads[0], [11, 0]);
});

test('a file that grew after its stat is "too large" with the bytes seen, and is never returned truncated, even when reads are short', async () => {
  const body = Buffer.alloc(50, 0x61);
  for (const perRead of [Infinity, 10, 4, 1]) {
    const { api, log } = fakeFs(body, { size: 5, perRead });
    const r = await readRepoFile('f', { fsApi: api, maxBytes: 10 });
    assert.deepStrictEqual(r, { ok: false, why: 'too-large', size: 11, limit: 10 }, `perRead ${perRead}`);
    assert.ok(log.reads.every(([len, pos]) => pos + len <= 11), `no request reaches past cap + 1: ${JSON.stringify(log.reads)}`);
    assert.strictEqual(log.closed, 1);
  }
});

test('short reads ask for the REST of the cap + 1 at the right offset each time', async () => {
  const { api, log } = fakeFs(Buffer.alloc(11, 0x61), { size: 5, perRead: 10 });
  await readRepoFile('f', { fsApi: api, maxBytes: 10 });
  assert.deepStrictEqual(log.reads, [[11, 0], [1, 10]]);
});

test('short reads are stitched back together without the zero padding of an unfilled chunk', async () => {
  const text = 'the quick brown fox';
  const { api } = fakeFs(Buffer.from(text), { perRead: 4 });
  const r = await readRepoFile('f', { fsApi: api, maxBytes: 100 });
  assert.deepStrictEqual(core(r), { ok: true, text, size: text.length, mtimeMs: 123 });
});

test('the default cap is MAX_BYTES, and a big file is read in chunks of at most 256 KiB', async () => {
  const body = Buffer.alloc(CHUNK + 1000, 0x62);
  const { api, log } = fakeFs(body);
  const r = await readRepoFile('f', { fsApi: api });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.size, body.length);
  assert.ok(MAX_BYTES > body.length);
  assert.ok(log.reads.every(([len]) => len <= CHUNK), JSON.stringify(log.reads));
  assert.strictEqual(r.text, body.toString('utf8'));
  const { api: api2 } = fakeFs(Buffer.alloc(0), { size: MAX_BYTES + 1 });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: api2 }), { ok: false, why: 'too-large', size: MAX_BYTES + 1, limit: MAX_BYTES });
});

// ---- not a file, errors ----

test('a folder is "not-a-file" for a read and for a stat, with ok false, and the handle is closed', async () => {
  const { api, log } = fakeFs(Buffer.alloc(0), { isFile: false });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: api }), { ok: false, why: 'not-a-file' });
  assert.strictEqual(log.closed, 1);
  const st = await statRepoFile('f', { fsApi: { stat: async () => ({ isFile: () => false, size: 0, mtimeMs: 1 }) } });
  assert.deepStrictEqual(st, { ok: false, why: 'not-a-file' });
});

test('a failed open is "gone" for ENOENT and "unreadable" with the error text for anything else', async () => {
  const failing = (e) => ({ open: async () => { throw e; } });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: failing(errWith('ENOENT', 'no such file')) }), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: failing(errWith('EACCES', 'denied')) }), { ok: false, why: 'unreadable', error: 'denied' });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: failing(errWith('EPERM', '')) }), { ok: false, why: 'unreadable', error: 'Error' });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: failing('boom') }), { ok: false, why: 'unreadable', error: 'boom' });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: failing(undefined) }), { ok: false, why: 'unreadable', error: 'undefined' });
});

test('a failure after the open (stat or read) is reported the same way, and the handle is still closed', async () => {
  const a = fakeFs(Buffer.from('x'), { readError: errWith('EIO', 'disk error') });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: a.api }), { ok: false, why: 'unreadable', error: 'disk error' });
  assert.strictEqual(a.log.closed, 1);
  const b = fakeFs(Buffer.from('x'), { statError: errWith('ENOENT', 'vanished') });
  assert.deepStrictEqual(await readRepoFile('f', { fsApi: b.api }), { ok: false, why: 'gone' });
  assert.strictEqual(b.log.closed, 1);
});

test('a close that throws does not turn a good read into a failure', async () => {
  const { api } = fakeFs(Buffer.from('hi'), { closeError: new Error('already closed') });
  assert.deepStrictEqual(core(await readRepoFile('f', { fsApi: api })), { ok: true, text: 'hi', size: 2, mtimeMs: 123 });
});

test('statRepoFile answers size and mtime for a file, and maps its failures like a read does', async () => {
  const ok = await statRepoFile('f', { fsApi: { stat: async () => ({ isFile: () => true, size: 7, mtimeMs: 99 }) } });
  assert.deepStrictEqual(ok, { ok: true, size: 7, mtimeMs: 99 });
  assert.deepStrictEqual(await statRepoFile('f', { fsApi: { stat: async () => { throw errWith('ENOENT', 'x'); } } }), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await statRepoFile('f', { fsApi: { stat: async () => { throw errWith('EACCES', 'denied'); } } }), { ok: false, why: 'unreadable', error: 'denied' });
});

test('the default fs works on a real file and a real folder', async () => {
  const dir = tmpDir('cc-read-kills-');
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'real');
  const r = await readRepoFile(file);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'real');
  assert.strictEqual(r.size, 4);
  assert.deepStrictEqual(await readRepoFile(dir), { ok: false, why: 'not-a-file' });
  assert.deepStrictEqual(await statRepoFile(dir), { ok: false, why: 'not-a-file' });
  assert.strictEqual((await statRepoFile(file)).size, 4);
  assert.deepStrictEqual(await readRepoFile(path.join(dir, 'missing')), { ok: false, why: 'gone' });
});

// ---- decoding: BOMs ----

const read = async (bytes) => readRepoFile('f', { fsApi: fakeFs(Buffer.from(bytes)).api });
const le = (s) => Buffer.from(s, 'utf16le');
const be = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return b; };

test('a UTF-16LE file with a BOM is decoded as UTF-16, the BOM dropped', async () => {
  const r = await read(Buffer.concat([Buffer.from([0xff, 0xfe]), le('héllo\r\n')]));
  assert.deepStrictEqual(core(r), { ok: true, text: 'héllo\r\n', size: 2 + 14, mtimeMs: 123 });
});

test('a UTF-16BE file with a BOM is decoded as UTF-16', async () => {
  const r = await read(Buffer.concat([Buffer.from([0xfe, 0xff]), be('héllo')]));
  assert.strictEqual(r.text, 'héllo');
  assert.strictEqual(r.ok, true);
});

test('a BOM and nothing else is an empty text, not a garbled one', async () => {
  assert.strictEqual((await read([0xff, 0xfe])).text, '');
  assert.strictEqual((await read([0xfe, 0xff])).text, '');
});

test('a trailing odd byte after a UTF-16 body is dropped, for both byte orders', async () => {
  assert.strictEqual((await read(Buffer.concat([Buffer.from([0xff, 0xfe]), le('ab'), Buffer.from([0x41])]))).text, 'ab');
  const r = await read(Buffer.concat([Buffer.from([0xfe, 0xff]), be('ab'), Buffer.from([0x41])]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'ab');
  const odd3 = await read(Buffer.concat([Buffer.from([0xfe, 0xff]), be('abc'), Buffer.from([0x7a])]));
  assert.strictEqual(odd3.text, 'abc');
});

test('only a full BOM counts: one matching byte of the two is just text', async () => {
  for (const [bytes, text] of [
    [[0xff, 0x41, 0x42], '�AB'],
    [[0x41, 0xfe, 0x42], 'A�B'],
    [[0xfe, 0x41, 0x42], '�AB'],
    [[0x41, 0xff, 0x42], 'A�B'],
    [[0xff, 0xff, 0x41], '��A'],
    [[0xfe, 0xfe, 0x41], '��A'],
  ]) {
    const r = await read(bytes);
    assert.strictEqual(r.ok, true, JSON.stringify(bytes));
    assert.strictEqual(r.text, text, JSON.stringify(bytes));
  }
});

test('a one-byte file is read as text, whatever the byte', async () => {
  assert.deepStrictEqual(core(await read([0xff])), { ok: true, text: '�', size: 1, mtimeMs: 123 });
  assert.deepStrictEqual(core(await read([0x41])), { ok: true, text: 'A', size: 1, mtimeMs: 123 });
});

test('a UTF-32LE BOM (FF FE 00 00) is not decoded: its NULs make it binary, at exactly four bytes and beyond', async () => {
  assert.deepStrictEqual(await read([0xff, 0xfe, 0, 0]), { ok: false, why: 'binary', size: 4 });
  assert.deepStrictEqual(await read([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]), { ok: false, why: 'binary', size: 8 });
});

test('FF FE 00 with a non-zero fourth byte is still UTF-16LE (the character is 0x4100)', async () => {
  const r = await read([0xff, 0xfe, 0x00, 0x41]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '䄀');
  const r2 = await read([0xff, 0xfe, 0x41, 0x00]);
  assert.strictEqual(r2.text, 'A');
});

test('only an LE BOM can be a UTF-32 one: a BE BOM followed by two zero bytes is UTF-16BE', async () => {
  const r = await read([0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '\u0000A');
});

// ---- decoding: the rest ----

test('a NUL in the first 8 KiB makes a file binary, with its size; one past 8 KiB does not', async () => {
  const early = Buffer.alloc(100, 0x61); early[99] = 0;
  assert.deepStrictEqual(await read(early), { ok: false, why: 'binary', size: 100 });
  const sniffEdge = Buffer.alloc(8 * 1024, 0x61); sniffEdge[8 * 1024 - 1] = 0;
  assert.deepStrictEqual(await read(sniffEdge), { ok: false, why: 'binary', size: 8 * 1024 });
  const late = Buffer.alloc(8 * 1024 + 10, 0x61); late[8 * 1024] = 0;
  assert.strictEqual((await read(late)).ok, true);
});

test('a leading UTF-8 BOM is dropped; one in the middle stays; Latin-1 bytes become replacement characters', async () => {
  assert.strictEqual((await read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]))).text, 'hi');
  assert.strictEqual((await read(Buffer.concat([Buffer.from('a'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('b')]))).text, 'a\uFEFFb');
  assert.strictEqual((await read([0x63, 0x61, 0x66, 0xe9])).text, 'caf�');
});

test('an empty file reads as empty text', async () => {
  assert.deepStrictEqual(core(await read([])), { ok: true, text: '', size: 0, mtimeMs: 123 });
});
