'use strict';
/**
 * host/mod-feed.js: what the claude-custom mod (mods/claude-custom) posts to the host (BACKLOG #119 A2). The records are validated
 * with strict typeof checks (absence is never 0), the route takes only the right token, only from loopback, and only a small body.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  parseRecord, windowsFromRateLimits, contextFromUsage, createModServer, isLoopbackAddress, MAX_BODY_BYTES,
} = require('../host/mod-feed');

const TOKEN = 'abcdef0123456789abcdef0123456789abcdef0123456789';
const usage = (over = {}) => ({ v: 1, kind: 'usage', sessionId: 's1', at: 1000, usage: { rateLimits: [], ...over } });
const parse = (r) => parseRecord(typeof r === 'string' ? r : JSON.stringify(r));

test('a usage record parses into the same record', () => {
  const rec = usage({ context: { tokens: 10, window: 200, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-19T20:00:00Z' }], cost: { usd: 0.5 }, startedAt: 7 });
  const r = parse(rec);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.record, rec);
});

test('agents, ask and end records parse', () => {
  assert.strictEqual(parse({ v: 1, kind: 'agents', sessionId: 's', at: 1, agents: [{ id: 'a', status: 'waiting', type: 'Explore', name: 'n', parentId: 'p' }] }).ok, true);
  assert.strictEqual(parse({ v: 1, kind: 'ask', sessionId: 's', at: 1, ask: { tool: 'Bash', agentId: 'a' } }).ok, true);
  assert.strictEqual(parse({ v: 1, kind: 'end', sessionId: 's', at: 1, reason: 'other' }).ok, true);
  assert.strictEqual(parse({ v: 1, kind: 'end', sessionId: 's', at: 1 }).ok, true);
});

test('what is not JSON, not an object, the wrong version or an unknown kind is refused', () => {
  for (const bad of ['', '{nope', 'null', '[]', '1', '"x"', { ...usage(), v: 2 }, { ...usage(), v: '1' }, { ...usage(), kind: 'other' }, { ...usage(), kind: undefined }]) {
    assert.strictEqual(parse(bad).ok, false, JSON.stringify(bad));
  }
});

test('the session id and the time are required and strict', () => {
  for (const sessionId of [undefined, null, '', 5, {}, 'x'.repeat(201)]) assert.strictEqual(parse({ ...usage(), sessionId }).ok, false, String(sessionId));
  for (const at of [undefined, null, '1000', NaN, Infinity, {}]) assert.strictEqual(parse({ ...usage(), at }).ok, false, String(at));
});

test('a wrong-typed figure refuses the whole record, it is never coerced', () => {
  for (const over of [
    { context: { tokens: '10', window: 200 } }, { context: { window: null } }, { context: { percent: NaN } }, { context: 'x' },
    { rateLimits: 'x' }, { rateLimits: [{ kind: 'five_hour', percentUsed: null }] }, { rateLimits: [{ kind: 'five_hour', percentUsed: '5' }] },
    { rateLimits: [{ kind: '', percentUsed: 5 }] }, { rateLimits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: 5 }] }, { rateLimits: [null] },
    { cost: { usd: '1' } }, { cost: 3 }, { startedAt: 'x' },
  ]) assert.strictEqual(parse(usage(over)).ok, false, JSON.stringify(over));
});

test('a usage record without a rateLimits list is refused (the mod always sends one)', () => {
  assert.strictEqual(parse({ v: 1, kind: 'usage', sessionId: 's', at: 1, usage: {} }).ok, false);
  assert.strictEqual(parse({ v: 1, kind: 'usage', sessionId: 's', at: 1 }).ok, false);
});

test('an agent without a string id or status, an ask without a tool, a non-array agents field: refused', () => {
  const agents = (a) => ({ v: 1, kind: 'agents', sessionId: 's', at: 1, agents: a });
  for (const a of ['x', [null], [{ status: 'running' }], [{ id: 'a' }], [{ id: 'a', status: 5 }], [{ id: 'a', status: 'running', type: 5 }]]) assert.strictEqual(parse(agents(a)).ok, false, JSON.stringify(a));
  for (const ask of [undefined, null, {}, { tool: '' }, { tool: 5 }, { tool: 'Bash', agentId: 5 }]) assert.strictEqual(parse({ v: 1, kind: 'ask', sessionId: 's', at: 1, ask }).ok, false, JSON.stringify(ask));
  assert.strictEqual(parse({ v: 1, kind: 'end', sessionId: 's', at: 1, reason: 5 }).ok, false);
});

test('more than 64 agents or 32 rate limits is refused', () => {
  assert.strictEqual(parse({ v: 1, kind: 'agents', sessionId: 's', at: 1, agents: Array.from({ length: 65 }, (_, i) => ({ id: 'a' + i, status: 'running' })) }).ok, false);
  assert.strictEqual(parse({ v: 1, kind: 'agents', sessionId: 's', at: 1, agents: Array.from({ length: 64 }, (_, i) => ({ id: 'a' + i, status: 'running' })) }).ok, true);
  assert.strictEqual(parse(usage({ rateLimits: Array.from({ length: 33 }, () => ({ kind: 'k', percentUsed: 1 })) })).ok, false);
});

test('fields the host does not know are dropped from the parsed record', () => {
  const r = parse({ ...usage(), extra: 1, usage: { rateLimits: [], secret: 'x' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.record).sort(), ['at', 'kind', 'sessionId', 'usage', 'v']);
  assert.deepStrictEqual(r.record.usage, { rateLimits: [] });
});

// --- windows ---------------------------------------------------------------------------------------------------------

test('five_hour and seven_day become the windows quota.js calls session and weekly_all, with its labels', () => {
  const w = windowsFromRateLimits([{ kind: 'five_hour', percentUsed: 41.5, resetsAt: 'A' }, { kind: 'seven_day', percentUsed: 12, resetsAt: 'B' }]);
  assert.deepStrictEqual(w.map(x => [x.key, x.label, x.percent, x.resetsAt]), [['session', '5h', 41.5, 'A'], ['weekly_all', 'week', 12, 'B']]);
});

test('a window has the full shape the displays read, with no money and no lock', () => {
  const [w] = windowsFromRateLimits([{ kind: 'five_hour', percentUsed: 10 }]);
  assert.deepStrictEqual(w, { key: 'session', label: '5h', percent: 10, resetsAt: null, severity: 'normal', isActive: true, usedDollars: null, remainingDollars: null, lockedReason: null });
});

test('a kind with no name of ours keeps its own key and a readable label', () => {
  const [w] = windowsFromRateLimits([{ kind: 'spend_limit', percentUsed: 20 }]);
  assert.strictEqual(w.key, 'spend_limit');
  assert.strictEqual(w.label, 'spend limit');
});

test('only the fullest window is the binding one', () => {
  const w = windowsFromRateLimits([{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 70 }]);
  assert.deepStrictEqual(w.map(x => x.isActive), [false, true]);
});

test('nothing in, nothing out; a malformed row is skipped', () => {
  assert.deepStrictEqual(windowsFromRateLimits([]), []);
  assert.deepStrictEqual(windowsFromRateLimits(undefined), []);
  assert.deepStrictEqual(windowsFromRateLimits([null, { kind: 'five_hour' }, { percentUsed: 5 }]), []);
});

// --- context ---------------------------------------------------------------------------------------------------------

test('context: tokens and window become used and size', () => {
  assert.deepStrictEqual(contextFromUsage({ context: { tokens: 50, window: 200, percent: 25 } }), { used: 50, size: 200 });
});

test('context: without tokens the percent of the window is used, rounded', () => {
  assert.deepStrictEqual(contextFromUsage({ context: { window: 200, percent: 25 } }), { used: 50, size: 200 });
});

test('context: no window, a window of 0, or neither tokens nor percent is unknown (null), never a zero fill', () => {
  for (const u of [undefined, {}, { context: {} }, { context: { window: 0, tokens: 5 } }, { context: { window: 200 } }, { context: { window: 'x', tokens: 1 } },
    { context: { window: 200, tokens: -1 } }, { context: { window: 200, percent: -5 } }]) assert.strictEqual(contextFromUsage(u), null, JSON.stringify(u));
});

test('context: a percent and a window whose product overflows is unknown, not Infinity', () => {
  assert.strictEqual(contextFromUsage({ context: { window: 1e308, percent: 1e308 } }), null);
});

// --- the route -------------------------------------------------------------------------------------------------------

// The token travels as `Authorization: Bearer <token>` (PR #197 Miguel Y2): a URL ends up in logs, a header does not. `auth: null` sends none.
function ask(port, { path = '/mod', method = 'POST', body = '', headers = {}, auth = 'Bearer ' + TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }), ...headers };
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn, over = {}) {
  const got = [];
  const server = createModServer({ token: TOKEN, onRecord: (r) => got.push(r), ...over });
  const port = await server.listen();
  try { await fn(port, got, server); } finally { await server.close(); }
}

test('a good post is accepted (204), handed to onRecord, and the server is on 127.0.0.1', async () => {
  await withServer(async (port, got, server) => {
    const r = await ask(port, { body: JSON.stringify(usage()) });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].kind, 'usage');
    assert.strictEqual(server.address().address, '127.0.0.1');
  });
});

test('a wrong token, a missing token and a token of another length are refused (401) and nothing is delivered', async () => {
  await withServer(async (port, got) => {
    for (const auth of ['Bearer ' + TOKEN.replace(/a/, 'b'), null, 'Bearer ', 'Bearer', 'Bearer ' + TOKEN + '0', 'Basic ' + TOKEN, TOKEN, 'bearer-' + TOKEN]) {
      const r = await ask(port, { auth, body: JSON.stringify(usage()) });
      assert.strictEqual(r.status, 401, String(auth));
      assert.ok(!r.text.includes(TOKEN));
    }
    assert.deepStrictEqual(got, []);
  });
});

test('PR #197 Miguel Y2: the token in the URL is no token at all: a query alone is refused, and a header wins over a wrong query', async () => {
  await withServer(async (port, got) => {
    assert.strictEqual((await ask(port, { path: '/mod?token=' + TOKEN, auth: null, body: JSON.stringify(usage()) })).status, 401);
    assert.deepStrictEqual(got, []);
    assert.strictEqual((await ask(port, { path: '/mod?token=wrong', body: JSON.stringify(usage()) })).status, 204);
    assert.strictEqual(got.length, 1);
  });
});

test('a request that carries an Origin (a web page) is refused (403) even with the right token', async () => {
  await withServer(async (port, got) => {
    const r = await ask(port, { body: JSON.stringify(usage()), headers: { origin: 'http://evil.example' } });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(got, []);
  });
});

test('a Host header that is not the loopback address and this port is refused (403): DNS rebinding', async () => {
  await withServer(async (port, got) => {
    for (const host of ['evil.example', 'evil.example:' + port, '127.0.0.1:' + (port + 1), 'localhost:' + port]) {
      const r = await ask(port, { body: JSON.stringify(usage()), headers: { host } });
      assert.strictEqual(r.status, 403, host);
    }
    assert.deepStrictEqual(got, []);
  });
});

test('only POST on /mod: other methods are 405, other paths 404', async () => {
  await withServer(async (port) => {
    assert.strictEqual((await ask(port, { method: 'GET' })).status, 405);
    assert.strictEqual((await ask(port, { method: 'PUT', body: '{}' })).status, 405);
    assert.strictEqual((await ask(port, { path: '/other', body: '{}' })).status, 404);
    assert.strictEqual((await ask(port, { path: '/', body: '{}' })).status, 404);
  });
});

const padded = (bytes) => {
  const base = JSON.stringify({ ...usage(), pad: '' }).length;
  return JSON.stringify({ ...usage(), pad: 'x'.repeat(bytes - base) });
};

test('a body over the cap is refused (413) and not delivered', async () => {
  await withServer(async (port, got) => {
    assert.strictEqual((await ask(port, { body: padded(MAX_BODY_BYTES + 1) })).status, 413);
    assert.deepStrictEqual(got, []);
  });
});

test('a body exactly at the cap is parsed', async () => {
  await withServer(async (port, got) => {
    const body = padded(MAX_BODY_BYTES);
    assert.strictEqual(Buffer.byteLength(body), MAX_BODY_BYTES);
    assert.strictEqual((await ask(port, { body })).status, 204);
    assert.strictEqual(got.length, 1);
  });
});

test('a chunked body (no declared length) that grows past the cap is refused too', async () => {
  await withServer(async (port, got) => {
    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mod', method: 'POST', headers: { 'transfer-encoding': 'chunked', authorization: 'Bearer ' + TOKEN } }, (res) => resolve(res.statusCode));
      req.on('error', () => resolve('reset'));
      req.write(padded(MAX_BODY_BYTES + 5000));
      req.end();
    });
    assert.ok(r === 413 || r === 'reset', String(r));
    assert.deepStrictEqual(got, []);
  });
});

test('a malformed body is 400 and not delivered', async () => {
  await withServer(async (port, got) => {
    assert.strictEqual((await ask(port, { body: '{nope' })).status, 400);
    assert.strictEqual((await ask(port, { body: JSON.stringify({ ...usage(), at: 'x' }) })).status, 400);
    assert.deepStrictEqual(got, []);
  });
});

test('an onRecord that throws does not take the server down: the post is still answered', async () => {
  await withServer(async (port) => {
    const r = await ask(port, { body: JSON.stringify(usage()) });
    assert.strictEqual(r.status, 204);
    assert.strictEqual((await ask(port, { body: JSON.stringify(usage()) })).status, 204);
  }, { onRecord: () => { throw new Error('boom'); }, log: () => {} });
});

test('with no token configured the server refuses everything', async () => {
  await withServer(async (port) => {
    assert.strictEqual((await ask(port, { auth: 'Bearer ', body: JSON.stringify(usage()) })).status, 401);
    assert.strictEqual((await ask(port, { auth: null, body: JSON.stringify(usage()) })).status, 401);
    assert.strictEqual((await ask(port, { auth: 'Bearer anything', body: JSON.stringify(usage()) })).status, 401);
  }, { token: '' });
});

test('isLoopbackAddress: 127.0.0.1 and its mapped form only', () => {
  for (const a of ['127.0.0.1', '::ffff:127.0.0.1']) assert.strictEqual(isLoopbackAddress(a), true, a);
  for (const a of ['10.0.0.5', '192.168.1.2', '::1x', '', undefined, null, '0.0.0.0', '128.0.0.1']) assert.strictEqual(isLoopbackAddress(a), false, String(a));
});
