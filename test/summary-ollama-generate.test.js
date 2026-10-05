'use strict';
/**
 * The Ollama client's raw `generate` (host/summary-ollama.js), for the indexing assistant (backlog #66,
 * DESIGN_INDEXING_ASSISTANT.md "Claude's call" 3): the classifier asks for a JSON reply and parses it itself, so the
 * reply comes back as the model wrote it, never through the summary's cleanReply (which would strip and clip it).
 * Same retry rules as `summarize`: a hang is tried twice, anything Ollama answered is not.
 */
const test = require('node:test');
const assert = require('node:assert');

const { startFakeOllama } = require('../verify/lib/fake-ollama');
const { createOllamaClient } = require('../host/summary-ollama');

async function withFake(opts, fn) {
  const fake = await startFakeOllama(opts);
  const client = createOllamaClient({ baseUrl: fake.url, healthTimeoutMs: 300, tagsTimeoutMs: 300, generateTimeoutMs: 500 });
  try { await fn(fake, client); } finally { await fake.close(); }
}

const JSON_REPLY = '{"kind":"idea","target":"new","title":"A thing","sure":true}';

test('generate: posts the prompt with format json, temperature 0 and the asked-for length, and returns the raw reply', async () => {
  await withFake({ generate: () => ({ json: { response: JSON_REPLY } }) }, async (fake, c) => {
    const r = await c.generate('the prompt', { format: 'json', numPredict: 120, temperature: 0 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, JSON_REPLY);
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
    const req = fake.requests.find(q => q.path === '/api/generate');
    assert.deepStrictEqual(req.body, {
      model: 'llama3.2:3b', prompt: 'the prompt', stream: false, keep_alive: '5m', format: 'json',
      options: { num_ctx: 8192, temperature: 0, num_predict: 120 },
    });
  });
});

test('generate: markdown and long lines are NOT cleaned: the caller parses the reply', async () => {
  const raw = '**not** a summary\n- ' + 'x'.repeat(500);
  await withFake({ generate: () => ({ json: { response: raw } }) }, async (fake, c) => {
    assert.strictEqual((await c.generate('p')).text, raw);
  });
});

test('generate: with no options it sends no format and the summary\'s defaults', async () => {
  await withFake({}, async (fake, c) => {
    await c.generate('p');
    const req = fake.requests.find(q => q.path === '/api/generate');
    assert.strictEqual('format' in req.body, false);
    assert.deepStrictEqual(req.body.options, { num_ctx: 8192, temperature: 0.2, num_predict: 200 });
  });
});

test('generate: options that are not usable values fall back to the defaults', async () => {
  await withFake({}, async (fake, c) => {
    await c.generate('p', { format: 42, numPredict: -1, temperature: NaN });
    const req = fake.requests.find(q => q.path === '/api/generate');
    assert.strictEqual('format' in req.body, false);
    assert.deepStrictEqual(req.body.options, { num_ctx: 8192, temperature: 0.2, num_predict: 200 });
  });
});

test('generate: a hang is retried once, and the second answer is used', async () => {
  await withFake({ generate: (b, n) => (n === 1 ? { hang: true } : { json: { response: JSON_REPLY } }) }, async (fake, c) => {
    const r = await c.generate('p', { format: 'json' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fake.count('POST', '/api/generate'), 2);
  });
});

test('generate: two hangs is a timeout', async () => {
  await withFake({ generate: () => ({ hang: true }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.generate('p'), { ok: false, reason: 'timeout' });
  });
});

test('generate: 404 is model-missing, another status is http, neither retried', async () => {
  await withFake({ generate: () => ({ status: 404, json: { error: 'no' } }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.generate('p'), { ok: false, reason: 'model-missing' });
    assert.strictEqual(fake.count('POST', '/api/generate'), 1);
  });
  await withFake({ generate: () => ({ status: 503, json: { error: 'busy' } }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.generate('p'), { ok: false, reason: 'http', status: 503 });
  });
});

test('generate: a reply with no response string, or an empty one, is a bad reply', async () => {
  for (const r of [{ raw: 'nope' }, { json: {} }, { json: { response: 7 } }, { json: { response: '  ' } }, { json: null }]) {
    await withFake({ generate: () => r }, async (fake, c) => {
      assert.deepStrictEqual(await c.generate('p'), { ok: false, reason: 'bad-reply' }, JSON.stringify(r));
      assert.strictEqual(fake.count('POST', '/api/generate'), 1);
    });
  }
});
