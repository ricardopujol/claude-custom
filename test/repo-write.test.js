'use strict';
/**
 * #50: the reader's save. Atomic (a temp file beside the target, then a rename; the target is never opened for
 * writing), and never blind: the file on disk must still be the one the person started from (its sha256), or
 * nothing is written and the caller is told it is stale. All in temp dirs.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { writeRepoFile } = require('../host/repo-write');

const dir = tmpDir('cc-write-');
let n = 0;
const put = (data) => { const p = path.join(dir, `f${++n}.txt`); fs.writeFileSync(p, data); return p; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tempsIn = () => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

test('a save replaces the file with the new text and reports the new size, mtime and hash', async () => {
  const p = put('old\n');
  const r = await writeRepoFile(p, { text: 'new text\n', expectHash: sha(Buffer.from('old\n')) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'new text\n');
  assert.strictEqual(r.size, 9);
  assert.strictEqual(r.mtimeMs, fs.statSync(p).mtimeMs);
  assert.strictEqual(r.hash, sha(Buffer.from('new text\n')));
  assert.deepStrictEqual(tempsIn(), [], 'no temp file left behind');
});

test('the target is never opened for writing: the bytes go to a temp file beside it and a rename lands them', async () => {
  const p = put('old');
  const opened = [];
  const renamed = [];
  const api = {
    ...fsp,
    open: (f, flags, ...rest) => { opened.push([path.basename(String(f)), flags]); return fsp.open(f, flags, ...rest); },
    rename: (a, b) => { renamed.push([path.basename(a), path.basename(b)]); return fsp.rename(a, b); },
    writeFile: (f, ...rest) => { opened.push([path.basename(String(f)), 'writeFile']); return fsp.writeFile(f, ...rest); },
  };
  const r = await writeRepoFile(p, { text: 'x', expectHash: sha(Buffer.from('old')), fsApi: api });
  assert.strictEqual(r.ok, true);
  const target = path.basename(p);
  assert.ok(!opened.some(([f, flags]) => f === target && flags !== 'r'), `the target was opened for writing: ${JSON.stringify(opened)}`);
  assert.strictEqual(renamed.length, 1);
  assert.strictEqual(renamed[0][1], target);
  assert.notStrictEqual(renamed[0][0], target);
  assert.match(renamed[0][0], /\.tmp$/);
});

test('a write that fails midway leaves the original untouched and cleans its temp file up', async () => {
  const p = put('precious\n');
  const api = {
    ...fsp,
    open: async (f, flags, ...rest) => {
      const fh = await fsp.open(f, flags, ...rest);
      if (String(f).endsWith('.tmp')) {
        return new Proxy(fh, { get: (t, k) => (k === 'writeFile' || k === 'write'
          ? async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
          : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
      }
      return fh;
    },
  };
  const r = await writeRepoFile(p, { text: 'replacement\n', expectHash: sha(Buffer.from('precious\n')), fsApi: api });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'unwritable');
  assert.match(r.error, /disk full/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'precious\n');
  assert.deepStrictEqual(tempsIn(), []);
});

test('a rename that fails leaves the original untouched and removes the temp file', async () => {
  const p = put('keep me\n');
  const api = { ...fsp, rename: async () => { throw Object.assign(new Error('locked'), { code: 'ENOENT' }); } };
  const r = await writeRepoFile(p, { text: 'lost\n', expectHash: sha(Buffer.from('keep me\n')), fsApi: api });
  assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'unwritable' });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'keep me\n');
  assert.deepStrictEqual(tempsIn(), []);
});

test('STALE: the file changed on disk since the person read it, so nothing is written', async () => {
  const p = put('v1\n');
  const mine = sha(Buffer.from('v1\n'));
  fs.writeFileSync(p, 'v2 by Claude\n');
  const r = await writeRepoFile(p, { text: 'my edit\n', expectHash: mine });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'stale');
  assert.strictEqual(r.hash, sha(Buffer.from('v2 by Claude\n')));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'v2 by Claude\n', 'the disk version is untouched');
  assert.deepStrictEqual(tempsIn(), []);
});

test('STALE is decided by content, not mtime: a touch with identical bytes still saves', async () => {
  const p = put('same\n');
  const h = sha(Buffer.from('same\n'));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(p, later, later);
  const r = await writeRepoFile(p, { text: 'edited\n', expectHash: h });
  assert.strictEqual(r.ok, true);
});

test('STALE: a change that lands after the first check but before the rename is caught by the second check', async () => {
  const p = put('v1\n');
  const h = sha(Buffer.from('v1\n'));
  const api = {
    ...fsp,
    // Claude writes the file just after the temp file is written, before the rename
    open: async (f, flags, ...rest) => {
      const fh = await fsp.open(f, flags, ...rest);
      if (String(f).endsWith('.tmp')) {
        return new Proxy(fh, { get: (t, k) => (k === 'close'
          ? async () => { await t.close(); fs.writeFileSync(p, 'sneaky\n'); }
          : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
      }
      return fh;
    },
  };
  const r = await writeRepoFile(p, { text: 'mine\n', expectHash: h, fsApi: api });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'stale');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'sneaky\n');
  assert.deepStrictEqual(tempsIn(), []);
});

test('a deleted file is stale when a hash was expected', async () => {
  const p = put('x');
  const h = sha(Buffer.from('x'));
  fs.unlinkSync(p);
  const r = await writeRepoFile(p, { text: 'y', expectHash: h });
  assert.deepStrictEqual({ ok: r.ok, why: r.why, gone: r.gone }, { ok: false, why: 'stale', gone: true });
  assert.ok(!fs.existsSync(p), 'a save does not resurrect a deleted file by itself');
});

test('expectHash null means "the file must not exist": it creates it, and refuses if it is there', async () => {
  const p = path.join(dir, `new${++n}.txt`);
  const made = await writeRepoFile(p, { text: 'fresh\n', expectHash: null });
  assert.strictEqual(made.ok, true);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'fresh\n');
  const again = await writeRepoFile(p, { text: 'other\n', expectHash: null });
  assert.deepStrictEqual({ ok: again.ok, why: again.why }, { ok: false, why: 'stale' });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'fresh\n');
});

test('no expected hash at all is refused: a save is never blind', async () => {
  const p = put('x');
  for (const bad of [undefined, '', 5, {}]) {
    const r = await writeRepoFile(p, { text: 'y', expectHash: bad });
    assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'bad request' }, String(bad));
  }
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'x');
});

test('the text must be a string without a CR (the editor only holds \\n)', async () => {
  const p = put('x');
  const h = sha(Buffer.from('x'));
  for (const bad of [undefined, null, 5, 'a\r\nb', 'a\rb']) {
    const r = await writeRepoFile(p, { text: bad, expectHash: h });
    assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'bad request' }, JSON.stringify(bad));
  }
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'x');
});

test('crlf puts every \\n back as CR LF; lf leaves them; anything else is refused', async () => {
  const p = put('a\r\nb\r\n');
  const h = sha(Buffer.from('a\r\nb\r\n'));
  const r = await writeRepoFile(p, { text: 'a\nb\nc\n', eol: 'crlf', expectHash: h });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(p).toString('latin1'), 'a\r\nb\r\nc\r\n');
  const q = put('a\n');
  const bad = await writeRepoFile(q, { text: 'a', eol: 'cr', expectHash: sha(Buffer.from('a\n')) });
  assert.deepStrictEqual({ ok: bad.ok, why: bad.why }, { ok: false, why: 'bad request' });
  const lf = await writeRepoFile(q, { text: 'a\nb', eol: 'lf', expectHash: sha(Buffer.from('a\n')) });
  assert.strictEqual(lf.ok, true);
  assert.strictEqual(fs.readFileSync(q, 'utf8'), 'a\nb');
});

test('a BOM is written back when the file had one, and only then', async () => {
  const p = put(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]));
  const h = sha(fs.readFileSync(p));
  const r = await writeRepoFile(p, { text: 'ho', bom: true, expectHash: h });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...fs.readFileSync(p)], [0xef, 0xbb, 0xbf, 0x68, 0x6f]);
  const q = put('hi');
  await writeRepoFile(q, { text: 'ho', bom: false, expectHash: sha(Buffer.from('hi')) });
  assert.deepStrictEqual([...fs.readFileSync(q)], [0x68, 0x6f]);
});

test('non-ASCII text is written as UTF-8', async () => {
  const p = put('x');
  await writeRepoFile(p, { text: 'café \u{1F600}\n', expectHash: sha(Buffer.from('x')) });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'café \u{1F600}\n');
});

test('over the 2 MB the reader opens is refused, so a file the reader would not reopen is never produced', async () => {
  const p = put('x');
  const r = await writeRepoFile(p, { text: 'a'.repeat(11), expectHash: sha(Buffer.from('x')), maxBytes: 10 });
  assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'too-large' });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'x');
  const ok = await writeRepoFile(p, { text: 'a'.repeat(10), expectHash: sha(Buffer.from('x')), maxBytes: 10 });
  assert.strictEqual(ok.ok, true);
});

test('a folder in the way is "not-a-file", never written', async () => {
  const sub = path.join(dir, `sub${++n}`);
  fs.mkdirSync(sub);
  const r = await writeRepoFile(sub, { text: 'x', expectHash: null });
  assert.strictEqual(r.ok, false);
  assert.ok(['stale', 'not-a-file', 'unwritable'].includes(r.why), r.why);
  assert.ok(fs.statSync(sub).isDirectory());
});

test('a save keeps the file permission bits it had (where the platform has them)', { skip: process.platform === 'win32' }, async () => {
  const p = put('#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
  await writeRepoFile(p, { text: '#!/bin/sh\necho\n', expectHash: sha(Buffer.from('#!/bin/sh\n')) });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o755);
});

// PROPERTY: what the save writes is a valid input to the read that re-opens it, and says the same thing.
test('PROPERTY: a saved file re-opens as the same text, line endings and BOM, and is editable again', async () => {
  const fc = require('fast-check');
  const { readRepoFile } = require('../host/repo-read');
  const lineText = fc.string({ unit: 'binary-ascii', maxLength: 12 }).map(s => s.replace(/[\r\0]/g, ''));
  const text = fc.array(lineText, { maxLength: 6 }).chain(ls => fc.constantFrom('', '\n').map(end => ls.join('\n') + end));
  await fc.assert(fc.asyncProperty(text, fc.constantFrom('lf', 'crlf'), fc.boolean(), async (t, eol, bom) => {
    const p = put('seed');
    const r = await writeRepoFile(p, { text: t, eol, bom, expectHash: sha(Buffer.from('seed')) });
    assert.strictEqual(r.ok, true);
    const back = await readRepoFile(p);
    assert.strictEqual(back.ok, true);
    assert.strictEqual(back.text, t);
    assert.strictEqual(back.bom, bom);
    assert.strictEqual(back.editable, true);
    assert.strictEqual(back.hash, r.hash, 'the hash the save returns is the hash a fresh read computes');
    if (t.includes('\n')) assert.strictEqual(back.eol, eol);
  }), { numRuns: 60 });
});
