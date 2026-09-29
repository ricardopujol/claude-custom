'use strict';
/**
 * Dexter N1 (PR #64 round 2): the host's own _global watcher echoes
 * {ok:true, quiet:true} 150 ms after every change it made itself. On a
 * partial-success set-global / reset-global (a leftover that could not be
 * removed) that echo erased the refusal from the Style row.
 */
const test = require('node:test');
const assert = require('node:assert');

const { reduceAvatars, emptyStyleState } = require('../app/style-display');

const REASON = 'the new picture was saved, but the old default.png could not be removed and is still shown';
const info = { set: true, file: 'default.png', media: 'image' };

test('N1: a refusal followed by the watcher echo keeps the reason', () => {
  let s = emptyStyleState();
  s = reduceAvatars(s, { type: 'portrait', global: true, ok: false, reason: REASON, globalPortrait: info });
  s = reduceAvatars(s, { type: 'portrait', global: true, ok: true, quiet: true, globalPortrait: info });
  assert.strictEqual(s.avatars.error, REASON);
});

test('N1: a quiet message still refreshes the picture the row names', () => {
  let s = reduceAvatars(emptyStyleState(), { type: 'hello', globalPortrait: { set: false, file: null, media: null } });
  s = reduceAvatars(s, { type: 'portrait', global: true, ok: true, quiet: true, globalPortrait: info });
  assert.deepStrictEqual(s.avatars.global, info);
});

test('N1: a quiet message with no error leaves it null', () => {
  const s = reduceAvatars(emptyStyleState(), { type: 'portrait', global: true, quiet: true, ok: true, globalPortrait: info });
  assert.strictEqual(s.avatars.error, null);
});

test('N1: a quiet message never sets an error either, whatever its ok says', () => {
  const s = reduceAvatars(emptyStyleState(), { type: 'portrait', global: true, quiet: true, ok: false, reason: 'x', globalPortrait: info });
  assert.strictEqual(s.avatars.error, null);
});

test('N1: a later NON-quiet success still clears the error', () => {
  let s = reduceAvatars(emptyStyleState(), { type: 'portrait', global: true, ok: false, reason: REASON, globalPortrait: info });
  s = reduceAvatars(s, { type: 'portrait', global: true, ok: true, globalPortrait: { set: false, file: null, media: null } });
  assert.strictEqual(s.avatars.error, null);
});
