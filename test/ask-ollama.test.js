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

// --- kill tests for the release-176 survivors (BACKLOG #94, M6) --------------------------------------------------------

const okGen = (response = 'an answer') => json(200, { response });
const sentOptions = (calls) => calls.find(x => x.path === '/api/generate').body;

test('M6: the base URL loses every trailing slash, and a GET carries no body or content type while a POST carries both', async () => {
  const seen = [];
  const c = createAskOllama({
    baseUrl: 'http://127.0.0.1:11434///', answerModel: 'm', embedModel: 'e',
    fetchImpl: async (url, init) => { seen.push([url, init]); return url.endsWith('/api/tags') ? tags('m:latest', 'e:latest') : json(200, { embeddings: [[1]] }); },
  });
  await c.check();
  await c.embed(['t']);
  assert.strictEqual(seen[0][0], 'http://127.0.0.1:11434/api/tags');
  assert.strictEqual(seen[0][1].method, 'GET');
  assert.strictEqual(seen[0][1].headers, undefined);
  assert.strictEqual(seen[0][1].body, undefined);
  assert.strictEqual(seen[1][0], 'http://127.0.0.1:11434/api/embed');
  assert.strictEqual(seen[1][1].method, 'POST');
  assert.deepStrictEqual(seen[1][1].headers, { 'content-type': 'application/json' });
  assert.strictEqual(typeof seen[1][1].body, 'string');
});

test('M6: check: a status other than 200, or a body that is not a models list, is ollama-down (and a reply is not retried)', async () => {
  for (const reply of [json(500, { models: [] }), json(404, { models: [] }), json(201, { models: [] }), json(200, { models: 'x' }), json(200, []), json(200, null), json(200, { nope: 1 })]) {
    const { c, calls } = client(() => reply);
    assert.deepStrictEqual(await c.check(), { ok: false, reason: 'ollama-down' }, String(reply.status));
    assert.strictEqual(calls.length, 1, 'a reply that arrived is not asked for twice');
  }
});

test('M6: check: the first call after a quiet spell may fail; the second one answers', async () => {
  let n = 0;
  const { c, calls } = client(() => { if (++n === 1) throw new Error('quiet'); return tags('qwen2.5-coder:latest', 'snowflake-arctic-embed2:latest'); });
  assert.deepStrictEqual(await c.check(), { ok: true, answer: true, embed: true });
  assert.strictEqual(calls.length, 2);
  const down = client(() => { throw new Error('x'); });
  await down.c.check();
  assert.strictEqual(down.calls.length, 2, 'asked twice, then down');
});

test('M6: check reads model names from name or model, ignores junk entries, and matches a bare name as :latest', async () => {
  const { c } = client(() => json(200, { models: [null, 'str', 5, { name: 5 }, { name: 'other:1' }, { model: 'qwen2.5-coder:latest' }, { name: 'snowflake-arctic-embed2', model: 'x' }] }));
  assert.deepStrictEqual(await c.check(), { ok: true, answer: true, embed: false }, 'a bare name is not the :latest one');
  const both = client(() => json(200, { models: [{ name: 'qwen2.5-coder:latest' }, { model: 'snowflake-arctic-embed2:latest' }] }));
  assert.deepStrictEqual(await both.c.check(), { ok: true, answer: true, embed: true });
  const bare = createAskOllama({ fetchImpl: async () => tags('qwen3.5:4b', 'snowflake-arctic-embed2:latest'), answerModel: 'qwen3.5:4b', embedModel: 'snowflake-arctic-embed2' });
  assert.deepStrictEqual(await bare.check(), { ok: true, answer: true, embed: true }, 'the configured bare name gets :latest');
});

test('M6: a status outside 200-299 is http with that status; 200 and 299 are replies, 199 and 300 are not', async () => {
  for (const [status, good] of [[199, false], [200, true], [299, true], [300, false], [500, false]]) {
    const { c } = client(() => json(status, { embeddings: [[1]] }));
    const r = await c.embed(['a']);
    assert.strictEqual(r.ok, good, String(status));
    if (!good) assert.deepStrictEqual(r, { ok: false, reason: 'http', status });
  }
});

test('M6: an embedding list is good only when every row is a non-empty list of finite numbers', async () => {
  const bad = [[[1], []], [[1], 'x'], [[1, NaN]], [[Infinity]], [['1']], [[1], [2, null]], [[]], [[1], null]];
  for (const v of bad) {
    const { c } = client(() => json(200, { embeddings: v }));
    assert.deepStrictEqual(await c.embed(v.map(() => 't')), { ok: false, reason: 'bad-reply' }, JSON.stringify(v));
  }
  const { c } = client(() => json(200, { embeddings: [[0.5, -2], [3]] }));
  assert.deepStrictEqual(await c.embed(['a', 'b']), { ok: true, vectors: [[0.5, -2], [3]] });
  const none = client(() => json(200, null));
  assert.deepStrictEqual(await none.c.embed(['a']), { ok: false, reason: 'bad-reply' });
});

test('M6: temperature is sent only when it is a finite number of zero or more, otherwise 0', async () => {
  const sent = async (temperature) => { const { c, calls } = client(() => okGen()); await c.generate({ system: 's', prompt: 'p', temperature }); return sentOptions(calls).options.temperature; };
  assert.strictEqual(await sent(0.7), 0.7);
  assert.strictEqual(await sent(0), 0);
  for (const junk of [-0.5, NaN, Infinity, '0.5', null, undefined, true]) assert.strictEqual(await sent(junk), 0, String(junk));
});

test('M6: a reply is text only when the body is an object with a string response; the text is trimmed', async () => {
  for (const body of [null, [], 'x', { response: 5 }, { response: null }, { response: '   ' }, {}]) {
    const { c } = client(() => json(200, body));
    assert.deepStrictEqual(await c.generate({ system: 's', prompt: 'p' }), { ok: false, reason: 'bad-reply' }, JSON.stringify(body));
  }
  const { c } = client(() => okGen('  hello \n'));
  assert.deepStrictEqual(await c.generate({ system: 's', prompt: 'p' }), { ok: true, text: 'hello' });
});

test('M6: neverShorten reads a keepAlive like "45s", "5m" or "2h" (trimmed), and anything else is sent as given without asking /api/ps', async () => {
  const run = async (keepAlive) => {
    const { c, calls } = client((path) => (path === '/api/ps' ? json(200, { models: [] }) : okGen()));
    await c.generate({ system: 's', prompt: 'p', keepAlive, neverShorten: true });
    return [calls.some(x => x.path === '/api/ps'), sentOptions(calls).keep_alive];
  };
  for (const ok of ['45s', '5m', '2h', ' 45s ', '0s']) assert.strictEqual((await run(ok))[0], true, ok);
  for (const bad of ['45sx', 'x45s', '45', 's', '1.5m', '-5s', '5 m', '45S']) assert.deepStrictEqual(await run(bad), [false, bad], bad);
});

test('M6: neverShorten: the remaining time wins only when it is MORE than the floor; at exactly the floor the plain value goes', async () => {
  const T = Date.parse('2026-10-14T12:00:00Z');
  const run = async (keepAlive, secondsLeft, extra = {}) => {
    const { c, calls } = client((path) => (path === '/api/ps' ? json(extra.status || 200, { models: [{ name: 'qwen2.5-coder:latest', expires_at: new Date(T + secondsLeft * 1000).toISOString() }] }) : okGen()), { now: () => T });
    await c.generate({ system: 's', prompt: 'p', keepAlive, neverShorten: true });
    return sentOptions(calls).keep_alive;
  };
  assert.strictEqual(await run('1m', 60), '1m');
  assert.strictEqual(await run('1m', 61), '61s');
  assert.strictEqual(await run('1m', 59), '1m');
  assert.strictEqual(await run('45s', 600, { status: 500 }), '45s', 'a failing ps changes nothing');
  assert.strictEqual(await run('45s', 600, { status: 404 }), '45s');
});

test('M6: a request that is given no usable time bound falls back to its own default and still goes through', async () => {
  const slow = (extra) => createAskOllama({ answerModel: 'm', embedModel: 'e', ...extra, fetchImpl: async () => { await new Promise(r => setTimeout(r, 25)); return json(200, { embeddings: [[1]], response: 'ok' }); } });
  for (const bad of [0, -5, NaN, Infinity, '5', null]) {
    assert.strictEqual((await slow({ embedTimeoutMs: bad }).embed(['a'])).ok, true, `embed ${String(bad)}`);
    assert.strictEqual((await slow({ generateTimeoutMs: bad }).generate({ system: 's', prompt: 'p' })).ok, true, `generate ${String(bad)}`);
  }
  assert.deepStrictEqual(await slow({ embedTimeoutMs: 5 }).embed(['a']), { ok: false, reason: 'timeout' }, 'a real bound still cuts');
});

test('M6: numPredict is used when it is a positive finite number, else the default', async () => {
  const sent = async (numPredict) => { const { c, calls } = client(() => okGen()); await c.generate({ system: 's', prompt: 'p', numPredict }); return sentOptions(calls).options.num_predict; };
  assert.strictEqual(await sent(100), 100);
  for (const junk of [0, -1, NaN, Infinity, '100', null, undefined]) assert.strictEqual(await sent(junk), 350, String(junk));
});
