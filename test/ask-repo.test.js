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
    { rel: 'host/file-lock.js', size: 1, mtimeMs: 1, lines: 200, chunks: [chunk(140, 175, 'function withFileLock(path) {\n  // acquire the lock\n}' + '\n// more'.repeat(33), [1, 0])] },
    { rel: 'app/toolbar.js', size: 1, mtimeMs: 1, lines: 50, chunks: [chunk(1, 30, 'renders the toolbar buttons', [0, 1])] },
  ],
};

function build({ data = DATA, running = false, check = { ok: true, answer: true, embed: true }, embed, generate, refreshMs, refreshImpl, progressImpl, embedModel, probeMs = 30 } = {}) {
  const calls = { generate: [], refresh: 0, embed: [] };
  let current = data;
  const index = {
    load: async () => current,
    get: () => current,
    isRunning: () => running,
    progress: () => (progressImpl ? progressImpl() : { state: current ? 'ready' : 'building', done: 1, total: 4 }),
    refresh: async () => { calls.refresh++; if (refreshImpl) return refreshImpl(); if (refreshMs) await new Promise(r => setTimeout(r, refreshMs)); return { ok: true }; },
  };
  const ollama = {
    answerModel: 'qwen2.5-coder:latest',
    embedModel,
    check: async () => check,
    embed: embed || (async (t) => { calls.embed.push(t); return { ok: true, vectors: t.map(() => [1, 0]) }; }),
    generate: generate || (async (a) => { calls.generate.push(a); return { ok: true, text: 'It is defined in host/file-lock.js:150.' }; }),
  };
  return { ask: createAskRepo({ index, ollama, k: 8, staleWaitMs: 30, buildProbeMs: probeMs }), calls, setData: (d) => { current = d; } };
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

// ---- PR #136 review fixes ----
const { buildPrompt, PROMPT_MAX_CHARS, SYSTEM } = require('../host/ask-repo');
const fc = require('fast-check');

test('D2/M1: a build that fails at once is index-failed with the reason, not index-building', async () => {
  const { ask } = build({ data: null, refreshImpl: async () => { throw new Error('fatal: not a git repository'); } });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'index-failed']);
  assert.match(r.error, /not a git repository/);
});

test('D2: a build that is genuinely running is still index-building (the probe window passes quietly)', async () => {
  const { ask } = build({ data: null, refreshMs: 500 });
  assert.strictEqual((await ask.ask(WT, 'x')).reason, 'index-building');
});

test('D2: status of a failed index says failed with the error', async () => {
  const { ask } = build({ data: null, progressImpl: () => ({ state: 'failed', done: 0, total: 0, error: 'git gone', partial: false }) });
  const s = await ask.status(WT);
  assert.deepStrictEqual([s.state, s.error], ['failed', 'git gone']);
});

test('D3: a refresh that fails answers from the saved index marked stale, with the reason', async () => {
  const { ask } = build({ refreshImpl: async () => { throw new Error('git gone'); } });
  const r = await ask.ask(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.stale, r.refreshError], [true, 'git gone']);
});

test('M5: a partial index is not answered from: index-building with partial, and the build resumes', async () => {
  const { ask, calls } = build({ progressImpl: () => ({ state: 'partial', done: 1, total: 1, partial: true }), refreshMs: 500 });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason, r.partial], [false, 'index-building', true]);
  assert.strictEqual(calls.refresh, 1);
  assert.strictEqual((await ask.status(WT)).state, 'partial');
});

test('D4: the model parroting a made-up example, or citing a line it was never shown, comes back dropped', async () => {
  assert.doesNotMatch(SYSTEM, /session-lock/);
  const { ask } = build({ generate: async () => ({ ok: true, text: 'path/to/file.ext:123 and host/file-lock.js:190 and host/file-lock.js:150' }) });
  const r = await ask.ask(WT, 'withFileLock');
  assert.deepStrictEqual(r.citations, [{ file: 'host/file-lock.js', line: 150, endLine: 150 }]);
  assert.deepStrictEqual(r.dropped, ['path/to/file.ext:123', 'host/file-lock.js:190']);
});

test('D7: an index made by another embedding model is not searched by vector, and says keywordOnly', async () => {
  const { ask, calls } = build({ embedModel: 'other-model' });
  const r = await ask.ask(WT, 'withFileLock');
  assert.strictEqual(r.keywordOnly, true);
  assert.strictEqual(calls.embed.length, 0, 'a vector from the wrong model was used');
});

test('D5: one huge line cannot push the prompt past the budget, and the sent range follows what was kept', () => {
  const top = [{ rel: 'app/bundle.js', chunk: { start: 1, end: 3, text: `short\n${'x'.repeat(200000)}\nlast` } }];
  const { prompt, sent } = buildPrompt('what is this?', top);
  assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${prompt.length} chars`);
  assert.match(prompt, /^2: x+/m);
  assert.deepStrictEqual(sent.map(x => [x.file, x.start]), [['app/bundle.js', 1]]);
});

test('D5 P: for any chunks and any question the prompt fits the budget, and every sent range lies inside its chunk', () => {
  const chunkArb = fc.record({
    rel: fc.constantFrom('a.js', 'b/c.md'),
    start: fc.integer({ min: 1, max: 500 }),
    lines: fc.array(fc.string({ maxLength: 4000 }).filter(l => !l.includes('\n')), { minLength: 1, maxLength: 70 }),
  });
  fc.assert(fc.property(fc.array(chunkArb, { minLength: 1, maxLength: 12 }), fc.string({ maxLength: 700 }), (cs, q) => {
    const top = cs.map(c => ({ rel: c.rel, chunk: { start: c.start, end: c.start + c.lines.length - 1, text: c.lines.join('\n') } }));
    const { prompt, sent } = buildPrompt(q.trim().slice(0, 500), top);
    assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${prompt.length}`);
    for (const x of sent) {
      assert.ok(x.end >= x.start && top.some(t => t.rel === x.file && t.chunk.start === x.start && x.end <= t.chunk.end));
    }
    assert.ok(sent.length >= 1);
  }));
});
