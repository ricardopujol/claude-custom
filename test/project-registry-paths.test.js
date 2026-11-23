'use strict';
/** The registry keys a window by the project's NORMALISED root, so one folder in two spellings is one window (PR #256 Dexter 2). */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');

const win = (root) => ({ root, isStrip: () => false, isTabView: () => false, canvasViews: { isPanel: () => false }, dispose() {} });

test('the same folder spelled with a trailing separator or a ./ segment is the same window', () => {
  const r = createProjectRegistry();
  const a = r.add(win(process.platform === 'win32' ? 'C:\\Temp\\proj' : '/tmp/proj'));
  const sep = process.platform === 'win32' ? '\\' : '/';
  const base = process.platform === 'win32' ? 'C:\\Temp\\proj' : '/tmp/proj';
  assert.strictEqual(r.get(base + sep), a);
  assert.strictEqual(r.get(base + sep + '.'), a);
  assert.throws(() => r.add(win(base + sep)), /already registered/);
});

test('on Windows the same folder in another case is the same window', { skip: process.platform !== 'win32' }, () => {
  const r = createProjectRegistry();
  const a = r.add(win('C:\\Temp\\proj'));
  assert.strictEqual(r.get('c:\\temp\\PROJ'), a);
  assert.throws(() => r.add(win('c:\\temp\\proj')), /already registered/);
  r.remove(win('c:\\temp\\proj'));
  assert.strictEqual(r.size(), 1, 'removing needs the very window, not a lookalike');
  r.remove(a);
  assert.strictEqual(r.size(), 0);
});

test('a window\'s own spelling is kept (root is what the window says it is); only the key is normalised', () => {
  const r = createProjectRegistry();
  const w = r.add(win(process.platform === 'win32' ? 'C:\\Temp\\Proj' : '/tmp/Proj'));
  assert.strictEqual(r.list()[0].root, w.root);
});

test('closed() finds the window by the same key', () => {
  const r = createProjectRegistry();
  const a = r.add(win(process.platform === 'win32' ? 'C:\\A' : '/a'));
  const b = r.add(win(process.platform === 'win32' ? 'C:\\B' : '/b'));
  assert.strictEqual(r.closed(a), true);
  assert.strictEqual(r.get(b.root), b);
  assert.strictEqual(r.closed(b), false, 'the last stays');
});
