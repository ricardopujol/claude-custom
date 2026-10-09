'use strict';
/**
 * Kill tests for the release-gate survivor S8 in app/canvas-fetch.js (Mortimer, 2026-10-09): the broker's forbidden-header list, method
 * allow-list, redirect rewrite rules, response filter and size/count limits. Every number is a literal on purpose: the constants the
 * module exports are what a mutant would also change.
 */
const test = require('node:test');
const assert = require('node:assert');
const { brokerFetch } = require('../app/canvas-fetch');

const ORIGIN = 'https://api.example.com';
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
function rig(respond = () => new Response('ok', { status: 200 })) {
  const calls = [];
  return {
    calls,
    opts: {
      decide: () => 'allow', ask: async () => 'allow', resolveHost: async () => PUBLIC,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); },
    },
  };
}
const go = (req, respond) => { const r = rig(respond); return brokerFetch({ url: `${ORIGIN}/x`, ...req }, r.opts).then(out => ({ out, calls: r.calls })); };

const FORBIDDEN = ['host', 'cookie', 'cookie2', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'expect', 'keep-alive', 'origin', 'referer', 'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'date', 'dnt', 'via', 'set-cookie'];

test('S8: every forbidden header is dropped, in any case, and the allowed ones pass through', async () => {
  for (const name of FORBIDDEN) {
    for (const spelled of [name, name.toUpperCase()]) {
      const { out, calls } = await go({ init: { headers: { [spelled]: 'v', 'x-keep': 'k' } } });
      assert.strictEqual(out.ok, true, spelled);
      assert.deepStrictEqual(calls[0].init.headers, { 'x-keep': 'k' }, `${spelled} is dropped`);
    }
  }
  for (const name of ['proxy-x', 'Proxy-Foo', 'sec-fetch-mode', 'Sec-Anything']) {
    const { calls } = await go({ init: { headers: { [name]: 'v' } } });
    assert.deepStrictEqual(calls[0].init.headers, {}, `${name} is dropped by prefix`);
  }
  const { calls } = await go({ init: { headers: { accept: 'text/html', 'x-api-key': 'k', secret: 's', proxyish: 'p', 'content-type': 'application/json', authorization: 'Bearer t' } } });
  assert.deepStrictEqual(calls[0].init.headers, { accept: 'text/html', 'x-api-key': 'k', secret: 's', proxyish: 'p', 'content-type': 'application/json', authorization: 'Bearer t' });
});

test('S8: the six methods pass (any case, GET by default); anything else is refused and nothing is sent', async () => {
  for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const { out, calls } = await go({ init: { method: m } });
    assert.strictEqual(out.ok, true, m);
    assert.strictEqual(calls[0].init.method, m);
  }
  assert.strictEqual((await go({ init: { method: 'post', body: 'x' } })).calls[0].init.method, 'POST');
  assert.strictEqual((await go({})).calls[0].init.method, 'GET');
  assert.strictEqual((await go({ init: {} })).calls[0].init.method, 'GET');
  assert.strictEqual((await go({ init: null })).calls[0].init.method, 'GET');
  for (const m of ['TRACE', 'CONNECT', 'OPTIONS', 'LINK', '']) {
    const { out, calls } = await go({ init: { method: m } });
    assert.strictEqual(out.ok, false, m);
    assert.match(out.error, /not allowed/);
    assert.strictEqual(calls.length, 0, m);
  }
});

test('S8: a redirect rewrites the method and drops the body for 303, and for 301/302 only after a POST', async () => {
  const cases = [
    // [first method, redirect status, expected second method, body kept]
    ['POST', 303, 'GET', false], ['POST', 301, 'GET', false], ['POST', 302, 'GET', false],
    ['POST', 307, 'POST', true], ['POST', 308, 'POST', true],
    ['PUT', 303, 'GET', false], ['PUT', 301, 'PUT', true], ['PUT', 302, 'PUT', true], ['PUT', 307, 'PUT', true],
    ['DELETE', 301, 'DELETE', true], ['PATCH', 302, 'PATCH', true],
    ['GET', 301, 'GET', false], ['GET', 302, 'GET', false], ['GET', 303, 'GET', false], ['GET', 307, 'GET', false],
  ];
  for (const [method, status, want, keeps] of cases) {
    const respond = (_u, _i, n) => (n === 1 ? new Response(null, { status, headers: { location: '/next' } }) : new Response('landed', { status: 200 }));
    const withBody = method !== 'GET';
    const { out, calls } = await go({ init: { method, ...(withBody ? { body: 'payload' } : {}) } }, respond);
    assert.strictEqual(out.ok, true, `${method} ${status}`);
    assert.strictEqual(calls.length, 2, `${method} ${status}`);
    assert.strictEqual(calls[1].init.method, want, `${method} ${status}`);
    assert.strictEqual(calls[1].init.body, keeps ? 'payload' : undefined, `${method} ${status} body`);
    assert.strictEqual(calls[1].url, `${ORIGIN}/next`);
  }
});

test('S8: five redirects are followed, a sixth is refused', async () => {
  const chain = (n) => (_u, _i, call) => (call <= n ? new Response(null, { status: 302, headers: { location: `/hop${call}` } }) : new Response('end', { status: 200 }));
  const five = await go({}, chain(5));
  assert.strictEqual(five.out.ok, true);
  assert.strictEqual(five.calls.length, 6);
  const six = await go({}, chain(6));
  assert.strictEqual(six.out.ok, false);
  assert.match(six.out.error, /too many redirects/);
  assert.strictEqual(six.calls.length, 6, 'no seventh request');
});

test('S8: a response never hands the page a Set-Cookie, and carries at most 50 headers', async () => {
  const withCookie = await go({}, () => new Response('x', { status: 200, headers: { 'set-cookie': 'a=b', 'x-other': 'o', 'content-type': 'text/plain' } }));
  assert.strictEqual(withCookie.out.headers['set-cookie'], undefined);
  assert.strictEqual(withCookie.out.headers['x-other'], 'o');
  const many = {}; for (let i = 0; i < 51; i++) many[`x-h${String(i).padStart(2, '0')}`] = 'v';
  const capped = await go({}, () => new Response('x', { status: 200, headers: many }));
  assert.strictEqual(Object.keys(capped.out.headers).length, 50);
});

test('S8: the request body limit is 262144 bytes: that many pass, one more is refused with nothing sent', async () => {
  const exact = await go({ init: { method: 'POST', body: 'a'.repeat(262144) } });
  assert.strictEqual(exact.out.ok, true);
  assert.strictEqual(exact.calls.length, 1);
  const over = await go({ init: { method: 'POST', body: 'a'.repeat(262145) } });
  assert.strictEqual(over.out.ok, false);
  assert.match(over.out.error, /too big/);
  assert.strictEqual(over.calls.length, 0);
  const multibyte = await go({ init: { method: 'POST', body: 'é'.repeat(131073) } });
  assert.strictEqual(multibyte.out.ok, false, 'the limit is in bytes, not characters');
});

test('S8: a body needs a string and a method that has one; null and undefined are no body', async () => {
  for (const body of [5, {}, [], true]) assert.match((await go({ init: { method: 'POST', body } })).out.error, /body must be a string/);
  for (const m of ['GET', 'HEAD']) assert.match((await go({ init: { method: m, body: 'x' } })).out.error, new RegExp(`a ${m} request has no body`));
  assert.strictEqual((await go({ init: { method: 'POST', body: null } })).out.ok, true);
  assert.strictEqual((await go({ init: { method: 'POST' } })).calls[0].init.body, undefined);
  assert.strictEqual((await go({ init: { method: 'GET', body: null } })).out.ok, true);
});

test('S8: 50 headers pass and a 51st is refused; a bad name or value is refused', async () => {
  const n = (k) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`x-h${i}`, 'v']));
  assert.strictEqual((await go({ init: { headers: n(50) } })).out.ok, true);
  const over = await go({ init: { headers: n(51) } });
  assert.strictEqual(over.out.ok, false);
  assert.match(over.out.error, /too many headers/);
  assert.strictEqual(over.calls.length, 0);
  for (const headers of [{ 'bad name': 'v' }, { 'x-a': 'line\nbreak' }, { 'x-a': 5 }, { '': 'v' }, { 'x-a': 'café' }, []]) {
    const r = await go({ init: { headers } });
    assert.strictEqual(r.out.ok, false, JSON.stringify(headers));
    assert.strictEqual(r.calls.length, 0);
  }
  assert.strictEqual((await go({ init: { headers: { 'x-a': 'tab\tok ~' } } })).out.ok, true);
  assert.strictEqual((await go({ init: { headers: null } })).out.ok, true);
});

test('S8: the response limit is 2 MB: exactly that is returned, one byte more is refused', async () => {
  const exact = await go({}, () => new Response(Buffer.alloc(2097152, 97), { status: 200 }));
  assert.strictEqual(exact.out.ok, true);
  assert.strictEqual(Buffer.from(exact.out.bodyBase64, 'base64').length, 2097152);
  const over = await go({}, () => new Response(Buffer.alloc(2097153, 97), { status: 200 }));
  assert.strictEqual(over.out.ok, false);
  assert.match(over.out.error, /too big/);
});

test('S8: a null-body status answers with no bytes and no read', async () => {
  for (const status of [204, 205, 304]) {
    const { out } = await go({}, () => new Response(null, { status }));
    assert.deepStrictEqual([out.ok, out.status, out.bodyBase64], [true, status, ''], String(status));
  }
});
