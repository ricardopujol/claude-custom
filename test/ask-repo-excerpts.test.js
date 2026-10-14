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

function build({ data = DATA, check = { ok: true, answer: true, embed: true }, embed, running = false, progressImpl, generate } = {}) {
  const calls = { embed: [], generate: [] };
  const index = {
    load: async () => data, get: () => data, isRunning: () => running,
    progress: () => (progressImpl ? progressImpl() : { state: data ? 'ready' : 'building', done: 1, total: 4 }),
    refresh: async () => ({ ok: true }),
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

test('ask: a model failure carries the answerer\'s own words (a Claude run says why), not just a reason', async () => {
  const { repo } = build({ generate: async () => ({ ok: false, reason: 'claude-failed', detail: 'Overloaded' }) });
  const r = await repo.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'claude-failed', 'Overloaded']);
  assert.ok(Array.isArray(r.hits) && r.hits.length > 0, 'the places the search found still come back');
});
