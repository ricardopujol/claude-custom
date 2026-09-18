'use strict';
/**
 * What happens when files are dropped on the window.
 *
 * Ricardo: "The possibility to drag and drop files and make them visible to
 * the session." He chose the strong reading: type the path AND grant the
 * session read access to the file's folder, so Claude can open it without a
 * permission prompt.
 *
 * That makes this module a SECURITY BOUNDARY, not a convenience: a drag
 * gesture widens what a session -- possibly running with permissions bypassed
 * -- may read. So the decision of what to grant is pure, tested, and
 * deliberately narrow: the containing folder, never a parent, never a drive
 * root, and never anything already covered by the project directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { planDrop, MAX_DROP_FILES } = require('../host/drop');

const CWD = 'C:/w/proj';
const at = (p, isDirectory = false) => ({ path: p, isDirectory });

// --- what gets typed -----------------------------------------------------------

test('a dropped file types its absolute path', () => {
  const plan = planDrop({ entries: [at('C:/w/proj/src/index.js')], cwd: CWD });
  assert.strictEqual(plan.text, 'C:/w/proj/src/index.js ');
});

test('several files type as several paths, space separated', () => {
  const plan = planDrop({ entries: [at('C:/w/proj/a.js'), at('C:/w/proj/b.js')], cwd: CWD });
  assert.strictEqual(plan.text, 'C:/w/proj/a.js C:/w/proj/b.js ');
});

test('a path containing spaces is quoted, or it reads as two arguments', () => {
  const plan = planDrop({ entries: [at('C:/w/proj/my notes.md')], cwd: CWD });
  assert.strictEqual(plan.text, '"C:/w/proj/my notes.md" ');
});

test('a trailing space is left so the next thing typed is not glued to the path', () => {
  const plan = planDrop({ entries: [at('C:/w/proj/a.js')], cwd: CWD });
  assert.ok(plan.text.endsWith(' '));
});

// --- what gets granted ---------------------------------------------------------

test('a file already inside the project grants NOTHING', () => {
  // The session can already read it. Issuing /add-dir here would widen access
  // for no reason and train the user to ignore the notice.
  const plan = planDrop({ entries: [at('C:/w/proj/src/index.js')], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, []);
});

test('a file OUTSIDE the project grants its containing folder', () => {
  const plan = planDrop({ entries: [at('C:/Users/ricar/Desktop/spec.pdf')], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, ['C:/Users/ricar/Desktop']);
});

test('a dropped FOLDER grants the folder itself, not its parent', () => {
  const plan = planDrop({ entries: [at('C:/data/corpus', true)], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, ['C:/data/corpus']);
});

test('two files from one folder grant it once', () => {
  const plan = planDrop({
    entries: [at('C:/tmp/a.txt'), at('C:/tmp/b.txt')],
    cwd: CWD,
  });
  assert.deepStrictEqual(plan.dirsToAdd, ['C:/tmp']);
});

test('a folder already granted this session is not granted again', () => {
  const plan = planDrop({
    entries: [at('C:/tmp/a.txt')], cwd: CWD, alreadyGranted: ['C:/tmp'],
  });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.ok(plan.text.includes('C:/tmp/a.txt'), 'the path is still typed');
});

test('the granted-folder check is case- and separator-insensitive on Windows', () => {
  // C:\TMP and C:/tmp are the same folder; granting twice would issue a
  // pointless second /add-dir and double the notice.
  const plan = planDrop({
    entries: [at('C:\TMP\a.txt')], cwd: CWD, alreadyGranted: ['C:/tmp'],
  });
  assert.deepStrictEqual(plan.dirsToAdd, []);
});

test('a file inside the project is recognised whatever the separators', () => {
  const plan = planDrop({ entries: [at('C:\w\proj\src\a.js')], cwd: 'C:/w/proj' });
  assert.deepStrictEqual(plan.dirsToAdd, []);
});

// --- the refusals, which are the point -----------------------------------------

test('a DRIVE ROOT is never granted', () => {
  // Dropping a file from C:\ would otherwise hand the session the whole disk.
  const plan = planDrop({ entries: [at('C:/pagefile.sys')], cwd: CWD });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.ok(plan.refused.length === 1);
  assert.match(plan.refused[0].why, /root/i);
});

test('a home directory is never granted wholesale', () => {
  // Every credential, key and SSH config the user owns lives under it.
  const plan = planDrop({
    entries: [at('C:/Users/ricar/notes.txt')], cwd: CWD, home: 'C:/Users/ricar',
  });
  assert.deepStrictEqual(plan.dirsToAdd, []);
  assert.match(plan.refused[0].why, /home/i);
});

test('a refused grant still types the path, so the drop is not silently useless', () => {
  // Claude can still ask for permission the normal way; what it cannot do is
  // read it without anyone noticing.
  const plan = planDrop({ entries: [at('C:/pagefile.sys')], cwd: CWD });
  assert.ok(plan.text.includes('C:/pagefile.sys'));
});

test('a drop of absurd size is capped rather than typed in full', () => {
  const many = Array.from({ length: MAX_DROP_FILES + 25 }, (_, i) => at(`C:/w/proj/f${i}.js`));
  const plan = planDrop({ entries: many, cwd: CWD });
  assert.strictEqual(plan.used, MAX_DROP_FILES);
  assert.ok(plan.truncated > 0);
});

test('an empty drop is a no-op, not an empty command', () => {
  const plan = planDrop({ entries: [], cwd: CWD });
  assert.strictEqual(plan.text, '');
  assert.deepStrictEqual(plan.dirsToAdd, []);
});

test('entries with no usable path are ignored rather than typed as undefined', () => {
  const plan = planDrop({ entries: [{ path: '' }, { path: null }, at('C:/w/proj/a.js')], cwd: CWD });
  assert.strictEqual(plan.text, 'C:/w/proj/a.js ');
});
