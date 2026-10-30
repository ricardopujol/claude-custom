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

const { normPath } = require('../host/project-layout');
const entry = (name, branch = null) => ({ key: normPath(`C:\\p\\${name}`), path: `C:\\p\\${name}`, branch });
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
    closed: [CLOSED, { key: 'x' }, { key: 5, path: 'p' }, null, 'str', { ...CLOSED }, { ...entry('k2'), branch: 9 }, { ...entry('k3'), branch: '' }],
  }));
  assert.deepStrictEqual(r.order, ['a', 'b']);
  assert.deepStrictEqual(r.closed, [
    CLOSED,
    entry('k2'),
    entry('k3'),
  ]);
});

test('a missing or wrong-typed list is an empty one', () => {
  assert.deepStrictEqual(parseLayout('{"version":1}'), { order: [], closed: [] });
  assert.deepStrictEqual(parseLayout('{"order":"a","closed":{}}'), { order: [], closed: [] });
});

test('lists are bounded when written, keeping the newest closed (they are most recent first) and the first of the order', () => {
  const m = memory();
  const order = Array.from({ length: 700 }, (_, i) => `k${i}`);
  const closed = Array.from({ length: 300 }, (_, i) => entry(`c${i}`));
  m.layout.save({ order, closed });
  const r = parseLayout(m.files.get('F'));
  assert.strictEqual(r.order.length, 500);
  assert.strictEqual(r.order[0], 'k0');
  assert.strictEqual(r.closed.length, 100);
  assert.strictEqual(r.closed[0].key, entry('c0').key);
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

// --- PR #227 Dexter 2 + 7 ---------------------------------------------------------------------------

/** Two windows of one project: two stores over ONE file. */
function twoWindows() {
  const box = { text: undefined };
  const make = () => createStripLayout({
    file: 'F',
    readText: () => { if (box.text === undefined) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return box.text; },
    writeText: (f, t) => { box.text = t; },
    mkdir: () => {},
  });
  return { box, a: make(), b: make() };
}

test('Dexter 2: two windows each save from their own memory; a lane one closed stays closed when the other saves', () => {
  const w = twoWindows();
  w.a.load(); w.b.load();
  w.a.save({ order: [], closed: [entry('x')] });
  w.b.save({ order: [entry('y').key, entry('z').key], closed: [] });
  const r = parseLayout(w.box.text);
  assert.deepStrictEqual(r.closed, [entry('x')], 'a closed lane survives the other window\'s save');
  assert.deepStrictEqual(r.order, [entry('y').key, entry('z').key], 'and the other window\'s drag is kept');
  // window A saves again without touching the order: B's order is not put back to A's old (empty) one
  w.a.save({ order: [], closed: [entry('x'), entry('w')] });
  const r2 = parseLayout(w.box.text);
  assert.deepStrictEqual(r2.order, [entry('y').key, entry('z').key]);
  assert.deepStrictEqual(r2.closed.map(c => c.key), [entry('x').key, entry('w').key]);
});

test('Dexter 2: a lane this window reopened is removed from the file; one another window closed is not', () => {
  const w = twoWindows();
  w.a.save({ order: [], closed: [entry('x')] });
  w.b.load();                                               // b starts knowing x is closed
  w.a.save({ order: [], closed: [entry('x'), entry('q')] });   // a closes q too
  w.b.save({ order: [], closed: [] });                      // b reopens x (and has never heard of q)
  assert.deepStrictEqual(parseLayout(w.box.text).closed.map(c => c.key), [entry('q').key]);
});

test('Dexter 2: a file that cannot be read at save time is an error answer, and the next save may still go through', () => {
  let busy = true;
  let body = JSON.stringify({ version: 1, order: [], closed: [] });
  const layout = createStripLayout({
    file: 'F',
    readText: () => { if (busy) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return body; },
    writeText: (f, t) => { body = t; }, mkdir: () => {},
  });
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, false);
  busy = false;
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, true);
  assert.deepStrictEqual(parseLayout(body).order, ['a']);
});

test('Dexter 7: a closed entry whose key is not its path\'s key is dropped (it could never be reopened)', () => {
  const r = parseLayout(JSON.stringify({ version: 1, order: [], closed: [{ key: 'c:\\p\\feat-x', path: 'C:\\p\\feat-y', branch: null }, entry('ok')] }));
  assert.deepStrictEqual(r.closed, [entry('ok')]);
});

test('Dexter 7: a file of another version is an unknown store: load says so and save will not write over it', () => {
  const m = memory(JSON.stringify({ version: 2, order: ['a'], closed: [] }));
  const l = m.layout.load();
  assert.ok(typeof l.error === 'string' && l.error !== '');
  assert.strictEqual(m.layout.save({ order: ['b'], closed: [] }).ok, false);
  assert.deepStrictEqual(m.writes, []);
  assert.throws(() => parseLayout(JSON.stringify({ version: 2 })));
  assert.doesNotThrow(() => parseLayout(JSON.stringify({ version: 1 })));
  assert.doesNotThrow(() => parseLayout(JSON.stringify({})), 'a file with no version is a v1 file');
});
