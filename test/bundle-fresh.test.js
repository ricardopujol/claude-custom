'use strict';
/**
 * PR #95 Miguel M3: the committed CodeMirror bundle (app/codemirror-reader.js) must not silently drift from
 * what builds it. Its header carries a hash of its INPUTS: build/codemirror-entry.mjs, build/build-reader.mjs
 * and the lockfile's versions of the packages it bundles. This test recomputes the hash; a bumped dependency or
 * an edited entry with no `npm run build:reader` fails here, with that command in the message.
 * Line endings are normalised, so a Windows (CRLF) checkout and the repo's LF text hash alike.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { inputsHash, bundledVersions } = require('../build/inputs-hash');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the bundle\'s header hash is the hash of its current inputs (else: run npm run build:reader)', () => {
  const header = read('app', 'codemirror-reader.js').split('\n')[0];
  const m = header.match(/inputs sha256:([0-9a-f]{64})/);
  assert.ok(m, `no inputs hash in the bundle header: ${header.slice(0, 160)}`);
  const now = inputsHash({
    entry: read('build', 'codemirror-entry.mjs'), builder: read('build', 'build-reader.mjs'),
    lock: JSON.parse(read('package-lock.json')),
  });
  assert.strictEqual(m[1], now, 'app/codemirror-reader.js is stale: the entry, the build script or a bundled package changed. Run `npm run build:reader` and commit the result.');
});

test('the hash moves when the entry, the build script or a bundled package version moves', () => {
  const lock = { packages: { 'node_modules/@codemirror/state': { version: '6.7.6' }, 'node_modules/@lezer/common': { version: '1.0.0' }, 'node_modules/leftpad': { version: '1.0.0' } } };
  const base = { entry: 'a\nb\n', builder: 'c\n', lock };
  const h = inputsHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(inputsHash({ ...base, entry: 'a\nB\n' }), h);
  assert.notStrictEqual(inputsHash({ ...base, builder: 'd\n' }), h);
  const bumped = JSON.parse(JSON.stringify(lock));
  bumped.packages['node_modules/@lezer/common'].version = '1.0.1';
  assert.notStrictEqual(inputsHash({ ...base, lock: bumped }), h);
});

test('the hash ignores line endings and packages the bundle does not contain', () => {
  const lock = { packages: { 'node_modules/@codemirror/state': { version: '6.7.6' }, 'node_modules/leftpad': { version: '1.0.0' } } };
  const h = inputsHash({ entry: 'a\nb\n', builder: 'c\n', lock });
  assert.strictEqual(inputsHash({ entry: 'a\r\nb\r\n', builder: 'c\r\n', lock }), h);
  const other = JSON.parse(JSON.stringify(lock));
  other.packages['node_modules/leftpad'].version = '9.9.9';
  assert.strictEqual(inputsHash({ entry: 'a\nb\n', builder: 'c\n', lock: other }), h);
});

test('bundledVersions lists the bundled packages, sorted, and esbuild', () => {
  const v = bundledVersions({ packages: { 'node_modules/esbuild': { version: '0.28.2' }, 'node_modules/@lezer/b': { version: '1' }, 'node_modules/@codemirror/a': { version: '2' }, 'node_modules/x': { version: '3' }, '': { version: '0' } } });
  assert.deepStrictEqual(v, ['@codemirror/a@2', '@lezer/b@1', 'esbuild@0.28.2']);
});

test('a missing or malformed lockfile is a hash of nothing, not a crash', () => {
  assert.deepStrictEqual(bundledVersions(null), []);
  assert.deepStrictEqual(bundledVersions({}), []);
  assert.match(inputsHash({ entry: '', builder: '', lock: null }), /^[0-9a-f]{64}$/);
});

test('the bundle is marked generated, so a 600 KB one-line blob stays out of every diff', () => {
  const attrs = read('.gitattributes');
  assert.match(attrs, /^app\/codemirror-reader\.js\s+linguist-generated(=true)?\s+-diff\s*$/m);
});

// ---- the Markdown bundle (BACKLOG #119 A9): app/markdown-reader.js, from marked + DOMPurify + Mermaid ----

const { MARKDOWN_ROOTS } = require('../build/inputs-hash');

test('the Markdown bundle\'s header hash is the hash of its current inputs (else: run npm run build:markdown)', () => {
  const header = read('app', 'markdown-reader.js').split('\n')[0];
  const m = header.match(/inputs sha256:([0-9a-f]{64})/);
  assert.ok(m, `no inputs hash in the bundle header: ${header.slice(0, 160)}`);
  const now = inputsHash({
    entry: read('build', 'markdown-entry.mjs') + '\n--\n' + read('app', 'markdown-links.js') + '\n--\n' + read('app', 'external-link.js'),
    builder: read('build', 'build-markdown.mjs'), lock: JSON.parse(read('package-lock.json')), roots: MARKDOWN_ROOTS,
  });
  assert.strictEqual(m[1], now, 'app/markdown-reader.js is stale: its entry, the link rule, the build script or a bundled package changed. Run `npm run build:markdown` and commit the result.');
});

test('with roots, the hash covers the roots\' whole dependency closure and nothing else', () => {
  const lock = { packages: {
    '': { name: 'x' },
    'node_modules/top': { version: '1.0.0', dependencies: { mid: '^1' } },
    'node_modules/mid': { version: '2.0.0', dependencies: { leaf: '^1' }, optionalDependencies: { opt: '^1' } },
    'node_modules/mid/node_modules/leaf': { version: '3.1.0' },
    'node_modules/leaf': { version: '3.0.0' },
    'node_modules/opt': { version: '4.0.0' },
    'node_modules/unrelated': { version: '9.0.0' },
  } };
  assert.deepStrictEqual(bundledVersions(lock, ['top']), ['leaf@3.0.0', 'leaf@3.1.0', 'mid@2.0.0', 'opt@4.0.0', 'top@1.0.0']);
  const base = { entry: 'e', builder: 'b', lock, roots: ['top'] };
  const h = inputsHash(base);
  const bumpedLeaf = JSON.parse(JSON.stringify(lock));
  bumpedLeaf.packages['node_modules/mid/node_modules/leaf'].version = '3.1.1';
  assert.notStrictEqual(inputsHash({ ...base, lock: bumpedLeaf }), h, 'a transitive bump moves the hash');
  const bumpedOther = JSON.parse(JSON.stringify(lock));
  bumpedOther.packages['node_modules/unrelated'].version = '9.9.9';
  assert.strictEqual(inputsHash({ ...base, lock: bumpedOther }), h, 'an unrelated bump does not');
  assert.notStrictEqual(inputsHash({ ...base, roots: undefined }), h, 'no roots is the CodeMirror pattern, a different hash');
});

test('the Markdown roots are the three libraries, and the lockfile pins them', () => {
  assert.deepStrictEqual([...MARKDOWN_ROOTS].sort(), ['dompurify', 'marked', 'mermaid']);
  const pkg = JSON.parse(read('package.json'));
  for (const name of MARKDOWN_ROOTS) assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
});

test('the Markdown bundle is marked generated too', () => {
  assert.match(read('.gitattributes'), /^app\/markdown-reader\.js\s+linguist-generated(=true)?\s+-diff\s*$/m);
});
