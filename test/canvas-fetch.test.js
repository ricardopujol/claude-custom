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
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
function rig({ approved = [], denied = [], answer = 'deny', respond = () => ok(), resolve = async () => PUBLIC } = {}) {
  const calls = []; const asked = []; const resolved = [];
  return {
    calls, asked, resolved,
    opts: {
      decide: (origin) => (approved.includes(origin) ? 'allow' : denied.includes(origin) ? 'deny' : 'ask'),
      ask: async (origin) => { asked.push(origin); return answer; },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); },
      resolveHost: async (host) => { resolved.push(host); return resolve(host); },
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

// ---- a name is not an address (PR #122 Dexter F6 / Miguel Y2) ------------------------------------------------------------------------------

const LOCAL_URLS = ['http://127.0.0.1:11434/api/tags', 'http://localhost:11434/api/tags', 'http://LOCALHOST/', 'http://[::1]:8080/', 'http://10.0.0.5/', 'http://192.168.1.1/admin',
  'http://169.254.169.254/latest/meta-data', 'http://172.16.0.9/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://a.localhost/', 'http://2130706433/', 'http://0x7f.1/',
  'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd00::1]/'];

test('an address on this machine or its network is refused BEFORE the person is asked, and nothing is requested, even if it was approved', async () => {
  for (const url of LOCAL_URLS) {
    const origin = hostOrigin(url);
    const asking = rig({ answer: 'allow' });
    const out = await brokerFetch({ url }, asking.opts);
    assert.strictEqual(out.ok, false, url);
    assert.match(out.error, /on this computer or its network/, url);
    assert.deepStrictEqual(asking.asked, [], `${url} must not ask`);
    assert.strictEqual(asking.calls.length, 0, url);
    const approved = rig({ approved: [origin] });
    assert.strictEqual((await brokerFetch({ url }, approved.opts)).ok, false, `${url} approved`);
    assert.strictEqual(approved.calls.length, 0, `${url} approved`);
  }
});

test('a name that resolves to a local or private address is refused after the question, and the transport is never called', async () => {
  for (const address of ['127.0.0.1', '192.168.1.1', '10.1.2.3', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    const r = rig({ approved: ['https://rebind.example.com'], resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    const out = await brokerFetch({ url: 'https://rebind.example.com/x' }, r.opts);
    assert.strictEqual(out.ok, false, address);
    assert.match(out.error, /on this computer or its network/, address);
    assert.strictEqual(r.calls.length, 0, address);
  }
});

test('the transport is handed the address that was checked: the first public answer, never a private one that came before it', async () => {
  const r = rig({ approved: ['https://a.example.com'], resolve: async () => [{ address: '10.0.0.1', family: 4 }, { address: '2606:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }] });
  const out = await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(r.calls[0].init.pin, { address: '2606:4700::1111', family: 6 });
  assert.deepStrictEqual(r.resolved, ['a.example.com']);
});

test("a resolver's family field is not trusted: the pin's family comes from the address", async () => {
  const r = rig({ approved: ['https://a.example.com'], resolve: async () => [{ address: '8.8.8.8', family: 6 }] });
  await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
  assert.deepStrictEqual(r.calls[0].init.pin, { address: '8.8.8.8', family: 4 });
});

test('DNS rebinding between hops: the same approved name answering a private address on the redirect is refused, with one request made', async () => {
  let n = 0;
  const r = rig({ approved: ['https://a.example.com'],
    resolve: async () => (++n === 1 ? PUBLIC : [{ address: '192.168.0.1', family: 4 }]),
    respond: () => new Response(null, { status: 302, headers: { location: '/next' } }) });
  const out = await brokerFetch({ url: 'https://a.example.com/start' }, r.opts);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /on this computer or its network/);
  assert.strictEqual(r.calls.length, 1, 'the second hop was never sent');
});

test('a resolver that fails, returns nothing or returns junk is an error answer, never a request', async () => {
  for (const resolve of [async () => { throw new Error('getaddrinfo ENOTFOUND a.example.com'); }, async () => [], async () => null, async () => [{ address: 5 }, null, {}], async () => 'x']) {
    const r = rig({ approved: ['https://a.example.com'], resolve });
    const out = await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(r.calls.length, 0);
  }
});

test('a public IP literal is fetched as itself, pinned to itself, with no DNS', async () => {
  const r = rig({ approved: ['http://8.8.8.8'] });
  const out = await brokerFetch({ url: 'http://8.8.8.8/dns-query' }, r.opts);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(r.calls[0].init.pin, { address: '8.8.8.8', family: 4 });
  assert.deepStrictEqual(r.resolved, []);
});

test('property: whatever the resolver answers, every address the transport is told to connect to is a public one', async () => {
  const ip = fc.oneof(fc.ipV4(), fc.ipV6(), fc.constantFrom('127.0.0.1', '::1', '10.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', '8.8.8.8', '2606:4700::1111'));
  const answers = fc.array(fc.record({ address: ip, family: fc.constantFrom(4, 6) }), { maxLength: 5 });
  const { isPublicAddress } = require('../app/canvas-net');
  await fc.assert(fc.asyncProperty(answers, async (list) => {
    const r = rig({ approved: ['https://a.example.com'], resolve: async () => list });
    const out = await brokerFetch({ url: 'https://a.example.com/' }, r.opts);
    for (const c of r.calls) assert.ok(isPublicAddress(c.init.pin.address), `connected to ${c.init.pin.address}`);
    assert.strictEqual(out.ok, list.some(a => isPublicAddress(a.address)), 'fetched exactly when some answer was public');
  }), { numRuns: 300 });
});

test('property: a page cannot make the broker connect to a local address by any spelling of the URL', async () => {
  const net = require('net');
  const { isPublicAddress, bareHost } = require('../app/canvas-net');
  const spell = fc.oneof(
    fc.ipV4().map(ip => `http://${ip}/`), fc.ipV6().map(ip => `http://[${ip}]/`), fc.integer({ min: 0, max: 0xffffffff }).map(n => `http://${n}/`),
    fc.constantFrom('http://localhost/', 'http://127.1/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://127.0.0.1.:80/', 'http://0/'));
  await fc.assert(fc.asyncProperty(spell, async (url) => {
    const r = rig({ answer: 'allow', resolve: async () => PUBLIC });
    await brokerFetch({ url }, r.opts);
    for (const c of r.calls) {
      assert.ok(isPublicAddress(c.init.pin.address), `${url} -> ${c.init.pin.address}`);
      const host = bareHost(new URL(c.url).hostname);
      assert.ok(!net.isIP(host) || isPublicAddress(host), `${url} requested as ${c.url}`);
    }
  }), { numRuns: 300 });
});

test("a browser's forbidden request headers are the engine's, never the page's: origin, referer, sec-*, proxy-*, accept-encoding", async () => {
  const r = rig({ approved: ['https://a.example.com'] });
  const headers = { Origin: 'https://a.example.com', Referer: 'https://a.example.com/', 'Sec-Fetch-Site': 'same-origin', 'sec-ch-ua': 'x', 'Proxy-Foo': '1', 'Accept-Encoding': 'br',
    Via: '1.1 x', Date: 'x', DNT: '1', 'x-ok': '1', Authorization: 'Bearer t' };
  await brokerFetch({ url: 'https://a.example.com/', init: { headers } }, r.opts);
  assert.deepStrictEqual(Object.keys(r.calls[0].init.headers).sort(), ['Authorization', 'x-ok']);
});

test("an injected resolver can vouch for its own answer (a probe's stand-in for DNS); an IP literal in a URL never gets that", async () => {
  const r = rig({ approved: ['http://probe-name.invalid:8080'], resolve: async () => [{ address: '127.0.0.1', family: 4, trusted: true }] });
  assert.strictEqual((await brokerFetch({ url: 'http://probe-name.invalid:8080/' }, r.opts)).ok, true);
  assert.deepStrictEqual(r.calls[0].init.pin, { address: '127.0.0.1', family: 4 });
  const lit = rig({ approved: ['http://127.0.0.1:8080'], resolve: async () => [{ address: '127.0.0.1', family: 4, trusted: true }] });
  assert.strictEqual((await brokerFetch({ url: 'http://127.0.0.1:8080/' }, lit.opts)).ok, false);
  const untrusted = rig({ approved: ['http://probe-name.invalid:8080'], resolve: async () => [{ address: '127.0.0.1', family: 4, trusted: 'yes' }] });
  assert.strictEqual((await brokerFetch({ url: 'http://probe-name.invalid:8080/' }, untrusted.opts)).ok, false, 'only true counts');
});
