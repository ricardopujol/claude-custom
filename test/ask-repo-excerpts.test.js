'use strict';
/** host/ask-repo.js excerptsFor() (BACKLOG #33): the retrieval half of the explainer and of the panel's early "where to look" cards. */
const test = require('node:test');
const assert = require('node:assert');
const { createAskRepo } = require('../host/ask-repo');

const WT = 'C:\\proj\\wt';
const chunk = (start, end, text, vec) => ({ start, end, ownStart: start, text, vec: vec ? Float32Array.from(vec) : null });
const DATA = {
  embedModel: 'e', builtAt: 1,
  files: [
    { rel: 'host/file-lock.js', size: 1, mtimeMs: 1, lines: 200, chunks: [chunk(1, 40, 'function withFileLock(path) {\n  acquire lock\n}', [1, 0]), chunk(41, 80, 'function releaseFileLock(path) {\n  release lock\n}', [0.9, 0.1])] },
    { rel: 'app/toolbar.js', size: 1, mtimeMs: 1, lines: 50, chunks: [chunk(1, 30, 'renders the toolbar buttons', [0, 1])] },
  ],
};

function build({ data = DATA, check = { ok: true, answer: true, embed: true }, embed, running = false, progressImpl, generate, snapshot } = {}) {
  const calls = { embed: [], generate: [] };
  const index = {
    load: async () => data, get: () => data, isRunning: () => running,
    progress: () => (progressImpl ? progressImpl() : { state: data ? 'ready' : 'building', done: 1, total: 4 }),
    refresh: async () => ({ ok: true }),
    ...(snapshot ? { snapshot: () => snapshot } : {}),
  };
  const ollama = {
    answerModel: 'm', embedModel: 'e', check: async () => check,
    embed: embed || (async (t) => { calls.embed.push(t); return { ok: true, vectors: t.map(() => [1, 0]) }; }),
    generate: generate || (async (a) => { calls.generate.push(a); return { ok: true, text: 'x' }; }),
  };
  return { repo: createAskRepo({ index, ollama, k: 8, staleWaitMs: 30 }), calls };
}

test('excerptsFor: numbered excerpts, the ranges they hold, the files\' line counts, and the model status', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'withFileLock acquire lock');
  assert.strictEqual(r.ok, true);
  assert.match(r.body, /### host\/file-lock\.js:1-3\n1: function withFileLock/);
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 1));
  assert.strictEqual(r.lineCounts.get('host/file-lock.js'), 200);
  assert.deepStrictEqual(r.ollamaStatus, { ok: true, answer: true, embed: true });
  assert.strictEqual(r.keywordOnly, false);
});

test('excerptsFor: the selection\'s own lines are left out, so the excerpts say where ELSE it shows up', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 1, end: 40 } });
  assert.ok(!r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 1), 'the chunk holding the selection is gone');
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 41), 'a neighbouring chunk stays');
});

test('excerptsFor: a chunk that only touches the selection by one line is excluded, one beside it is not', async () => {
  const { repo } = build();
  const touch = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 40, end: 41 } });
  assert.ok(!touch.sent.some(s => s.file === 'host/file-lock.js'), 'both chunks overlap lines 40-41');
  const beside = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 81, end: 90 } });
  assert.strictEqual(beside.sent.filter(s => s.file === 'host/file-lock.js').length, 2);
});

test('excerptsFor: k limits how many chunks are offered', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'lock', { k: 1 });
  assert.strictEqual(r.sent.length, 1);
});

test('excerptsFor: nothing matching is ok with an empty body (an explanation can still be written from the selection)', async () => {
  const { repo } = build({ data: { embedModel: 'e', builtAt: 1, files: [] } });
  const r = await repo.excerptsFor(WT, 'anything');
  assert.deepStrictEqual([r.ok, r.body, r.sent], [true, '', []]);
});

test('excerptsFor: an empty query is refused; the index still building is the same failure ask() gives, with its progress', async () => {
  assert.strictEqual((await build().repo.excerptsFor(WT, '  ')).reason, 'empty-question');
  const building = build({ data: null, running: true, progressImpl: () => ({ state: 'building', done: 5, total: 20 }) });
  const r = await building.repo.excerptsFor(WT, 'q');
  assert.deepStrictEqual([r.ok, r.reason, r.progress], [false, 'index-building', { state: 'building', done: 5, total: 20 }]);
});

test('excerptsFor: Ollama down is not a failure of the search: keywords answer and the status says why', async () => {
  const { repo, calls } = build({ check: { ok: false, reason: 'ollama-down' } });
  const r = await repo.excerptsFor(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.keywordOnly, true);
  assert.deepStrictEqual(r.ollamaStatus, { ok: false, reason: 'ollama-down' });
  assert.strictEqual(calls.embed.length, 0);
});

test('excerptsFor never asks a model to write anything', async () => {
  const { repo, calls } = build();
  await repo.excerptsFor(WT, 'lock');
  assert.strictEqual(calls.generate.length, 0);
});

const SNAP = { embedModel: 'e', builtAt: 1, files: [DATA.files[0]] };
const building = (over = {}) => build({ data: null, running: true, progressImpl: () => ({ state: 'building', done: 1, total: 9, partial: false }), ...over });

test('PR #169 Dexter 3 (Round 7): while the first index is being built, a question is answered from the files indexed so far, and says so', async () => {
  const { repo } = building({ snapshot: SNAP });
  const r = await repo.ask(WT, 'where is withFileLock defined?');
  assert.strictEqual(r.ok, true, 'not a refusal');
  assert.deepStrictEqual(r.building, { state: 'building', done: 1, total: 9, partial: false });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.sources[0].file, 'host/file-lock.js');
});

test('the same for an explanation\'s excerpts and the places preview', async () => {
  const { repo } = building({ snapshot: SNAP });
  const r = await repo.excerptsFor(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.ok(r.building);
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js'));
});

test('with nothing indexed yet (no file so far) it is still "building", with its progress', async () => {
  for (const snapshot of [undefined, { embedModel: 'e', builtAt: 1, files: [] }, null]) {
    const { repo } = building({ snapshot });
    const r = await repo.ask(WT, 'anything');
    assert.deepStrictEqual([r.ok, r.reason, r.progress.done], [false, 'index-building', 1]);
  }
});

test('a finished index is not marked as building', async () => {
  const { repo } = build({ snapshot: SNAP });
  const r = await repo.ask(WT, 'where is withFileLock defined?');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.building, undefined);
});

test('ask: a model failure carries the answerer\'s own words (a Claude run says why), not just a reason', async () => {
  const { repo } = build({ generate: async () => ({ ok: false, reason: 'claude-failed', detail: 'Overloaded' }) });
  const r = await repo.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'claude-failed', 'Overloaded']);
  assert.ok(Array.isArray(r.hits) && r.hits.length > 0, 'the places the search found still come back');
});

// ---- one retrieval per ask (PR #169 El Gordo 1, Miguel Y10), against a REAL index over a fake file world ----
const { createIndex } = require('../host/ask-index');
const { tmpDir } = require('./tmp-dir');

function realRepo() {
  const files = new Map([['lib/lock.js', { text: 'function releaseLock(path) {\n  // the lock is released here\n}\n', mtimeMs: 1 }], ['lib/bar.js', { text: 'function toolbar() {}\n', mtimeMs: 1 }]]);
  const calls = { refresh: 0, embed: 0, generate: 0 };
  const index = createIndex({
    dir: tmpDir(), embedModel: 'e',
    listFiles: async () => [...files.keys()].sort(),
    statFile: async (_w, rel) => { const f = files.get(rel); return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null; },
    readFile: async (_w, rel) => files.get(rel).text,
    embed: async (texts) => { calls.embed += 1; return { ok: true, vectors: texts.map(() => [1, 0]) }; },
  });
  const realRefresh = index.refresh;
  index.refresh = (wt) => { calls.refresh += 1; return realRefresh(wt); };
  const ollama = {
    answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, answer: true, embed: true }),
    embed: async (t) => { calls.embed += 1; return { ok: true, vectors: t.map(() => [1, 0]) }; },
    generate: async () => { calls.generate += 1; return { ok: true, text: 'It is in lib/lock.js:2.' }; },
  };
  return { repo: createAskRepo({ index, ollama, k: 8 }), calls, index };
}

test('a fresh index gives NO "index may be a little behind" note: places then the answer on the same hits is one retrieval, one freshness check', async () => {
  const { repo, calls, index } = realRepo();
  await index.refresh(WT);
  const refreshesBefore = calls.refresh;
  const embedsBefore = calls.embed;
  const ex = await repo.excerptsFor(WT, 'where is the lock released?');
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(ex.stale, false);
  const r = await repo.ask(WT, 'where is the lock released?', { prepared: ex.prepared });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stale, false, 'no stale note on a fresh index');
  assert.strictEqual(calls.refresh - refreshesBefore, 1, 'one freshness check for the whole ask');
  assert.strictEqual(calls.embed - embedsBefore, 1, 'one query embedding for the whole ask');
  assert.deepStrictEqual(r.sources, ex.sent.map(s => ({ file: s.file, line: s.start, endLine: s.end })), 'the answer used the places\' own hits');
});

test('prepared retrieval is used as given: ask() does not search again, and a prepared miss is still no-matches', async () => {
  const { repo, calls } = realRepo();
  const none = { data: { files: [] }, stale: false, status: { ok: true }, top: [], keywordOnly: false };
  const r = await repo.ask(WT, 'whatever', { prepared: none });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no-matches']);
  assert.strictEqual(calls.refresh, 0);
  assert.strictEqual(calls.embed, 0);
});
