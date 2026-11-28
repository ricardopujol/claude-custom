'use strict';
/**
 * Jiandu's own record of the projects it opened, the pins and the removed set (documentation/DESIGN_PROJECT_HUB.md §3; plan
 * documentation/PLAN_PROJECT_HUB.md H-PR1 task 7). On a real host/store.js in a temp folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../host/store');
const { createHomeRecord, STORE_KEY, MAX_PROJECTS, MAX_LIST } = require('../app/home-record');

const keyOf = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').toLowerCase() : null);
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function setup({ start = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-record-'));
  made.push(dir);
  const store = createStore({ dir });
  let t = start;
  const lines = [];
  const home = createHomeRecord({ store, keyOf, now: () => t, log: (l) => lines.push(l) });
  return { dir, store, home, lines, file: path.join(dir, `${STORE_KEY}.json`), tick: (n = 1) => { t += n; } };
}
const EMPTY = { projects: [], pins: [], removed: [] };

test('the store key is home-projects', () => {
  assert.strictEqual(STORE_KEY, 'home-projects');
});

test('a missing file reads as the empty record', () => {
  assert.deepStrictEqual(setup().home.read(), EMPTY);
});

test('opened writes the root with now(); a second open of the same root, spelled differently, keeps one entry', () => {
  const s = setup();
  assert.deepStrictEqual(s.home.opened('C:\\P'), { projects: [{ root: 'C:\\P', lastOpened: 1000 }], pins: [], removed: [] });
  s.tick(5);
  s.home.opened('c:\\p\\');
  assert.deepStrictEqual(s.home.read().projects, [{ root: 'C:\\P', lastOpened: 1005 }]);
  assert.strictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).version, 1);
});

test('opened puts a removed project back (design §6 default)', () => {
  const s = setup();
  s.home.remove('C:\\r');
  assert.deepStrictEqual(s.home.read().removed, ['C:\\r']);
  s.home.opened('c:\\R');
  assert.deepStrictEqual(s.home.read(), { projects: [{ root: 'c:\\R', lastOpened: 1000 }], pins: [], removed: [] });
});

test('pin on and off; pinning twice keeps one pin', () => {
  const s = setup();
  s.home.pin('C:\\a', true);
  s.home.pin('c:\\A', true);
  assert.deepStrictEqual(s.home.read().pins, ['C:\\a']);
  s.home.pin('c:\\a\\', false);
  assert.deepStrictEqual(s.home.read().pins, []);
});

test('pin refuses a value that is not a real boolean, and a root that is not a path', () => {
  const s = setup();
  assert.strictEqual(s.home.pin('C:\\a', 'yes'), null);
  assert.strictEqual(s.home.pin('', true), null);
  assert.strictEqual(s.home.opened(null), null);
  assert.strictEqual(s.home.remove(5), null);
  assert.ok(!fs.existsSync(s.file), 'nothing was written');
});

test('remove drops the pin and the entry and adds the root to the removed set', () => {
  const s = setup();
  s.home.opened('C:\\a');
  s.home.opened('C:\\b');
  s.home.pin('C:\\a', true);
  assert.deepStrictEqual(s.home.remove('c:\\a'), { projects: [{ root: 'C:\\b', lastOpened: 1000 }], pins: [], removed: ['c:\\a'] });
});

test('a corrupt file is never written over: the edit answers null, the bytes stay, one line says why', () => {
  const s = setup();
  fs.writeFileSync(s.file, '{ not json');
  assert.deepStrictEqual(s.home.read(), EMPTY);
  assert.strictEqual(s.home.opened('C:\\a'), null);
  assert.strictEqual(s.home.pin('C:\\a', true), null);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), '{ not json');
  assert.strictEqual(s.lines.length, 2);
  assert.match(s.lines[0], /home-projects.*not written/);
});

test('a newer version is never written over, and reads as empty', () => {
  const s = setup();
  const newer = JSON.stringify({ version: 2, projects: [{ root: 'C:\\x', lastOpened: 5 }], pins: [], removed: [] });
  fs.writeFileSync(s.file, newer);
  assert.deepStrictEqual(s.home.read(), EMPTY);
  assert.strictEqual(s.home.opened('C:\\a'), null);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), newer);
});

test('a file with no version is read as version 1 and written as version 1', () => {
  const s = setup();
  fs.writeFileSync(s.file, JSON.stringify({ projects: [{ root: 'C:\\x', lastOpened: 5 }] }));
  assert.deepStrictEqual(s.home.read(), { projects: [{ root: 'C:\\x', lastOpened: 5 }], pins: [], removed: [] });
  s.home.pin('C:\\x', true);
  assert.strictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).version, 1);
});

test('read sanitizes: strings only, one entry per root (the later time), strict times (Number(null) is 0)', () => {
  const s = setup();
  fs.writeFileSync(s.file, JSON.stringify({
    version: 1,
    projects: [{ root: 'C:\\a', lastOpened: 5 }, { root: 'c:\\A\\', lastOpened: 9 }, { root: 7 }, null, { root: 'C:\\b', lastOpened: null },
      { root: 'C:\\c', lastOpened: '12' }, { root: 'C:\\d', lastOpened: -4 }],
    pins: ['C:\\a', 3, '', 'c:\\a', null],
    removed: 'not a list',
  }));
  assert.deepStrictEqual(s.home.read(), {
    projects: [{ root: 'C:\\a', lastOpened: 9 }, { root: 'C:\\b', lastOpened: null }, { root: 'C:\\c', lastOpened: null }, { root: 'C:\\d', lastOpened: null }],
    pins: ['C:\\a'], removed: [],
  });
});

test('the projects list is capped: the oldest unpinned entry goes first, a pinned one stays', () => {
  const s = setup();
  s.home.opened('C:\\p0');
  s.home.pin('C:\\p0', true);
  for (let i = 1; i <= MAX_PROJECTS; i++) { s.tick(); s.home.opened(`C:\\p${i}`); }
  const roots = s.home.read().projects.map((p) => p.root);
  assert.strictEqual(roots.length, MAX_PROJECTS);
  assert.ok(roots.includes('C:\\p0'), 'the pinned oldest stays');
  assert.ok(!roots.includes('C:\\p1'), 'the oldest unpinned went');
  assert.ok(roots.includes(`C:\\p${MAX_PROJECTS}`));
});

test('the removed set is capped: the oldest removal goes first', () => {
  const s = setup();
  for (let i = 0; i <= MAX_LIST; i++) s.home.remove(`C:\\r${i}`);
  const removed = s.home.read().removed;
  assert.strictEqual(removed.length, MAX_LIST);
  assert.strictEqual(removed[0], 'C:\\r1');
  assert.strictEqual(removed[MAX_LIST - 1], `C:\\r${MAX_LIST}`);
});

test('a store whose lock cannot be taken answers null and logs, never throws', () => {
  const store = { readState: () => ({ status: 'missing', value: null }), write: () => {}, withLock: () => { throw new Error('busy'); } };
  const lines = [];
  const home = createHomeRecord({ store, keyOf, log: (l) => lines.push(l) });
  assert.strictEqual(home.opened('C:\\a'), null);
  assert.match(lines[0], /busy/);
});

test('main records each project window that started (the lifecycle afterStart), and a failed record never costs the window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.match(src, /const homeRecord = createHomeRecord\(\{ store: uiStore,/);
  const fn = /function recordOpened\(pw\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, 'main has a recordOpened(pw)');
  assert.match(fn[1], /try \{ homeRecord\.opened\(pw\.root\); \} catch/);
  const after = /afterStart: \(pw\) => \{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(after, 'the lifecycle has an afterStart');
  assert.match(after[1], /recordOpened\(pw\);/);
});

test('an edit waits at most LOCK_WAIT_MS for the lock: it runs on Electron main, which a 3 s wait would freeze', () => {
  let seen = null;
  const store = { readState: () => ({ status: 'missing', value: null }), write: () => {}, withLock: (name, fn, opts) => { seen = { name, opts }; return fn(); } };
  createHomeRecord({ store, keyOf, now: () => 9 }).opened('C:\\a');
  assert.deepStrictEqual(seen, { name: 'home-projects', opts: { deadlineMs: 500 } });
});

test('createHomeRecord without a store with readState, write and withLock throws and says so', () => {
  assert.throws(() => createHomeRecord({ store: { read() {} } }), /readState, write and withLock/);
});
