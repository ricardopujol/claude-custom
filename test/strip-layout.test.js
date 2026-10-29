'use strict';
/**
 * host/strip-layout.js (BACKLOG #141 + the design's "closed stays closed"): the strip's drag order and the lanes closed by
 * hand, kept beside the project's other state so both survive a restart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createStripLayout, stripLayoutFileFor, parseLayout, FILE_NAME } = require('../host/strip-layout');

function memory(initial) {
  const files = new Map(initial === undefined ? [] : [['F', initial]]);
  const writes = [];
  return {
    files, writes,
    layout: createStripLayout({
      file: 'F',
      readText: (f) => { if (!files.has(f)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(f); },
      writeText: (f, t) => { writes.push(t); files.set(f, t); },
      mkdir: () => {},
    }),
  };
}

const CLOSED = { key: 'c:\\p\\feat-a', path: 'C:\\p\\feat-a', branch: 'feat/a' };

test('no file yet is an empty layout, and saving then loading round-trips', () => {
  const m = memory();
  assert.deepStrictEqual(m.layout.load(), { order: [], closed: [], error: null });
  assert.deepStrictEqual(m.layout.save({ order: ['c:\\p\\b', 'c:\\p\\a'], closed: [CLOSED] }), { ok: true });
  const again = createStripLayout({ file: 'F', readText: (f) => m.files.get(f), writeText: () => assert.fail('a read writes nothing'), mkdir: () => {} });
  assert.deepStrictEqual(again.load(), { order: ['c:\\p\\b', 'c:\\p\\a'], closed: [CLOSED], error: null });
});

test('the file name sits in the look folder under the project, and a foreign look folder means no file', () => {
  assert.strictEqual(FILE_NAME, 'tab-strip.json');
  assert.strictEqual(stripLayoutFileFor('C:\\proj', {
    lstatSync: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, mkdirSync: () => {}, existsSync: () => true,
  }).endsWith(FILE_NAME), true);
  assert.strictEqual(stripLayoutFileFor('C:\\proj', {
    lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => true }),
  }), null);
});

test('a file that is not understood is left alone: load says so, and save refuses to write over it', () => {
  for (const bad of ['{ nope', '[]', '"x"', 'null']) {
    const m = memory(bad);
    const r = m.layout.load();
    assert.deepStrictEqual([r.order, r.closed], [[], []], bad);
    assert.ok(typeof r.error === 'string' && r.error !== '', bad);
    assert.strictEqual(m.layout.save({ order: ['a'], closed: [] }).ok, false, bad);
    assert.deepStrictEqual(m.writes, [], bad);
  }
});

test('a read that fails some other way (a scan holding the file) is an unknown store, not an empty one', () => {
  const layout = createStripLayout({
    file: 'F', readText: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, writeText: () => assert.fail('must not write'), mkdir: () => {},
  });
  assert.ok(layout.load().error);
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, false);
});

test('without a file (a look folder that is a link elsewhere) it lives in memory for this run and says ok', () => {
  const layout = createStripLayout({ file: null });
  assert.deepStrictEqual(layout.load(), { order: [], closed: [], error: null });
  assert.deepStrictEqual(layout.save({ order: ['a'], closed: [] }), { ok: true });
});

test('a failed write is an error answer, never a throw', () => {
  const layout = createStripLayout({
    file: 'F', readText: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, writeText: () => { throw new Error('disk full'); }, mkdir: () => {},
  });
  layout.load();
  assert.deepStrictEqual(layout.save({ order: ['a'], closed: [] }), { ok: false, error: 'disk full' });
});

test('strict parsing: bad entries are dropped one by one, repeats once, and nothing coerces', () => {
  const r = parseLayout(JSON.stringify({
    version: 1,
    order: ['a', '', 7, null, 'b', 'a', {}],
    closed: [CLOSED, { key: 'x' }, { key: 5, path: 'p' }, null, 'str', { ...CLOSED }, { key: 'k2', path: 'P2', branch: 9 }, { key: 'k3', path: 'P3', branch: '' }],
  }));
  assert.deepStrictEqual(r.order, ['a', 'b']);
  assert.deepStrictEqual(r.closed, [
    CLOSED,
    { key: 'k2', path: 'P2', branch: null },
    { key: 'k3', path: 'P3', branch: null },
  ]);
});

test('a missing or wrong-typed list is an empty one', () => {
  assert.deepStrictEqual(parseLayout('{"version":1}'), { order: [], closed: [] });
  assert.deepStrictEqual(parseLayout('{"order":"a","closed":{}}'), { order: [], closed: [] });
});

test('lists are bounded when written, keeping the newest closed (they are most recent first) and the first of the order', () => {
  const m = memory();
  const order = Array.from({ length: 700 }, (_, i) => `k${i}`);
  const closed = Array.from({ length: 300 }, (_, i) => ({ key: `c${i}`, path: `P${i}`, branch: null }));
  m.layout.save({ order, closed });
  const r = parseLayout(m.files.get('F'));
  assert.strictEqual(r.order.length, 500);
  assert.strictEqual(r.order[0], 'k0');
  assert.strictEqual(r.closed.length, 100);
  assert.strictEqual(r.closed[0].key, 'c0');
});

test('property: whatever is saved, what loads is clean (strings, no repeats) and a second save of it changes nothing', () => {
  const junk = fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined), fc.constant({}));
  fc.assert(fc.property(fc.array(junk, { maxLength: 30 }), fc.array(fc.record({ key: junk, path: junk, branch: junk }, { requiredKeys: [] }), { maxLength: 10 }), (order, closed) => {
    const m = memory();
    m.layout.save({ order, closed });
    const text = m.files.get('F');
    const first = parseLayout(text);
    assert.ok(first.order.every(k => typeof k === 'string' && k !== ''));
    assert.strictEqual(new Set(first.order).size, first.order.length);
    assert.ok(first.closed.every(c => typeof c.key === 'string' && c.key !== '' && typeof c.path === 'string' && c.path !== ''));
    m.layout.save(first);
    assert.deepStrictEqual(parseLayout(m.files.get('F')), first);
  }), { numRuns: 200 });
});
