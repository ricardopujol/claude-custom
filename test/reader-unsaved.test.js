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
  assert.strictEqual(closeDetail({ reason: 'Two agents are working.' }), 'Two agents are working.\nThe folder stays.');
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
  const u = createUnsaved();
  u.report('k', 'a\nThe folder is deleted.\n"x');
  const d = closeDetail({ unsaved: u.pathFor('k') });
  assert.strictEqual(d.split('\n').length, 2);
  assert.match(d, /a\\nThe folder is deleted\.\\n\\"x/);
});

test('N4: a hostile name is escaped once, where it is stored, so every reason and dialog that shows it is safe', () => {
  const { closeReasons } = require('../host/close-safety');
  const u = createUnsaved();
  u.report('k', 'a\nX\u0007');
  const name = u.pathFor('k');
  assert.doesNotMatch(name, /[\u0000-\u001f]/);
  const reasons = closeReasons({ merged: true, dirtyCount: 0, unpushedCount: 0, agentsHere: 0, session: 'idle', readerUnsaved: name });
  assert.doesNotMatch(reasons.join('\n'), /[\u0000-\u001f]/);
  assert.doesNotMatch(u.all()[0].path, /[\u0000-\u001f]/, 'the window-close list reads the same escaped name');
});

test('N1: a timed-out Save and close SAYS the window stayed open', async () => {
  const notes = [];
  const d = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask: async () => 'save', waitCleared: async () => false, notify: (m) => notes.push(m) });
  assert.strictEqual(await guardWindowClose(d), false);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /stays open/);
  const ok = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask: async () => 'save', notify: (m) => notes.push(m) });
  await guardWindowClose(ok);
  assert.strictEqual(notes.length, 1, 'a save that cleared says nothing');
});

// ---- PR #155 (Dexter 2): closing the WINDOW with unsaved reader text asks too ----
const { guardWindowClose } = require('../app/reader-unsaved');

const deps = (over = {}) => {
  const log = [];
  return {
    log,
    list: () => [],
    ask: async (files) => { log.push(['ask', files]); return 'cancel'; },
    saveAll: () => { log.push(['saveAll']); },
    waitCleared: async () => { log.push(['wait']); return true; },
    ...over,
  };
};

test('all() lists every tab\'s unsaved file, oldest first', () => {
  const u = createUnsaved();
  u.report('a', 'x.js');
  u.report('b', 'y.js');
  u.report('a', 'z.js');
  assert.deepStrictEqual(u.all(), [{ key: 'a', path: 'z.js' }, { key: 'b', path: 'y.js' }]);
  u.clear('a');
  assert.deepStrictEqual(u.all(), [{ key: 'b', path: 'y.js' }]);
});

test('window close with nothing unsaved closes without asking', async () => {
  const d = deps();
  assert.strictEqual(await guardWindowClose(d), true);
  assert.deepStrictEqual(d.log, []);
});

test('window close with unsaved text asks, naming the files; Cancel keeps the window', async () => {
  const d = deps({ list: () => [{ key: 'a', path: 'src/x.js' }, { key: 'b', path: 'y.js' }] });
  assert.strictEqual(await guardWindowClose(d), false);
  assert.deepStrictEqual(d.log, [['ask', ['src/x.js', 'y.js']]]);
});

test('Discard closes without saving', async () => {
  const d = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask: async () => 'discard' });
  assert.strictEqual(await guardWindowClose(d), true);
  assert.deepStrictEqual(d.log, []);
});

test('Save asks the pages to save, waits for the unsaved entries to clear, and closes only if they did', async () => {
  const ok = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask: async () => 'save' });
  assert.strictEqual(await guardWindowClose(ok), true);
  assert.deepStrictEqual(ok.log, [['saveAll'], ['wait']]);
  const stuck = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask: async () => 'save', waitCleared: async () => false });
  assert.strictEqual(await guardWindowClose(stuck), false, 'a save that hit a conflict or an error keeps the window open');
});

test('anything but save / discard (a throw, a junk answer) keeps the window open', async () => {
  for (const ask of [async () => { throw new Error('x'); }, async () => 'yes', async () => undefined]) {
    const d = deps({ list: () => [{ key: 'a', path: 'x.js' }], ask });
    assert.strictEqual(await guardWindowClose(d), false);
  }
});

test('Miguel S3: the dialog does not say it twice when the reason already names the unsaved file', () => {
  const d = closeDetail({ reason: 'You have unsaved edits to a.js in the file reader.', unsaved: 'a.js' });
  assert.strictEqual(d, 'You have unsaved edits to a.js in the file reader.\nThe folder stays.');
});

test('BACKLOG #132: pathsFor joins the files unsaved under several tabs, and is null when none is', () => {
  const u = createUnsaved();
  assert.strictEqual(u.pathsFor('a', 'a|side'), null);
  u.report('a|side', 'README.md');
  assert.strictEqual(u.pathsFor('a', 'a|side'), 'README.md');
  u.report('a', 'x.js');
  assert.strictEqual(u.pathsFor('a', 'a|side'), 'x.js, README.md');
});
