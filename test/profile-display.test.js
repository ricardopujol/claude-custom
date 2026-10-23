'use strict';
/**
 * app/profile-display.js: the header's Profile chip, its menu, and the switch decision (BACKLOG #119 A1, design point 3).
 * Pure: inputs in, a render-ready shape out.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/profile-display');

const DEFAULT = { id: 'default', name: 'Default', colour: null };
const WORK = { id: 'work', name: 'Work', colour: '#4c8bf5' };
const PLAY = { id: 'play', name: 'Play <b>', colour: '#4caf6a' };
const ALL = [DEFAULT, WORK, PLAY];

test('chipView names the current profile and carries its colour', () => {
  const v = D.chipView({ profiles: ALL, currentId: 'work' });
  assert.strictEqual(v.name, 'Work');
  assert.strictEqual(v.colour, '#4c8bf5');
  assert.strictEqual(v.known, true);
  assert.match(v.title, /Work/);
  assert.strictEqual(v.icon, 'user');
});

test('chipView: the default has no colour of its own (the theme\'s shows), and an absent id reads as the default', () => {
  for (const currentId of ['default', undefined, null]) {
    const v = D.chipView({ profiles: ALL, currentId });
    assert.strictEqual(v.name, 'Default');
    assert.strictEqual(v.colour, null);
  }
});

test('chipView: a profile that is no longer in the list is shown by its id, flagged, never as the default', () => {
  const v = D.chipView({ profiles: ALL, currentId: 'gone' });
  assert.strictEqual(v.name, 'gone');
  assert.strictEqual(v.known, false);
  assert.match(v.title, /no longer/i);
  assert.strictEqual(v.colour, null);
});

test('chipView never throws on a missing list', () => {
  for (const profiles of [undefined, null, 'x', [null, 5]]) {
    assert.doesNotThrow(() => D.chipView({ profiles, currentId: 'work' }));
  }
  assert.strictEqual(D.chipView({}).name, 'Default');
});

test('chipView ignores a colour that is not #rrggbb', () => {
  assert.strictEqual(D.chipView({ profiles: [{ id: 'x', name: 'X', colour: 'url(javascript:1)' }], currentId: 'x' }).colour, null);
});

test('menuView lists every profile in order, marks the current one, and ends with Manage profiles…', () => {
  const m = D.menuView({ profiles: ALL, currentId: 'play' });
  assert.deepStrictEqual(m.rows.map(r => r.id), ['default', 'work', 'play']);
  assert.deepStrictEqual(m.rows.map(r => r.current), [false, false, true]);
  assert.strictEqual(m.manageLabel, 'Manage profiles…');
});

test('planSwitch: the same profile does nothing', () => {
  assert.deepStrictEqual(D.planSwitch({ profiles: ALL, currentId: 'work', pickedId: 'work', sessionLive: true }), { action: 'none' });
});

test('planSwitch: with no live session the choice is just set', () => {
  assert.deepStrictEqual(D.planSwitch({ profiles: ALL, currentId: 'default', pickedId: 'work', sessionLive: false }), { action: 'set', id: 'work' });
});

test('planSwitch: with a live session it asks, in the design\'s words, and never ends a session by itself', () => {
  const p = D.planSwitch({ profiles: ALL, currentId: 'default', pickedId: 'work', sessionLive: true });
  assert.strictEqual(p.action, 'confirm');
  assert.strictEqual(p.id, 'work');
  assert.strictEqual(p.text, 'Restart this session as Work? The current session keeps its transcript.');
});

test('planSwitch: an unknown profile, or a non-string pick, is refused', () => {
  for (const pickedId of ['ghost', undefined, null, 5, '']) {
    assert.strictEqual(D.planSwitch({ profiles: ALL, currentId: 'work', pickedId, sessionLive: true }).action, 'refuse', String(pickedId));
  }
});

test('property: a live session NEVER gets action "set" for a different known profile (it always confirms first)', () => {
  fc.assert(fc.property(fc.constantFrom('default', 'work', 'play'), fc.constantFrom('default', 'work', 'play'), (cur, pick) => {
    const p = D.planSwitch({ profiles: ALL, currentId: cur, pickedId: pick, sessionLive: true });
    if (cur === pick) assert.strictEqual(p.action, 'none');
    else assert.strictEqual(p.action, 'confirm');
  }));
});

test('tabDot: the default shows no dot, another profile shows its colour and name, an unknown one nothing', () => {
  assert.strictEqual(D.tabDot({ profiles: ALL, profileId: 'default' }), null);
  assert.strictEqual(D.tabDot({ profiles: ALL, profileId: undefined }), null);
  assert.deepStrictEqual(D.tabDot({ profiles: ALL, profileId: 'work' }), { colour: '#4c8bf5', name: 'Work' });
  assert.strictEqual(D.tabDot({ profiles: ALL, profileId: 'ghost' }), null);
  assert.strictEqual(D.tabDot({ profiles: [{ id: 'x', name: 'X', colour: null }], profileId: 'x' }), null);
});

test('the chip icon is constant Lucide "user" markup that takes the text colour, with no user data in it', () => {
  const svg = D.userIconSvg();
  assert.match(svg, /^<svg class="tb-icon" aria-hidden="true"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /<circle cx="12" cy="7" r="4"/);
  assert.strictEqual(D.userIconSvg(), svg);
  assert.doesNotMatch(svg, /\$\{|undefined|null/);
});
