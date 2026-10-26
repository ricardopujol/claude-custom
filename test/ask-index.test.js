'use strict';
/**
 * The per-worktree index for "ask the repo" (BACKLOG #33). PROPERTIES:
 *   - an incremental refresh after any sequence of edits gives the same index as a build from scratch
 *   - an unchanged file is never re-embedded; a vanished file never lingers
 *   - the index lives outside the worktree
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const { createIndex, isIndexable, vecToB64, b64ToVec } = require('../host/ask-index');

// A fake world: a Map of path -> { text, mtimeMs }. embed() is a pure function of the text so "from scratch" is comparable.
function world(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, { text: v, mtimeMs: 1 }]));
  let clock = 1;
  const embeds = [];
  const deps = {
    listFiles: async () => [...files.keys()].sort(),
    statFile: async (_wt, rel) => { const f = files.get(rel); return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null; },
    readFile: async (_wt, rel) => files.get(rel).text,
    embed: async (texts) => { embeds.push(...texts); return { ok: true, vectors: texts.map(t => [t.length, t.split('\n').length, 1]) }; },
  };
  return {
    files, embeds, deps,
    edit(rel, text) { files.set(rel, { text, mtimeMs: ++clock }); },
    remove(rel) { files.delete(rel); },
  };
}

const WT = 'C:\\proj\\wt';
const snapshot = (idx) => JSON.stringify(idx.files.map(f => [f.rel, f.lines, f.chunks.map(c => [c.start, c.end, c.ownStart, c.text, c.vec && [...c.vec]])]));

test('isIndexable: source and docs in, tests / verify / vendored / lockfiles / huge files out', () => {
  for (const p of ['host/host.js', 'app/x.mjs', 'README.md', 'documentation/a.md', 'lib/y.ts']) assert.ok(isIndexable(p), p);
  for (const p of ['test/a.test.js', 'verify/probe.js', 'node_modules/x/i.js', 'package-lock.json', 'dist/app.min.js', 'img/a.png', 'a/test/b.js']) assert.ok(!isIndexable(p), p);
});

test('base64 vectors round-trip as Float32', () => {
  const v = [0.5, -1.25, 3];
  assert.deepStrictEqual([...b64ToVec(vecToB64(v))], v);
});

test('a build indexes every file once and saves outside the worktree', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one\ntwo', 'b.md': 'x' });
  const idx = createIndex({ dir, ...w.deps });
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.files, r.chunks, r.embedded, r.reused], [2, 2, 2, 0]);
  const saved = fs.readdirSync(dir);
  assert.strictEqual(saved.length, 1);
  assert.ok(!path.resolve(dir).toLowerCase().startsWith(WT.toLowerCase()));
});

test('PR #169 Dexter 3: the files indexed so far can be searched while the first build runs; the finished index replaces it', async () => {
  const w = world({ 'a.js': 'alpha one', 'b.js': 'beta two', 'c.js': 'gamma three' });
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, embed: async (texts) => { calls += 1; if (calls === 2) await gate; return w.deps.embed(texts); } });
  assert.strictEqual(idx.snapshot(WT), null, 'nothing indexed, nothing to search');
  const build = idx.refresh(WT);
  for (let i = 0; i < 50 && calls < 2; i += 1) await new Promise(r => setImmediate(r));
  const mid = idx.snapshot(WT);
  assert.deepStrictEqual(mid.files.map(f => f.rel), ['a.js'], 'the first file is done, the second is being embedded, the third is not read yet');
  assert.strictEqual(idx.get(WT), null, 'get() is still the FINISHED index: none yet');
  release();
  await build;
  assert.deepStrictEqual(idx.snapshot(WT).files.map(f => f.rel), ['a.js', 'b.js', 'c.js']);
  assert.strictEqual(idx.snapshot(WT), idx.get(WT), 'after the build the snapshot is the finished index itself');
});

test('a second refresh with nothing changed embeds nothing', async () => {
  const w = world({ 'a.js': 'one\ntwo' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps });
  await idx.refresh(WT);
  w.embeds.length = 0;
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [0, 1]);
  assert.strictEqual(w.embeds.length, 0);
});

test('a new process loads the saved index and still embeds nothing', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one\ntwo' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  w.embeds.length = 0;
  const r = await createIndex({ dir, ...w.deps }).refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [0, 1]);
});

test('a changed file is re-embedded alone; a deleted one is dropped', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two', 'c.js': 'three' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps });
  await idx.refresh(WT);
  w.edit('a.js', 'changed');
  w.remove('c.js');
  w.embeds.length = 0;
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused, r.removed], [1, 1, 1]);
  assert.deepStrictEqual(idx.get(WT).files.map(f => f.rel), ['a.js', 'b.js']);
});

test('the embedder down leaves chunks without vectors, says so, and the next refresh fills them', async () => {
  const w = world({ 'a.js': 'one' });
  let up = false;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, embed: async (t) => (up ? w.deps.embed(t) : { ok: false, reason: 'ollama-down' }) });
  const r1 = await idx.refresh(WT);
  assert.deepStrictEqual([r1.keywordOnly, r1.embedFailure], [true, 'ollama-down']);
  assert.strictEqual(idx.get(WT).files[0].chunks[0].vec, null);
  up = true;
  const r2 = await idx.refresh(WT);
  assert.deepStrictEqual([r2.keywordOnly, r2.embedded], [false, 1]);
  assert.ok(idx.get(WT).files[0].chunks[0].vec);
});

test('a file that cannot be read is skipped and counted, not fatal', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps, readFile: async (wt, rel) => { if (rel === 'b.js') throw new Error('EBUSY'); return w.files.get(rel).text; } });
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.files, r.unreadable], [1, 1]);
});

test('a corrupt or foreign-version index file is an empty index, rebuilt', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  const f = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(f, '{not json');
  const r = await createIndex({ dir, ...w.deps }).refresh(WT);
  assert.strictEqual(r.embedded, 1);
});

test('an index built with another embedding model is not reused', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, embedModel: 'm1', ...w.deps }).refresh(WT);
  const r = await createIndex({ dir, embedModel: 'm2', ...w.deps }).refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [1, 0]);
});

test('two refreshes at once share one run', async () => {
  const w = world({ 'a.js': 'one' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps });
  const [a, b] = await Promise.all([idx.refresh(WT), idx.refresh(WT)]);
  assert.strictEqual(a, b);
  assert.strictEqual(w.embeds.length, 1);
});

test('progress is visible while building', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  let seen = null;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, embed: async (t) => { seen = idx.progress(WT); return w.deps.embed(t); } });
  const p = idx.refresh(WT);
  await p;
  assert.strictEqual(seen.state, 'building');
  assert.strictEqual(seen.total, 2);
  assert.strictEqual(idx.progress(WT).state, 'ready');
});

test('P an incremental refresh equals a build from scratch, after any sequence of edits', async () => {
  const name = fc.constantFrom('a.js', 'b.js', 'c.md', 'd.js');
  const text = fc.array(fc.string({ maxLength: 30 }).filter(s => !/[\r\n]/.test(s)), { maxLength: 150 }).map(ls => ls.join('\n'));
  const op = fc.oneof(
    fc.record({ k: fc.constant('edit'), n: name, t: text }),
    fc.record({ k: fc.constant('remove'), n: name }),
    fc.record({ k: fc.constant('refresh') }),
  );
  const base = tmpDir();
  let n = 0;
  await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 14 }), async (ops) => {
    const w = world({ 'a.js': 'seed' });
    const live = createIndex({ dir: path.join(base, String(n++)), ...w.deps });
    await live.refresh(WT);
    for (const o of ops) {
      if (o.k === 'edit') w.edit(o.n, o.t);
      else if (o.k === 'remove') w.remove(o.n);
      else await live.refresh(WT);
    }
    await live.refresh(WT);
    const fresh = createIndex({ dir: path.join(base, String(n++)), ...w.deps });
    await fresh.refresh(WT);
    assert.strictEqual(snapshot(live.get(WT)), snapshot(fresh.get(WT)));
  }), { numRuns: 60 });
});
