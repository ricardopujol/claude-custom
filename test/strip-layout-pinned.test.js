'use strict';
/**
 * host/strip-layout.js, the `pinned` list (BACKLOG #167; documentation/DESIGN_TABS_SESSIONS.md 3.2): the lanes the person pinned,
 * kept beside `order` in tab-strip.json. Parsed like `order`, saved like `order` (this window's only if this window changed it).
 */
const test = require('node:test');
const assert = require('node:assert');

const { createStripLayout, parseLayout } = require('../host/strip-layout');

function memory(initial) {
  const box = { text: initial };
  const layout = createStripLayout({
    file: 'F',
    readText: () => { if (box.text === undefined) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return box.text; },
    writeText: (f, t) => { box.text = t; },
    mkdir: () => {},
  });
  return { box, layout };
}

test('parseLayout carries pinned like order: strings only, once each, junk dropped', () => {
  const r = parseLayout(JSON.stringify({ version: 1, order: [], closed: [], pinned: ['a', '', 7, null, 'b', 'a', {}] }));
  assert.deepStrictEqual(r.pinned, ['a', 'b']);
});

test('a file with no pinned (an older build wrote it) reads as nothing pinned', () => {
  assert.deepStrictEqual(parseLayout('{"version":1,"order":["a"]}').pinned, []);
  assert.deepStrictEqual(parseLayout('{"pinned":"a"}').pinned, []);
});

test('pinned is saved and loads back, in the order it was given', () => {
  const m = memory();
  m.layout.load();
  assert.deepStrictEqual(m.layout.save({ order: [], closed: [], pinned: ['b', 'a'] }), { ok: true });
  assert.deepStrictEqual(JSON.parse(m.box.text).pinned, ['b', 'a']);
  const again = createStripLayout({ file: 'F', readText: () => m.box.text, writeText: () => assert.fail('a read writes nothing'), mkdir: () => {} });
  assert.deepStrictEqual(again.load().pinned, ['b', 'a']);
});

test('load of a missing file, and of a file that is not understood, has an empty pinned', () => {
  assert.deepStrictEqual(memory().layout.load().pinned, []);
  assert.deepStrictEqual(memory('{ nope').layout.load().pinned, []);
  assert.deepStrictEqual(createStripLayout({ file: null }).load().pinned, []);
});

test('a window that did not change the pins leaves the other window\'s pins alone; one that did, wins', () => {
  const m = memory(JSON.stringify({ version: 1, order: [], closed: [], pinned: ['a'] }));
  const a = m.layout;
  a.load();
  // another window pins b after this one loaded
  m.box.text = JSON.stringify({ version: 1, order: [], closed: [], pinned: ['a', 'b'] });
  a.save({ order: ['x'], closed: [], pinned: ['a'] });       // this window only dragged
  assert.deepStrictEqual(JSON.parse(m.box.text).pinned, ['a', 'b'], 'the other window\'s pin stands');
  a.save({ order: ['x'], closed: [], pinned: [] });          // this window unpinned a
  assert.deepStrictEqual(JSON.parse(m.box.text).pinned, [], 'this window changed it, so it is this window\'s');
});

test('a save that carries no pinned at all (an older caller) keeps what is on disk', () => {
  const m = memory(JSON.stringify({ version: 1, order: [], closed: [], pinned: ['a'] }));
  m.layout.load();
  m.layout.save({ order: [], closed: [] });
  assert.deepStrictEqual(JSON.parse(m.box.text).pinned, ['a']);
});
