'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { menuModel, ageText, windowsText, folderText } = require('../app/background-menu');

const NOW = 1790000000000;
const row = (over = {}) => ({
  install: 'C:\\cc\\feat-a', build: 'feat-a', own: true, port: 7701, pid: 101,
  cwd: 'C:\\Users\\ricar\\VibeCode\\agent-creator', startedAt: NOW - 3 * 3600e3, processStartedAt: '1', windows: 0,
  ...over,
});
const model = (rows, over = {}) => menuModel({ rows, verified: true, ...over }, { now: NOW, tabsByPort: new Map(), ...over.ctx });

test('ageText: coarse and honest', () => {
  assert.strictEqual(ageText(NOW - 20e3, NOW), 'just now');
  assert.strictEqual(ageText(NOW - 5 * 60e3, NOW), '5 min');
  assert.strictEqual(ageText(NOW - 59 * 60e3, NOW), '59 min');
  assert.strictEqual(ageText(NOW - 3 * 3600e3, NOW), '3 h');
  assert.strictEqual(ageText(NOW - 50 * 3600e3, NOW), '2 d');
  assert.strictEqual(ageText(NOW + 60e3, NOW), 'just now');        // a clock that moved back
  for (const bad of [null, undefined, NaN, '5']) assert.strictEqual(ageText(bad, NOW), 'age unknown');
});

test("windowsText: null is unknown, never 'no window'", () => {
  assert.strictEqual(windowsText(0), 'no window');
  assert.strictEqual(windowsText(1), '1 window');
  assert.strictEqual(windowsText(3), '3 windows');
  assert.strictEqual(windowsText(null), 'windows unknown');
});

test('folderText: the last two parts of the folder', () => {
  assert.strictEqual(folderText('C:\\Users\\ricar\\VibeCode\\agent-creator'), 'VibeCode\\agent-creator');
  assert.strictEqual(folderText('C:/a/b/'), 'a\\b');
  assert.strictEqual(folderText('C:\\'), 'C:\\');
  assert.strictEqual(folderText('C:\\x'), 'x');
});

test("an own windowless host: Open in a new window, and Stop", () => {
  const m = model([row()]);
  assert.strictEqual(m.items.length, 1);
  const it = m.items[0];
  assert.strictEqual(it.label, 'VibeCode\\agent-creator  ·  feat-a  ·  3 h  ·  no window');
  assert.deepStrictEqual(it.open, { kind: 'window', port: 7701, cwd: row().cwd });
  assert.strictEqual(it.stop, true);
  assert.strictEqual(m.footer, null);
});

test("another build's host: Stop only, never Open", () => {
  const it = model([row({ own: false, build: 'dev' })]).items[0];
  assert.strictEqual(it.open, null);
  assert.strictEqual(it.stop, true);
});

test('a host with a window is not offered Stop', () => {
  for (const windows of [1, 2]) {
    const it = model([row({ windows })]).items[0];
    assert.strictEqual(it.stop, false);
    assert.deepStrictEqual(it.open, { kind: 'window', port: 7701, cwd: row().cwd });
  }
});

test("unknown windows still offer Stop: the stop itself asks, and refuses with a window", () => {
  assert.strictEqual(model([row({ windows: null })]).items[0].stop, true);
});

test('a host that is a tab in THIS window: Open selects that tab, and it says so', () => {
  const m = menuModel({ rows: [row({ windows: 1 })], verified: true }, { now: NOW, tabsByPort: new Map([[7701, 'tab-key']]) });
  const it = m.items[0];
  assert.deepStrictEqual(it.open, { kind: 'select-tab', key: 'tab-key' });
  assert.match(it.label, /open here$/);
  assert.strictEqual(it.stop, false);
});

test("a tab's port in another build's row is not this window's tab", () => {
  const m = menuModel({ rows: [row({ own: false })] , verified: true }, { now: NOW, tabsByPort: new Map([[7701, 'tab-key']]) });
  assert.strictEqual(m.items[0].open, null);
});

test('the footer: nothing running, or not everything could be checked', () => {
  assert.strictEqual(model([]).footer, 'No sessions running.');
  assert.strictEqual(menuModel({ rows: [], verified: false }, { now: NOW, tabsByPort: new Map() }).footer,
    "Couldn't check every session; some may be missing.");
  assert.strictEqual(menuModel({ rows: [row()], verified: false }, { now: NOW, tabsByPort: new Map() }).footer,
    "Couldn't check every session; some may be missing.");
  assert.strictEqual(menuModel(null, { now: NOW }).footer, "Couldn't check every session; some may be missing.");
});

test('each item keeps its row, for the stop', () => {
  const r = row();
  assert.strictEqual(model([r]).items[0].row, r);
});
