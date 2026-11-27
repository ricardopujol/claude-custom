'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');



const { createRightClickFilter, isRightCode } = require('../app/right-click-guard');

const sgr = (b, press = true) => `\x1b[<${b};12;7${press ? 'M' : 'm'}`;
const legacy = (b) => `\x1b[M${String.fromCharCode(b + 32)}${String.fromCharCode(12 + 32)}${String.fromCharCode(7 + 32)}`;

test('an SGR right-button press, release and drag are dropped, with or without modifiers', () => {
  const f = createRightClickFilter();
  for (const b of [2, 2 + 4, 2 + 8, 2 + 16, 2 + 32]) assert.equal(f.drop(sgr(b)), true, `press ${b}`);
  assert.equal(f.drop(sgr(2, false)), true, 'release');
});

test('left, middle, wheel and the other reports are kept', () => {
  const f = createRightClickFilter();
  for (const b of [0, 1, 32, 33, 64, 65, 66, 67]) assert.equal(f.drop(sgr(b)), false, `button ${b}`);
  assert.equal(f.drop(sgr(0, false)), false);
});

test('the legacy encoding: a right press is dropped and so is its release, but not a left release', () => {
  const f = createRightClickFilter();
  assert.equal(f.drop(legacy(0)), false, 'left press');
  assert.equal(f.drop(legacy(3)), false, 'left release');
  assert.equal(f.drop(legacy(2)), true, 'right press');
  assert.equal(f.drop(legacy(3)), true, 'its release');
  assert.equal(f.drop(legacy(3)), false, 'a second release is nobody\'s');
});

test('typed text, focus reports and an unknown escape are kept', () => {
  const f = createRightClickFilter();
  for (const d of ['a', '\x1b[I', '\x1b[O', '\x1b[A', '\x1b[200~paste\x1b[201~', '', null, undefined, 5]) assert.equal(f.drop(d), false, JSON.stringify(d));
});

test('a plain shell tab keeps its right-button reports (Dexter 3): the filter is off when isActive says no', () => {
  let active = false;
  const f = createRightClickFilter(() => active);
  assert.equal(f.drop(sgr(2)), false);
  assert.equal(f.drop(legacy(2)), false);
  active = true;
  assert.equal(f.drop(sgr(2)), true, 'it is asked each time');
});

test('isRightCode is strict about what a right button is', () => {
  assert.equal(isRightCode(2), true);
  assert.equal(isRightCode(66), false, 'wheel');
  assert.equal(isRightCode(null), false);
  assert.equal(isRightCode(NaN), false);
});

test('the filter is a pure function of what xterm sends: it needs no element and offers nothing to attach (PR #251 Dexter 4)', () => {
  const mod = require('../app/right-click-guard');
  assert.deepEqual(Object.keys(mod).sort(), ['createRightClickFilter', 'isRightCode']);
  assert.deepEqual(Object.keys(createRightClickFilter()), ['drop']);
});
