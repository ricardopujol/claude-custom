'use strict';
/**
 * app/canvas-fetch.js: the only way anything leaves Claude's panel (BACKLOG #71).
 *
 * The panel's own network is shut: connect-src 'none', a dead proxy, no DNS (verify/probe-canvas-sandbox.js measured
 * that a sandboxed frame with a CSP alone still leaks WebRTC and DNS). Its `fetch` is a message to main, which makes the
 * request itself, and only to a host the person approved for THIS panel. The properties that matter: nothing is
 * requested for a host that isn't approved, a redirect can't carry the request to another host, and a response can't
 * be bigger than the cap.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { brokerFetch, LIMITS } = require('../app/canvas-fetch');
const { hostOrigin } = require('../app/canvas-csp');

const ok = (body = 'pong', init = {}) => new Response(body, { status: 200, ...init });
function rig({ approved = [], denied = [], answer = 'deny', respond = () => ok() } = {}) {
  const calls = []; const asked = [];
  return {
    calls, asked,
    opts: {
      decide: (origin) => (approved.includes(origin) ? 'allow' : denied.includes(origin) ? 'deny' : 'ask'),
      ask: async (origin) => { asked.push(origin); return answer; },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); },
    },
  };
}
const body64 = (r) => Buffer.from(r.bodyBase64, 'base64').toString('utf8');

test('an approved host is fetched, and the answer carries status, headers and the body', async () => {
  const r = rig({ approved: ['https://api.example.com'], respond: () => ok('{"t":1}', { headers: { 'content-type': 'application/json' } }) });
  const out = await brokerFetch({ url: 'https://api.example.com/v1/x?y=1', init: {} }, r.opts);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.headers['content-type'], 'application/json');
  assert.strictEqual(body64(out), '{"t":1}');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].init.redirect, 'manual', 'a redirect is looked at here, never followed by the engine');
  assert.deepStrictEqual(r.asked, []);
});

test('an unknown host asks once; Allow fetches, Deny does not', async () => {
  const yes = rig({ answer: 'allow' });
  assert.strictEqual((await brokerFetch({ url: 'https://new.example.com/' }, yes.opts)).ok, true);
  assert.deepStrictEqual(yes.asked, ['https://new.example.com']);
  const no = rig({ answer: 'deny' });
  const out = await brokerFetch({ url: 'https://new.example.com/' }, no.opts);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /not allowed/i);
  assert.strictEqual(no.calls.length, 0);
});

test('a host that was denied is refused without asking again', async () => {
  const r = rig({ denied: ['https://bad.example.com'], answer: 'allow' });
  const out = await brokerFetch({ url: 'https://bad.example.com/' }, r.opts);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(r.asked, []);
  assert.strictEqual(r.calls.length, 0);
});

test('not an http(s) address: refused without asking', async () => {
  for (const url of ['file:///c:/secret', 'ftp://x.com/', 'javascript:alert(1)', 'data:text/plain,hi', 'blob:https://a.com/x', '', null, 42,
    'https://user:pw@x.com/', 'not a url']) {
    const r = rig({ answer: 'allow' });
    const out = await brokerFetch({ url }, r.opts);
    assert.strictEqual(out.ok, false, String(url));
    assert.strictEqual(r.asked.length + r.calls.length, 0, String(url));
  }
});

test('a redirect to the same host is followed; to another host it is refused, and nothing is sent there', async () => {
  const same = rig({ approved: ['https://a.example.com'], respond: (u, i, n) => (n === 1
    ? new Response(null, { status: 302, headers: { location: '/next' } }) : ok('landed')) });
  const out = await brokerFetch({ url: 'https://a.example.com/start' }, same.opts);
  assert.strictEqual(body64(out), 'landed');
  assert.deepStrictEqual(same.calls.map(c => c.url), ['https://a.example.com/start', 'https://a.example.com/next']);

  const other = rig({ approved: ['https://a.example.com'], answer: 'allow',
    respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/steal' } }) });
  const bad = await brokerFetch({ url: 'https://a.example.com/start' }, other.opts);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /another host/i);
  assert.strictEqual(other.calls.length, 1, 'only the approved host was ever contacted');
  assert.deepStrictEqual(other.asked, [], 'a redirect never prompts: only the person adds a host');
});

test('a redirect loop ends', async () => {
  const r = rig({ approved: ['https://a.example.com'], respond: () => new Response(null, { status: 302, headers: { location: '/again' } }) });
  const out = await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
  assert.strictEqual(out.ok, false);
  assert.ok(r.calls.length <= LIMITS.redirects + 1);
});

test('a response over the cap is refused, whatever it claims', async () => {
  const big = 'x'.repeat(LIMITS.responseBytes + 1);
  const out = await brokerFetch({ url: 'https://a.example.com/' }, rig({ approved: ['https://a.example.com'], respond: () => ok(big) }).opts);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /too big/i);
  const exact = 'x'.repeat(LIMITS.responseBytes);
  assert.strictEqual((await brokerFetch({ url: 'https://a.example.com/' }, rig({ approved: ['https://a.example.com'], respond: () => ok(exact) }).opts)).ok, true);
});

test('a null-body status (204) comes back with an empty body', async () => {
  const out = await brokerFetch({ url: 'https://a.example.com/' }, rig({ approved: ['https://a.example.com'], respond: () => new Response(null, { status: 204 }) }).opts);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 204);
  assert.strictEqual(out.bodyBase64, '');
});

test('the request is sanitised: methods, hidden headers, body size, GET with a body', async () => {
  const approved = ['https://a.example.com'];
  const send = (init) => brokerFetch({ url: 'https://a.example.com/', init }, rig({ approved }).opts);
  assert.strictEqual((await send({ method: 'CONNECT' })).ok, false);
  assert.strictEqual((await send({ method: 'get', body: 'x' })).ok, false);
  assert.strictEqual((await send({ method: 'POST', body: 'x'.repeat(LIMITS.requestBytes + 1) })).ok, false);
  assert.strictEqual((await send({ headers: { 'bad name': 'x' } })).ok, false);
  assert.strictEqual((await send({ headers: { 'x-ok': 'a\r\nInjected: 1' } })).ok, false);
  assert.strictEqual((await send({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })).ok, true);
  const r = rig({ approved });
  await brokerFetch({ url: 'https://a.example.com/', init: { headers: { Cookie: 'a=1', Host: 'evil', 'x-ok': '1' } } }, r.opts);
  assert.deepStrictEqual(Object.keys(r.calls[0].init.headers), ['x-ok'], 'cookie and host are the engine\'s, never the page\'s');
});

test('a fetch that throws or times out is an error answer, never a throw', async () => {
  const r = rig({ approved: ['https://a.example.com'], respond: () => { throw new Error('ECONNREFUSED'); } });
  const out = await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /ECONNREFUSED/);
});

test('a malformed request is an error answer', async () => {
  for (const req of [null, undefined, 'x', {}, { url: 'https://a.example.com/', init: 'x' }]) {
    const out = await brokerFetch(req, rig({ approved: ['https://a.example.com'] }).opts);
    assert.strictEqual(out.ok, false, JSON.stringify(req));
  }
});

// The property the design asks for, at the point where it is now enforced: whatever the page asks for, the engine is only
// ever pointed at an origin the person approved.
test('property: nothing is requested for a host that is not approved, for any url', async () => {
  const approvedOrigins = ['https://api.example.com', 'http://127.0.0.1:8080'];
  const url = fc.oneof(fc.webUrl(), fc.string(), fc.constantFrom('https://api.example.com@evil.com/', 'https://api.example.com.evil.com/',
    'https://evil.com/?https://api.example.com', 'https://API.EXAMPLE.COM/x', 'https://api.example.com:444/', 'http://api.example.com/',
    'https://api.example.com:443/ok', 'https://api.example.com\\@evil.com/', 'https://evil.com#@api.example.com', 'http://127.0.0.1:8080/ok'));
  await fc.assert(fc.asyncProperty(url, async (u) => {
    const r = rig({ approved: approvedOrigins, answer: 'deny' });
    await brokerFetch({ url: u }, r.opts);
    for (const c of r.calls) assert.ok(approvedOrigins.includes(hostOrigin(c.url)), `${c.url} was requested`);
  }), { numRuns: 400 });
});
