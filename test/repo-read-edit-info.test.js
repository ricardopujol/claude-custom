'use strict';
/**
 * #50: what the read tells the reader about editing a file. Saving writes UTF-8 with the file's own line endings
 * and BOM, so a file that can't be written back byte-faithfully (UTF-16, Latin-1, mixed line endings) is shown
 * but never offered for edit, and every read carries the hash the save compares against.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { readRepoFile } = require('../host/repo-read');

const dir = tmpDir('cc-read-edit-');
const put = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('every read carries the sha256 of the file\'s bytes', async () => {
  const bytes = Buffer.from('const a = 1;\n');
  const r = await readRepoFile(put('a.js', bytes));
  assert.strictEqual(r.hash, sha(bytes));
});

test('the hash covers the BOM and the raw CRLF bytes, not the decoded text', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]);
  const r = await readRepoFile(put('bom-crlf.txt', bytes));
  assert.strictEqual(r.hash, sha(bytes));
});

test('a plain LF file is editable, eol lf, no BOM', async () => {
  const r = await readRepoFile(put('lf.txt', 'a\nb\n'));
  assert.deepStrictEqual({ eol: r.eol, bom: r.bom, editable: r.editable, text: r.text }, { eol: 'lf', bom: false, editable: true, text: 'a\nb\n' });
});

test('a file with no line break at all is editable as lf', async () => {
  const r = await readRepoFile(put('one.txt', 'single line'));
  assert.deepStrictEqual({ eol: r.eol, editable: r.editable }, { eol: 'lf', editable: true });
});

test('an empty file is editable', async () => {
  const r = await readRepoFile(put('empty.txt', ''));
  assert.deepStrictEqual({ eol: r.eol, editable: r.editable, text: r.text }, { eol: 'lf', editable: true, text: '' });
});

test('a CRLF file is editable, eol crlf, and its text comes back with plain \\n so the editor and the saved text agree', async () => {
  const r = await readRepoFile(put('crlf.txt', 'a\r\nb\r\nc'));
  assert.deepStrictEqual({ eol: r.eol, editable: r.editable, text: r.text }, { eol: 'crlf', editable: true, text: 'a\nb\nc' });
});

test('a UTF-8 BOM is remembered so the save puts it back', async () => {
  const r = await readRepoFile(put('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\n')])));
  assert.deepStrictEqual({ bom: r.bom, editable: r.editable, text: r.text }, { bom: true, editable: true, text: 'hi\n' });
});

test('mixed line endings are shown but not editable, and say why', async () => {
  const r = await readRepoFile(put('mixed.txt', 'a\r\nb\nc\n'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.eol, 'mixed');
  assert.strictEqual(r.editable, false);
  assert.match(r.editableWhy, /line endings/);
  assert.strictEqual(r.text, 'a\r\nb\nc\n', 'the text is untouched');
});

test('a lone CR (old Mac) counts as mixed with LF, and as non-editable on its own', async () => {
  const lone = await readRepoFile(put('cr.txt', 'a\rb\r'));
  assert.deepStrictEqual({ eol: lone.eol, editable: lone.editable }, { eol: 'mixed', editable: false });
  const withLf = await readRepoFile(put('cr-lf.txt', 'a\rb\n'));
  assert.deepStrictEqual({ eol: withLf.eol, editable: withLf.editable }, { eol: 'mixed', editable: false });
});

test('UTF-16 with a BOM is shown but not editable', async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
  const r = await readRepoFile(put('u16.txt', bytes));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'hi\n');
  assert.strictEqual(r.editable, false);
  assert.match(r.editableWhy, /UTF-16/);
  assert.strictEqual(r.hash, sha(bytes));
});

test('bytes that are not valid UTF-8 (Latin-1) are shown but not editable: a save would rewrite them', async () => {
  const r = await readRepoFile(put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.editable, false);
  assert.match(r.editableWhy, /UTF-8/);
});

test('a real U+FFFD in a valid UTF-8 file does not count as invalid', async () => {
  const r = await readRepoFile(put('fffd.txt', 'a�b\n'));
  assert.strictEqual(r.editable, true);
});
