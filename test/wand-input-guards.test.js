'use strict';
/**
 * Kill tests for the wand editor and the drawer's /merged wording, from Mortimer's gate on release PR #109 (survivor 15):
 * a padded emoji is saved trimmed (and a padded copy of the stored emoji is no change), an existing favourite's editor is
 * not "new", a wand file without a version says so in those words, and /merged's answer only names what is a string.
 */
const test = require('node:test');
const assert = require('node:assert');

const W = require('../app/wand-display');
const wand = require('../host/wand');
const A = require('../app/git-actions');

const SKILLS = [{ name: 'bedtime', description: 'Overnight run.', source: 'user' }, { name: 'merged', description: 'After a merge.', source: 'user' }];
const FAVS = [{ id: 'f1', emoji: '🌙', skill: 'bedtime', args: '' }];
const loaded = () => W.reduce(W.emptyState(), { type: 'hello', wand: { status: 'ok', favourites: FAVS, unavailable: null, dropped: 0, skills: SKILLS, skillsError: null } });
const editing = (id) => W.openEditor(W.toggleEdit(loaded()), id);

test('wand editor: Save trims the emoji it sends for a new favourite', () => {
  const s = W.editorSet(W.editorSet(editing(null), 'emoji', '  🚀 '), 'skill', 'merged');
  const r = W.editorSubmit(s);
  assert.strictEqual(r.message.type, 'wand-add');
  assert.strictEqual(r.message.emoji, '🚀');
});

test('wand editor: an emoji of only blanks is refused, with nothing sent', () => {
  const s = W.editorSet(W.editorSet(editing(null), 'emoji', '   '), 'skill', 'merged');
  const r = W.editorSubmit(s);
  assert.strictEqual(r.message, null);
  assert.strictEqual(r.state.error, 'Pick or type an emoji.');
});

test('wand editor: the stored emoji with padding is no change, and a changed one is sent trimmed', () => {
  const same = W.editorSubmit(W.editorSet(editing('f1'), 'emoji', ' 🌙 '));
  assert.strictEqual(same.message.type, 'wand-update');
  assert.deepStrictEqual(same.message.patch, {});
  const changed = W.editorSubmit(W.editorSet(editing('f1'), 'emoji', ' 🚀 '));
  assert.deepStrictEqual(changed.message.patch, { emoji: '🚀' });
});

test('wand editor: an existing favourite\'s editor is not new, a fresh one is', () => {
  assert.strictEqual(W.view(editing('f1')).editor.isNew, false);
  assert.strictEqual(W.view(editing(null)).editor.isNew, true);
});

test('wand store: a file with the right shape but no version says it has no version', () => {
  const r = wand.load({ status: 'ok', value: { favourites: [] } });
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'the wand file has no version');
  const bad = wand.load({ status: 'ok', value: { version: 'two', favourites: [] } });
  assert.strictEqual(bad.reason, 'the wand file has no version', 'a version that is not a number is no version, not "version two"');
});

test('mergedSaid: a branch or text that is not a string is not used', () => {
  assert.match(A.mergedSaid({ kind: 'typed', branch: 5 }, 'feat-x'), /Typed \/merged in feat-x's tab/);
  assert.match(A.mergedSaid({ kind: 'typed', branch: '' }, 'feat-x'), /Typed \/merged in feat-x's tab/);
  assert.strictEqual(A.mergedSaid({ kind: 'explain', text: 5 }, 'b'), "Couldn't run /merged.");
  assert.strictEqual(A.mergedSaid({ kind: 'explain', text: '' }, 'b'), "Couldn't run /merged.");
  assert.strictEqual(A.mergedSaid({ kind: 'explain', text: 'nope' }, 'b'), 'nope');
});
