'use strict';
/**
 * Jiandu's own record of the projects it opened, the pins and the removed set (documentation/DESIGN_PROJECT_HUB.md §3; plan
 * documentation/PLAN_PROJECT_HUB.md H-PR1 task 7). On a real host/store.js in a temp folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { mainOnly } = require('./main-source');
const { createStore } = require('../host/store');
const { createHomeRecord, STORE_KEY, MAX_PROJECTS, MAX_LIST } = require('../app/home-record');

const keyOf = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').toLowerCase() : null);
// The same fake as test/home-model.test.js: `<x>\dev` and `<x>\feat-*` (and anything inside them) fold to the container `<x>`.
const projectOf = (p) => {
  if (typeof p !== 'string' || !p) return null;
  const m = /^(.*?)\\(dev|feat-[^\\]+)(\\.*)?$/i.exec(p);
  return m ? { kind: 'container', root: m[1], dev: `${m[1]}\\dev` } : { kind: 'flat', root: p, dev: p };
};
function setup({ start = 1000 } = {}) {
  const dir = tmpDir('home-record-');
  const store = createStore({ dir });
  let t = start;
  const lines = [];
  const home = createHomeRecord({ store, keyOf, projectOf, now: () => t, log: (l) => lines.push(l) });
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
  assert.strictEqual(s.lines.length, 3, 'the read says it once, and each refused edit says it');
  assert.match(s.lines[1], /home-projects.*not written/);
  assert.match(s.lines[2], /home-projects.*not written/);
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

test('Dexter 4: with every entry pinned, the root just opened is still recorded (the cap never drops it)', () => {
  const s = setup();
  for (let i = 0; i < MAX_PROJECTS; i++) { s.home.opened(`C:\\p${i}`); s.home.pin(`C:\\p${i}`, true); }
  s.tick();
  s.home.opened('C:\\new');
  const projects = s.home.read().projects;
  assert.deepStrictEqual(projects.find((p) => p.root === 'C:\\new'), { root: 'C:\\new', lastOpened: 1001 });
  assert.strictEqual(projects.length, MAX_PROJECTS + 1, 'pinned entries are never dropped, so the list may pass the cap');
});

test('Miguel G5: a hand-edited file past the cap comes back to MAX_PROJECTS on the next open, the root just opened kept', () => {
  const s = setup({ start: 5000 });
  const projects = Array.from({ length: 250 }, (_, i) => ({ root: `C:\\h${i}`, lastOpened: 6000 + i }));
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, projects, pins: [], removed: [] }));
  s.home.opened('C:\\new');      // now() is 5000: older than every entry in the file
  const roots = s.home.read().projects.map((p) => p.root);
  assert.strictEqual(roots.length, MAX_PROJECTS);
  assert.ok(roots.includes('C:\\new'));
  assert.ok(!roots.includes('C:\\h0') && roots.includes('C:\\h249'));
});

test('Miguel Y2: a version that is not a whole number from 1 is never written over (0, "1", 1.5, -1, null)', () => {
  for (const version of [0, '1', 1.5, -1, null]) {
    const s = setup();
    const text = JSON.stringify({ version, projects: [{ root: 'C:\\x', lastOpened: 5 }], pins: [], removed: [] });
    fs.writeFileSync(s.file, text);
    assert.deepStrictEqual(s.home.read(), EMPTY, `version ${JSON.stringify(version)}`);
    assert.strictEqual(s.home.opened('C:\\a'), null, `version ${JSON.stringify(version)}`);
    assert.strictEqual(fs.readFileSync(s.file, 'utf8'), text);
  }
});

test('Miguel G2 / Dexter 5: a read that finds a damaged or newer file logs one line, once until the file changes', () => {
  const s = setup();
  fs.writeFileSync(s.file, '{ not json');
  s.home.read();
  s.home.read();
  assert.strictEqual(s.lines.length, 1);
  assert.match(s.lines[0], /^\[main\] home-projects: the file is corrupt; Home shows no pins or removed set until it is fixed$/);
  fs.writeFileSync(s.file, JSON.stringify({ version: 3 }));
  s.home.read();
  assert.strictEqual(s.lines.length, 2);
  assert.match(s.lines[1], /version 3, newer than this build's 1/);
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, projects: [] }));
  s.home.read();
  fs.writeFileSync(s.file, '{ not json');
  s.home.read();
  assert.strictEqual(s.lines.length, 3, 'a good read in between: the damage is news again');
});

test('a missing file is no damage: the read logs nothing', () => {
  const s = setup();
  s.home.read();
  assert.deepStrictEqual(s.lines, []);
});

test('Dexter 3 (open question, default built): a pin takes the project out of the removed set, so the pinned card stays', () => {
  const s = setup();
  s.home.remove('C:\\r');
  assert.deepStrictEqual(s.home.pin('c:\\R', true), { projects: [], pins: ['c:\\R'], removed: [] });
  s.home.remove('C:\\q');
  s.home.pin('C:\\q', false);
  assert.deepStrictEqual(s.home.read().removed, ['C:\\q'], 'an unpin leaves the removed set as it is');
});

test('Dexter R2-1: the record folds by rootOf as the model does: a lane-spelled pin is unpinned from its card, a lane-spelled removal clears', () => {
  const { homeCards } = require('../app/home-model');
  const s = setup();
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, projects: [{ root: 'C:\\p', lastOpened: 5 }], pins: ['C:\\p\\feat-a'], removed: ['C:\\q\\dev'] }));
  const cards = () => homeCards({ record: s.home.read(), recents: [], windows: [], windowless: [], projectOf, exists: () => true, keyOf,
    labelOf: (r) => r.split('\\').pop() }).cards;
  assert.deepStrictEqual(cards().map((c) => [c.key, c.pinned]), [['c:\\p', true]]);
  s.home.pin('C:\\p', false);
  assert.deepStrictEqual(cards().map((c) => [c.key, c.pinned]), [['c:\\p', false]]);
  assert.deepStrictEqual(s.home.read().pins, []);
  s.home.opened('C:\\q');
  assert.deepStrictEqual(s.home.read().removed, [], 'an open of the root clears a removal spelled as its lane');
  s.home.remove('C:\\q\\feat-b');
  s.home.pin('C:\\q', true);
  assert.deepStrictEqual(s.home.read().removed, [], 'a pin of the root clears it too');
});

test('Dexter R2-1: a lane path sent to the record is stored as its project root, once', () => {
  const s = setup();
  s.home.opened('C:\\p\\dev');
  s.home.opened('C:\\p\\feat-a\\src');
  s.home.pin('C:\\p\\feat-a', true);
  s.home.remove('C:\\r\\dev');
  assert.deepStrictEqual(s.home.read(), { projects: [{ root: 'C:\\p', lastOpened: 1000 }], pins: ['C:\\p'], removed: ['C:\\r'] });
});

test('a store whose lock cannot be taken answers null and logs, never throws', () => {
  const store = { readState: () => ({ status: 'missing', value: null }), write: () => {}, withLock: () => { throw new Error('busy'); } };
  const lines = [];
  const home = createHomeRecord({ store, keyOf, log: (l) => lines.push(l) });
  assert.strictEqual(home.opened('C:\\a'), null);
  assert.match(lines[0], /busy/);
});

test('main records each project window that started (the lifecycle afterStart), and a failed record never costs the window', () => {
  const src = mainOnly({ strip: true });
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
