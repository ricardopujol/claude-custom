'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { readDocsDir, MAX_FILE_BYTES } = require('../host/drift-docs-fs');

const tmp = () => tmpDir('drift-docs-');

test('reads top-level .md files, the build log apart; ignores other files and sub-folders', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'CLAUDECUSTOM_BUILD_LOG.md'), '## Now\n\nx');
  fs.writeFileSync(path.join(dir, 'DESIGN_A.md'), 'design');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'no');
  fs.mkdirSync(path.join(dir, 'handoffs'));
  fs.writeFileSync(path.join(dir, 'handoffs', 'CURRENT-x.md'), 'no');
  const out = await readDocsDir(dir);
  assert.strictEqual(out.buildLog, '## Now\n\nx');
  assert.deepStrictEqual(out.docs, [{ rel: 'DESIGN_A.md', text: 'design' }]);
});

test('a missing folder is empty, not an error; an oversize file is skipped', async () => {
  assert.deepStrictEqual(await readDocsDir(path.join(tmp(), 'nope')), { buildLog: null, buildLogName: null, docs: [] });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DESIGN_BIG.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'DESIGN_OK.md'), 'ok');
  assert.deepStrictEqual((await readDocsDir(dir)).docs.map(d => d.rel), ['DESIGN_OK.md']);
});

test('it changes nothing in the folder it reads', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DESIGN_A.md'), 'design');
  const before = fs.statSync(path.join(dir, 'DESIGN_A.md')).mtimeMs;
  await readDocsDir(dir);
  assert.deepStrictEqual(fs.readdirSync(dir), ['DESIGN_A.md']);
  assert.strictEqual(fs.statSync(path.join(dir, 'DESIGN_A.md')).mtimeMs, before);
});

test('any <NAME>_BUILD_LOG.md is the build log, whatever the project calls it, and its name is reported (PR #153 Dexter 8)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'FACEBOOKDEALS_BUILD_LOG.md'), '## Now\n\nfb');
  fs.writeFileSync(path.join(dir, 'DESIGN_A.md'), 'design');
  const out = await readDocsDir(dir);
  assert.strictEqual(out.buildLog, '## Now\n\nfb');
  assert.strictEqual(out.buildLogName, 'FACEBOOKDEALS_BUILD_LOG.md');
  assert.deepStrictEqual(out.docs.map(d => d.rel), ['DESIGN_A.md']);
});

test('with two build logs the newer one wins; with none the name is null', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'OLD_BUILD_LOG.md'), 'old');
  fs.writeFileSync(path.join(dir, 'NEW_BUILD_LOG.md'), 'new');
  fs.utimesSync(path.join(dir, 'OLD_BUILD_LOG.md'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.strictEqual((await readDocsDir(dir)).buildLogName, 'NEW_BUILD_LOG.md');
  assert.strictEqual((await readDocsDir(tmp())).buildLogName, null);
});
