'use strict';
/**
 * app/canvas-net.js: which addresses Claude's panel broker may connect to, and the transport that connects only to the one it checked
 * (PR #122 Dexter F6 / Miguel Y2). The person approves a NAME; these are the tests that the name can't be turned into the person's own
 * machine or network, by an address typed in, by a name that resolves there, or by a name that changes its answer later.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const fc = require('fast-check');
const { isPublicAddress, isLocalName, parseIPv4, parseIPv6, createPinnedFetch } = require('../app/canvas-net');

const v4 = (a, b, c, d) => `${a}.${b}.${c}.${d}`;

test('public IPv4 addresses are public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '192.169.0.1', '198.20.0.1']) {
    assert.strictEqual(isPublicAddress(ip), true, ip);
  }
});

test('loopback, private, link-local, CGNAT, multicast, reserved and documentation IPv4 are not', () => {
  for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
    assert.strictEqual(isPublicAddress(ip), false, ip);
  }
});

test('IPv6: global unicast is public; loopback, unspecified, link-local, unique-local, multicast, documentation and mapped private IPv4 are not', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) assert.strictEqual(isPublicAddress(ip), true, ip);
  for (const ip of ['::', '::1', 'fe80::1', 'fe80::a00:27ff:fe4e:66a1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '3fff::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:c0a8:101::',
    '::127.0.0.1', '100::1', 'fec0::1', '1::1', '0:0:0:0:0:0:0:1']) {
    assert.strictEqual(isPublicAddress(ip), false, ip);
  }
  assert.strictEqual(isPublicAddress('::ffff:8.8.8.8'), true, 'a mapped PUBLIC address is judged by the address inside');
  assert.strictEqual(isPublicAddress('[::1]'), false, 'a bracketed literal is read as the literal');
});

test('anything that is not a clean IP literal is not public (a refusal is the default)', () => {
  for (const x of ['', 'localhost', 'example.com', '8.8.8', '8.8.8.8.8', '256.1.1.1', '08.8.8.8', 'fe80::1%eth0', ':::', '2606::1::1', null, undefined, 5, {}, '8.8.8.8 ']) {
    assert.strictEqual(isPublicAddress(x), false, JSON.stringify(x));
  }
});

test('the local names: localhost and anything under it, however written', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'a.b.localhost.']) assert.strictEqual(isLocalName(h), true, h);
  for (const h of ['notlocalhost', 'localhost.example.com', 'example.com', '127.0.0.1']) assert.strictEqual(isLocalName(h), false, h);
});

test('property: every address inside a blocked IPv4 range is refused, however it is spelled (plain, mapped, 6to4, NAT64)', () => {
  const ranges = [['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['0.0.0.0', 8], ['224.0.0.0', 4], ['240.0.0.0', 4], ['198.18.0.0', 15]];
  fc.assert(fc.property(fc.constantFrom(...ranges), fc.integer({ min: 0, max: 0xffffffff }), ([base, bits], r) => {
    const host = (r & (bits === 32 ? 0 : 0xffffffff >>> bits)) >>> 0;
    const n = (parseIPv4(base) | host) >>> 0;
    const ip = v4(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const hex = (x) => x.toString(16);
    assert.strictEqual(isPublicAddress(ip), false, ip);
    assert.strictEqual(isPublicAddress(`::ffff:${ip}`), false, `mapped ${ip}`);
    assert.strictEqual(isPublicAddress(`::ffff:${hex(n >>> 16)}:${hex(n & 0xffff)}`), false, `mapped hex ${ip}`);
    assert.strictEqual(isPublicAddress(`2002:${hex(n >>> 16)}:${hex(n & 0xffff)}::1`), false, `6to4 ${ip}`);
    assert.strictEqual(isPublicAddress(`64:ff9b::${hex(n >>> 16)}:${hex(n & 0xffff)}`), false, `nat64 ${ip}`);
  }), { numRuns: 500 });
});

test('property: an IPv4 address and its IPv4-mapped IPv6 form always get the same verdict', () => {
  fc.assert(fc.property(fc.ipV4(), (ip) => { assert.strictEqual(isPublicAddress(`::ffff:${ip}`), isPublicAddress(ip), ip); }), { numRuns: 500 });
});

test('property: an IPv6 address outside 2000::/3 is never public', () => {
  fc.assert(fc.property(fc.ipV6(), (ip) => {
    const g = parseIPv6(ip);
    fc.pre(g !== null && (g[0] & 0xe000) !== 0x2000 && !(g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) && !(g[0] === 0x64 && g[1] === 0xff9b));
    assert.strictEqual(isPublicAddress(ip), false, ip);
  }), { numRuns: 500 });
});

test('property: a verdict never throws, whatever string it is given', () => {
  fc.assert(fc.property(fc.string(), (x) => { assert.strictEqual(typeof isPublicAddress(x), 'boolean'); }), { numRuns: 500 });
});

// ---- the pinned transport, against a real server on this machine (the transport judges nothing: the broker already did) --------------------------

async function serve(handler) {
  const seen = [];
  const server = http.createServer((q, res) => { seen.push({ host: q.headers.host, url: q.url, method: q.method, headers: q.headers }); handler(q, res, seen); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise(r => server.close(r)) };
}
const text = async (res) => Buffer.from(await res.arrayBuffer()).toString('utf8');

test('the transport connects to the pinned address, whatever the URL names, and keeps the name in the Host header', async () => {
  const s = await serve((q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pong'); });
  try {
    const f = createPinnedFetch();
    const res = await f(`http://approved-name.invalid:${s.port}/path?q=1`, { pin: { address: '127.0.0.1', family: 4 }, redirect: 'manual' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await text(res), 'pong');
    assert.strictEqual(s.seen[0].host, `approved-name.invalid:${s.port}`, 'the name is what the server hears, the pin is where the connection went');
    assert.strictEqual(s.seen[0].url, '/path?q=1');
  } finally { await s.close(); }
});

test('with no pin (or a malformed one) the transport refuses to resolve for itself', async () => {
  const f = createPinnedFetch();
  await assert.rejects(() => f('http://approved-name.invalid:1/', {}), /no pinned address/);
  await assert.rejects(() => f('http://approved-name.invalid:1/', { pin: {} }), /no pinned address/);
  await assert.rejects(() => f('http://approved-name.invalid:1/', { pin: { address: '127.0.0.1', family: 5 } }), /no pinned address/);
});

test('an IP literal in the URL must be the pinned address, and only http(s) is spoken', async () => {
  const f = createPinnedFetch();
  await assert.rejects(() => f('http://8.8.8.8/', { pin: { address: '127.0.0.1', family: 4 } }), /not the one in the URL/);
  await assert.rejects(() => f('ftp://x.example/', { pin: { address: '8.8.8.8', family: 4 } }), /only http/);
  await assert.rejects(() => f('not a url', { pin: { address: '8.8.8.8', family: 4 } }), /not an address/);
});

test('a redirect is handed back as it is, never followed', async () => {
  const s = await serve((q, res) => { res.writeHead(302, { location: 'http://elsewhere.invalid/' }); res.end(); });
  try {
    const res = await createPinnedFetch()(`http://a.invalid:${s.port}/`, { pin: { address: '127.0.0.1', family: 4 }, redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), 'http://elsewhere.invalid/');
    assert.strictEqual(s.seen.length, 1);
  } finally { await s.close(); }
});

test('method, body and headers go out as given; the forbidden defaults are ours', async () => {
  const s = await serve((q, res, seen) => { let b = ''; q.on('data', d => { b += d; }); q.on('end', () => { seen[seen.length - 1].body = b; res.writeHead(201); res.end('made'); }); });
  try {
    const res = await createPinnedFetch()(`http://a.invalid:${s.port}/x`, { method: 'POST', body: '{"é":1}', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, pin: { address: '127.0.0.1', family: 4 } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(s.seen[0].method, 'POST');
    assert.strictEqual(s.seen[0].body, '{"é":1}');
    assert.strictEqual(s.seen[0].headers['content-type'], 'application/json');
    assert.strictEqual(s.seen[0].headers['content-length'], String(Buffer.byteLength('{"é":1}')));
    assert.strictEqual(s.seen[0].headers['accept-encoding'], 'gzip, deflate, br', 'the page does not choose the encoding: this transport decodes the ones it advertises');
  } finally { await s.close(); }
});

test('gzip, deflate and brotli answers are decoded, and their encoding headers dropped', async () => {
  const payload = 'x'.repeat(5000) + 'é';
  for (const [enc, pack] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    const s = await serve((q, res) => { res.writeHead(200, { 'content-encoding': enc }); res.end(pack(payload)); });
    try {
      const res = await createPinnedFetch()(`http://a.invalid:${s.port}/`, { pin: { address: '127.0.0.1', family: 4 } });
      assert.strictEqual(await text(res), payload, enc);
      assert.strictEqual(res.headers.get('content-encoding'), null, enc);
    } finally { await s.close(); }
  }
});

test('an encoding it cannot read is an error, not garbage bytes', async () => {
  const s = await serve((q, res) => { res.writeHead(200, { 'content-encoding': 'zstd' }); res.end('x'); });
  try {
    await assert.rejects(() => createPinnedFetch()(`http://a.invalid:${s.port}/`, { pin: { address: '127.0.0.1', family: 4 } }), /encoding/);
  } finally { await s.close(); }
});

test('204 and HEAD come back with no body, and an aborted request rejects', async () => {
  const s = await serve((q, res) => { if (q.url === '/slow') return; res.writeHead(q.method === 'HEAD' ? 200 : 204); res.end(); });
  try {
    const f = createPinnedFetch();
    const no = await f(`http://a.invalid:${s.port}/`, { pin: { address: '127.0.0.1', family: 4 } });
    assert.strictEqual(no.status, 204);
    assert.strictEqual(await text(no), '');
    const head = await f(`http://a.invalid:${s.port}/`, { method: 'HEAD', pin: { address: '127.0.0.1', family: 4 } });
    assert.strictEqual(head.status, 200);
    const ctl = new AbortController();
    const slow = f(`http://a.invalid:${s.port}/slow`, { pin: { address: '127.0.0.1', family: 4 }, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(() => slow);
  } finally { await s.close(); }
});
