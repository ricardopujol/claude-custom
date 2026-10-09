'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFaces, sanitizeFaces, MAX_FACES } = require('../app/lean-faces');

const face = (agent, extra = {}) => ({ agent, images: true, portrait: { kind: 'file', path: `C:/p/${agent}.png`, media: 'image', tier: 'forge' }, ...extra });

test('sanitizeFaces: keeps a name, the images flag and the portrait\'s plain fields; drops everything else', () => {
  const [f] = sanitizeFaces([{ agent: 'dexter', images: true, evil: 1, portrait: { kind: 'file', path: 'C:/p/d.png', media: 'image', tier: 'forge', mtimeMs: 5, script: 'x', fallback: { initials: 'DX', hue: 90, junk: 1 } } }]);
  assert.deepStrictEqual(f, { agent: 'dexter', images: true, portrait: { kind: 'file', path: 'C:/p/d.png', media: 'image', tier: 'forge', mtimeMs: 5, fallback: { kind: 'placeholder', initials: 'DX', hue: 90 } } });
});

test('sanitizeFaces: junk is dropped, a missing portrait is null, the images flag is true/false/null only, the list is capped', () => {
  assert.deepStrictEqual(sanitizeFaces('x'), []);
  assert.deepStrictEqual(sanitizeFaces([null, 3, { agent: '' }, { agent: 'a'.repeat(81) }, { agent: 'ok', images: 'yes' }]), [{ agent: 'ok', images: null, portrait: null }]);
  assert.strictEqual(sanitizeFaces(Array.from({ length: 60 }, (_, i) => face('a' + i))).length, MAX_FACES);
});

test('flat: every page\'s agents, one entry per name, in owner order', () => {
  const f = createFaces();
  f.set(1, [face('amy'), face('bob')]);
  f.set(2, [face('bob'), face('cat')]);
  assert.deepStrictEqual(f.flat().map(x => x.agent), ['amy', 'bob', 'cat']);
});

test('set reports a change only when the page\'s list changed; an empty list removes the page', () => {
  const f = createFaces();
  assert.strictEqual(f.set(1, [face('amy')]), true);
  assert.strictEqual(f.set(1, [face('amy')]), false);
  assert.strictEqual(f.set(1, []), true);
  assert.strictEqual(f.set(1, []), false);
  assert.deepStrictEqual(f.flat(), []);
});

test('drop: a closed page leaves no faces', () => {
  const f = createFaces();
  f.set(1, [face('amy')]);
  assert.strictEqual(f.drop(1), true);
  assert.strictEqual(f.drop(1), false);
  assert.deepStrictEqual(f.flat(), []);
});
