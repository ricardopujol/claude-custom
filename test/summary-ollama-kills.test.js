'use strict';
/**
 * Kill tests for host/summary-ollama.js, from Mortimer's gate on release PR #109 (survivor 8): the response size cap,
 * the abort and the timer clean-up, pinned at their boundaries with a scripted fetch. The base URL is user-redirectable
 * (CLAUDE_CUSTOM_OLLAMA_URL), so the cap is a real boundary: a body of exactly MAX_BODY_BYTES is read, one byte more is
 * refused, and the connection is cut rather than drained.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createOllamaClient, MAX_BODY_BYTES } = require('../host/summary-ollama');

/**
 * A scripted fetch. `chunks` are Uint8Arrays streamed in order; `declared` is the content-length header (null = none).
 * Everything the client does to it is recorded.
 */
function script({ status = 200, declared = null, chunks = [] } = {}) {
  const log = { signals: [], reads: 0, readerCancels: 0, bodyCancels: 0, getReaders: 0, urls: [] };
  const fetchImpl = async (url, opts) => {
    log.urls.push(url);
    log.signals.push(opts.signal);
    let i = 0;
    return {
      status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' && declared !== null ? String(declared) : null) },
      body: {
        cancel: async () => { log.bodyCancels += 1; },
        getReader: () => {
          log.getReaders += 1;
          return {
            read: async () => { log.reads += 1; return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }; },
            cancel: async () => { log.readerCancels += 1; },
          };
        },
      },
    };
  };
  return { fetchImpl, log };
}

const client = (fetchImpl, opts = {}) => createOllamaClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl, generateTimeoutMs: 5000, ...opts });

/** A valid /api/generate body of exactly `bytes` bytes. */
function bodyOf(bytes) {
  const head = JSON.stringify({ response: 'Working on: a', pad: '' });
  const pad = 'p'.repeat(bytes - Buffer.byteLength(head));
  const s = JSON.stringify({ response: 'Working on: a', pad });
  assert.strictEqual(Buffer.byteLength(s), bytes);
  return Buffer.from(s);
}
const split = (buf, at) => [new Uint8Array(buf.subarray(0, at)), new Uint8Array(buf.subarray(at))];
const small = Buffer.from(JSON.stringify({ response: 'Working on: a' }));

test('a declared content-length of exactly MAX_BODY_BYTES is read; one byte more is refused unread and the body is let go', async () => {
  const exact = script({ declared: MAX_BODY_BYTES, chunks: [new Uint8Array(small)] });
  assert.strictEqual((await client(exact.fetchImpl).summarize('p')).ok, true);
  assert.strictEqual(exact.log.bodyCancels, 0);

  const over = script({ declared: MAX_BODY_BYTES + 1, chunks: [new Uint8Array(small)] });
  assert.deepStrictEqual(await client(over.fetchImpl).summarize('p'), { ok: false, reason: 'bad-reply' });
  assert.strictEqual(over.log.bodyCancels, 1, 'the body is cancelled, not drained');
  assert.strictEqual(over.log.getReaders, 0, 'and never read');
});

test('a declared length is judged on the header alone; no header means the stream is counted', async () => {
  const none = script({ declared: null, chunks: [new Uint8Array(small)] });
  assert.strictEqual((await client(none.fetchImpl).summarize('p')).ok, true);
  assert.strictEqual(none.log.getReaders, 1);
});

test('a streamed body of exactly MAX_BODY_BYTES is read whole', async () => {
  const s = script({ chunks: split(bodyOf(MAX_BODY_BYTES), 1000) });
  const r = await client(s.fetchImpl).summarize('p');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.log.readerCancels, 0);
  assert.strictEqual(s.log.signals[0].aborted, false, 'a complete read cuts nothing');
});

test('a streamed body one byte over MAX_BODY_BYTES is refused, the reader is cancelled, the request is aborted, nothing after it is read', async () => {
  const [a, b] = split(bodyOf(MAX_BODY_BYTES + 1), 1000);
  const s = script({ chunks: [a, b, new Uint8Array(10), new Uint8Array(10)] });
  const r = await client(s.fetchImpl).summarize('p');
  assert.deepStrictEqual(r, { ok: false, reason: 'bad-reply' });
  assert.strictEqual(s.log.readerCancels, 1);
  assert.strictEqual(s.log.signals[0].aborted, true, 'the connection is cut');
  assert.strictEqual(s.log.reads, 2, 'it stopped reading at the chunk that crossed the cap');
});

test('/api/tags is held to the same cap, on a stream and on a header', async () => {
  const hdr = script({ declared: MAX_BODY_BYTES + 1 });
  assert.deepStrictEqual(await client(hdr.fetchImpl).hasModel(), { ok: false, reason: 'bad-reply' });
  const tags = Buffer.from(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
  const ok = script({ declared: MAX_BODY_BYTES, chunks: [new Uint8Array(tags)] });
  assert.deepStrictEqual(await client(ok.fetchImpl).hasModel(), { ok: true });
});

test('the timeout timer is cleared once the request is done: a finished request is never aborted later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = script({ chunks: [new Uint8Array(small)] });
  const r = await client(s.fetchImpl, { generateTimeoutMs: 1000 }).summarize('p');
  assert.strictEqual(r.ok, true);
  t.mock.timers.tick(10_000);
  assert.strictEqual(s.log.signals[0].aborted, false, 'the timeout must not fire after the request finished');
});

test('the timeout still fires on a request that never answers (the timer is armed, not just cleared)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const hang = async (url, opts) => new Promise((resolve, reject) => {
    signal = opts.signal;
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const p = client(hang, { generateTimeoutMs: 1000 }).summarize('p');
  // One miss is retried once, and each try has its own timer: fire both.
  for (let i = 0; i < 2; i++) {
    await new Promise(res => setImmediate(res));
    t.mock.timers.tick(1000);
  }
  const r = await p;
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
  assert.strictEqual(signal.aborted, true);
});

test('HTTP status: 199 and 300 are errors, 200 and 299 are answers, 404 is a missing model', async () => {
  const run = async (status) => client(script({ status, chunks: [new Uint8Array(small)] }).fetchImpl).summarize('p');
  assert.strictEqual((await run(200)).ok, true);
  assert.strictEqual((await run(299)).ok, true);
  assert.deepStrictEqual(await run(300), { ok: false, reason: 'http', status: 300 });
  assert.deepStrictEqual(await run(199), { ok: false, reason: 'http', status: 199 });
  assert.deepStrictEqual(await run(404), { ok: false, reason: 'model-missing' });
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M7) --------------------------------------------------------

const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
const textFetch = (status, text, { declared = null } = {}) => {
  const seen = [];
  const { fetchImpl } = script({ status, declared, chunks: text === '' ? [] : [bytes(text)] });
  return { seen, fetchImpl: async (url, init) => { seen.push([url, init]); return fetchImpl(url, init); } };
};
const tagBody = (...models) => JSON.stringify({ models });

test('M7: the base URL loses every trailing slash; a GET carries no body and no content type, a POST carries both', async () => {
  const f = textFetch(200, tagBody({ name: 'llama3.2:3b' }));
  const c = createOllamaClient({ baseUrl: 'http://127.0.0.1:11434///', fetchImpl: f.fetchImpl });
  await c.hasModel();
  assert.strictEqual(f.seen[0][0], 'http://127.0.0.1:11434/api/tags');
  assert.strictEqual(f.seen[0][1].method, 'GET');
  assert.strictEqual(f.seen[0][1].headers, undefined);
  assert.strictEqual(f.seen[0][1].body, undefined);
  const g = textFetch(200, JSON.stringify({ response: 'A summary of the work.' }));
  await createOllamaClient({ baseUrl: 'http://x:1//', fetchImpl: g.fetchImpl }).summarize('prompt');
  assert.strictEqual(g.seen[0][0], 'http://x:1/api/generate');
  assert.strictEqual(g.seen[0][1].method, 'POST');
  assert.deepStrictEqual(g.seen[0][1].headers, { 'content-type': 'application/json' });
  assert.strictEqual(JSON.parse(g.seen[0][1].body).prompt, 'prompt');
});

test('M7: hasModel: only a 200 counts, whatever the body says', async () => {
  for (const status of [201, 204, 301, 404, 500]) {
    const f = textFetch(status, tagBody({ name: 'llama3.2:3b' }));
    assert.deepStrictEqual(await createOllamaClient({ fetchImpl: f.fetchImpl }).hasModel(), { ok: false, reason: 'unreachable' }, String(status));
  }
});

test('M7: hasModel reads names from name or model, ignores junk entries, and a bare configured name means :latest', async () => {
  const junk = textFetch(200, tagBody(null, 'str', 5, [], { name: 7 }, { name: 'other:1' }, { model: 'llama3.2:3b' }));
  assert.deepStrictEqual(await createOllamaClient({ fetchImpl: junk.fetchImpl }).hasModel(), { ok: true });
  const none = textFetch(200, tagBody(null, { name: 'other:1' }));
  assert.deepStrictEqual(await createOllamaClient({ fetchImpl: none.fetchImpl }).hasModel(), { ok: false, reason: 'model-missing' });
  const bare = textFetch(200, tagBody({ name: 'mymodel:latest' }));
  assert.deepStrictEqual(await createOllamaClient({ model: 'mymodel', fetchImpl: bare.fetchImpl }).hasModel(), { ok: true });
});

test('M7: a content-length that is not a number does not stop the body being read; one at the cap reads, one over does not', async () => {
  const ok = textFetch(200, tagBody({ name: 'llama3.2:3b' }), { declared: 'not-a-number' });
  assert.deepStrictEqual(await createOllamaClient({ fetchImpl: ok.fetchImpl }).hasModel(), { ok: true });
  const exact = textFetch(200, tagBody({ name: 'llama3.2:3b' }), { declared: MAX_BODY_BYTES });
  assert.deepStrictEqual(await createOllamaClient({ fetchImpl: exact.fetchImpl }).hasModel(), { ok: true });
  const over = textFetch(200, tagBody({ name: 'llama3.2:3b' }), { declared: MAX_BODY_BYTES + 1 });
  assert.deepStrictEqual(await createOllamaClient({ fetchImpl: over.fetchImpl }).hasModel(), { ok: false, reason: 'bad-reply' });
});

test('M7: summarize: the reply must be an object with a string response; anything else is a bad reply', async () => {
  for (const text of ['', '{', 'null', '[]', '"x"', JSON.stringify({ response: 5 }), JSON.stringify({ response: null }), JSON.stringify({}), JSON.stringify({ response: ['a'] })]) {
    const f = textFetch(200, text);
    assert.deepStrictEqual(await createOllamaClient({ fetchImpl: f.fetchImpl }).summarize('p'), { ok: false, reason: 'bad-reply' }, JSON.stringify(text));
  }
});

test('M7: summarize reports how long it took, and a clock that steps back reads 0', async () => {
  const f = textFetch(200, JSON.stringify({ response: 'A summary of the work.' }));
  let t = 1000;
  const marks = [1000, 1250];
  const c = createOllamaClient({ fetchImpl: f.fetchImpl, now: () => marks.shift() });
  const r = await c.summarize('p');
  assert.deepStrictEqual([r.ok, r.ms], [true, 250]);
  const back = [5000, 4000];
  const c2 = createOllamaClient({ fetchImpl: textFetch(200, JSON.stringify({ response: 'A summary of the work.' })).fetchImpl, now: () => back.shift() });
  assert.strictEqual((await c2.summarize('p')).ms, 0);
  assert.ok(t);
});

test('M7: the status of a failed generate is named: 404 is model-missing, 199 and 300 are http with the status, 200 and 299 are replies', async () => {
  const run = async (status) => createOllamaClient({ fetchImpl: textFetch(status, JSON.stringify({ response: 'A summary of the work.' })).fetchImpl }).summarize('p');
  assert.deepStrictEqual(await run(404), { ok: false, reason: 'model-missing' });
  assert.deepStrictEqual(await run(199), { ok: false, reason: 'http', status: 199 });
  assert.deepStrictEqual(await run(300), { ok: false, reason: 'http', status: 300 });
  assert.strictEqual((await run(200)).ok, true);
  assert.strictEqual((await run(299)).ok, true);
});
