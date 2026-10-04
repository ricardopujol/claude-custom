'use strict';
/**
 * The repo service's limits and wiring, driven entirely through injected seams (backlog #60, Mortimer's
 * release-#101 part 2): the overlay settle loop (one timer, a bounded number of re-reads, a push only when the
 * answer changed), the lazy watcher, the list cap, the guard re-check around a read, and the shape of every
 * failure. No real timers, no disk, no git.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRepoService, MAX_LIST_ENTRIES } = require('../host/repo-service');

// Tuned values the module owns and does not export; pinned on purpose, so tuning one is a conscious test edit.
const SETTLE_MS = 1500;
const MAX_SETTLES = 6;
const MAX_DIR = 4096;
const ROOT = 'C:\\w';

const edited = (p) => ({ path: p, tier: 'edited', edits: 1 });
const fogOf = (files, pendingEdits) => ({ files, status: { transcriptsFound: 1, transcriptErrors: 0, transcriptsMissing: false, pendingEdits } });

function fakeIndex(over = {}) {
  const calls = { refresh: [], list: [] };
  return {
    calls,
    refresh: async (o) => { calls.refresh.push(o); return { ok: true }; },
    list: (dir) => { calls.list.push(dir); return { ok: true, entries: [] }; },
    resolve: () => undefined,
    ...over,
  };
}

function fakeTimers() {
  const armed = [];
  const cleared = [];
  return {
    armed, cleared,
    setTimer: (fn, ms) => { const t = { fn, ms, id: armed.length }; armed.push(t); return t; },
    clearTimer: (t) => { cleared.push(t); },
  };
}

function build(over = {}) {
  const timers = fakeTimers();
  const announced = [];
  const watchers = [];
  const index = over.index || fakeIndex();
  const svc = createRepoService({
    root: ROOT, projectsDir: 'P', index,
    watch: (root, onChange) => { const w = { root, onChange, closed: 0, close() { this.closed += 1; } }; watchers.push(w); return w; },
    announce: (m) => announced.push(m),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    ...over,
  });
  return { svc, timers, announced, watchers, index };
}

const ask = (svc, msg) => svc.handle({ type: 'repo', ...msg });

// ---- the settle loop ----

test('two overlay asks while a settle timer is armed leave exactly one armed timer, set for SETTLE_MS', async () => {
  const { svc, timers } = build({ readFog: async () => fogOf([edited('a.js')], 1) });
  await ask(svc, { action: 'overlay' });
  await ask(svc, { action: 'overlay' });
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(timers.armed.length, 1);
  assert.strictEqual(timers.armed[0].ms, SETTLE_MS);
});

test('a read with edits still unanswered re-reads exactly MAX_SETTLES times, then stops arming', async () => {
  let reads = 0;
  const { svc, timers } = build({ readFog: async () => { reads += 1; return fogOf([edited('a.js')], 1); } });
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(reads, 1);
  for (let i = 0; i < MAX_SETTLES + 3 && timers.armed.length > i; i++) await timers.armed[i].fn();
  assert.strictEqual(reads, 1 + MAX_SETTLES);
  assert.strictEqual(timers.armed.length, MAX_SETTLES);
});

test('a re-read that answers the same announces nothing; one that answers differently announces overlay-ready once', async () => {
  let files = [edited('a.js')];
  const { svc, timers, announced } = build({ readFog: async () => fogOf(files, 1) });
  await ask(svc, { action: 'overlay' });
  await timers.armed[0].fn();
  assert.deepStrictEqual(announced, []);
  files = [edited('a.js'), edited('b.js')];
  await timers.armed[1].fn();
  assert.deepStrictEqual(announced, [{ type: 'repo', action: 'overlay-ready' }]);
  await timers.armed[2].fn();
  assert.strictEqual(announced.length, 1);
});

test('a re-read answer that differs only in the dirs counts as changed', async () => {
  let n = 1;
  const { svc, timers, announced } = build({ readFog: async () => fogOf([{ path: 'd/a.js', tier: 'edited', edits: n }], 1) });
  await ask(svc, { action: 'overlay' });
  n = 4;
  await timers.armed[0].fn();
  assert.strictEqual(announced.length, 1);
});

test('a read with nothing pending arms no timer and resets the count, so a later pending read settles again', async () => {
  let pending = 1;
  const { svc, timers } = build({ readFog: async () => fogOf([edited('a.js')], pending) });
  await ask(svc, { action: 'overlay' });
  for (let i = 0; i < MAX_SETTLES; i++) await timers.armed[i].fn();
  assert.strictEqual(timers.armed.length, MAX_SETTLES);
  pending = 0;
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(timers.armed.length, MAX_SETTLES);
  pending = 1;
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(timers.armed.length, MAX_SETTLES + 1);
});

test('"pending" must be a positive number: 0, undefined, null, NaN and a negative arm nothing', async () => {
  for (const pending of [0, undefined, null, NaN, -1]) {
    const { svc, timers } = build({ readFog: async () => fogOf([edited('a.js')], pending) });
    await ask(svc, { action: 'overlay' });
    assert.strictEqual(timers.armed.length, 0, String(pending));
  }
});

test('a worktree change resets the re-read count, so the loop can run again after it used itself up', async () => {
  const { svc, timers, watchers } = build({ readFog: async () => fogOf([edited('a.js')], 1) });
  await ask(svc, { action: 'overlay' });
  for (let i = 0; i < MAX_SETTLES; i++) await timers.armed[i].fn();
  assert.strictEqual(timers.armed.length, MAX_SETTLES);
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(timers.armed.length, MAX_SETTLES, 'spent: nothing more is armed');
  await watchers[0].onChange();
  await ask(svc, { action: 'overlay' });
  assert.strictEqual(timers.armed.length, MAX_SETTLES + 1);
});

test('close() clears an armed settle timer, once, with that timer; closing again clears nothing more', async () => {
  const { svc, timers } = build({ readFog: async () => fogOf([edited('a.js')], 1) });
  await ask(svc, { action: 'overlay' });
  svc.close();
  assert.deepStrictEqual(timers.cleared, [timers.armed[0]]);
  svc.close();
  assert.strictEqual(timers.cleared.length, 1);
});

test('close() with no timer armed clears nothing, and a fired timer is no longer cleared', async () => {
  const idle = build({ readFog: async () => fogOf([], 0) });
  await ask(idle.svc, { action: 'overlay' });
  idle.svc.close();
  assert.deepStrictEqual(idle.timers.cleared, []);

  const fired = build({ readFog: async () => fogOf([edited('a.js')], 1) });
  await ask(fired.svc, { action: 'overlay' });
  await fired.timers.armed[0].fn();
  fired.svc.close();
  // the fired timer re-armed a new one in its re-read, so that is the one cleared, never the spent one
  assert.deepStrictEqual(fired.timers.cleared, [fired.timers.armed[1]]);
});

// ---- the overlay itself ----

test('a readFog that throws is reported with its message; a thrown string is reported too; the next ask reads again', async () => {
  let reads = 0;
  let boom = new Error('boom');
  const { svc } = build({ readFog: async () => { reads += 1; throw boom; } });
  const r = await ask(svc, { action: 'overlay', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /boom/);
  boom = 'plain string';
  const s = await ask(svc, { action: 'overlay', seq: 2 });
  assert.strictEqual(s.ok, false);
  assert.match(s.error, /plain string/);
  assert.strictEqual(reads, 2, 'a failed read is not kept as the in-flight answer');
});

test('overlay answers the rolled-up files, dirs, and the three status fields, and passes cwd and projectsDir to fog', async () => {
  let seen;
  const { svc } = build({
    readFog: async (o) => { seen = o; return { files: [edited('src/a.js')], status: { transcriptsFound: 3, transcriptErrors: 1, transcriptsMissing: true, pendingEdits: 0, extra: 'dropped' } }; },
  });
  const r = await ask(svc, { action: 'overlay' });
  assert.deepStrictEqual(seen, { cwd: ROOT, projectsDir: 'P' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files, [{ path: 'src/a.js', tier: 'edited', edits: 1 }]);
  assert.deepStrictEqual(r.dirs, [{ path: '', edits: 1, edited: 1, read: 0 }, { path: 'src', edits: 1, edited: 1, read: 0 }]);
  assert.deepStrictEqual(r.status, { transcriptsFound: 3, transcriptErrors: 1, transcriptsMissing: true });
});

test('a fog result with no status still answers, with undefined status fields', async () => {
  const { svc } = build({ readFog: async () => ({ files: [] }) });
  const r = await ask(svc, { action: 'overlay' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.status, { transcriptsFound: undefined, transcriptErrors: undefined, transcriptsMissing: undefined });
});

test('the overlay is spelled the way the listing spells the file', async () => {
  const index = fakeIndex({ resolve: (p) => (p.toLowerCase() === 'src/a.js' ? 'Src/A.js' : null) });
  const { svc } = build({ index, readFog: async () => fogOf([edited('src/a.js')], 0) });
  const r = await ask(svc, { action: 'overlay' });
  assert.deepStrictEqual(r.files.map((f) => f.path), ['Src/A.js']);
});

test('the overlay waits for the first listing, so it can spell files the listing way', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const index = fakeIndex({ refresh: async () => { await gate; return { ok: true }; } });
  const { svc } = build({ index, readFog: async () => fogOf([], 0) });
  let done = false;
  const p = ask(svc, { action: 'overlay' }).then((r) => { done = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(done, false);
  release();
  assert.strictEqual((await p).ok, true);
});

test('an ask while a read is in flight shares it; an ask after a worktree change waits for it, then reads again', async () => {
  const gates = [];
  let reads = 0;
  const readFog = () => { reads += 1; return new Promise((res) => gates.push(res)); };
  const { svc, watchers } = build({ readFog });
  const first = ask(svc, { action: 'overlay' });
  const second = ask(svc, { action: 'overlay' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(reads, 1, 'no change between them: one read answers both');
  await watchers[0].onChange();
  const third = ask(svc, { action: 'overlay' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(reads, 1, 'the third waits for the read that began before the change');
  gates[0](fogOf([], 0));
  await first; await second;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(reads, 2, 'then it reads again');
  gates[1](fogOf([], 0));
  assert.strictEqual((await third).ok, true);
});

// ---- the watcher ----

test('nothing watches until the first ask; then one watcher, for the worktree root, however many asks follow', async () => {
  const { svc, watchers } = build({ readFog: async () => fogOf([], 0) });
  assert.strictEqual(watchers.length, 0);
  await ask(svc, { action: 'list', dir: '' });
  await ask(svc, { action: 'overlay' });
  await ask(svc, { action: 'list', dir: 'x' });
  assert.strictEqual(watchers.length, 1);
  assert.strictEqual(watchers[0].root, ROOT);
});

test('overlay alone starts the watch; read and stat start it only once the path passed the guard; diff and unknown never do', async () => {
  const guard = async (root, p) => (p === 'ok.txt' ? { ok: true, abs: 'C:\\w\\ok.txt', rel: 'ok.txt', real: 'C:\\w\\ok.txt' } : { ok: false, why: 'outside the worktree' });
  const stat = async () => ({ ok: true, size: 1, mtimeMs: 5 });
  const read = async () => ({ ok: true, text: 't' });
  const base = { guard, stat, read, modified: async () => false, diff: async () => ({ ok: true }) };

  const ov = build({ ...base, readFog: async () => fogOf([], 0) });
  await ask(ov.svc, { action: 'overlay' });
  assert.strictEqual(ov.watchers.length, 1);

  for (const action of ['read', 'stat']) {
    const refused = build(base);
    await ask(refused.svc, { action, path: 'bad.txt' });
    assert.strictEqual(refused.watchers.length, 0, `${action} refused by the guard`);
    const allowed = build(base);
    await ask(allowed.svc, { action, path: 'ok.txt' });
    assert.strictEqual(allowed.watchers.length, 1, `${action} allowed`);
  }

  const d = build(base);
  await ask(d.svc, { action: 'diff', path: 'ok.txt' });
  await ask(d.svc, { action: 'nope' });
  assert.strictEqual(d.watchers.length, 0);
});

test('a worktree change refreshes the listing with `again`, then tells every client `changed`', async () => {
  const { svc, watchers, announced, index } = build({ readFog: async () => fogOf([], 0) });
  await ask(svc, { action: 'list', dir: '' });
  index.calls.refresh.length = 0;
  await watchers[0].onChange();
  assert.deepStrictEqual(index.calls.refresh, [{ again: true }]);
  assert.deepStrictEqual(announced, [{ type: 'repo', action: 'changed' }]);
});

test('a refresh that fails on a change is logged with its reason, announces nothing, and does not throw', async () => {
  const index = fakeIndex();
  const { svc, watchers, announced } = build({ index, readFog: async () => fogOf([], 0) });
  await ask(svc, { action: 'list', dir: '' });
  index.refresh = async () => { throw new Error('git went away'); };
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try {
    await watchers[0].onChange();
    index.refresh = async () => { throw undefined; };
    await watchers[0].onChange();
  } finally {
    console.log = real;
  }
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /refresh failed.*git went away/);
  assert.deepStrictEqual(announced, []);
});

test('close() closes the watcher once and swallows a close that throws', async () => {
  const { svc, watchers } = build({ readFog: async () => fogOf([], 0) });
  await ask(svc, { action: 'list', dir: '' });
  watchers[0].close = function () { this.closed += 1; throw new Error('already closed'); };
  svc.close();
  svc.close();
  assert.strictEqual(watchers[0].closed, 1);
  await ask(svc, { action: 'list', dir: '' });
  assert.strictEqual(watchers.length, 2, 'a closed service watches again on its next ask');
});

// ---- list ----

test('list accepts a dir of exactly MAX_DIR characters and refuses one more', async () => {
  const { svc, index } = build();
  const edge = await ask(svc, { action: 'list', dir: 'a'.repeat(MAX_DIR) });
  assert.strictEqual(edge.ok, true);
  assert.deepStrictEqual(index.calls.list, ['a'.repeat(MAX_DIR)]);
  const over = await ask(svc, { action: 'list', dir: 'a'.repeat(MAX_DIR + 1) });
  assert.deepStrictEqual(over, { type: 'repo', action: 'list', ok: false, error: 'not a folder' });
});

test('list caps its entries at listCap and says how many it omitted; exactly the cap omits none', async () => {
  const entries = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'file', name: `f${i}`, path: `f${i}` }));
  for (const [n, kept, omitted] of [[5, 2, 3], [2, 2, 0], [1, 1, 0], [0, 0, 0]]) {
    const { svc } = build({ listCap: 2, index: fakeIndex({ list: () => ({ ok: true, entries: entries(n) }) }) });
    const r = await ask(svc, { action: 'list', dir: 'd' });
    assert.strictEqual(r.entries.length, kept, `n=${n}`);
    assert.strictEqual(r.omitted, omitted, `n=${n}`);
    assert.strictEqual(r.dir, 'd');
  }
});

test('the default list cap is MAX_LIST_ENTRIES', async () => {
  const entries = Array.from({ length: MAX_LIST_ENTRIES + 2 }, (_, i) => ({ kind: 'file', name: `f${i}`, path: `f${i}` }));
  const { svc } = build({ index: fakeIndex({ list: () => ({ ok: true, entries }) }) });
  const r = await ask(svc, { action: 'list', dir: '' });
  assert.strictEqual(r.entries.length, MAX_LIST_ENTRIES);
  assert.strictEqual(r.omitted, 2);
});

test('a listing that failed, or that has no entries array, is passed through with its dir and no omitted count', async () => {
  const failed = build({ index: fakeIndex({ list: () => ({ ok: false, error: 'nope' }) }) });
  assert.deepStrictEqual(await ask(failed.svc, { action: 'list', dir: 'd' }), { type: 'repo', action: 'list', dir: 'd', ok: false, error: 'nope' });
  const odd = build({ index: fakeIndex({ list: () => ({ ok: true, entries: 'x' }) }) });
  const r = await ask(odd.svc, { action: 'list', dir: 'd' });
  assert.strictEqual(r.entries, 'x');
  assert.strictEqual('omitted' in r, false);
});

test('the first listing is shared and kept when it worked; a failed one is not kept, so the next ask runs git again', async () => {
  let n = 0;
  const kept = build({ index: fakeIndex({ refresh: async () => { n += 1; return { ok: true }; } }) });
  await ask(kept.svc, { action: 'list', dir: '' });
  await ask(kept.svc, { action: 'list', dir: 'x' });
  assert.strictEqual(n, 1);

  for (const failure of [{ ok: false, error: 'timeout' }, null, undefined]) {
    let m = 0;
    const flaky = build({ index: fakeIndex({ refresh: async () => { m += 1; return m === 1 ? failure : { ok: true }; } }) });
    await ask(flaky.svc, { action: 'list', dir: '' });
    await ask(flaky.svc, { action: 'list', dir: '' });
    assert.strictEqual(m, 2, String(failure && failure.error));
  }
});

test('two list asks at once share one first listing', async () => {
  let n = 0;
  const { svc } = build({ index: fakeIndex({ refresh: async () => { n += 1; return { ok: true }; } }) });
  await Promise.all([ask(svc, { action: 'list', dir: '' }), ask(svc, { action: 'list', dir: '' })]);
  assert.strictEqual(n, 1);
});

// ---- read and stat ----

const G = { ok: true, abs: 'C:\\w\\a.js', rel: 'a.js', real: 'C:\\w\\REAL.js' };

test('stat asks about the real path (the spelled one when there is none) and answers with the relative path', async () => {
  const asked = [];
  const stat = async (p) => { asked.push(p); return { ok: true, size: 3, mtimeMs: 9 }; };
  const a = build({ guard: async () => G, stat });
  assert.deepStrictEqual(await ask(a.svc, { action: 'stat', path: 'a.js', seq: 'q' }),
    { type: 'repo', action: 'stat', seq: 'q', ok: true, size: 3, mtimeMs: 9, path: 'a.js' });
  const b = build({ guard: async () => ({ ok: true, abs: 'C:\\w\\a.js', rel: 'a.js' }), stat });
  await ask(b.svc, { action: 'stat', path: 'a.js' });
  assert.deepStrictEqual(asked, ['C:\\w\\REAL.js', 'C:\\w\\a.js']);
});

test('read and stat refuse a path that is not a string, and a refusal by the guard says why, with the path cut to 200 characters', async () => {
  const { svc } = build({ guard: async () => ({ ok: false, why: 'outside the worktree' }) });
  for (const action of ['read', 'stat', 'diff']) {
    for (const p of [undefined, 5, null, {}, ['a']]) {
      assert.deepStrictEqual(await ask(svc, { action, path: p }), { type: 'repo', action, ok: false, why: 'bad request', error: 'no path' }, `${action} ${String(p)}`);
    }
  }
  const long = 'a'.repeat(300);
  const r = await ask(svc, { action: 'read', path: long });
  assert.deepStrictEqual(r, { type: 'repo', action: 'read', ok: false, why: 'outside the worktree', path: 'a'.repeat(200) });
});

test('read opens the real path, asks git about the relative path, and attaches `modified` only to a read that worked', async () => {
  const seen = { read: [], modified: [] };
  const mk = (readResult, mod) => build({
    guard: async () => G,
    read: async (p) => { seen.read.push(p); return readResult; },
    modified: async (root, rel) => { seen.modified.push([root, rel]); return mod; },
  });
  const ok = await ask(mk({ ok: true, text: 'x' }, true).svc, { action: 'read', path: 'a.js' });
  assert.deepStrictEqual(ok, { type: 'repo', action: 'read', ok: true, text: 'x', modified: true, path: 'a.js' });
  const bad = await ask(mk({ ok: false, why: 'binary' }, true).svc, { action: 'read', path: 'a.js' });
  assert.deepStrictEqual(bad, { type: 'repo', action: 'read', ok: false, why: 'binary', path: 'a.js' });
  assert.deepStrictEqual(seen.read, ['C:\\w\\REAL.js', 'C:\\w\\REAL.js']);
  assert.deepStrictEqual(seen.modified, [[ROOT, 'a.js'], [ROOT, 'a.js']]);
});

test('read falls back to the spelled path when the guard gives no real one', async () => {
  const seen = [];
  const { svc } = build({
    guard: async () => ({ ok: true, abs: 'C:\\w\\a.js', rel: 'a.js' }),
    read: async (p) => { seen.push(p); return { ok: true, text: '' }; },
    modified: async () => false,
  });
  const r = await ask(svc, { action: 'read', path: 'a.js' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, ['C:\\w\\a.js']);
});

test('read re-checks the path after the bytes are in hand: a changed or refused answer drops the text', async () => {
  const run = async (again) => {
    let n = 0;
    const { svc } = build({
      guard: async () => (++n === 1 ? G : again),
      read: async () => ({ ok: true, text: 'secret' }),
      modified: async () => false,
    });
    return ask(svc, { action: 'read', path: 'a.js' });
  };
  const expected = { type: 'repo', action: 'read', ok: false, why: 'changed while reading', path: 'a.js' };
  assert.deepStrictEqual(await run({ ok: false, why: 'gone' }), expected);
  assert.deepStrictEqual(await run({ ok: true, abs: 'C:\\w\\a.js', rel: 'a.js', real: 'D:\\out\\a.js' }), expected);
  assert.deepStrictEqual(await run({ ok: true, abs: 'C:\\w\\OTHER.js', rel: 'a.js' }), expected);
  const same = await run({ ok: true, abs: 'x', rel: 'a.js', real: 'c:\\w\\real.JS' });
  assert.strictEqual(same.ok, true, 'a different spelling of the same file is the same file');
  const sameAbs = await run({ ok: true, abs: 'C:\\W\\REAL.JS', rel: 'a.js' });
  assert.strictEqual(sameAbs.ok, true);
});

test('a failed read is not re-checked, so the guard runs once', async () => {
  let n = 0;
  const { svc } = build({ guard: async () => { n += 1; return G; }, read: async () => ({ ok: false, why: 'gone' }), modified: async () => false });
  await ask(svc, { action: 'read', path: 'a.js' });
  assert.strictEqual(n, 1);
});

// ---- diff ----

test('diff runs the lexical half, re-spells the path through the guard, and hands the diff the file\'s mtime', async () => {
  const seen = {};
  const { svc } = build({
    guard: async (root, rel) => { seen.guard = [root, rel]; return G; },
    stat: async (p) => { seen.stat = p; return { ok: true, mtimeMs: 77 }; },
    diff: async (o) => { seen.diff = o; return { ok: true, calls: [] }; },
  });
  const r = await ask(svc, { action: 'diff', path: 'sub/../a.js' });
  assert.deepStrictEqual(seen.guard, [ROOT, 'a.js']);
  assert.strictEqual(seen.stat, 'C:\\w\\REAL.js');
  assert.deepStrictEqual(seen.diff, { root: ROOT, rel: 'a.js', projectsDir: 'P', fileMtimeMs: 77 });
  assert.deepStrictEqual(r, { type: 'repo', action: 'diff', ok: true, calls: [], path: 'a.js' });
});

test('diff with no file time (the guard refused, the stat failed) still diffs, with an undefined mtime', async () => {
  for (const [guard, stat] of [
    [async () => ({ ok: false, why: 'gone' }), async () => { throw new Error('must not stat'); }],
    [async () => G, async () => ({ ok: false, mtimeMs: 5 })],
  ]) {
    let got;
    const { svc } = build({ guard, stat, diff: async (o) => { got = o; return { ok: true }; } });
    await ask(svc, { action: 'diff', path: 'a.js' });
    assert.strictEqual(got.fileMtimeMs, undefined);
  }
});

test('diff stats the spelled path when the guard has no real one', async () => {
  let asked;
  const { svc } = build({
    guard: async () => ({ ok: true, abs: 'C:\\w\\a.js', rel: 'a.js' }),
    stat: async (p) => { asked = p; return { ok: true, mtimeMs: 1 }; },
    diff: async () => ({ ok: true }),
  });
  await ask(svc, { action: 'diff', path: 'a.js' });
  assert.strictEqual(asked, 'C:\\w\\a.js');
});

test('diff refuses a path the lexical half refuses, without touching git or the disk', async () => {
  const { svc } = build({
    guard: async () => { throw new Error('no'); }, stat: async () => { throw new Error('no'); }, diff: async () => { throw new Error('no'); },
  });
  const r = await ask(svc, { action: 'diff', path: '..\\x' });
  assert.deepStrictEqual(r, { type: 'repo', action: 'diff', ok: false, why: 'outside the worktree', path: '..\\x' });
});

// ---- handle ----

test('a request that is not an object is "not a request"', async () => {
  const { svc } = build();
  for (const bad of [null, undefined, 'list', 5]) {
    assert.deepStrictEqual(await svc.handle(bad), { type: 'repo', ok: false, error: 'not a request' }, String(bad));
  }
});

test('an unknown or missing action says so; the echoed action is cut to 32 characters and only echoed when it is a string', async () => {
  const { svc } = build();
  assert.deepStrictEqual(await ask(svc, { action: 'nope' }), { type: 'repo', action: 'nope', ok: false, error: 'unknown repo action' });
  assert.deepStrictEqual(await ask(svc, { action: 'x'.repeat(40) }), { type: 'repo', action: 'x'.repeat(32), ok: false, error: 'unknown repo action' });
  for (const action of [undefined, 5, null]) {
    const r = await ask(svc, { action });
    assert.strictEqual(r.action, undefined);
    assert.strictEqual(r.error, 'unknown repo action');
  }
});

test('seq is echoed when it is a safe integer or a string of up to 64 characters, and dropped otherwise', async () => {
  const { svc } = build();
  for (const seq of [0, 7, -3, 's', 'x'.repeat(64)]) assert.strictEqual((await ask(svc, { action: 'nope', seq })).seq, seq, String(seq));
  for (const seq of [1.5, NaN, Infinity, 'x'.repeat(65), null, {}, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.strictEqual('seq' in (await ask(svc, { action: 'nope', seq })), false, String(seq));
  }
});

test('a service call that throws is reported as a failure carrying the reason, for an Error and for a thrown string', async () => {
  const boom = (e) => build({ index: fakeIndex({ refresh: async () => { throw e; } }) });
  const a = await ask(boom(new Error('disk on fire')).svc, { action: 'list', dir: '', seq: 4 });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.seq, 4);
  assert.strictEqual(a.action, 'list');
  assert.match(a.error, /disk on fire/);
  const b = await ask(boom('a plain string').svc, { action: 'list', dir: '' });
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /a plain string/);
});

// ---- the default timer ----

// Replaces the global timers for the body, then restores them. The service reads them when it is CREATED
// (clearTimer's default) and when it arms a timer (setTimer's default), so the body builds it inside.
async function withGlobalTimers(fake, body) {
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  global.setTimeout = fake.setTimeout;
  global.clearTimeout = fake.clearTimeout;
  try { return await body(); } finally { Object.assign(global, real); }
}

function plainService(over = {}) {
  return createRepoService({
    root: ROOT, projectsDir: 'P', index: fakeIndex(), watch: () => ({ close() {} }),
    readFog: async () => fogOf([edited('a.js')], 1), ...over,
  });
}

test('the default timer is a real setTimeout of SETTLE_MS that is unref\'d so it never holds the host open, and close() clears it', async () => {
  const armed = [];
  const cleared = [];
  const timer = { unrefs: 0, unref() { this.unrefs += 1; } };
  await withGlobalTimers({ setTimeout: (fn, ms) => { armed.push([fn, ms]); return timer; }, clearTimeout: (t) => cleared.push(t) }, async () => {
    const svc = plainService();
    await ask(svc, { action: 'overlay' });
    await ask(svc, { action: 'overlay' });
    assert.strictEqual(armed.length, 1, 'one timer however many asks');
    assert.strictEqual(armed[0][1], SETTLE_MS);
    assert.strictEqual(timer.unrefs, 1);
    svc.close();
    assert.deepStrictEqual(cleared, [timer]);
  });
});

test('a default timer that has no unref (or is not an object) is used as it is', async () => {
  for (const handle of [{}, 7, 'h']) {
    const armed = [];
    await withGlobalTimers({ setTimeout: (fn, ms) => { armed.push([fn, ms]); return handle; }, clearTimeout: () => {} }, async () => {
      const svc = plainService();
      await ask(svc, { action: 'overlay' });
      await ask(svc, { action: 'overlay' });
      assert.strictEqual(armed.length, 1, `handle ${String(handle)}`);
    });
  }
});

test('a default timer that is null or undefined does not throw, and does not count as armed twice', async () => {
  for (const handle of [null, undefined]) {
    const armed = [];
    await withGlobalTimers({ setTimeout: (fn, ms) => { armed.push([fn, ms]); return handle; }, clearTimeout: () => {} }, async () => {
      const svc = plainService();
      const r = await ask(svc, { action: 'overlay' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(armed.length, 1);
    });
  }
});

test('the default timer\'s callback re-reads and announces when the answer changed', async () => {
  let files = [edited('a.js')];
  const armed = [];
  const announced = [];
  await withGlobalTimers({ setTimeout: (fn) => { armed.push(fn); return { unref() {} }; }, clearTimeout: () => {} }, async () => {
    const svc = plainService({ announce: (m) => announced.push(m), readFog: async () => fogOf(files, 1) });
    await ask(svc, { action: 'overlay' });
    files = [edited('a.js'), edited('b.js')];
    await armed[0]();
    assert.deepStrictEqual(announced, [{ type: 'repo', action: 'overlay-ready' }]);
  });
});

// ---- more edges ----

test('a listing that failed but still carries an entries array is passed through whole, uncut, with no omitted count', async () => {
  const { svc } = build({ listCap: 1, index: fakeIndex({ list: () => ({ ok: false, error: 'half', entries: [1, 2, 3] }) }) });
  const r = await ask(svc, { action: 'list', dir: 'd' });
  assert.deepStrictEqual(r.entries, [1, 2, 3]);
  assert.strictEqual('omitted' in r, false);
  assert.strictEqual(r.ok, false);
});

test('diff cuts the path it echoes on a refusal to 200 characters', async () => {
  const { svc } = build();
  const long = '..\\' + 'a'.repeat(300);
  const r = await ask(svc, { action: 'diff', path: long });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.path.length, 200);
  assert.strictEqual(r.path, long.slice(0, 200));
});
