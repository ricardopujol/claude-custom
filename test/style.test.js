'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  planBackgroundChoice, setBackground, resetBackground, resolveStyle,
  ACCEPTED_EXTENSIONS, MAX_BYTES, normalize, fileNameFor, isInside,
} = require('../host/style');
const { createStore } = require('../host/store');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A minimal in-memory store double for the pure/thin-layer tests below --
// the real createStore (host/store.js) is exercised separately by the
// integration tests further down, so both the fake and the real thing agree.
function fakeStore(initial = {}) {
  let data = { ...initial };
  return {
    read: (name, fallback) => (name in data ? data[name] : fallback),
    write: (name, value) => { data[name] = value; return value; },
    _dump: () => data,
  };
}

// --- planBackgroundChoice: PURE, no fs at all --------------------------------

test('planBackgroundChoice refuses when no source is given', () => {
  const r = planBackgroundChoice({ cwd: 'C:/proj', dir: 'C:/harness/style' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no file/i);
});

test('planBackgroundChoice refuses when no project is open', () => {
  const r = planBackgroundChoice({ source: 'C:/x/pic.png', dir: 'C:/harness/style' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /project/i);
});

test('planBackgroundChoice refuses when there is nowhere to store the copy', () => {
  const r = planBackgroundChoice({ source: 'C:/x/pic.png', cwd: 'C:/proj' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /nowhere/i);
});

test('planBackgroundChoice refuses an unsupported extension, and says why', () => {
  const r = planBackgroundChoice({ source: 'C:/x/movie.mp4', cwd: 'C:/proj', dir: 'C:/harness/style' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /mp4/);
});

test('planBackgroundChoice refuses a file with no extension at all', () => {
  const r = planBackgroundChoice({ source: 'C:/x/README', cwd: 'C:/proj', dir: 'C:/harness/style' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no extension/i);
});

test('every accepted extension is actually accepted, case-insensitively', () => {
  for (const ext of ACCEPTED_EXTENSIONS) {
    for (const cased of [ext, ext.toUpperCase()]) {
      const r = planBackgroundChoice({
        source: `C:/x/pic.${cased}`, cwd: 'C:/proj', dir: 'C:/harness/style', size: 100,
      });
      assert.strictEqual(r.ok, true, `${cased} should be accepted: ${r.reason}`);
      assert.ok(r.dest.endsWith(`.${ext}`), `dest ${r.dest} should keep the ${ext} extension`);
    }
  }
});

test('planBackgroundChoice refuses a file over the size ceiling, and says so', () => {
  const r = planBackgroundChoice({
    source: 'C:/x/pic.png', cwd: 'C:/proj', dir: 'C:/harness/style', size: MAX_BYTES + 1,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /25MB|large/i);
});

test('the size ceiling boundary is pinned, not a bare literal', () => {
  // The module-scope-constant trap this codebase already names in
  // host/control.js: a bare number in the test would drift silently.
  assert.strictEqual(MAX_BYTES, 25 * 1024 * 1024);
  assert.strictEqual(
    planBackgroundChoice({ source: 'C:/x/pic.png', cwd: 'C:/proj', dir: 'C:/harness/style', size: MAX_BYTES }).ok,
    true, 'exactly at the ceiling must still be accepted');
  assert.strictEqual(
    planBackgroundChoice({ source: 'C:/x/pic.png', cwd: 'C:/proj', dir: 'C:/harness/style', size: MAX_BYTES + 1 }).ok,
    false, 'one byte over the ceiling must be refused');
});

test('a missing size is not treated as oversized', () => {
  // planBackgroundChoice is pure -- when the caller has not statted yet (or
  // chooses not to pass it through), size is simply not judged.
  const r = planBackgroundChoice({ source: 'C:/x/pic.png', cwd: 'C:/proj', dir: 'C:/harness/style' });
  assert.strictEqual(r.ok, true);
});

// PROPERTY: for a wide sample of project paths and filenames, the destination
// this function proposes is ALWAYS inside `dir` -- the invariant the brief
// names explicitly. Constructed by looping many synthetic inputs, the same
// style test/drop-security.test.js and test/store.test.js already use in this
// project, which has no property-testing library installed for JS.
test('PROPERTY: the proposed destination is always inside the given directory', () => {
  const dir = 'C:/harness/style';
  const cwds = [
    'C:/proj', 'C:/Users/ricar/VibeCode/weird name with spaces',
    '/home/ricar/proj', 'c:\\Work\\Alpha', 'C:/proj/../../etc',
    'C:/proj/☃/unicode', '', '   ', 'C:/' + 'a'.repeat(500),
  ];
  const exts = [...ACCEPTED_EXTENSIONS];
  let checked = 0;
  for (const cwd of cwds) {
    for (const ext of exts) {
      const r = planBackgroundChoice({ source: `C:/drop/x.${ext}`, cwd, dir, size: 10 });
      if (!r.ok) continue;             // an empty/blank cwd is refused above
      checked++;
      assert.ok(isInside(r.dest, dir), `${r.dest} must resolve inside ${dir}`);
    }
  }
  assert.ok(checked > 0, 'the sweep must exercise at least one accepted case');
});

test('the same project and extension always produce the same filename', () => {
  const a = planBackgroundChoice({ source: 'C:/drop/one.png', cwd: 'C:/proj/alpha', dir: 'C:/h/style', size: 1 });
  const b = planBackgroundChoice({ source: 'C:/drop/two.png', cwd: 'c:\\proj\\alpha', dir: 'C:/h/style', size: 1 });
  assert.strictEqual(a.dest, b.dest, 'slash direction and case must not change the destination');
});

test('different projects get different filenames', () => {
  const a = planBackgroundChoice({ source: 'C:/drop/one.png', cwd: 'C:/proj/alpha', dir: 'C:/h/style', size: 1 });
  const b = planBackgroundChoice({ source: 'C:/drop/one.png', cwd: 'C:/proj/beta', dir: 'C:/h/style', size: 1 });
  assert.notStrictEqual(a.dest, b.dest);
});

test('fileNameFor is exposed and matches what planBackgroundChoice proposes', () => {
  const r = planBackgroundChoice({ source: 'C:/drop/one.png', cwd: 'C:/proj/alpha', dir: 'C:/h/style', size: 1 });
  assert.strictEqual(r.dest, path.join('C:/h/style', fileNameFor('C:/proj/alpha', 'png')));
});

// --- setBackground: the thin fs layer ----------------------------------------

function fakeFs({ existing = new Set(), fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    statSync: (p) => {
      calls.push(['stat', p]);
      if (fail.stat) throw fail.stat;
      if (!existing.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isFile: () => true, size: fail.size ?? 1024 };
    },
    mkdirSync: (p) => calls.push(['mkdir', p]),
    copyFileSync: (from, to) => {
      calls.push(['copy', from, to]);
      if (fail.copy) throw fail.copy;
    },
    renameSync: (from, to) => {
      calls.push(['rename', from, to]);
      if (fail.rename) throw fail.rename;
    },
    unlinkSync: (p) => calls.push(['unlink', p]),
  };
}

test('setBackground refuses to read the store missing a store', () => {
  assert.throws(() => setBackground({ source: 'x', cwd: 'C:/proj', dir: 'C:/h/style' }),
    /store is required/);
});

test('setBackground refuses a source that cannot be statted', () => {
  const store = fakeStore();
  const r = setBackground({
    source: 'C:/gone/x.png', cwd: 'C:/proj', dir: 'C:/h/style', store,
    fsImpl: fakeFs({ existing: new Set() }),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /could not be read/);
  assert.deepStrictEqual(store._dump(), {}, 'a failed read must never touch the store');
});

test('setBackground refuses a directory statted where a file was expected', () => {
  const store = fakeStore();
  const fsImpl = fakeFs({ existing: new Set(['C:/x/dir']) });
  fsImpl.statSync = (p) => { fsImpl.calls.push(['stat', p]); return { isFile: () => false, size: 1 }; };
  const r = setBackground({ source: 'C:/x/dir', cwd: 'C:/proj', dir: 'C:/h/style', store, fsImpl });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not a file/);
});

test('a refused choice leaves the store BYTE-IDENTICAL', () => {
  // The invariant named in the brief. Backed by the REAL store (write-and-
  // rename to an actual file), not the fake, so "byte-identical" means what
  // it says: the file on disk, not just an in-memory object.
  const dir = tmp('cc-style-store-');
  const store = createStore({ dir });
  store.write('style', { 'c:/existing': { background: { file: 'C:/h/style/x.png', setAt: 'then' } } });
  const before = fs.readFileSync(path.join(dir, 'style.json'), 'utf8');

  const r = setBackground({
    source: 'C:/x/movie.mp4', cwd: 'C:/proj', dir: 'C:/h/style', store,
    fsImpl: fakeFs({ existing: new Set(['C:/x/movie.mp4']) }),
  });
  assert.strictEqual(r.ok, false);

  const after = fs.readFileSync(path.join(dir, 'style.json'), 'utf8');
  assert.strictEqual(after, before, 'an unsupported extension must not touch style.json at all');
});

test('setBackground copies temp-then-rename, in that order, before writing the store', () => {
  const store = fakeStore();
  const fsImpl = fakeFs({ existing: new Set(['C:/drop/pic.png']) });
  const r = setBackground({ source: 'C:/drop/pic.png', cwd: 'C:/proj/alpha', dir: 'C:/h/style', store, fsImpl });

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const kinds = fsImpl.calls.map(c => c[0]);
  assert.deepStrictEqual(kinds, ['stat', 'mkdir', 'copy', 'rename']);

  const [, copyFrom, copyTo] = fsImpl.calls[2];
  const [, renameFrom, renameTo] = fsImpl.calls[3];
  assert.strictEqual(copyFrom, 'C:/drop/pic.png');
  assert.strictEqual(renameTo, r.dest, 'the rename must land on the planned destination');
  assert.strictEqual(copyTo, renameFrom, 'the copy target and the rename source must be the same temp file');
  assert.notStrictEqual(copyTo, r.dest, 'the destination must never be opened directly for the copy');
});

test('setBackground records the override under the NORMALISED project key', () => {
  const store = fakeStore();
  const fsImpl = fakeFs({ existing: new Set(['C:/drop/pic.png']) });
  const r = setBackground({ source: 'C:/drop/pic.png', cwd: 'c:\\Proj\\Alpha\\', dir: 'C:/h/style', store, fsImpl });

  assert.strictEqual(r.ok, true);
  const state = store._dump().style;
  const key = normalize('c:\\Proj\\Alpha\\');
  assert.ok(state[key], 'the entry must be keyed by the normalised project path');
  assert.strictEqual(state[key].background.file, r.dest);
  assert.ok(typeof state[key].background.setAt === 'string' && state[key].background.setAt.length > 0);
  // Returned to the caller too, so host.js can broadcast it without a second
  // read of the store it just wrote.
  assert.strictEqual(r.setAt, state[key].background.setAt);
});

test('a copy failure is reported, cleans up the temp file, and never reaches the store', () => {
  const store = fakeStore();
  const fsImpl = fakeFs({ existing: new Set(['C:/drop/pic.png']), fail: { copy: new Error('disk full') } });
  const r = setBackground({ source: 'C:/drop/pic.png', cwd: 'C:/proj', dir: 'C:/h/style', store, fsImpl });

  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /disk full/);
  assert.deepStrictEqual(store._dump(), {});
  const kinds = fsImpl.calls.map(c => c[0]);
  assert.ok(kinds.includes('unlink'), 'a failed copy must clean up its temp file');
});

// --- resetBackground ----------------------------------------------------------

test('resetBackground on a project with no override reports nothing removed, and does not write', () => {
  const store = fakeStore();
  const r = resetBackground({ cwd: 'C:/proj', dir: 'C:/h/style', store, fsImpl: fakeFs() });
  assert.deepStrictEqual(r, { ok: true, removed: false });
  assert.deepStrictEqual(store._dump(), {});
});

test('resetBackground removes the entry and unlinks a copy that lives inside the style dir', () => {
  const key = normalize('C:/proj');
  const store = fakeStore({ style: { [key]: { background: { file: 'C:/h/style/proj-abc.png', setAt: 'x' } } } });
  const fsImpl = fakeFs();
  const r = resetBackground({ cwd: 'C:/proj', dir: 'C:/h/style', store, fsImpl });

  assert.deepStrictEqual(r, { ok: true, removed: true });
  assert.deepStrictEqual(store._dump().style, {});
  assert.deepStrictEqual(fsImpl.calls, [['unlink', 'C:/h/style/proj-abc.png']]);
});

test('resetBackground NEVER unlinks a file outside the style directory', () => {
  // A hand-edited style.json must not turn "reset" into an arbitrary delete.
  const key = normalize('C:/proj');
  const store = fakeStore({ style: { [key]: { background: { file: 'C:/Users/ricar/Desktop/family.png', setAt: 'x' } } } });
  const fsImpl = fakeFs();
  const r = resetBackground({ cwd: 'C:/proj', dir: 'C:/h/style', store, fsImpl });

  assert.deepStrictEqual(r, { ok: true, removed: true }, 'the STATE entry is still removed');
  assert.deepStrictEqual(fsImpl.calls, [], 'but nothing outside the style dir is ever touched on disk');
});

test('resetBackground only removes the ASKING project, not every override', () => {
  const store = fakeStore({
    style: {
      [normalize('C:/proj/a')]: { background: { file: 'C:/h/style/a.png', setAt: 'x' } },
      [normalize('C:/proj/b')]: { background: { file: 'C:/h/style/b.png', setAt: 'x' } },
    },
  });
  resetBackground({ cwd: 'C:/proj/a', dir: 'C:/h/style', store, fsImpl: fakeFs() });
  const state = store._dump().style;
  assert.ok(!state[normalize('C:/proj/a')]);
  assert.ok(state[normalize('C:/proj/b')]);
});

// --- resolveStyle ---------------------------------------------------------------

test('resolveStyle falls back to generated when there is no store at all', () => {
  assert.deepStrictEqual(resolveStyle(null, 'C:/proj', '/gen/bg.svg'), { background: '/gen/bg.svg', source: 'generated' });
});

test('resolveStyle falls back to generated when nothing is recorded for this project', () => {
  const store = fakeStore({ style: {} });
  assert.deepStrictEqual(resolveStyle(store, 'C:/proj', '/gen/bg.svg'), { background: '/gen/bg.svg', source: 'generated' });
});

test('resolveStyle does not leak one project\'s override onto another', () => {
  const store = fakeStore({
    style: { [normalize('C:/other')]: { background: { file: 'C:/h/style/x.png', setAt: 't' } } },
  });
  assert.deepStrictEqual(resolveStyle(store, 'C:/proj', '/gen/bg.svg'), { background: '/gen/bg.svg', source: 'generated' });
});

test('resolveStyle returns the override, keyed regardless of slash direction or case', () => {
  const store = fakeStore({
    style: { [normalize('C:/Proj/Alpha')]: { background: { file: 'C:/h/style/x.png', setAt: 't1' } } },
  });
  const r = resolveStyle(store, 'c:\\proj\\alpha', '/gen/bg.svg');
  assert.deepStrictEqual(r, { background: 'C:/h/style/x.png', source: 'override', setAt: 't1' });
});

test('resolveStyle never throws on a malformed entry, and falls back', () => {
  const cases = [
    { style: { [normalize('C:/proj')]: null } },
    { style: { [normalize('C:/proj')]: {} } },
    { style: { [normalize('C:/proj')]: { background: null } } },
    { style: { [normalize('C:/proj')]: { background: {} } } },
    { style: { [normalize('C:/proj')]: { background: { file: 123 } } } },
    { style: [] },
    { style: 'garbage' },
    { style: null },
  ];
  for (const data of cases) {
    const store = fakeStore(data);
    assert.doesNotThrow(() => resolveStyle(store, 'C:/proj', '/gen/bg.svg'), JSON.stringify(data));
    const r = resolveStyle(store, 'C:/proj', '/gen/bg.svg');
    assert.strictEqual(r.source, 'generated', JSON.stringify(data));
  }
});

test('resolveStyle refuses an override that resolves outside the given style directory', () => {
  const store = fakeStore({
    style: { [normalize('C:/proj')]: { background: { file: 'C:/Users/ricar/Desktop/x.png', setAt: 't' } } },
  });
  const r = resolveStyle(store, 'C:/proj', '/gen/bg.svg', { styleDir: 'C:/h/style' });
  assert.strictEqual(r.source, 'generated');
  assert.strictEqual(r.background, '/gen/bg.svg');
  assert.match(r.note, /outside the harness directory/);
});

test('resolveStyle trusts an override that DOES resolve inside the given style directory', () => {
  const store = fakeStore({
    style: { [normalize('C:/proj')]: { background: { file: 'C:/h/style/x.png', setAt: 't' } } },
  });
  const r = resolveStyle(store, 'C:/proj', '/gen/bg.svg', { styleDir: 'C:/h/style' });
  assert.strictEqual(r.source, 'override');
  assert.strictEqual(r.background, 'C:/h/style/x.png');
});

// --- integration, against the REAL store and REAL filesystem -------------------

test('INTEGRATION: set, resolve, and reset round-trip through the real store and fs', () => {
  const stateDir = tmp('cc-style-state-');
  const styleDir = tmp('cc-style-files-');
  const sourceDir = tmp('cc-style-src-');
  const store = createStore({ dir: stateDir });

  const source = path.join(sourceDir, 'chosen.png');
  fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

  const cwd = 'C:/some/real/project';

  // Before setting anything, resolveStyle must fall back to the generated one.
  const before = resolveStyle(store, cwd, '/gen/bg.svg', { styleDir });
  assert.strictEqual(before.source, 'generated');

  const set = setBackground({ source, cwd, dir: styleDir, store });
  assert.strictEqual(set.ok, true, JSON.stringify(set));
  assert.ok(fs.existsSync(set.dest), 'the copy must actually exist on disk');
  assert.ok(isInside(set.dest, styleDir));
  assert.deepStrictEqual(fs.readFileSync(set.dest), fs.readFileSync(source), 'the copy must be byte-identical to the source');

  const after = resolveStyle(store, cwd, '/gen/bg.svg', { styleDir });
  assert.strictEqual(after.source, 'override');
  assert.strictEqual(after.background, set.dest);

  const reset = resetBackground({ cwd, dir: styleDir, store });
  assert.deepStrictEqual(reset, { ok: true, removed: true });
  assert.ok(!fs.existsSync(set.dest), 'reset must remove the copy');

  const finalState = resolveStyle(store, cwd, '/gen/bg.svg', { styleDir });
  assert.strictEqual(finalState.source, 'generated');
});

test('PROPERTY: after setBackground, resolveStyle never returns a path outside the harness style dir', () => {
  const stateDir = tmp('cc-style-state2-');
  const styleDir = tmp('cc-style-files2-');
  const sourceDir = tmp('cc-style-src2-');
  const store = createStore({ dir: stateDir });

  const source = path.join(sourceDir, 'a.png');
  fs.writeFileSync(source, Buffer.from([1, 2, 3]));

  const cwds = [
    'C:/proj/one', 'C:/Proj/Two/', 'c:\\proj\\three', '/home/r/four',
    'C:/proj/with spaces/five', 'C:/proj/six/../six',
  ];
  for (const cwd of cwds) {
    const r = setBackground({ source, cwd, dir: styleDir, store });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const resolved = resolveStyle(store, cwd, '/gen/bg.svg', { styleDir });
    assert.strictEqual(resolved.source, 'override');
    assert.ok(isInside(resolved.background, styleDir),
      `${resolved.background} escaped ${styleDir} for cwd ${cwd}`);
  }
});
