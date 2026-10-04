'use strict';
/**
 * The Ollama client for the "where are we" summary (host/summary-ollama.js, backlog #39 job 1,
 * DESIGN_SLAVE_MODE_SUMMARY.md decision 6), against a fake Ollama (verify/lib/fake-ollama.js):
 *   health   GET / with a short timeout and ONE retry (the first /api/tags call on the real machine timed out at
 *            5 s and then answered: a single miss must not read as "Ollama is off")
 *   model    GET /api/tags, to say WHICH model is missing
 *   summarize POST /api/generate with the measured settings, a timeout and one retry, and a garbled reply refused
 * The client only ever talks to the base URL it was given, and never pulls a model.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { startFakeOllama, DEFAULT_REPLY } = require('../verify/lib/fake-ollama');
const { createOllamaClient, MAX_BODY_BYTES, DEFAULT_MODEL, NUM_CTX, KEEP_ALIVE, GENERATE_TIMEOUT_MS } = require('../host/summary-ollama');
const { STALE_MS } = require('../host/summary-slot');

async function withFake(opts, fn, clientOpts = {}) {
  const fake = await startFakeOllama(opts);
  const client = createOllamaClient({ baseUrl: fake.url, healthTimeoutMs: 300, tagsTimeoutMs: 300, generateTimeoutMs: 500, ...clientOpts });
  try { await fn(fake, client); } finally { await fake.close(); }
}

// A port nothing listens on.
const deadUrl = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(`http://127.0.0.1:${port}`)); });
});

test('the measured settings: llama3.2:3b, num_ctx 8192, keep_alive 5m', () => {
  assert.strictEqual(DEFAULT_MODEL, 'llama3.2:3b');
  assert.strictEqual(NUM_CTX, 8192);
  assert.strictEqual(KEEP_ALIVE, '5m');
});

test('two tries of a job must finish inside the slot\'s own staleness window, or another host could take the GPU mid-job', () => {
  assert.ok(2 * GENERATE_TIMEOUT_MS < STALE_MS);
});

test('health: a 200 from GET / is up', async () => {
  await withFake({}, async (fake, c) => {
    assert.deepStrictEqual(await c.health(), { ok: true });
    assert.strictEqual(fake.count('GET', '/'), 1);
  });
});

test('health: one miss is retried, so a single slow answer does not read as "Ollama is off"', async () => {
  await withFake({ rootHangFirst: 1 }, async (fake, c) => {
    assert.deepStrictEqual(await c.health(), { ok: true });
    assert.strictEqual(fake.count('GET', '/'), 2);
  });
});

test('health: two misses in a row is unreachable, and only two tries are made', async () => {
  await withFake({ rootHangFirst: 5 }, async (fake, c) => {
    assert.deepStrictEqual(await c.health(), { ok: false, reason: 'unreachable' });
    assert.strictEqual(fake.count('GET', '/'), 2);
  });
});

test('health: nothing listening is unreachable (and retried once, like any miss)', async () => {
  const c = createOllamaClient({ baseUrl: await deadUrl(), healthTimeoutMs: 80 });
  assert.deepStrictEqual(await c.health(), { ok: false, reason: 'unreachable' });
});

test('health: something answering 500 is not "Ollama is running"', async () => {
  await withFake({ rootStatus: 500 }, async (fake, c) => {
    assert.deepStrictEqual(await c.health(), { ok: false, reason: 'unreachable' });
  });
});

test('a base URL with a trailing slash works the same', async () => {
  const fake = await startFakeOllama();
  try {
    const c = createOllamaClient({ baseUrl: fake.url + '/', healthTimeoutMs: 80 });
    assert.deepStrictEqual(await c.health(), { ok: true });
    assert.strictEqual(fake.requests[0].path, '/');
  } finally { await fake.close(); }
});

test('model: the installed one is found; another model is not', async () => {
  await withFake({ models: ['llama3.1:8b', 'llama3.2:3b'] }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: true });
  });
  await withFake({ models: ['llama3.1:8b', 'llama3.2:3b-instruct-q4'] }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: false, reason: 'model-missing' });
  });
  await withFake({ models: [] }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: false, reason: 'model-missing' });
  });
});

test('model: a name without a tag means :latest', async () => {
  await withFake({ models: ['summariser:latest'] }, async (fake, c) => {
    const bare = createOllamaClient({ baseUrl: fake.url, model: 'summariser', tagsTimeoutMs: 80 });
    assert.deepStrictEqual(await bare.hasModel(), { ok: true });
  });
});

test('model: /api/tags is retried once on a miss, then unreachable', async () => {
  await withFake({ tagsHangFirst: 1 }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: true });
    assert.strictEqual(fake.count('GET', '/api/tags'), 2);
  });
  await withFake({ tagsHangFirst: 9 }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: false, reason: 'unreachable' });
    assert.strictEqual(fake.count('GET', '/api/tags'), 2);
  });
});

test('model: a /api/tags that is not the list is a bad reply, never "the model is installed"', async () => {
  for (const tagsBody of ['not json', '{}', '{"models":"x"}', 'null', '[]']) {
    await withFake({ tagsBody }, async (fake, c) => {
      assert.deepStrictEqual(await c.hasModel(), { ok: false, reason: 'bad-reply' }, tagsBody);
    });
  }
});

test('check: health first, then the model; the first failure is the answer', async () => {
  await withFake({}, async (fake, c) => assert.deepStrictEqual(await c.check(), { ok: true }));
  await withFake({ models: [] }, async (fake, c) => assert.deepStrictEqual(await c.check(), { ok: false, reason: 'model-missing', model: 'llama3.2:3b' }));
  await withFake({ rootHangFirst: 9 }, async (fake, c) => {
    assert.deepStrictEqual(await c.check(), { ok: false, reason: 'unreachable', model: 'llama3.2:3b' });
    assert.strictEqual(fake.count('GET', '/api/tags'), 0, 'no model question is asked of a server that is not there');
  });
});

test('summarize: sends the measured request and returns the cleaned reply', async () => {
  await withFake({}, async (fake, c) => {
    const r = await c.summarize('User: hi\n\n---\nsummarise');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, DEFAULT_REPLY);
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
    const req = fake.requests.find(q => q.path === '/api/generate');
    assert.strictEqual(req.method, 'POST');
    assert.deepStrictEqual(req.body, {
      model: 'llama3.2:3b', prompt: 'User: hi\n\n---\nsummarise', stream: false, keep_alive: '5m',
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 200 },
    });
  });
});

test('summarize: markdown in the reply is stripped on the way out', async () => {
  await withFake({ generate: () => ({ json: { response: '**Working on:** x\n- Next: y' } }) }, async (fake, c) => {
    const r = await c.summarize('p');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'Working on: x\nNext: y');
  });
});

test('summarize: a timeout is retried once, and the second answer is used', async () => {
  await withFake({ generate: (b, n) => (n === 1 ? { hang: true } : { json: { response: 'Working on: a\nNext: b' } }) }, async (fake, c) => {
    const r = await c.summarize('p');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fake.count('POST', '/api/generate'), 2);
  });
});

test('summarize: two timeouts is a timeout, after exactly two tries', async () => {
  await withFake({ generate: () => ({ hang: true }) }, async (fake, c) => {
    const r = await c.summarize('p');
    assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
    assert.strictEqual(fake.count('POST', '/api/generate'), 2);
  });
});

test('summarize: nothing listening is unreachable', async () => {
  const c = createOllamaClient({ baseUrl: await deadUrl(), generateTimeoutMs: 150 });
  assert.deepStrictEqual(await c.summarize('p'), { ok: false, reason: 'unreachable' });
});

test('summarize: Ollama\'s "model not found" (404) is model-missing, and is not retried', async () => {
  await withFake({ generate: () => ({ status: 404, json: { error: "model 'llama3.2:3b' not found" } }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.summarize('p'), { ok: false, reason: 'model-missing' });
    assert.strictEqual(fake.count('POST', '/api/generate'), 1);
  });
});

test('summarize: another server error says so, with its status, and is not retried', async () => {
  await withFake({ generate: () => ({ status: 500, json: { error: 'out of memory' } }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.summarize('p'), { ok: false, reason: 'http', status: 500 });
    assert.strictEqual(fake.count('POST', '/api/generate'), 1);
  });
});

test('summarize: a garbled reply is refused, never turned into a summary', async () => {
  const replies = [
    { raw: 'not json at all' },
    { raw: '' },
    { json: {} },
    { json: { response: 42 } },
    { json: { response: '' } },
    { json: { response: '   \n ' } },
    { json: { response: '**' } },
    { json: null },
    { json: ['array'] },
  ];
  for (const r of replies) {
    await withFake({ generate: () => r }, async (fake, c) => {
      assert.deepStrictEqual(await c.summarize('p'), { ok: false, reason: 'bad-reply' }, JSON.stringify(r));
      assert.strictEqual(fake.count('POST', '/api/generate'), 1, 'a bad reply is not retried');
    });
  }
});

test('timeouts that are not usable numbers fall back to the defaults instead of firing at once', async () => {
  const fake = await startFakeOllama();
  try {
    for (const bad of [0, -5, NaN, null, 'soon', Infinity]) {
      const c = createOllamaClient({ baseUrl: fake.url, healthTimeoutMs: bad, tagsTimeoutMs: bad, generateTimeoutMs: bad });
      assert.deepStrictEqual(await c.health(), { ok: true }, String(bad));
    }
  } finally { await fake.close(); }
});

test('the client talks to its base URL and nothing else, and never pulls a model', async () => {
  await withFake({ models: [] }, async (fake, c) => {
    await c.check();
    await c.summarize('p');
    for (const r of fake.requests) assert.ok(['/', '/api/tags', '/api/generate'].includes(r.path), r.path);
  });
});

// --- Miguel I2 (PR #105): the size of what Ollama (or whatever is on the port) sends back is capped ------------------

test('a reply that declares itself over 1 MB is refused unread, as a bad reply, and not retried', async () => {
  await withFake({ generate: () => ({ raw: 'x'.repeat(2 * 1024 * 1024) }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.summarize('p'), { ok: false, reason: 'bad-reply' });
    assert.strictEqual(fake.count('POST', '/api/generate'), 1);
  });
});

test('a streamed reply with no length is cut off at 1 MB: the client hangs up and does not buffer it all', async () => {
  await withFake({ generate: () => ({ streamBytes: 200 * 1024 * 1024 }) }, async (fake, c) => {
    const r = await c.summarize('p');
    assert.deepStrictEqual(r, { ok: false, reason: 'bad-reply' });
    await new Promise(res => setTimeout(res, 100));
    assert.strictEqual(fake.stats.streamFinished, false, 'the server was cut off before it finished 200 MB');
  }, { generateTimeoutMs: 5000 });
});

test('a reply just inside the cap still reads', async () => {
  const body = JSON.stringify({ response: 'Working on: a', pad: 'p'.repeat(MAX_BODY_BYTES - 200) });
  await withFake({ generate: () => ({ raw: body }) }, async (fake, c) => {
    assert.strictEqual((await c.summarize('p')).ok, true);
  }, { generateTimeoutMs: 5000 });
});

test('/api/tags over the cap is a bad reply, never "the model is installed"', async () => {
  await withFake({ tagsBody: JSON.stringify({ models: [{ name: 'llama3.2:3b' }], pad: 'x'.repeat(2 * 1024 * 1024) }) }, async (fake, c) => {
    assert.deepStrictEqual(await c.hasModel(), { ok: false, reason: 'bad-reply' });
  });
});

test('the health check never reads a body: only the status is looked at', async () => {
  let cancelled = 0;
  const res = { status: 200, headers: { get: () => null }, body: { cancel: async () => { cancelled += 1; }, getReader: () => { throw new Error('read the body'); } }, text: async () => { throw new Error('read the body'); } };
  const c = createOllamaClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: async () => res });
  assert.deepStrictEqual(await c.health(), { ok: true });
  assert.strictEqual(cancelled, 1, 'and the body is let go');
});
