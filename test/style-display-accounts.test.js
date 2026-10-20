'use strict';
/**
 * The Style panel's Accounts section (BACKLOG #119 A1, design point 5): list, add, rename, remove, open folder.
 * No sign-in button: the terminal does that. Pure view + reducer, like the other sections.
 */
const test = require('node:test');
const assert = require('node:assert');

const S = require('../app/style-display');

const DEFAULT = { id: 'default', name: 'Default', colour: null, configDir: null };
const WORK = { id: 'work', name: 'Work', colour: '#4c8bf5', configDir: 'C:\\Users\\x\\.claude-profiles\\work' };

test('Accounts is a registered Style section', () => {
  assert.ok(S.STYLE_SECTIONS.some(s => s.id === 'accounts' && s.title === 'Accounts'));
  const sec = S.styleDisplay(S.emptyStyleState()).find(s => s.id === 'accounts');
  assert.ok(sec && sec.view, 'an unread state still draws the section');
});

test('before main answers the section is "reading…", not an empty list', () => {
  const v = S.accountsSectionView(S.emptyStyleState().accounts);
  assert.strictEqual(v.known, false);
  assert.deepStrictEqual(v.rows, []);
});

test('rows: the default is listed first, unrenameable and unremovable, with the CLI\'s own folder named', () => {
  const v = S.accountsSectionView({ profiles: [DEFAULT, WORK], inUse: [], error: null });
  assert.strictEqual(v.known, true);
  const d = v.rows[0];
  assert.strictEqual(d.id, 'default');
  assert.strictEqual(d.canRename, false);
  assert.strictEqual(d.canRemove, false);
  assert.match(d.folder, /own folder/i);
  assert.strictEqual(d.canOpenFolder, false);
});

test('a profile in use by a tab cannot be removed, and says why; an unused one can', () => {
  const used = S.accountsSectionView({ profiles: [DEFAULT, WORK], inUse: ['work'], error: null }).rows[1];
  assert.strictEqual(used.canRemove, false);
  assert.match(used.removeWhy, /tab/i);
  const free = S.accountsSectionView({ profiles: [DEFAULT, WORK], inUse: [], error: null }).rows[1];
  assert.strictEqual(free.canRemove, true);
  assert.strictEqual(free.canRename, true);
  assert.strictEqual(free.canOpenFolder, true);
  assert.strictEqual(free.folder, WORK.configDir);
});

test('the note says sign-in happens in the terminal and that removing never deletes the folder', () => {
  const v = S.accountsSectionView({ profiles: [DEFAULT], inUse: [], error: null });
  assert.match(v.note, /\/login|terminal/i);
  assert.match(v.note, /never deletes|doesn't delete|does not delete/i);
});

test('reduceAccounts takes main\'s list; a malformed one changes nothing; an error is kept beside the last good list', () => {
  let s = S.reduceAccounts(S.emptyStyleState(), { profiles: [DEFAULT, WORK], inUse: ['work'] });
  assert.deepStrictEqual(s.accounts.profiles.map(p => p.id), ['default', 'work']);
  assert.deepStrictEqual(s.accounts.inUse, ['work']);
  const same = S.reduceAccounts(s, { profiles: 'nope' });
  assert.deepStrictEqual(same.accounts, s.accounts);
  const err = S.reduceAccounts(s, { error: 'that folder is the default account\'s' });
  assert.strictEqual(err.accounts.error, 'that folder is the default account\'s');
  assert.deepStrictEqual(err.accounts.profiles, s.accounts.profiles);
  const ok = S.reduceAccounts(err, { profiles: [DEFAULT], inUse: [] });
  assert.strictEqual(ok.accounts.error, null);
});

test('reduceAccounts drops entries that are not profiles and non-string in-use ids', () => {
  const s = S.reduceAccounts(S.emptyStyleState(), { profiles: [DEFAULT, null, { id: 5 }, WORK], inUse: ['work', 5, null] });
  assert.deepStrictEqual(s.accounts.profiles.map(p => p.id), ['default', 'work']);
  assert.deepStrictEqual(s.accounts.inUse, ['work']);
});
