'use strict';
/**
 * host/canvas-store.js: where Claude's panel lives on disk (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md call 1).
 *
 *   <state>/canvas/<cli-session-id>/index.html   the page Claude wrote (at most 1 MB)
 *   <state>/canvas/<cli-session-id>/hosts.json   the hosts the person approved / denied for THIS panel
 *
 * Keyed by the CLI's session id, so `--resume` brings the panel back. The id comes from a hook payload, so it is
 * checked before it ever becomes a path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const fc = require('fast-check');
const { validSessionId, panelDir, readPage, readHosts, setHostDecision, MAX_HTML_BYTES, MAX_HOSTS } = require('../host/canvas-store');

const tmp = () => tmpDir('cc-canvas-store-');

test('a session id is a plain token: it can never walk out of the canvas folder', () => {
  for (const ok of ['0f6c8a1e-3b8e-4a5b-9f0e-1d2c3b4a5f6e', 'abc', 'a_b-c', 'A1']) assert.strictEqual(validSessionId(ok), true, ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a b', '-x', '_x', 'x'.repeat(129), null, undefined, 42, 'a\0b', 'C:x', 'x:y']) assert.strictEqual(validSessionId(bad), false, String(bad));
});

test('property: panelDir is always inside <root>/canvas, or null', () => {
  const root = path.resolve(os.tmpdir(), 'state-root');
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constantFrom('..', '../..', 'a/../..', '..\\x', 'ok-id')), (id) => {
    const dir = panelDir(root, id);
    if (dir === null) return;
    const rel = path.relative(path.join(root, 'canvas'), dir);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep), `${id} -> ${dir}`);
  }), { numRuns: 500 });
  assert.strictEqual(panelDir(root, '../x'), null);
  assert.strictEqual(panelDir(root, 'ok-id'), path.join(root, 'canvas', 'ok-id'));
});

test('readPage: a missing folder or file is empty, never an error', () => {
  const root = tmp();
  assert.deepStrictEqual(readPage(path.join(root, 'nope')), { status: 'empty', bytes: 0, signature: 'empty' });
  fs.mkdirSync(path.join(root, 'd'));
  assert.strictEqual(readPage(path.join(root, 'd')).status, 'empty');
});

test('readPage: a page is read as UTF-8 with a signature that changes when it does', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>héllo</p>');
  const a = readPage(dir);
  assert.strictEqual(a.status, 'ok');
  assert.strictEqual(a.html, '<p>héllo</p>');
  assert.strictEqual(a.bytes, Buffer.byteLength('<p>héllo</p>'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>héllo!</p>');
  assert.notStrictEqual(readPage(dir).signature, a.signature);
});

test('readPage: exactly 1 MB is fine, one byte more is "toobig" and its bytes are reported, not its content', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), 'x'.repeat(MAX_HTML_BYTES));
  assert.strictEqual(readPage(dir).status, 'ok');
  fs.writeFileSync(path.join(dir, 'index.html'), 'x'.repeat(MAX_HTML_BYTES + 1));
  const big = readPage(dir);
  assert.strictEqual(big.status, 'toobig');
  assert.strictEqual(big.bytes, MAX_HTML_BYTES + 1);
  assert.strictEqual(big.html, undefined);
});

test('readPage: an index.html that is a directory or unreadable is reported as unreadable, not thrown', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'index.html'));
  assert.strictEqual(readPage(dir).status, 'unreadable');
});

test('readHosts: missing, corrupt or the wrong shape is "no hosts yet"', () => {
  const dir = tmp();
  assert.deepStrictEqual(readHosts(dir), { approved: [], denied: [] });
  fs.writeFileSync(path.join(dir, 'hosts.json'), '{not json');
  assert.deepStrictEqual(readHosts(dir), { approved: [], denied: [] });
  fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify({ version: 1, approved: 'x', denied: { a: 1 } }));
  assert.deepStrictEqual(readHosts(dir), { approved: [], denied: [] });
});

test('readHosts: entries are normalised, de-duplicated, and anything that is not a plain origin is dropped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify({ version: 1,
    approved: ['https://A.example.com/x', 'https://a.example.com', 'javascript:alert(1)', '*', 42], denied: ['http://127.0.0.1:8080'] }));
  assert.deepStrictEqual(readHosts(dir), { approved: ['https://a.example.com'], denied: ['http://127.0.0.1:8080'] });
});

test('setHostDecision: allow, deny and remove move a host between the lists and persist', () => {
  const dir = tmp();
  let r = setHostDecision(dir, 'https://a.example.com/', 'allow');
  assert.deepStrictEqual(r, { approved: ['https://a.example.com'], denied: [] });
  r = setHostDecision(dir, 'https://b.example.com', 'deny');
  assert.deepStrictEqual(r, { approved: ['https://a.example.com'], denied: ['https://b.example.com'] });
  r = setHostDecision(dir, 'https://b.example.com', 'allow');
  assert.deepStrictEqual(r, { approved: ['https://a.example.com', 'https://b.example.com'], denied: [] }, 'allowing a denied host moves it');
  r = setHostDecision(dir, 'https://a.example.com', 'remove');
  assert.deepStrictEqual(r, { approved: ['https://b.example.com'], denied: [] });
  assert.deepStrictEqual(readHosts(dir), r);
});

test('setHostDecision: a bad origin or action changes nothing', () => {
  const dir = tmp();
  setHostDecision(dir, 'https://a.example.com', 'allow');
  for (const [o, a] of [['*', 'allow'], ['javascript:alert(1)', 'allow'], ['', 'allow'], [null, 'allow'], ['https://x.example.com', 'bogus'], ['https://x.example.com', undefined]]) {
    assert.strictEqual(setHostDecision(dir, o, a), null, `${o} ${a}`);
  }
  assert.deepStrictEqual(readHosts(dir), { approved: ['https://a.example.com'], denied: [] });
});

test('setHostDecision: each list is capped, so a page cannot fill the disk with questions', () => {
  const dir = tmp();
  for (let i = 0; i < MAX_HOSTS + 5; i++) setHostDecision(dir, `https://h${i}.example.com`, 'deny');
  const h = readHosts(dir);
  assert.strictEqual(h.denied.length, MAX_HOSTS);
  assert.ok(!h.denied.includes(`https://h${MAX_HOSTS}.example.com`), 'the newest past the cap are the ones refused');
  assert.strictEqual(setHostDecision(dir, 'https://over.example.com', 'deny'), null);
  assert.ok(setHostDecision(dir, 'https://h0.example.com', 'remove'), 'removing still works at the cap');
});

test('readPage: a file under the cap that DECODES to more than the cap is "toobig" (invalid UTF-8 grows to three bytes a character), so main never refuses an "ok" page (PR #122 Dexter F9)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), Buffer.alloc(600000, 0xe9));
  const r = readPage(dir);
  assert.strictEqual(r.status, 'toobig');
  assert.strictEqual(r.bytes, 1800000);
  assert.strictEqual(r.html, undefined);
});

test('property: whatever the bytes, an "ok" page decodes to no more than the cap', () => {
  const dir = tmp();
  fc.assert(fc.property(fc.uint8Array({ maxLength: 4000 }), fc.integer({ min: 0, max: 2 }), (bytes, mult) => {
    fs.writeFileSync(path.join(dir, 'index.html'), Buffer.concat(Array(1 + mult * 100).fill(Buffer.from(bytes))).subarray(0, MAX_HTML_BYTES + 5000));
    const r = readPage(dir);
    if (r.status === 'ok') assert.ok(Buffer.byteLength(r.html) <= MAX_HTML_BYTES);
  }), { numRuns: 60 });
});
