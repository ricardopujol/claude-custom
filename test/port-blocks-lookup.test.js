'use strict';
/**
 * host/port-blocks.js lookup (BACKLOG #119 A4): the block a worktree already has, read without taking the lock and without
 * ever allocating one. The Dev servers chip asks about every tab on a timer; asking must never hand out a block.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { allocate, lookup } = require('../host/port-blocks');
const { tmpDir } = require('./tmp-dir');

const portsFile = () => path.join(tmpDir('port-blocks-lookup-'), 'state', 'worktree-ports.json');

test('lookup returns the block allocate gave, and the same one every time', () => {
  const file = portsFile();
  const base = allocate('C:\\proj\\dev', { file, exists: () => true });
  assert.strictEqual(lookup('C:\\proj\\dev', { file }), base);
  assert.strictEqual(lookup('C:\\proj\\dev', { file }), base);
});

test('lookup follows the same path spelling allocate does (case, slashes)', () => {
  const file = portsFile();
  const base = allocate('C:\\Proj\\Dev', { file, exists: () => true });
  assert.strictEqual(lookup('c:/proj/dev', { file }), base);
});

test('lookup of a worktree with no block is null and writes nothing', () => {
  const file = portsFile();
  assert.strictEqual(lookup('C:\\proj\\none', { file }), null);
  assert.strictEqual(fs.existsSync(file), false, 'no file made');
  assert.strictEqual(fs.existsSync(path.dirname(file)), false, 'no folder made');
  allocate('C:\\proj\\dev', { file, exists: () => true });
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(lookup('C:\\proj\\none', { file }), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the file is untouched');
});

test('lookup of a damaged file, or of no path, is null and moves nothing aside', () => {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(lookup('C:\\proj\\dev', { file }), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{not json');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  for (const bad of [null, undefined, '', 42, {}]) assert.strictEqual(lookup(bad, { file }), null);
});
