'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const {
  planBackgroundChoice, setBackground, resetBackground, resolveStyle, setLook,
  readLook, writeLook, lookDir, ACCEPTED_EXTENSIONS, MAX_BYTES, LOOK_DIR_NAME,
} = require('../host/style');
const { DEFAULT_LOOK } = require('../host/look');
const { tmpDir } = require('./tmp-dir');

// A project folder with one source image beside it, both real and self-cleaning.
function project() {
  const cwd = tmpDir('cc-look-proj-');
  const src = tmpDir('cc-look-src-');
  const png = path.join(src, 'chosen.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return { cwd, src, png };
}
const lookFile = (cwd) => path.join(cwd, LOOK_DIR_NAME, 'look.json');

// --- planBackgroundChoice: PURE, no fs at all --------------------------------

test('planBackgroundChoice refuses when no source is given', () => {
  const r = planBackgroundChoice({ cwd: 'C:/proj' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no file/i);
});

test('planBackgroundChoice refuses when no project is open', () => {
  for (const cwd of [undefined, '', '   ']) {
    const r = planBackgroundChoice({ source: 'C:/x/pic.png', cwd });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /project/i);
  }
});

test('planBackgroundChoice refuses an unsupported extension, and says why', () => {
  const r = planBackgroundChoice({ source: 'C:/x/movie.mp4', cwd: 'C:/proj' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /mp4/);
});

test('planBackgroundChoice refuses a file with no extension at all', () => {
  const r = planBackgroundChoice({ source: 'C:/x/README', cwd: 'C:/proj' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no extension/i);
});

test('every accepted extension is accepted, case-insensitively, as background.<ext>', () => {
  for (const ext of ACCEPTED_EXTENSIONS) {
    for (const cased of [ext, ext.toUpperCase()]) {
      const r = planBackgroundChoice({ source: `C:/x/pic.${cased}`, cwd: 'C:/proj', size: 100 });
      assert.strictEqual(r.ok, true, `${cased} should be accepted: ${r.reason}`);
      assert.strictEqual(r.dest, path.join(lookDir('C:/proj'), `background.${ext}`));
    }
  }
});

test('the size ceiling boundary is pinned, not a bare literal', () => {
  assert.strictEqual(MAX_BYTES, 25 * 1024 * 1024);
  assert.strictEqual(planBackgroundChoice({ source: 'C:/x/p.png', cwd: 'C:/proj', size: MAX_BYTES }).ok, true);
  const over = planBackgroundChoice({ source: 'C:/x/p.png', cwd: 'C:/proj', size: MAX_BYTES + 1 });
  assert.strictEqual(over.ok, false);
  assert.match(over.reason, /25MB/);
});

test('a missing size is not treated as oversized', () => {
  assert.strictEqual(planBackgroundChoice({ source: 'C:/x/pic.png', cwd: 'C:/proj' }).ok, true);
});

test('PROPERTY: the destination is always directly inside the project\'s look folder', () => {
  fc.assert(fc.property(
    fc.string({ minLength: 1 }).filter((s) => s.trim()),
    fc.constantFrom(...ACCEPTED_EXTENSIONS),
    // A non-empty base name: `.png` alone is a dotfile with NO extension to
    // Node, and is (correctly) refused by the extension check above.
    fc.string({ minLength: 1 }).filter((s) => !/[\\/]/.test(s)),
    (cwd, ext, name) => {
      const r = planBackgroundChoice({ source: `C:/drop/${name}.${ext}`, cwd, size: 1 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(path.dirname(r.dest), lookDir(cwd));
    }));
});

// --- readLook / writeLook ------------------------------------------------------

test('readLook of a project with no look folder is the default look', () => {
  assert.deepStrictEqual(readLook(tmpDir('cc-look-empty-')), DEFAULT_LOOK);
});

test('readLook of a corrupt look.json is the default look, never a throw', () => {
  const { cwd } = project();
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  for (const body of ['{not json', '[]', 'null', '"x"', '']) {
    fs.writeFileSync(lookFile(cwd), body);
    assert.deepStrictEqual(readLook(cwd), DEFAULT_LOOK, JSON.stringify(body));
  }
});

test('readLook drops a recorded background whose file is gone', () => {
  const { cwd } = project();
  writeLook(cwd, { appColor: '#112233', background: { file: 'background.png', setAt: null } });
  assert.strictEqual(readLook(cwd).background, null);
  assert.strictEqual(readLook(cwd).appColor, '#112233', 'the rest of the look survives');
});

test('writeLook creates the folder with a .gitignore that ignores everything, once', () => {
  const { cwd } = project();
  writeLook(cwd, { appColor: '#112233' });
  const ignore = path.join(cwd, LOOK_DIR_NAME, '.gitignore');
  assert.strictEqual(fs.readFileSync(ignore, 'utf8').trim().split(/\r?\n/).pop(), '*');
  // A person who edited it (say, to commit their look) keeps their edit.
  fs.writeFileSync(ignore, '# mine\n');
  writeLook(cwd, { appColor: '#445566' });
  assert.strictEqual(fs.readFileSync(ignore, 'utf8'), '# mine\n');
});

test('writeLook sanitizes before writing and leaves no temp file behind', () => {
  const { cwd } = project();
  const written = writeLook(cwd, { appColor: '#ABCDEF', textColor: 'blue', darkness: 7 });
  assert.strictEqual(written.appColor, '#abcdef');
  assert.strictEqual(written.textColor, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(lookFile(cwd), 'utf8')), written);
  const leftovers = fs.readdirSync(path.join(cwd, LOOK_DIR_NAME)).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

// --- setLook --------------------------------------------------------------------

test('setLook merges only the fields it is given; null resets a field', () => {
  const { cwd } = project();
  setLook({ cwd, patch: { appColor: '#102030', textColor: '#f0f0f0' } });
  setLook({ cwd, patch: { darkness: 0.2 } });
  let look = readLook(cwd);
  assert.strictEqual(look.appColor, '#102030');
  assert.strictEqual(look.textColor, '#f0f0f0');
  assert.strictEqual(look.darkness, 0.2);
  setLook({ cwd, patch: { textColor: null } });
  look = readLook(cwd);
  assert.strictEqual(look.textColor, null);
  assert.strictEqual(look.appColor, '#102030');
});

test('setLook cannot be used to point the background at an arbitrary file', () => {
  const { cwd } = project();
  const r = setLook({ cwd, patch: { background: { file: 'background.png' }, appColor: '#000000' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readLook(cwd).background, null, 'background is only ever set by setBackground');
});

test('setLook refuses a patch that is not an object, and writes nothing', () => {
  const { cwd } = project();
  for (const patch of [null, 'x', [], 3]) {
    assert.strictEqual(setLook({ cwd, patch }).ok, false);
  }
  assert.ok(!fs.existsSync(path.join(cwd, LOOK_DIR_NAME)));
});

// --- setBackground --------------------------------------------------------------

function fakeFs({ fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    statSync: () => { calls.push(['stat']); return { isFile: () => true, size: 1024 }; },
    mkdirSync: () => calls.push(['mkdir']),
    // No look folder yet, so the write is allowed (host/style.js lookDirState).
    lstatSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    existsSync: () => false,
    readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeFileSync: (p) => calls.push(['write', p]),
    copyFileSync: (from, to) => {
      calls.push(['copy', from, to]);
      if (fail.copy) throw fail.copy;
    },
    renameSync: (from, to) => calls.push(['rename', from, to]),
    readdirSync: () => [],
    unlinkSync: (p) => calls.push(['unlink', p]),
  };
}

test('setBackground refuses a source that cannot be read, and writes nothing', () => {
  const { cwd } = project();
  const r = setBackground({ source: path.join(cwd, 'gone.png'), cwd });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /could not be read/);
  assert.ok(!fs.existsSync(path.join(cwd, LOOK_DIR_NAME)));
});

test('setBackground refuses a directory', () => {
  const { cwd, src } = project();
  const r = setBackground({ source: src, cwd });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not a file/);
});

test('a refused choice leaves look.json BYTE-IDENTICAL', () => {
  const { cwd, src } = project();
  writeLook(cwd, { appColor: '#123456' });
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  const mp4 = path.join(src, 'movie.mp4');
  fs.writeFileSync(mp4, 'x');
  assert.strictEqual(setBackground({ source: mp4, cwd }).ok, false);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
});

test('setBackground copies to a temp file and renames it into place', () => {
  const fsImpl = fakeFs();
  const r = setBackground({ source: 'C:/drop/pic.png', cwd: 'C:/proj', fsImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const copy = fsImpl.calls.find((c) => c[0] === 'copy');
  const rename = fsImpl.calls.find((c) => c[0] === 'rename' && c[2] === r.dest);
  assert.ok(copy && rename, JSON.stringify(fsImpl.calls));
  assert.strictEqual(copy[2], rename[1], 'the copy target is the rename source');
  assert.notStrictEqual(copy[2], r.dest, 'the destination is never opened directly for the copy');
});

test('a copy failure is reported, cleans up its temp file, and never records a background', () => {
  const fsImpl = fakeFs({ fail: { copy: new Error('disk full') } });
  const r = setBackground({ source: 'C:/drop/pic.png', cwd: 'C:/proj', fsImpl });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /disk full/);
  assert.ok(fsImpl.calls.some((c) => c[0] === 'unlink'));
  assert.ok(!fsImpl.calls.some((c) => c[0] === 'rename' && String(c[2]).endsWith('look.json')));
});

test('setBackground keeps the rest of the look and replaces an older background of another format', () => {
  const { cwd, src, png } = project();
  setLook({ cwd, patch: { appColor: '#203040', darkness: 0.7 } });
  const jpg = path.join(src, 'old.jpg');
  fs.writeFileSync(jpg, 'jpg-bytes');
  assert.strictEqual(setBackground({ source: jpg, cwd }).ok, true);

  const r = setBackground({ source: png, cwd });
  assert.strictEqual(r.ok, true);
  const files = fs.readdirSync(path.join(cwd, LOOK_DIR_NAME)).filter((f) => f.startsWith('background.'));
  assert.deepStrictEqual(files, ['background.png'], 'the old jpg copy is gone');
  const look = readLook(cwd);
  assert.strictEqual(look.appColor, '#203040');
  assert.strictEqual(look.darkness, 0.7);
  assert.strictEqual(look.background.file, 'background.png');
  assert.strictEqual(look.background.setAt, r.setAt);
  assert.deepStrictEqual(fs.readFileSync(r.dest), fs.readFileSync(png), 'byte-identical copy');
});

// --- resetBackground ------------------------------------------------------------

test('resetBackground with nothing set reports nothing removed and writes nothing', () => {
  const { cwd } = project();
  assert.deepStrictEqual(resetBackground({ cwd }), { ok: true, removed: false });
  assert.ok(!fs.existsSync(path.join(cwd, LOOK_DIR_NAME)));
});

test('resetBackground removes the copy and the record, and keeps the colours', () => {
  const { cwd, png } = project();
  setLook({ cwd, patch: { appColor: '#203040' } });
  const set = setBackground({ source: png, cwd });
  assert.deepStrictEqual(resetBackground({ cwd }), { ok: true, removed: true });
  assert.ok(!fs.existsSync(set.dest));
  assert.strictEqual(readLook(cwd).background, null);
  assert.strictEqual(readLook(cwd).appColor, '#203040');
});

// --- resolveStyle -----------------------------------------------------------------

test('resolveStyle falls back to the generated art when there is no look', () => {
  const r = resolveStyle(tmpDir('cc-look-none-'), '/gen/bg.svg');
  assert.deepStrictEqual(r, { background: '/gen/bg.svg', source: 'generated', setAt: null, look: DEFAULT_LOOK });
});

test('resolveStyle returns the project\'s own copy, and the look with it', () => {
  const { cwd, png } = project();
  setLook({ cwd, patch: { appColor: '#203040' } });
  const set = setBackground({ source: png, cwd });
  const r = resolveStyle(cwd, '/gen/bg.svg');
  assert.strictEqual(r.source, 'override');
  assert.strictEqual(r.background, set.dest);
  assert.strictEqual(r.setAt, set.setAt);
  assert.strictEqual(r.look.appColor, '#203040');
});

test('resolveStyle never follows a hand-edited file name out of the look folder', () => {
  const { cwd } = project();
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(path.join(cwd, 'secret.png'), 'x');
  fs.writeFileSync(lookFile(cwd), JSON.stringify({ background: { file: '../secret.png' } }));
  assert.strictEqual(resolveStyle(cwd, '/gen/bg.svg').source, 'generated');
});

test('one project\'s look never leaks onto another', () => {
  const a = project();
  const b = project();
  setLook({ cwd: a.cwd, patch: { appColor: '#aa0000' } });
  setBackground({ source: a.png, cwd: a.cwd });
  const r = resolveStyle(b.cwd, '/gen/bg.svg');
  assert.strictEqual(r.source, 'generated');
  assert.strictEqual(r.look.appColor, null);
});

// --- review fixes: Dexter F1/F5/F6/F7, Miguel #1 -------------------------------

// Real fs, except that writing look.json fails -- the moment AFTER the image
// copy has landed, which is where F1 lost the old background.
const failingLookWrite = () => ({
  ...fs,
  renameSync: (from, to) => {
    if (String(to).endsWith('look.json')) throw new Error('disk full');
    return fs.renameSync(from, to);
  },
});

test('F1: a failed look.json write after a new-format copy keeps the old background intact', () => {
  const { cwd, src } = project();
  const jpg = path.join(src, 'old.jpg');
  fs.writeFileSync(jpg, 'old-jpg-bytes');
  assert.strictEqual(setBackground({ source: jpg, cwd }).ok, true);
  const png = path.join(src, 'new.png');
  fs.writeFileSync(png, 'new-png-bytes');

  const r = setBackground({ source: png, cwd, fsImpl: failingLookWrite() });
  assert.strictEqual(r.ok, false);
  const dir = path.join(cwd, LOOK_DIR_NAME);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'background.jpg'), 'utf8'), 'old-jpg-bytes');
  assert.ok(!fs.existsSync(path.join(dir, 'background.png')), 'no orphaned new copy');
  assert.strictEqual(readLook(cwd).background.file, 'background.jpg');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => /\.(tmp|bak)/.test(f)), []);
});

test('F1: a failed look.json write after a SAME-format copy keeps the old bytes', () => {
  const { cwd, src } = project();
  const a = path.join(src, 'a.png');
  fs.writeFileSync(a, 'A');
  assert.strictEqual(setBackground({ source: a, cwd }).ok, true);
  const b = path.join(src, 'b.png');
  fs.writeFileSync(b, 'B');

  assert.strictEqual(setBackground({ source: b, cwd, fsImpl: failingLookWrite() }).ok, false);
  assert.strictEqual(fs.readFileSync(path.join(cwd, LOOK_DIR_NAME, 'background.png'), 'utf8'), 'A');
});

test('F5: an invalid colour or darkness is refused, not silently reset', () => {
  const { cwd } = project();
  setLook({ cwd, patch: { appColor: '#102030', darkness: 0.3 } });
  for (const patch of [{ appColor: '#246' }, { textColor: 'red' }, { darkness: '0.5' }, { darkness: NaN }]) {
    const r = setLook({ cwd, patch });
    assert.strictEqual(r.ok, false, JSON.stringify(patch));
    assert.match(r.reason, /#rrggbb|number/);
  }
  assert.strictEqual(readLook(cwd).appColor, '#102030');
  assert.strictEqual(readLook(cwd).darkness, 0.3);
});

test('F5: a patch with nothing this code sets is refused and creates no folder', () => {
  const { cwd } = project();
  for (const patch of [{}, { background: { file: 'background.png' } }, { font: 'x' }]) {
    assert.strictEqual(setLook({ cwd, patch }).ok, false, JSON.stringify(patch));
  }
  assert.ok(!fs.existsSync(path.join(cwd, LOOK_DIR_NAME)));
});

test('F6: a corrupt look.json is never overwritten by a write -- it is refused, and says where', () => {
  const { cwd, png } = project();
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  const corrupt = '{"appColor": "#102030",}';
  fs.writeFileSync(lookFile(cwd), corrupt);
  for (const r of [
    setLook({ cwd, patch: { darkness: 0.2 } }),
    setBackground({ source: png, cwd }),
  ]) {
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /look\.json/);
  }
  assert.throws(() => resetBackground({ cwd }), /look\.json/);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), corrupt, 'byte-identical');
  assert.deepStrictEqual(readLook(cwd), DEFAULT_LOOK, 'reads still degrade to the default');
});

test('F7: a .claude-custom that is a link to elsewhere is neither written through nor read', () => {
  const { cwd, png } = project();
  const elsewhere = tmpDir('cc-look-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'look.json'), JSON.stringify({ appColor: '#ff0000' }));
  fs.writeFileSync(path.join(elsewhere, 'background.jpg'), 'someone else\'s');
  fs.symlinkSync(elsewhere, path.join(cwd, LOOK_DIR_NAME), 'junction');

  assert.strictEqual(readLook(cwd).appColor, null, 'not read through the link');
  const r = setLook({ cwd, patch: { appColor: '#102030' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /link/);
  assert.strictEqual(setBackground({ source: png, cwd }).ok, false);
  assert.deepStrictEqual(fs.readdirSync(elsewhere).sort(), ['background.jpg', 'look.json']);
  assert.strictEqual(fs.readFileSync(path.join(elsewhere, 'background.jpg'), 'utf8'), 'someone else\'s');
});
