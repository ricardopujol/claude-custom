'use strict';
/**
 * PR #136 review fixes for the ask-the-repo index: the load race (Dexter D1), failures that read as "building" forever
 * (D2 / Miguel M1), save cost (M3), cleanup (M4), partial builds (M5), vendored dirs (D9), symlinks (S2), and a property
 * with embed failures and interrupted runs (S8).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const { createIndex, isIndexable, realDeps } = require('../host/ask-index');

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
  return { files, embeds, deps, edit(rel, text) { files.set(rel, { text, mtimeMs: ++clock }); }, remove(rel) { files.delete(rel); } };
}
const WT = 'C:\\proj\\wt';
const snapshot = (idx) => JSON.stringify(idx.files.map(f => [f.rel, f.lines, f.chunks.map(c => [c.start, c.end, c.ownStart, c.text, c.vec && [...c.vec]])]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('D1: two loads at once get the same saved index, and a refresh racing a slow load re-embeds nothing and never shrinks the saved file', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one', 'b.js': 'two', 'c.js': 'three' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  const savedBytes = fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).size;
  w.embeds.length = 0;

  const slow = createIndex({ dir, ...w.deps, readIndexFile: async (f) => { await sleep(60); return fsp.readFile(f, 'utf8'); } });
  const [a, b] = await Promise.all([slow.load(WT), slow.load(WT)]);
  assert.ok(a && b, 'a second caller saw null while the read was still running');
  assert.strictEqual(a, b);

  const fresh = createIndex({ dir, ...w.deps, readIndexFile: async (f) => { await sleep(60); return fsp.readFile(f, 'utf8'); } });
  const sizes = [];
  const watcher = setInterval(() => { try { sizes.push(fs.statSync(path.join(dir, fs.readdirSync(dir).find(n => n.endsWith('.json')))).size); } catch { /* mid-rename */ } }, 5);
  const [, r] = await Promise.all([fresh.load(WT), fresh.refresh(WT)]);
  clearInterval(watcher);
  assert.deepStrictEqual([r.embedded, r.reused], [0, 3]);
  assert.strictEqual(w.embeds.length, 0);
  assert.ok(sizes.every(s => s >= savedBytes * 0.9), 'the saved index shrank while a refresh raced the load');
});

test('D2/M1: a rejecting listFiles with no saved index is a named failure state, not building or none', async () => {
  const w = world({ 'a.js': 'x' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps, listFiles: async () => { throw new Error('fatal: not a git repository'); } });
  await assert.rejects(idx.refresh(WT), /not a git repository/);
  const p = idx.progress(WT);
  assert.strictEqual(p.state, 'failed');
  assert.match(p.error, /not a git repository/);
  assert.strictEqual(idx.isRunning(WT), false);
});

test('D2/M1: a failed refresh over a saved index keeps the data, stays ready, and carries the error until a refresh succeeds', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'x' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  let broken = true;
  const idx = createIndex({ dir, ...w.deps, listFiles: async () => { if (broken) throw new Error('git gone'); return w.deps.listFiles(); } });
  await idx.load(WT);
  await assert.rejects(idx.refresh(WT));
  assert.ok(idx.get(WT));
  assert.deepStrictEqual([idx.progress(WT).state, idx.progress(WT).error], ['ready', 'git gone']);
  broken = false;
  await idx.refresh(WT);
  assert.strictEqual(idx.progress(WT).error, undefined);
});

test('M1: an embed function that throws mid-build is a failure too, not a build that never ends', async () => {
  const w = world({ 'a.js': 'x' });
  const idx = createIndex({ dir: tmpDir(), ...w.deps, embed: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(idx.refresh(WT));
  assert.strictEqual(idx.progress(WT).state, 'failed');
  assert.strictEqual(idx.isRunning(WT), false);
});

test('M3: saves are timed, not counted: one at the end when the clock does not move, many when it does, each off the hot loop', async () => {
  const names = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.js`, `line ${i}`]));
  const still = []; const w1 = world(names);
  await createIndex({ dir: tmpDir(), ...w1.deps, now: () => 1000, writeIndexFile: async (t, s) => { still.push(t); await fsp.writeFile(t, s); } }).refresh(WT);
  assert.strictEqual(still.length, 1);
  let t = 0; const moving = []; const w2 = world(names);
  await createIndex({ dir: tmpDir(), ...w2.deps, now: () => (t += 10_000), writeIndexFile: async (p, s) => { moving.push(p); await fsp.writeFile(p, s); } }).refresh(WT);
  assert.ok(moving.length > 5, `expected timed saves, got ${moving.length}`);
});

test('M5: an interrupted first build loads as partial, resumes without re-embedding what it saved, and only then reads ready', async () => {
  const dir = tmpDir();
  const names = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.js`, `line ${i}`]));
  const w = world(names);
  let t = 0; let calls = 0;
  const crashing = createIndex({ dir, ...w.deps, now: () => (t += 10_000), embed: async (x) => { if (++calls === 6) throw new Error('killed'); return w.deps.embed(x); } });
  await assert.rejects(crashing.refresh(WT));
  w.embeds.length = 0;
  const next = createIndex({ dir, ...w.deps });
  await next.load(WT);
  assert.deepStrictEqual([next.progress(WT).state, next.progress(WT).partial], ['partial', true]);
  const r = await next.refresh(WT);
  assert.ok(r.reused > 0, 'a resumed build re-embedded what it had already saved');
  assert.strictEqual(r.files, 10);
  assert.deepStrictEqual([next.progress(WT).state, next.progress(WT).partial], ['ready', false]);
});

test('M4: drop() removes a worktree index; sweep() removes indexes whose worktree is gone and old orphan tmp files, and keeps the rest', async () => {
  const dir = tmpDir();
  const live = tmpDir();
  const w = world({ 'a.js': 'x' });
  const idx = createIndex({ dir, ...w.deps });
  await idx.refresh(live);
  await idx.refresh('Z:\\definitely\\gone\\worktree');
  const orphan = path.join(dir, 'abc.json.99999.tmp');
  fs.writeFileSync(orphan, 'x');
  fs.utimesSync(orphan, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
  const young = path.join(dir, 'def.json.88888.tmp');
  fs.writeFileSync(young, 'x');
  const r = await idx.sweep();
  assert.deepStrictEqual([r.removedIndexes, r.removedTmp], [1, 1]);
  assert.ok(fs.existsSync(idx.fileFor(live)));
  assert.ok(!fs.existsSync(idx.fileFor('Z:\\definitely\\gone\\worktree')));
  assert.ok(fs.existsSync(young), 'a young tmp file may belong to a live writer');
  await idx.drop(live);
  assert.ok(!fs.existsSync(idx.fileFor(live)));
  assert.strictEqual(idx.get(live), null);
});

test('D9: vendored folders stay out', () => {
  for (const p of ['vendor/a.js', 'third_party/a.py', 'lib/vendor/x.js']) assert.ok(!isIndexable(p), p);
});

test('S2: a symlink is not indexed, a regular file is', async (t) => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'real.js'), 'x');
  const outside = path.join(tmpDir(), 'secret.js');
  fs.writeFileSync(outside, 'secret');
  try { fs.symlinkSync(outside, path.join(root, 'link.js')); } catch { t.skip('this account may not create symlinks'); return; }
  assert.ok(await realDeps.statFile(root, 'real.js'));
  assert.strictEqual(await realDeps.statFile(root, 'link.js'), null);
});

test('S8 P: after any mix of edits, embed outages, crashes and restarts, one healed refresh equals a from-scratch build', async () => {
  const name = fc.constantFrom('a.js', 'b.js', 'c.md', 'd.js');
  const text = fc.array(fc.string({ maxLength: 20 }).filter(s => !/[\r\n]/.test(s)), { maxLength: 80 }).map(ls => ls.join('\n'));
  const op = fc.oneof(
    fc.record({ k: fc.constant('edit'), n: name, t: text }), fc.record({ k: fc.constant('remove'), n: name }),
    fc.record({ k: fc.constant('refresh') }), fc.record({ k: fc.constant('down') }), fc.record({ k: fc.constant('up') }),
    fc.record({ k: fc.constant('crash') }), fc.record({ k: fc.constant('restart') }),
  );
  const base = tmpDir(); let n = 0;
  await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 14 }), async (ops) => {
    const w = world({ 'a.js': 'seed', 'b.js': 'seed two' });
    const dir = path.join(base, String(n++));
    let t = 0; let mode = 'up';
    const make = () => createIndex({
      dir, ...w.deps, now: () => (t += 10_000),
      embed: async (x) => { if (mode === 'down') return { ok: false, reason: 'ollama-down' }; if (mode === 'crash') { mode = 'up'; throw new Error('killed'); } return w.deps.embed(x); },
    });
    let live = make();
    for (const o of ops) {
      if (o.k === 'edit') w.edit(o.n, o.t); else if (o.k === 'remove') w.remove(o.n);
      else if (o.k === 'refresh') await live.refresh(WT).catch(() => {});
      else if (o.k === 'down') mode = 'down'; else if (o.k === 'up') mode = 'up'; else if (o.k === 'crash') mode = 'crash';
      else live = make();
    }
    mode = 'up';
    await live.refresh(WT);
    const scratch = createIndex({ dir: path.join(base, String(n++)), ...w.deps });
    await scratch.refresh(WT);
    assert.strictEqual(snapshot(live.get(WT)), snapshot(scratch.get(WT)));
  }), { numRuns: 60 });
});
