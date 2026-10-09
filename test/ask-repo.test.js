'use strict';
/** The "ask the repo" orchestrator (BACKLOG #33): retrieve, answer from the top chunks, cite what exists, fail honestly. */
const test = require('node:test');
const assert = require('node:assert');
const { createAskRepo } = require('../host/ask-repo');
const { tokenize } = require('../host/ask-retrieve');

const WT = 'C:\\proj\\wt';
const chunk = (start, end, text, vec) => ({ start, end, ownStart: start, text, vec: vec ? Float32Array.from(vec) : null });
const DATA = {
  embedModel: 'e', builtAt: 1,
  files: [
    { rel: 'host/file-lock.js', size: 1, mtimeMs: 1, lines: 200, chunks: [chunk(140, 175, 'function withFileLock(path) {\n  // acquire the lock\n}', [1, 0])] },
    { rel: 'app/toolbar.js', size: 1, mtimeMs: 1, lines: 50, chunks: [chunk(1, 30, 'renders the toolbar buttons', [0, 1])] },
  ],
};

function build({ data = DATA, running = false, check = { ok: true, answer: true, embed: true }, embed, generate, refreshMs } = {}) {
  const calls = { generate: [], refresh: 0, embed: [] };
  let current = data;
  const index = {
    load: async () => current,
    get: () => current,
    isRunning: () => running,
    progress: () => ({ state: current ? 'ready' : 'building', done: 1, total: 4 }),
    refresh: async () => { calls.refresh++; if (refreshMs) await new Promise(r => setTimeout(r, refreshMs)); return { ok: true }; },
  };
  const ollama = {
    answerModel: 'qwen2.5-coder:latest',
    check: async () => check,
    embed: embed || (async (t) => { calls.embed.push(t); return { ok: true, vectors: t.map(() => [1, 0]) }; }),
    generate: generate || (async (a) => { calls.generate.push(a); return { ok: true, text: 'It is defined in host/file-lock.js:150.' }; }),
  };
  return { ask: createAskRepo({ index, ollama, k: 8, staleWaitMs: 30 }), calls, setData: (d) => { current = d; } };
}

test('an answer carries text, verified citations, its sources, and the local-model label', async () => {
  const { ask } = build();
  const r = await ask.ask(WT, 'Where is withFileLock defined?');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.label, 'local model');
  assert.strictEqual(r.model, 'qwen2.5-coder:latest');
  assert.deepStrictEqual(r.citations, [{ file: 'host/file-lock.js', line: 150, endLine: 150 }]);
  assert.strictEqual(r.sources[0].file, 'host/file-lock.js');
  assert.strictEqual(r.keywordOnly, false);
});

test('the prompt carries line-numbered excerpts and the question', async () => {
  const { ask, calls } = build();
  await ask.ask(WT, 'Where is withFileLock defined?');
  const p = calls.generate[0].prompt;
  assert.match(p, /### host\/file-lock\.js:140-175/);
  assert.match(p, /^141: {3}\/\/ acquire the lock$/m);
  assert.match(p, /Question: Where is withFileLock defined\?/);
  assert.match(calls.generate[0].system, /ONLY the numbered excerpts/);
});

test('a citation the model invented is dropped and reported, never linked', async () => {
  const { ask } = build({ generate: async () => ({ ok: true, text: 'See host/ghost.js:9 and host/file-lock.js:5000 and host/file-lock.js:141.' }) });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual(r.citations.map(c => c.line), [141]);
  assert.deepStrictEqual(r.dropped, ['host/ghost.js:9', 'host/file-lock.js:5000']);
});

test('an empty question is refused plainly', async () => {
  assert.deepStrictEqual(await build().ask.ask(WT, '   '), { ok: false, reason: 'empty-question' });
});

test('Ollama down: says so, and still returns the keyword hits it can find', async () => {
  const { ask } = build({ check: { ok: false, reason: 'ollama-down' } });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'ollama-down']);
  assert.strictEqual(r.hits[0].file, 'host/file-lock.js');
  assert.strictEqual(r.hits[0].line, 140);
});

test('answer model missing: names the model and returns hits, no answer', async () => {
  const { ask, calls } = build({ check: { ok: false, reason: 'model-missing', model: 'qwen2.5-coder:latest', embed: true } });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason, r.model], [false, 'model-missing', 'qwen2.5-coder:latest']);
  assert.ok(r.hits.length > 0);
  assert.strictEqual(calls.generate.length, 0);
});

test('a generate failure is reported with the hits, not as an empty answer', async () => {
  const { ask } = build({ generate: async () => ({ ok: false, reason: 'timeout' }) });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'timeout']);
  assert.ok(r.hits.length > 0);
});

test('no index yet: starts the build and says it is building, with progress', async () => {
  const { ask, calls } = build({ data: null });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'index-building']);
  assert.deepStrictEqual(r.progress, { state: 'building', done: 1, total: 4 });
  assert.strictEqual(calls.refresh, 1);
});

test('no index and a build already running: does not start a second one', async () => {
  const { ask, calls } = build({ data: null, running: true });
  assert.strictEqual((await ask.ask(WT, 'x')).reason, 'index-building');
  assert.strictEqual(calls.refresh, 0);
});

test('the embedder failing for the question falls back to keywords and says so', async () => {
  const { ask } = build({ embed: async () => ({ ok: false, reason: 'ollama-down' }) });
  const r = await ask.ask(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.keywordOnly, true);
});

test('a refresh that outlasts the wait does not hold the question: it answers from the saved index, marked stale', async () => {
  const { ask } = build({ refreshMs: 400 });
  const r = await ask.ask(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stale, true);
});

test('a quick refresh is awaited and the answer is not stale', async () => {
  const { ask, calls } = build();
  const r = await ask.ask(WT, 'withFileLock');
  assert.strictEqual(calls.refresh, 1);
  assert.strictEqual(r.stale, false);
});

test('a question that matches nothing says so instead of asking the model with no excerpts', async () => {
  const { ask, calls } = build({ embed: async () => ({ ok: false, reason: 'ollama-down' }) });
  const r = await ask.ask(WT, 'zzzz qqqq');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no-matches']);
  assert.strictEqual(calls.generate.length, 0);
});

test('status reports the index state without touching Ollama', async () => {
  const { ask } = build();
  assert.deepStrictEqual(await ask.status(WT), { state: 'ready', files: 2, chunks: 2, builtAt: 1, keywordOnly: false, model: 'qwen2.5-coder:latest', progress: { state: 'ready', done: 1, total: 4 } });
});

test('tokenize is shared with the index (sanity: the same tokens the ranking sees)', () => {
  assert.ok(tokenize('withFileLock').includes('lock'));
});
