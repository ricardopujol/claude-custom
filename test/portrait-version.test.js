'use strict';
/**
 * Dexter F2 (PR #64): copyFile keeps the SOURCE's mtime, so two different
 * pictures with equal mtimes (zip-extracted, 2 s DOS resolution) shared one
 * ?v= URL and the cached one was served while the read-back said ok. The
 * uploader now stamps the destination with a time it controls.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { applyPortraitUpload, handleGlobalPortraitMessage } = require('../host/portrait-upload');
const { portraitFor, globalPortrait } = require('../host/portraits');
const { mediaElementFor } = require('../app/portrait-media-display');

const ZIP_TIME = new Date('2001-01-01T00:00:00Z');

function twoPictures() {
  const dir = tmpDir('cc-ver-');
  const a = path.join(dir, 'A.png');
  const b = path.join(dir, 'B.png');
  fs.writeFileSync(a, 'picture A');
  fs.writeFileSync(b, 'picture B, different bytes');
  fs.utimesSync(a, ZIP_TIME, ZIP_TIME);
  fs.utimesSync(b, ZIP_TIME, ZIP_TIME);
  return { dir, a, b };
}

test('the destination gets a fresh mtime, not the source\'s', () => {
  const { dir, a } = twoPictures();
  const dest = path.join(dir, 'up', 'coder', 'happy.png');
  const before = Date.now();
  applyPortraitUpload({ source: a, dest });
  const m = fs.statSync(dest).mtimeMs;
  assert.ok(m >= before - 5, `dest mtime ${m} should be about now (${before})`);
  assert.notStrictEqual(m, fs.statSync(a).mtimeMs);
});

test('two different pictures with EQUAL source mtimes never share a URL', () => {
  const { dir, a, b } = twoPictures();
  const uploadsDir = path.join(dir, 'up');
  const dest = path.join(uploadsDir, 'coder', 'happy.png');
  applyPortraitUpload({ source: a, dest });
  const first = mediaElementFor(portraitFor('coder', 'happy', { uploadsDir }), { imagesEnabled: true }).attrs.src;
  applyPortraitUpload({ source: b, dest });
  const second = mediaElementFor(portraitFor('coder', 'happy', { uploadsDir }), { imagesEnabled: true }).attrs.src;
  assert.notStrictEqual(second, first);
});

test('uploading twice in the same millisecond still moves the version forward', () => {
  const { dir, a, b } = twoPictures();
  const dest = path.join(dir, 'up', 'x', 'w.png');
  const base = Date.now(); const frozen = () => base;
  applyPortraitUpload({ source: a, dest }, { now: frozen });
  const m1 = fs.statSync(dest).mtimeMs;
  applyPortraitUpload({ source: b, dest }, { now: frozen });
  assert.ok(fs.statSync(dest).mtimeMs > m1);
});

test('a clock that runs BEHIND the file being replaced still moves the version forward', () => {
  const { dir, a, b } = twoPictures();
  const dest = path.join(dir, 'up', 'x', 'w.png');
  applyPortraitUpload({ source: a, dest }, { now: () => Date.now() + 60_000 });
  const m1 = fs.statSync(dest).mtimeMs;
  applyPortraitUpload({ source: b, dest }, { now: () => 1_000 });
  assert.ok(fs.statSync(dest).mtimeMs > m1);
});

test('the stamp is applied to the destination after the rename, and a failing stamp does not fail the copy', () => {
  const calls = [];
  const out = applyPortraitUpload({ source: 's.png', dest: path.join('d', 'w.png') }, {
    copyFile: () => calls.push('copy'),
    mkdirSync: () => {},
    rename: () => calls.push('rename'),
    unlinkSync: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
    statSync: () => { throw new Error('none yet'); },
    utimesSync: () => { calls.push('utimes'); throw new Error('EPERM'); },
    now: () => 10_000,
  });
  assert.deepStrictEqual(calls, ['copy', 'rename', 'utimes', 'utimes', 'utimes']);
  assert.deepStrictEqual(out.leftovers, []);
});

test('the global picture is versioned the same way', () => {
  const { dir, a, b } = twoPictures();
  const uploadsDir = path.join(dir, 'up');
  const deps = { uploadsDir, stat: (p) => fs.statSync(p), resolve: () => (globalPortrait(uploadsDir) || {}).path || null };
  handleGlobalPortraitMessage({ action: 'set-global', path: a }, deps);
  const v1 = globalPortrait(uploadsDir);
  handleGlobalPortraitMessage({ action: 'set-global', path: b }, deps);
  const p1 = mediaElementFor(portraitFor('any', 'working', { uploadsDir }), { imagesEnabled: true }).attrs.src;
  assert.match(p1, /\?v=\d+$/);
  assert.ok(fs.statSync(globalPortrait(uploadsDir).path).mtimeMs > 0);
  assert.notStrictEqual(String(v1.mtimeMs), String(globalPortrait(uploadsDir).mtimeMs));
});
