'use strict';
/** BACKLOG #88 (a project's terminal font) and #92 (plain colour background): the stored look and how the host edits it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { sanitizeLook, DEFAULT_LOOK } = require('../host/look');
const { setLook, readLook, resetBackground, writeLook, LOOK_DIR_NAME } = require('../host/style');
const { tmpDir } = require('./tmp-dir');

test('a look with neither field reads as no override and the image background', () => {
  assert.strictEqual(DEFAULT_LOOK.terminalFont, null);
  assert.strictEqual(DEFAULT_LOOK.backgroundMode, null);
  assert.strictEqual(sanitizeLook({}).terminalFont, null);
  assert.strictEqual(sanitizeLook({}).backgroundMode, null);
});

test('sanitizeLook keeps a safe terminalFont and drops anything that could break a CSS stack', () => {
  assert.strictEqual(sanitizeLook({ terminalFont: 'Fira Code' }).terminalFont, 'Fira Code');
  for (const bad of ['a"b', 'a;b', '', 5, {}, 'x'.repeat(101)]) assert.strictEqual(sanitizeLook({ terminalFont: bad }).terminalFont, null, JSON.stringify(bad));
});

test("sanitizeLook accepts backgroundMode 'colour' only", () => {
  assert.strictEqual(sanitizeLook({ backgroundMode: 'colour' }).backgroundMode, 'colour');
  for (const bad of ['image', 'Colour', '', null, 1, true, {}]) assert.strictEqual(sanitizeLook({ backgroundMode: bad }).backgroundMode, null, JSON.stringify(bad));
});

test('setLook sets and clears the terminal font and the background mode, leaving the rest alone', () => {
  const cwd = tmpDir('cc-look-fc-');
  assert.strictEqual(setLook({ cwd, patch: { appColor: '#202030' } }).ok, true);
  let r = setLook({ cwd, patch: { terminalFont: 'Fira Code', backgroundMode: 'colour' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readLook(cwd).terminalFont, 'Fira Code');
  assert.strictEqual(readLook(cwd).backgroundMode, 'colour');
  assert.strictEqual(readLook(cwd).appColor, '#202030');
  r = setLook({ cwd, patch: { terminalFont: null, backgroundMode: null } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readLook(cwd).terminalFont, null);
  assert.strictEqual(readLook(cwd).backgroundMode, null);
});

test('setLook refuses a malformed font or mode instead of wiping the stored one', () => {
  const cwd = tmpDir('cc-look-fc-');
  setLook({ cwd, patch: { terminalFont: 'Fira Code', backgroundMode: 'colour' } });
  for (const patch of [{ terminalFont: 'a;b' }, { terminalFont: 7 }, { backgroundMode: 'image' }, { backgroundMode: 3 }]) {
    const r = setLook({ cwd, patch });
    assert.strictEqual(r.ok, false, JSON.stringify(patch));
  }
  assert.strictEqual(readLook(cwd).terminalFont, 'Fira Code');
  assert.strictEqual(readLook(cwd).backgroundMode, 'colour');
});

test('switching to Plain colour keeps the background file on disk and the record of it; switching back restores it', () => {
  const cwd = tmpDir('cc-look-fc-');
  const dir = path.join(cwd, LOOK_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'background.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const setAt = new Date().toISOString();
  writeLook(cwd, { ...DEFAULT_LOOK, background: { file: 'background.png', setAt } });
  assert.strictEqual(setLook({ cwd, patch: { backgroundMode: 'colour' } }).ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'background.png')), 'the file stays');
  assert.strictEqual(readLook(cwd).background.file, 'background.png');
  assert.strictEqual(setLook({ cwd, patch: { backgroundMode: null } }).ok, true);
  assert.strictEqual(readLook(cwd).background.setAt, setAt);
});

test('choosing a new picture while on Plain colour switches back to the picture', async () => {
  const { setBackground } = require('../host/style');
  const cwd = tmpDir('cc-look-fc-');
  const src = tmpDir('cc-look-fc-src-');
  const png = path.join(src, 'chosen.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  setLook({ cwd, patch: { backgroundMode: 'colour' } });
  const r = await setBackground({ source: png, cwd });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(readLook(cwd).backgroundMode, null);
  assert.ok(readLook(cwd).background);
});

test('a Plain colour click made DURING the picture copy wins: the later action is not overwritten when the copy lands', async () => {
  const { setBackground } = require('../host/style');
  const cwd = tmpDir('cc-look-fc-');
  const src = tmpDir('cc-look-fc-src-');
  const png = path.join(src, 'chosen.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { ...fs, promises: { ...fs.promises, copyFile: async (a, b) => { await gate; return fs.promises.copyFile(a, b); } } };
  const pending = setBackground({ source: png, cwd, fsImpl: slow });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(setLook({ cwd, patch: { backgroundMode: 'colour' } }).ok, true);
  release();
  const r = await pending;
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(readLook(cwd).backgroundMode, 'colour', 'the click after the request stays');
  assert.ok(readLook(cwd).background, 'and the picture is in place for when the person goes back');
});

test('a reset of the picture does not change the background mode (on Plain colour the screen stays as it is)', () => {
  const cwd = tmpDir('cc-look-fc-');
  setLook({ cwd, patch: { backgroundMode: 'colour' } });
  resetBackground({ cwd });
  assert.strictEqual(readLook(cwd).backgroundMode, 'colour', 'a reset of the picture is not a change of mode');
});
