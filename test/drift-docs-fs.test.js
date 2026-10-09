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
  assert.deepStrictEqual(await readDocsDir(path.join(tmp(), 'nope')), { buildLog: null, docs: [] });
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
