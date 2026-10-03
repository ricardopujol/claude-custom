'use strict';
/**
 * #37: main resolves a path clicked in a tab's terminal, checks it exists, and
 * decides open or reveal (app/file-link.js). The page only ever asks.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const path = require('path');
const { OPENABLE, safePath, actionFor, check, open, MAX_LISTS, MAX_OPTIONS } = require('../app/file-link');

const CWD = 'C:\\Users\\ricar\\VibeCode\\claude-custom\\feat-terminal-file-links';

test('safePath: absolute stays, relative resolves against the tab folder, forward slashes normalise', () => {
  assert.strictEqual(safePath('c:/a/b.txt', CWD), 'c:\\a\\b.txt');
  assert.strictEqual(safePath('app/link-click.js', CWD), `${CWD}\\app\\link-click.js`);
  assert.strictEqual(safePath('..\\dev\\x.md', CWD), 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev\\x.md');
});

test('safePath refuses UNC, device, drive-relative, rooted, ADS, NUL and over-long', () => {
  for (const p of ['\\\\srv\\share\\x', '//srv/share/x', '\\\\?\\C:\\x', '\\\\.\\COM1', 'C:x.txt',
                   '\\x.txt', '/x.txt', 'C:\\x.txt:secret', 'C:\\x\u0000.txt', `C:\\${'a'.repeat(1100)}`,
                   '', null, 42, undefined]) {
    assert.strictEqual(safePath(p, CWD), null, String(p));
  }
  assert.strictEqual(safePath('x.txt', '\\\\srv\\share'), null, 'a UNC tab folder resolves nothing');
  assert.strictEqual(safePath('x.txt', null), null);
});

test('actionFor: folders open; files open only if BOTH the given and the real extension are openable', () => {
  assert.strictEqual(actionFor({ given: 'C:\\a', real: 'C:\\a', isDir: true }), 'open');
  assert.strictEqual(actionFor({ given: 'C:\\a.HTML', real: 'C:\\a.HTML', isDir: false }), 'open');
  for (const ext of ['.exe', '.bat', '.cmd', '.ps1', '.lnk', '.vbs', '.js', '.py', '.sh', '.msi',
                     '.hta', '.reg', '.url', '.xlsm', '.docm', '', '.', '.txt.', '.txt ',
                     // Miguel I1: formats that carry macros or embedded objects
                     '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf']) {
    assert.strictEqual(actionFor({ given: `C:\\a${ext}`, real: `C:\\a${ext}`, isDir: false }), 'reveal', ext);
  }
  assert.strictEqual(actionFor({ given: 'C:\\a.txt', real: 'C:\\b.exe', isDir: false }), 'reveal', 'a link to an exe');
});

test('PROPERTY: nothing outside OPENABLE ever opens', () => {
  fc.assert(fc.property(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), (a, b) => {
    const given = `C:\\x\\f.${a}`, real = `C:\\y\\g.${b}`;
    const act = actionFor({ given, real, isDir: false });
    const ok = (p) => OPENABLE.has(path.win32.extname(p).toLowerCase());
    return act === 'reveal' || (ok(given) && ok(real));
  }));
});

// A fake fs: path (lower-case) -> 'file' | 'dir' | { link: target }.
function fakeFs(entries) {
  const m = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  const get = (p) => m.get(p.toLowerCase());
  return {
    stat: async (p) => {
      const v = get(p);
      if (!v) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      const t = typeof v === 'object' ? get(v.link) : v;
      return { isFile: () => t === 'file', isDirectory: () => t === 'dir' };
    },
    realpath: async (p) => { const v = get(p); return typeof v === 'object' ? v.link : p; },
  };
}

test('check answers the longest option that exists, per candidate, and null for none', async () => {
  const fs = fakeFs({ 'C:\\Reaper Projects\\a b.xlsx': 'file', [`${CWD}\\documentation`]: 'dir' });
  const answers = await check([
    ['C:\\Reaper Projects\\a b.xlsx is saved', 'C:\\Reaper Projects\\a b.xlsx', 'C:\\Reaper'],
    ['C:\\nothing.txt'],
    ['documentation'],
  ], CWD, fs);
  assert.deepStrictEqual(answers[0], { option: 1, path: 'C:\\Reaper Projects\\a b.xlsx', action: 'open',
    isDir: false, name: 'a b.xlsx' });
  assert.strictEqual(answers[1], null);
  assert.deepStrictEqual(answers[2], { option: 0, path: `${CWD}\\documentation`, action: 'open',
    isDir: true, name: 'documentation' });
});

test('check never stats a refused path, and survives junk lists', async () => {
  const seen = [];
  const fs = { stat: async (p) => { seen.push(p); throw new Error('x'); }, realpath: async (p) => p };
  const answers = await check([['\\\\attacker\\share\\x.txt'], ['C:\\ok.txt'], 'junk', [42], null], CWD, fs);
  assert.deepStrictEqual(seen, ['C:\\ok.txt']);
  assert.deepStrictEqual(answers, [null, null, null, null, null]);
  assert.deepStrictEqual(await check('nope', CWD, fs), []);
});

test('check is bounded: at most MAX_LISTS x MAX_OPTIONS are looked at', async () => {
  let n = 0;
  const fs = { stat: async () => { n++; throw new Error('x'); }, realpath: async (p) => p };
  const answers = await check(Array.from({ length: 50 }, () => Array.from({ length: 20 }, (_, i) => `C:\\${i}.txt`)), CWD, fs);
  assert.ok(n <= MAX_LISTS * MAX_OPTIONS, String(n));
  assert.strictEqual(answers.length, MAX_LISTS);
});

test('open re-decides at click time: a .txt that is a link to an .exe is revealed, not opened', async () => {
  const calls = [];
  const shell = { openPath: async (p) => { calls.push(['open', p]); return ''; },
                  showItemInFolder: (p) => calls.push(['reveal', p]) };
  const fs = fakeFs({ 'C:\\a.txt': { link: 'C:\\evil.exe' }, 'C:\\evil.exe': 'file', 'C:\\b.md': 'file',
    'C:\\run.ps1': 'file', 'C:\\dir': 'dir' });
  assert.deepStrictEqual(await open('C:\\a.txt', CWD, fs, shell), { ok: true, action: 'reveal' });
  assert.deepStrictEqual(await open('C:\\b.md', CWD, fs, shell), { ok: true, action: 'open' });
  assert.deepStrictEqual(await open('C:\\run.ps1', CWD, fs, shell), { ok: true, action: 'reveal' });
  assert.deepStrictEqual(await open('C:\\dir', CWD, fs, shell), { ok: true, action: 'open' });
  assert.deepStrictEqual(calls, [['reveal', 'C:\\a.txt'], ['open', 'C:\\b.md'], ['reveal', 'C:\\run.ps1'],
    ['open', 'C:\\dir']]);
});

test('open says why when it opens nothing, and never calls the shell then', async () => {
  const calls = [];
  const shell = { openPath: async (p) => { calls.push(p); return 'No application is associated'; },
                  showItemInFolder: (p) => calls.push(p) };
  const fs = fakeFs({ 'C:\\b.md': 'file' });
  assert.deepStrictEqual(await open('C:\\gone.md', CWD, fs, shell), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await open('\\\\srv\\x', CWD, fs, shell), { ok: false, why: 'refused' });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(await open('C:\\b.md', CWD, fs, shell), { ok: false, why: 'No application is associated' });
  const throwing = { openPath: async () => { throw new Error('boom'); }, showItemInFolder: () => {} };
  assert.deepStrictEqual(await open('C:\\b.md', CWD, fs, throwing), { ok: false, why: 'boom' });
});

// --- PR #92 Miguel I3: a dead drive can't stall main ------------------------------
const { newState } = require('../app/file-link');

test('a stat that never answers times out, marks its drive slow, and the drive is skipped until it cools', async () => {
  let t = 1000, calls = [];
  const fsx = {
    stat: (p) => { calls.push(p); return p.startsWith('Z:') ? new Promise(() => {}) : Promise.reject(new Error('no')); },
    realpath: async (p) => p,
  };
  const opts = { state: newState(), now: () => t, timeoutMs: 20 };
  const t0 = Date.now();
  assert.deepStrictEqual(await check([['Z:\\share\\a.txt'], ['C:\\x.txt']], CWD, fsx, opts), [null, null]);
  assert.ok(Date.now() - t0 < 1000, 'answered without waiting on the dead drive');
  calls = [];
  await check([['z:\\share\\b.txt', 'Z:\\c.txt']], CWD, fsx, opts);
  assert.deepStrictEqual(calls, [], 'a slow drive is not asked again (either case)');
  t += 61000;
  await check([['Z:\\share\\b.txt']], CWD, fsx, opts);
  assert.deepStrictEqual(calls, ['Z:\\share\\b.txt'], 'after it cools it is tried again');
});

test('hover answers are cached for a moment; a click never uses the cache', async () => {
  let t = 0, stats = 0;
  const fsx = { stat: async () => { stats++; return { isFile: () => true, isDirectory: () => false }; }, realpath: async (p) => p };
  const opts = { state: newState(), now: () => t, timeoutMs: 1000 };
  await check([['C:\\a.md']], CWD, fsx, opts);
  await check([['C:\\a.md']], CWD, fsx, opts);
  assert.strictEqual(stats, 1);
  t += 2500;
  await check([['C:\\a.md']], CWD, fsx, opts);
  assert.strictEqual(stats, 2);
  const shell = { openPath: async () => '', showItemInFolder: () => {} };
  await open('C:\\a.md', CWD, fsx, shell, opts);
  assert.strictEqual(stats, 3, 'open stats again');
});

test('a click on a path whose stat hangs says so and runs nothing', async () => {
  const calls = [];
  const shell = { openPath: async (p) => { calls.push(p); return ''; }, showItemInFolder: (p) => calls.push(p) };
  const fsx = { stat: () => new Promise(() => {}), realpath: async (p) => p };
  const r = await open('Z:\\a.md', CWD, fsx, shell, { state: newState(), now: () => 0, timeoutMs: 20 });
  assert.deepStrictEqual(r, { ok: false, why: 'timed out' });
  assert.deepStrictEqual(calls, []);
});

test('PR #92 Miguel S1: main and the page share one set of caps', () => {
  const parse = require('../app/file-path-parse');
  assert.strictEqual(MAX_LISTS, parse.MAX_CANDIDATES);
  assert.strictEqual(MAX_OPTIONS, parse.MAX_OPTIONS);
  assert.notStrictEqual(safePath(`C:\\${'a'.repeat(parse.MAX_PATH_LENGTH - 3)}`, CWD), null);
  assert.strictEqual(safePath(`C:\\${'a'.repeat(parse.MAX_PATH_LENGTH)}`, CWD), null);
});
