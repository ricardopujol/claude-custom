'use strict';
/**
 * Miguel S1 / S7 (PR #64): the upload handlers refuse symbolic links instead
 * of following them, and the face pencil is not offered while images are off.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { handlePortraitMessage, handleGlobalPortraitMessage } = require('../host/portrait-upload');

const link = { isSymbolicLink: () => true, isFile: () => false, size: 10 };
const plain = { isSymbolicLink: () => false, isFile: () => true, size: 10 };

test('a per-agent drop of a symlink is refused with a reason that names it', () => {
  const out = handlePortraitMessage({ action: 'set', agent: 'a', state: 'working', path: 'C:\\x.png' }, {
    uploadsDir: 'C:\\up', stat: () => link, apply: () => { throw new Error('must not copy'); },
    resolve: () => null, liveState: () => 'working',
  });
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /symbolic link/);
});

test('a global pick of a symlink is refused with a reason that names it', () => {
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: 'C:\\x.png' }, {
    uploadsDir: 'C:\\up', stat: () => link, apply: () => { throw new Error('must not copy'); }, resolve: () => null,
  });
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /symbolic link/);
  assert.strictEqual(out.changed, false);
});

test('a plain file still goes through', () => {
  let copied = false;
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: 'C:\\x.png' }, {
    uploadsDir: 'C:\\up', stat: () => plain, apply: ({ dest }) => { copied = dest; return { leftovers: [] }; },
    resolve: () => copied,
  });
  assert.strictEqual(out.reply.ok, true);
});

test('a REAL symlink is refused end to end when lstat is used (skipped where symlinks are not permitted)', (t) => {
  const dir = tmpDir('cc-sym-');
  const target = path.join(dir, 'real.png');
  const sym = path.join(dir, 'link.png');
  fs.writeFileSync(target, 'x');
  try { fs.symlinkSync(target, sym); } catch { t.skip('this account cannot create symlinks'); return; }
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: sym }, {
    uploadsDir: path.join(dir, 'up'), stat: (p) => fs.lstatSync(p), resolve: () => null,
  });
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /symbolic link/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'up')), false);
});

test('the host stats uploads with lstat, in both handlers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  const sites = src.match(/stat: \(p\) => fs\.lstatSync\(p\)/g) || [];
  assert.strictEqual(sites.length, 2);
});

test('the face pencil is only drawn while images are known to be on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const i = src.indexOf('function faceEditHtml');
  assert.ok(i !== -1);
  assert.match(src.slice(i, src.indexOf('\n}', i)), /agentImagesEnabled === true/);
});
