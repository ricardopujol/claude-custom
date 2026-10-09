'use strict';
/**
 * #50: closing a tab says so when its reader holds unsaved edits. main keeps one entry per tab (reported by the
 * page); the "End session" dialog adds a line for it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createUnsaved, closeDetail } = require('../app/reader-unsaved');

test('a tab\'s unsaved file is remembered per tab, replaced by the next report, and forgotten by a null', () => {
  const u = createUnsaved();
  assert.strictEqual(u.pathFor('a'), null);
  u.report('a', 'src/x.js');
  u.report('b', 'README.md');
  assert.strictEqual(u.pathFor('a'), 'src/x.js');
  assert.strictEqual(u.pathFor('b'), 'README.md');
  u.report('a', 'src/y.js');
  assert.strictEqual(u.pathFor('a'), 'src/y.js');
  u.report('a', null);
  assert.strictEqual(u.pathFor('a'), null);
  assert.strictEqual(u.pathFor('b'), 'README.md', 'another tab is untouched');
});

test('anything but a non-empty string forgets the entry; a bad key is ignored', () => {
  const u = createUnsaved();
  for (const bad of ['', undefined, 5, {}, ['x']]) {
    u.report('a', 'f.js');
    u.report('a', bad);
    assert.strictEqual(u.pathFor('a'), null, String(bad));
  }
  u.report('', 'f.js');
  u.report(undefined, 'f.js');
  assert.strictEqual(u.pathFor(''), null);
});

test('clear forgets a tab (it was ended)', () => {
  const u = createUnsaved();
  u.report('a', 'f.js');
  u.clear('a');
  assert.strictEqual(u.pathFor('a'), null);
});

test('a hostile path is capped in length', () => {
  const u = createUnsaved();
  u.report('a', 'x'.repeat(5000));
  assert.strictEqual(u.pathFor('a').length, 300);
});

test('the dialog detail is unchanged with nothing unsaved', () => {
  assert.strictEqual(closeDetail({}), 'The folder stays.');
  assert.strictEqual(closeDetail({ reason: 'two agents are working' }), 'Not closed without asking: two agents are working.\nThe folder stays.');
  assert.strictEqual(closeDetail({ unsaved: null }), 'The folder stays.');
  assert.strictEqual(closeDetail({ unsaved: '' }), 'The folder stays.');
});

test('with unsaved edits the detail names the file and says they will be lost', () => {
  const d = closeDetail({ unsaved: 'src/x.js' });
  assert.match(d, /The folder stays\./);
  assert.match(d, /unsaved edits to src\/x\.js in the file reader; they will be lost/);
  const both = closeDetail({ reason: 'r', unsaved: 'a.js' });
  assert.strictEqual(both.split('\n').length, 3);
});

test('a newline or quote in the file name cannot forge a line in the dialog', () => {
  const d = closeDetail({ unsaved: 'a\nThe folder is deleted.\n"x' });
  assert.strictEqual(d.split('\n').length, 2);
  assert.match(d, /a\\nThe folder is deleted\.\\n\\"x/);
});
