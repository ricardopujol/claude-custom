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
  const goneWt = path.join(tmpDir(), 'removed-worktree'); // its parent exists, the folder does not
  const w = world({ 'a.js': 'x' });
  const idx = createIndex({ dir, ...w.deps });
  await idx.refresh(live);
  await idx.refresh(goneWt);
  const orphan = path.join(dir, 'abc.json.99999.tmp');
  fs.writeFileSync(orphan, 'x');
  fs.utimesSync(orphan, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
  const young = path.join(dir, 'def.json.88888.tmp');
  fs.writeFileSync(young, 'x');
  const r = await idx.sweep();
  assert.deepStrictEqual([r.removedIndexes, r.removedTmp], [1, 1]);
  assert.ok(fs.existsSync(idx.fileFor(live)));
  assert.ok(!fs.existsSync(idx.fileFor(goneWt)));
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

// ---- Dexter round 2 ----
const transient = (code) => Object.assign(new Error(code), { code });

test('r2 #2: a transient EBUSY on the saved-index read is retried, not latched as "no index"', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  w.embeds.length = 0;
  let calls = 0;
  const idx = createIndex({ dir, ...w.deps, readIndexFile: async (f) => { if (++calls === 1) throw transient('EBUSY'); return fsp.readFile(f, 'utf8'); } });
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [0, 2]);
});

test('r2 #2: a read that stays busy starts no build over the saved file, and is tried again next time', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const before = fs.readFileSync(file, 'utf8');
  let busy = true;
  const idx = createIndex({ dir, ...w.deps, readIndexFile: async (f) => { if (busy) throw transient('EPERM'); return fsp.readFile(f, 'utf8'); } });
  await assert.rejects(idx.refresh(WT), /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  busy = false;
  w.embeds.length = 0;
  const r = await idx.refresh(WT);
  assert.strictEqual(r.embedded, 0);
});

test('r2 #2: a timed save never replaces a complete saved index with a partial one', async () => {
  const dir = tmpDir();
  const names = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.js`, `line ${i}`]));
  const w = world(names);
  await createIndex({ dir, ...w.deps }).refresh(WT);
  for (const n of Object.keys(names)) w.edit(n, `changed ${n}`);
  let t = 0; let calls = 0;
  const idx = createIndex({ dir, ...w.deps, now: () => (t += 10_000), embed: async (x) => { if (++calls === 6) throw new Error('killed'); return w.deps.embed(x); } });
  await assert.rejects(idx.refresh(WT));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.deepStrictEqual([saved.complete, saved.files.length], [true, 10]);
});

test('r2 #3: sweep keeps an index whose drive or parent cannot be reached, and removes one whose folder is gone from a reachable parent', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'x' });
  const idx = createIndex({ dir, ...w.deps });
  const offline = 'Q:\\usb\\wt';
  await idx.refresh(offline);
  const gone = path.join(tmpDir(), 'wt-gone');
  await idx.refresh(gone);
  const r = await idx.sweep({ exists: (p) => p === path.parse(gone).root || p === path.dirname(gone) });
  assert.strictEqual(r.removedIndexes, 1);
  assert.ok(fs.existsSync(idx.fileFor(offline)), 'an unreachable worktree lost its index');
  assert.ok(!fs.existsSync(idx.fileFor(gone)));
});

test('r2 #4: a round-1 file with no complete key loads as partial and a refresh finishes it without re-embedding', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  const first = createIndex({ dir, ...w.deps });
  await first.refresh(WT);
  const file = first.fileFor(WT);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.complete;
  fs.writeFileSync(file, JSON.stringify(saved));
  w.embeds.length = 0;
  const idx = createIndex({ dir, ...w.deps });
  await idx.load(WT);
  assert.deepStrictEqual([idx.progress(WT).state, idx.progress(WT).partial], ['partial', true]);
  const r = await idx.refresh(WT);
  assert.strictEqual(r.embedded, 0);
  assert.strictEqual(idx.progress(WT).state, 'ready');
});

test('r2 #1: a build that fails after the watch window is remembered with a time, and cleared by a success', async () => {
  const w = world({ 'a.js': 'x' });
  let t = 5000; let fail = true;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, now: () => t, listFiles: async () => { if (fail) throw new Error('maxBuffer'); return w.deps.listFiles(); } });
  await assert.rejects(idx.refresh(WT));
  assert.deepStrictEqual([idx.progress(WT).state, idx.progress(WT).failedAt], ['failed', 5000]);
  fail = false;
  await idx.refresh(WT);
  assert.strictEqual(idx.progress(WT).failedAt, undefined);
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const savedFile = (dir) => path.join(dir, fs.readdirSync(dir).find(n => n.endsWith('.json')));
const MANY = Array.from({ length: 400 }, (_, i) => `line number ${i} of text`).join('\n');

test('S8: a saved index of another version, or none, or the wrong shape, is not trusted: everything is embedded again', async () => {
  for (const damage of [
    (p) => ({ ...p, version: p.version - 1 }),
    (p) => ({ ...p, version: p.version + 1 }),
    (p) => { const { version, ...rest } = p; return rest; }, // eslint-disable-line no-unused-vars
    (p) => ({ ...p, files: 'not an array' }),
  ]) {
    const dir = tmpDir();
    const w = world({ 'a.js': 'one', 'b.js': 'two' });
    await createIndex({ dir, ...w.deps }).refresh(WT);
    const f = savedFile(dir);
    fs.writeFileSync(f, JSON.stringify(damage(JSON.parse(fs.readFileSync(f, 'utf8')))));
    const next = createIndex({ dir, ...w.deps });
    await next.load(WT);
    assert.strictEqual(next.get(WT), null, 'nothing was loaded from it');
    const r = await next.refresh(WT);
    assert.deepStrictEqual([r.embedded, r.reused], [2, 0]);
  }
});

test('S8: a saved file that is the JSON literal null is an empty index, not a crash', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  fs.writeFileSync(savedFile(dir), 'null');
  const r = await createIndex({ dir, ...w.deps }).refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [1, 0]);
});

test('S8: a file deleted between two builds is gone from the second index and from the saved one', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one', 'b.js': 'two', 'c.js': 'three' });
  const idx = createIndex({ dir, ...w.deps });
  await idx.refresh(WT);
  w.remove('b.js');
  const r = await idx.refresh(WT);
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(idx.get(WT).files.map(f => f.rel), ['a.js', 'c.js']);
  const reloaded = createIndex({ dir, ...w.deps });
  await reloaded.load(WT);
  assert.deepStrictEqual(reloaded.get(WT).files.map(f => f.rel), ['a.js', 'c.js']);
  const again = await idx.refresh(WT);
  assert.strictEqual(again.removed, 0, 'nothing more to remove');
});

test('S8: the save yields to the event loop every 20 files, no more and no less', async () => {
  const yields = async (n) => {
    const names = Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(2, '0')}.js`, `line ${i}`]));
    const w = world(names);
    const real = global.setImmediate;
    let count = 0;
    global.setImmediate = (fn, ...rest) => {
      if (new Error().stack.includes('ask-index.js')) count += 1;
      return real(fn, ...rest);
    };
    try { await createIndex({ dir: tmpDir(), ...w.deps, now: () => 1000 }).refresh(WT); } finally { global.setImmediate = real; }
    return count;
  };
  assert.deepStrictEqual([await yields(19), await yields(20), await yields(39), await yields(40), await yields(45)], [0, 1, 1, 2, 2]);
});

test('S8: a file still waiting for its vectors is written out again once it has them (the text cache is for finished files only)', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  let up = false;
  const embed = async (t) => (up ? w.deps.embed(t) : { ok: false, reason: 'ollama-down' });
  const idx = createIndex({ dir, ...w.deps, embed });
  await idx.refresh(WT);
  up = true;
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.keywordOnly, r.embedded, r.reused], [false, 1, 0]);
  const fresh = createIndex({ dir, ...w.deps, embed });
  await fresh.load(WT);
  assert.ok(fresh.get(WT).files[0].chunks[0].vec, 'the saved copy carries the vector');
});

test('S8: a file of exactly the size cap is indexed, one byte over is not; a listed file that vanished is skipped', async () => {
  const w = world({ 'ok.js': 'a', 'big.js': 'b', 'gone.js': 'c' });
  const sizes = { 'ok.js': 400_000, 'big.js': 400_001 };
  const idx = createIndex({
    dir: tmpDir(), ...w.deps,
    statFile: async (_wt, rel) => (rel === 'gone.js' ? null : { size: sizes[rel], mtimeMs: 1 }),
  });
  const r = await idx.refresh(WT);
  assert.deepStrictEqual(idx.get(WT).files.map(f => f.rel), ['ok.js']);
  assert.strictEqual(r.files, 1);
});

test('S8: only indexable files are read, in sorted order, however the listing arrives', async () => {
  const w = world({ 'b.js': 'bee', 'a.js': 'ay', 'logo.png': 'x', 'test/t.js': 'x' });
  const order = [];
  const idx = createIndex({
    dir: tmpDir(), ...w.deps,
    listFiles: async () => ['b.js', 'logo.png', 'a.js', 'test/t.js', 'b.js'],
    readFile: async (_wt, rel) => { order.push(rel); return w.files.get(rel).text; },
  });
  const r = await idx.refresh(WT);
  assert.deepStrictEqual(order, ['a.js', 'b.js'], 'sorted, deduplicated, filtered');
  assert.strictEqual(r.files, 2);
});

test('S8: embeds go out in batches no larger than batchSize, never empty, and no text longer than the input cap', async () => {
  const w = world({ 'a.js': MANY, 'long.js': 'x'.repeat(5000) });
  const calls = [];
  const idx = createIndex({
    dir: tmpDir(), ...w.deps, batchSize: 3,
    embed: async (texts) => { calls.push(texts); return w.deps.embed(texts); },
  });
  const r = await idx.refresh(WT);
  assert.ok(r.chunks > 6, 'the file really has several chunks');
  assert.ok(calls.every(c => c.length >= 1 && c.length <= 3), calls.map(c => c.length).join(','));
  assert.strictEqual(calls.reduce((n, c) => n + c.length, 0), r.chunks, 'each chunk is embedded exactly once');
  assert.ok(calls.flat().every(t => t.length <= 2000));
  assert.ok(calls.flat().some(t => t.length === 2000), 'the over-long chunk is cut to the cap, not dropped');
  assert.ok(calls.flat()[0].startsWith('a.js:1-'), 'the text leads with rel:start-end');
});

test('S8: progress.done counts up one file at a time, and the unreadable ones count too', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two', 'c.js': 'three' });
  const seen = [];
  const idx = createIndex({
    dir: tmpDir(), ...w.deps,
    readFile: async (_wt, rel) => { seen.push(idx.progress(WT).done); if (rel === 'b.js') throw new Error('EBUSY'); return w.files.get(rel).text; },
  });
  await idx.refresh(WT);
  assert.deepStrictEqual(seen, [0, 1, 2]);
  assert.deepStrictEqual([idx.progress(WT).state, idx.progress(WT).done, idx.progress(WT).total], ['ready', 3, 3]);
});

test('S8: keywordOnly is true when ANY file lacks vectors; reused does not count files that were re-embedded', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  let calls = 0;
  const idx = createIndex({
    dir: tmpDir(), ...w.deps,
    embed: async (t) => (++calls === 1 ? w.deps.embed(t) : { ok: false, reason: 'ollama-down' }),
  });
  const r1 = await idx.refresh(WT);
  assert.strictEqual(r1.keywordOnly, true, 'a has vectors, b has none');
  assert.strictEqual(r1.embedded, 1);
  const r2 = await idx.refresh(WT);
  assert.strictEqual(r2.reused, 1, 'a was kept as it was; b went through the embedder again');
});

test('S8: timed saves fire when the clock has moved exactly saveEveryMs, and not before', async () => {
  const names = { 'a.js': 'one', 'b.js': 'two', 'c.js': 'three' };
  const writes = async (step, every) => {
    const w = world(names);
    let clock = 10_000;
    const out = [];
    await createIndex({
      dir: tmpDir(), ...w.deps, now: () => clock, saveEveryMs: every,
      embed: async (t) => { clock += step; return w.deps.embed(t); },
      writeIndexFile: async (p, s) => { out.push(p); await fsp.writeFile(p, s); },
    }).refresh(WT);
    return out.length;
  };
  assert.strictEqual(await writes(5000, 5000), 4, 'exactly on the interval saves after every file, and once at the end');
  assert.strictEqual(await writes(3000, 5000), 2, 'every second file, and once at the end');
  assert.strictEqual(await writes(1000, 5000), 1, 'only the final save');
});

test('S8: once the embedder has failed, no further batch or file is sent to it in that build', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two', 'c.js': 'three', 'd.js': '' });
  let calls = 0;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, embed: async () => { calls += 1; return { ok: false, reason: 'ollama-down' }; } });
  const r = await idx.refresh(WT);
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.embedFailure, 'ollama-down');
  assert.strictEqual(r.keywordOnly, true);
});

test('S8: a chunk count that is an exact multiple of batchSize sends no trailing empty batch', async () => {
  const w = world({ 'a.js': MANY });
  const n = (await createIndex({ dir: tmpDir(), ...w.deps }).refresh(WT)).chunks;
  assert.ok(n >= 2, n + ' chunks');
  const calls = [];
  await createIndex({
    dir: tmpDir(), ...w.deps, batchSize: n,
    embed: async (texts) => { calls.push(texts.length); return w.deps.embed(texts); },
  }).refresh(WT);
  assert.deepStrictEqual(calls, [n]);
});

test('S8: a file whose second batch fails is kept with NO vectors at all (all or nothing)', async () => {
  const w = world({ 'a.js': MANY });
  let calls = 0;
  const idx = createIndex({
    dir: tmpDir(), ...w.deps, batchSize: 3,
    embed: async (t) => (++calls === 2 ? { ok: false, reason: 'ollama-down' } : w.deps.embed(t)),
  });
  const r = await idx.refresh(WT);
  assert.strictEqual(r.keywordOnly, true);
  assert.ok(idx.get(WT).files[0].chunks.every(c => c.vec === null), 'the first batch\'s vectors were dropped too');
  assert.strictEqual(r.embedded, 0);
});

test('S8: an unchanged mtime with a different size is a changed file', async () => {
  const w = world({ 'a.js': 'one' });
  let size = 3;
  const idx = createIndex({ dir: tmpDir(), ...w.deps, statFile: async () => ({ size, mtimeMs: 7 }) });
  await idx.refresh(WT);
  size = 4;
  const r = await idx.refresh(WT);
  assert.deepStrictEqual([r.embedded, r.reused], [1, 0]);
});

test('S8: a kept file still waiting for vectors is embedded from memory, not read and chunked again', async () => {
  const w = world({ 'a.js': 'one', 'b.js': 'two' });
  let up = false;
  let reads = 0;
  const idx = createIndex({
    dir: tmpDir(), ...w.deps,
    embed: async (t) => (up ? w.deps.embed(t) : { ok: false, reason: 'ollama-down' }),
    readFile: async (_wt, rel) => { reads += 1; return w.files.get(rel).text; },
  });
  await idx.refresh(WT);
  assert.strictEqual(reads, 2);
  up = true;
  const before = idx.get(WT).files;
  const r = await idx.refresh(WT);
  assert.strictEqual(reads, 2, 'nothing was read again');
  assert.strictEqual(r.embedded, 2);
  assert.strictEqual(before[0].chunks[0].vec instanceof Float32Array, true, 'the same file objects were filled in');
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M9) --------------------------------------------------------

test('M9: isIndexable: minified files and lockfiles are out by their NAME, wherever they sit; extension case does not matter', () => {
  for (const out of ['dist2/app.min.mjs', 'a/x.min.js', 'a/X.MIN.JS', 'package-lock.js', 'a/pnpm-lock.js', 'package-locker.js']) assert.strictEqual(isIndexable(out), false, out);
  for (const keep of ['foo.min.config.js', 'x.minx.js', 'my-package-lock.js', 'README.MD', 'src/X.JS', 'a.min/b.js', 'docs/minutes.md']) assert.strictEqual(isIndexable(keep), true, keep);
});

test('M9: the saved index file is named by a 16-character hash of the worktree, case-folded', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh('C:\\Proj\\WT');
  const names = fs.readdirSync(dir);
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{16}\.json$/);
  const idx = createIndex({ dir, ...w.deps });
  const r = await idx.refresh('c:\\proj\\wt');
  assert.deepStrictEqual([r.embedded, r.reused], [0, 1], 'the same folder in another case is the same index');
});

test('M9: a saved index that stays busy is tried four times, with the pause doubling between tries', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  const stamps = [];
  const idx = createIndex({ dir, ...w.deps, readIndexFile: async () => { stamps.push(Date.now()); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  await assert.rejects(idx.refresh(WT), /unreadable right now/);
  assert.strictEqual(stamps.length, 4, 'four attempts, no more');
  assert.ok(stamps[3] - stamps[0] >= 150, `25 + 50 + 100 ms of waiting, not ${stamps[3] - stamps[0]}`);
  assert.ok(stamps[1] - stamps[0] >= 20 && stamps[2] - stamps[1] >= 45 && stamps[3] - stamps[2] >= 90, stamps.map((s, i) => (i ? s - stamps[i - 1] : 0)).join(','));
});

test('M9: a save that fails is said once with its reason, leaves no temp file, and the old index stays', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  await createIndex({ dir, ...w.deps }).refresh(WT);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const before = fs.readFileSync(file, 'utf8');
  w.edit('a.js', 'changed');
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a);
  try {
    const idx = createIndex({ dir, ...w.deps, writeIndexFile: async (p, s) => { await fsp.writeFile(p, s.slice(0, 10)); throw new Error('disk full'); } });
    await idx.refresh(WT);
  } finally { console.warn = realWarn; }
  assert.deepStrictEqual(warned, [['[ask-index] could not save the index:', 'disk full']]);
  assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], 'no .tmp left behind');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('M9: sweep removes an orphan temp file only when it is OLDER than an hour', async () => {
  const dir = tmpDir();
  const T0 = 1_800_000_000_000;
  const tmp = path.join(dir, 'abc.123.tmp');
  fs.writeFileSync(tmp, 'x');
  fs.utimesSync(tmp, new Date(T0), new Date(T0));
  const realNow = Date.now;
  const idx = createIndex({ dir, ...world().deps });
  try {
    Date.now = () => T0 + 3_600_000;
    assert.deepStrictEqual(await idx.sweep(), { removedIndexes: 0, removedTmp: 0 }, 'exactly an hour is still young');
    assert.ok(fs.existsSync(tmp));
    Date.now = () => T0 + 3_600_001;
    assert.deepStrictEqual(await idx.sweep(), { removedIndexes: 0, removedTmp: 1 });
    assert.ok(!fs.existsSync(tmp));
  } finally { Date.now = realNow; }
});

test('M9: sweep reads only .json and .tmp names, and an index of a folder that still exists is kept', async () => {
  const dir = tmpDir();
  const w = world({ 'a.js': 'one' });
  const here = tmpDir('cc-wt-');
  await createIndex({ dir, ...w.deps }).refresh(here);
  fs.writeFileSync(path.join(dir, 'notes.txt'), '{"worktree":"C:\\\\definitely\\\\gone"}');
  assert.deepStrictEqual(await createIndex({ dir, ...w.deps }).sweep(), { removedIndexes: 0, removedTmp: 0 });
  assert.strictEqual(fs.readdirSync(dir).length, 2);
});

const hasGit = require('child_process').spawnSync('git', ['--version']).status === 0;

test('M9: the real listing is git\'s: tracked and untracked files, not the ignored ones, as plain relative names', { skip: !hasGit }, async () => {
  const { spawnSync } = require('child_process');
  const repo = tmpDir('cc-ls-');
  const git = (...a) => assert.strictEqual(spawnSync('git', a, { cwd: repo }).status, 0, a.join(' '));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n');
  fs.mkdirSync(path.join(repo, 'sub'));
  for (const f of ['b.js', 'ignored.js', 'package-lock.js', 'a.min.js', 'sub/c.js']) fs.writeFileSync(path.join(repo, f), `// ${f}\n`);
  const listed = await realDeps.listFiles(repo);
  assert.deepStrictEqual([...listed].sort(), ['.gitignore', 'a.min.js', 'b.js', 'package-lock.js', 'sub/c.js']);
  assert.ok(listed.every(n => n !== ''), 'no empty names');
  const w = world();
  const idx = createIndex({ dir: tmpDir(), ...w.deps, listFiles: realDeps.listFiles, statFile: realDeps.statFile, readFile: realDeps.readFile });
  await idx.refresh(repo);
  assert.deepStrictEqual(idx.get(repo).files.map(f => f.rel), ['b.js', 'sub/c.js'], 'the lockfile and the minified file are not indexed');
});

test('M9: the real listing of a folder that is not a repository is a rejection, not an empty list', { skip: !hasGit }, async () => {
  const notRepo = tmpDir('cc-notrepo-');
  await assert.rejects(realDeps.listFiles(notRepo));
  await assert.rejects(realDeps.listFiles(path.join(notRepo, 'missing')));
});

test('M9: the real stat reports a regular file and nothing else: a folder, or a missing name, is null', async () => {
  const root = tmpDir('cc-stat-');
  fs.mkdirSync(path.join(root, 'adir'));
  fs.writeFileSync(path.join(root, 'f.js'), 'abc');
  const st = await realDeps.statFile(root, 'f.js');
  assert.strictEqual(st.size, 3);
  assert.strictEqual(typeof st.mtimeMs, 'number');
  assert.strictEqual(await realDeps.statFile(root, 'adir'), null);
  assert.strictEqual(await realDeps.statFile(root, 'missing.js'), null);
  assert.strictEqual(await realDeps.readFile(root, 'f.js'), 'abc');
});
