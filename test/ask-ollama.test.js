'use strict';
/** The Ollama client for "ask the repo" (BACKLOG #33): embeddings and one answer, with honest failure reasons. */
const test = require('node:test');
const assert = require('node:assert');
const { createAskOllama } = require('../host/ask-ollama');

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const tags = (...names) => json(200, { models: names.map(name => ({ name })) });

function client(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('http://127.0.0.1:11434', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    return handler(path, body, init);
  };
  return { c: createAskOllama({ fetchImpl, answerModel: 'qwen2.5-coder:latest', embedModel: 'snowflake-arctic-embed2:latest', ...extra }), calls };
}

test('check: both models installed is ok', async () => {
  const { c } = client(() => tags('qwen2.5-coder:latest', 'snowflake-arctic-embed2:latest'));
  assert.deepStrictEqual(await c.check(), { ok: true, answer: true, embed: true });
});

test('check: Ollama not answering says ollama-down', async () => {
  const { c } = client(() => { throw new Error('ECONNREFUSED'); });
  assert.deepStrictEqual(await c.check(), { ok: false, reason: 'ollama-down' });
});

test('check: no answer model says model-missing and names it', async () => {
  const { c } = client(() => tags('snowflake-arctic-embed2:latest'));
  assert.deepStrictEqual(await c.check(), { ok: false, reason: 'model-missing', model: 'qwen2.5-coder:latest', embed: true });
});

test('check: no embed model is still usable (keywords only), and says so', async () => {
  const { c } = client(() => tags('qwen2.5-coder:latest'));
  assert.deepStrictEqual(await c.check(), { ok: true, answer: true, embed: false });
});

test('embed: batches go to /api/embed and come back as arrays', async () => {
  const { c, calls } = client(() => json(200, { embeddings: [[1, 2], [3, 4]] }));
  const r = await c.embed(['a', 'b']);
  assert.deepStrictEqual(r, { ok: true, vectors: [[1, 2], [3, 4]] });
  assert.strictEqual(calls[0].path, '/api/embed');
  assert.deepStrictEqual(calls[0].body.input, ['a', 'b']);
  assert.strictEqual(calls[0].body.keep_alive, '2m');
});

test('embed: a reply with the wrong number of vectors is a bad reply, not a shorter index', async () => {
  const { c } = client(() => json(200, { embeddings: [[1, 2]] }));
  assert.deepStrictEqual(await c.embed(['a', 'b']), { ok: false, reason: 'bad-reply' });
});

test('embed: a non-numeric vector is a bad reply', async () => {
  const { c } = client(() => json(200, { embeddings: [[1, 'x']] }));
  assert.deepStrictEqual(await c.embed(['a']), { ok: false, reason: 'bad-reply' });
});

test('embed: 404 is model-missing, a thrown fetch is ollama-down', async () => {
  assert.deepStrictEqual(await client(() => json(404, {})).c.embed(['a']), { ok: false, reason: 'model-missing', model: 'snowflake-arctic-embed2:latest' });
  assert.deepStrictEqual(await client(() => { throw new Error('x'); }).c.embed(['a']), { ok: false, reason: 'ollama-down' });
});

test('generate: sends the system prompt, the settings per request, and unloads after 5 minutes idle', async () => {
  const { c, calls } = client(() => json(200, { response: ' host/a.js:3 ', eval_count: 4 }));
  const r = await c.generate({ system: 'S', prompt: 'P' });
  assert.deepStrictEqual(r, { ok: true, text: 'host/a.js:3' });
  const b = calls[0].body;
  assert.deepStrictEqual([calls[0].path, b.model, b.system, b.prompt, b.stream, b.keep_alive], ['/api/generate', 'qwen2.5-coder:latest', 'S', 'P', false, '5m']);
  assert.deepStrictEqual([b.options.num_ctx, b.options.temperature], [8192, 0]);
  assert.strictEqual(b.think, false, 'a thinking model must answer, not deliberate for 40 s');
});

test('generate: keepAlive is per call (background callers pass 45s); the default and a blank/non-string value stay 5m, num_ctx never changes', async () => {
  for (const [keepAlive, want] of [['45s', '45s'], [undefined, '5m'], ['', '5m'], ['  ', '5m'], [45, '5m']]) {
    const { c, calls } = client(() => json(200, { response: 'x' }));
    await c.generate({ system: 'S', prompt: 'P', keepAlive });
    assert.strictEqual(calls[0].body.keep_alive, want);
    assert.strictEqual(calls[0].body.options.num_ctx, 8192);
  }
});

test('generate: numPredict raises the reply budget for one call; a bad value falls back to the default', async () => {
  const { c, calls } = client(() => json(200, { response: 'x' }));
  await c.generate({ system: 'S', prompt: 'P', numPredict: 700 });
  await c.generate({ system: 'S', prompt: 'P', numPredict: -5 });
  await c.generate({ system: 'S', prompt: 'P', numPredict: 'lots' });
  await c.generate({ system: 'S', prompt: 'P' });
  assert.deepStrictEqual(calls.map(x => x.body.options.num_predict), [700, 350, 350, 350]);
});

test('generate: an empty reply is a bad reply, never a silent empty answer', async () => {
  const { c } = client(() => json(200, { response: '   ' }));
  assert.deepStrictEqual(await c.generate({ system: 'S', prompt: 'P' }), { ok: false, reason: 'bad-reply' });
});

test('generate: 404 model-missing, 500 http, timeout', async () => {
  assert.deepStrictEqual(await client(() => json(404, {})).c.generate({ system: '', prompt: 'p' }), { ok: false, reason: 'model-missing', model: 'qwen2.5-coder:latest' });
  assert.deepStrictEqual(await client(() => json(500, {})).c.generate({ system: '', prompt: 'p' }), { ok: false, reason: 'http', status: 500 });
  const slow = client((p, b, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), { generateTimeoutMs: 20 });
  assert.deepStrictEqual(await slow.c.generate({ system: '', prompt: 'p' }), { ok: false, reason: 'timeout' });
});

test('unload: asks Ollama to drop the answer model now (keep_alive 0)', async () => {
  const { c, calls } = client(() => json(200, {}));
  await c.unload();
  assert.deepStrictEqual([calls[0].path, calls[0].body.model, calls[0].body.keep_alive], ['/api/generate', 'qwen2.5-coder:latest', 0]);
});

test('M2/D8: a deadline that hits while the body is still being read is a timeout, not a bad reply', async () => {
  const slowBody = client((p, b, init) => ({
    status: 200, ok: true,
    json: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
  }), { generateTimeoutMs: 20, embedTimeoutMs: 20 });
  assert.deepStrictEqual(await slowBody.c.generate({ system: '', prompt: 'p' }), { ok: false, reason: 'timeout' });
  assert.deepStrictEqual(await slowBody.c.embed(['a']), { ok: false, reason: 'timeout' });
});

test('generate: numPredict and temperature are per-request options (the speech bubbles ask for a short, lively line), default unchanged', async () => {
  const { c, calls } = client(() => json(200, { response: 'Hi.' }));
  await c.generate({ system: 'S', prompt: 'P' });
  assert.deepStrictEqual([calls[0].body.options.num_predict, calls[0].body.options.temperature], [350, 0]);
  await c.generate({ system: 'S', prompt: 'P', numPredict: 60, temperature: 0.9 });
  assert.deepStrictEqual([calls[1].body.options.num_predict, calls[1].body.options.temperature], [60, 0.9]);
  await c.generate({ system: 'S', prompt: 'P', numPredict: -1, temperature: 'hot' });
  assert.deepStrictEqual([calls[2].body.options.num_predict, calls[2].body.options.temperature], [350, 0]);
});

// BACKLOG #91: a background caller (bubble, drift) must never shorten a window Ask already set; keep_alive belongs to the loaded model.
const NOW = Date.parse('2026-10-14T12:00:00Z');
const ps = (...models) => json(200, { models });
const bg = (psReply, extra = {}) => client((p) => (p === '/api/ps' ? psReply() : json(200, { response: 'x' })), { now: () => NOW, ...extra });
const sentKeep = (calls) => calls.find(c => c.path === '/api/generate').body.keep_alive;

test('neverShorten: Ask loaded the model with 5m, 20 s later a bubble sends the 4m40s that is left, not 45s', async () => {
  const { c, calls } = bg(() => ps({ name: 'qwen2.5-coder:latest', expires_at: new Date(NOW + 280_000).toISOString() }));
  await c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
  assert.strictEqual(sentKeep(calls), '280s');
  assert.strictEqual(calls.find(x => x.path === '/api/generate').body.options.num_ctx, 8192);
});

test('neverShorten: a fraction of a second left rounds UP to whole seconds', async () => {
  const { c, calls } = bg(() => ps({ name: 'qwen2.5-coder:latest', expires_at: new Date(NOW + 100_200).toISOString() }));
  await c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
  assert.strictEqual(sentKeep(calls), '101s');
});

test('neverShorten: less than 45 s left (or already expiring) sends the 45s floor', async () => {
  for (const left of [30_000, 0, -5_000]) {
    const { c, calls } = bg(() => ps({ name: 'qwen2.5-coder:latest', expires_at: new Date(NOW + left).toISOString() }));
    await c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
    assert.strictEqual(sentKeep(calls), '45s');
  }
});

test('neverShorten: the model not loaded (only others are) sends 45s; the name is matched with its tag', async () => {
  const far = new Date(NOW + 280_000).toISOString();
  const other = bg(() => ps({ name: 'llama3.2:3b', expires_at: far }));
  await other.c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
  assert.strictEqual(sentKeep(other.calls), '45s');
  const untagged = bg(() => ps({ model: 'qwen2.5-coder', expires_at: far }));
  await untagged.c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
  assert.strictEqual(sentKeep(untagged.calls), '280s');
});

test('neverShorten: ps down, an error status, junk or no expires_at all send 45s, and never fail the call', async () => {
  const far = new Date(NOW + 280_000).toISOString();
  const replies = [() => { throw new Error('ECONNREFUSED'); }, () => json(500, {}), () => json(200, { models: 'x' }), () => json(200, null),
    () => ps({ name: 'qwen2.5-coder:latest' }), () => ps({ name: 'qwen2.5-coder:latest', expires_at: 'soon' }), () => ps(null, { name: 'qwen2.5-coder:latest', expires_at: 7 })];
  for (const r of replies) {
    const { c, calls } = bg(r);
    assert.deepStrictEqual(await c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true }), { ok: true, text: 'x' });
    assert.strictEqual(sentKeep(calls), '45s');
  }
  assert.ok(far);
});

test('neverShorten: a ps that never answers is cut off at its own short deadline and the call still goes out with 45s', async () => {
  const { c, calls } = client((p, b, init) => (p === '/api/ps' ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) : json(200, { response: 'x' })), { now: () => NOW });
  const t0 = Date.now();
  await c.generate({ system: 'S', prompt: 'P', keepAlive: '45s', neverShorten: true });
  assert.strictEqual(sentKeep(calls), '45s');
  assert.ok(Date.now() - t0 < 5_000);
});

test('without neverShorten (Ask answers, the explainer) /api/ps is never read and 5m is sent', async () => {
  const { c, calls } = bg(() => ps({ name: 'qwen2.5-coder:latest', expires_at: new Date(NOW + 999_000).toISOString() }));
  await c.generate({ system: 'S', prompt: 'P' });
  assert.deepStrictEqual(calls.map(x => x.path), ['/api/generate']);
  assert.strictEqual(sentKeep(calls), '5m');
});

test('the remaining time never lowers a longer keepAlive: 5m asked with neverShorten and 1 minute left stays 5m', async () => {
  const { c, calls } = bg(() => ps({ name: 'qwen2.5-coder:latest', expires_at: new Date(NOW + 60_000).toISOString() }));
  await c.generate({ system: 'S', prompt: 'P', keepAlive: '5m', neverShorten: true });
  assert.strictEqual(sentKeep(calls), '5m');
});
