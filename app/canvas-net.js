'use strict';
/**
 * The network half of Claude's panel broker (BACKLOG #71, PR #122 Dexter F6 / Miguel Y2).
 *
 * WHAT THE PERSON APPROVES IS A NAME, AND A NAME IS NOT AN ADDRESS. The page chooses the origin the person is asked about, and
 * main's Node networking (which the process-wide resolver rule of app/main.js does not touch) will connect to whatever that name
 * resolves to, now or later (DNS rebinding). So the broker does three things here:
 *
 *   1. `isPublicAddress`: only a globally routable unicast address is ever connected to. Loopback, the private ranges, link-local
 *      (the cloud metadata address included), CGNAT, multicast, documentation and every transition range that carries an IPv4
 *      address inside it (mapped, NAT64, 6to4) are refused. A person can't grant that: the panel is not for reaching their own
 *      machine or network (the design: "it only reaches websites you allow").
 *   2. The broker resolves the name ITSELF, checks every answer, and passes the one it checked to the transport as `pin`.
 *   3. `createPinnedFetch` is that transport: it connects to the pinned address and nowhere else (the name stays in the URL, so TLS
 *      verifies the certificate for the name and the Host header is right). With no pin it refuses to connect at all, so swapping in
 *      a transport that resolves for itself can't happen silently.
 */
const net = require('net');

// ---- addresses ----------------------------------------------------------------------------------------------------------------------

/** "a.b.c.d" -> a 32-bit number, or null. Strict dotted-quad only (the URL parser has already normalised any other spelling). */
function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(n => n > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** An IPv6 literal -> its 8 groups, or null (a zone id, a bad shape, too many groups). An embedded dotted quad is read as two groups. */
function parseIPv6(text) {
  let t = String(text);
  if (t.includes('%') || !t.includes(':')) return null;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]);
    if (v4 === null) return null;
    t = t.slice(0, t.length - dotted[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const group = (s) => (s === '' ? [] : s.split(':'));
  const head = group(halves[0]); const tail = halves.length === 2 ? group(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const out = all.map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

// [network, prefix length] pairs of IPv4 space that is not the public internet.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [parseIPv4(base), bits]);

function v4Public(n) {
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return false;
  }
  return true;
}

function v6Public(g) {
  if (!g) return false;
  const v4In = (hi, lo) => ((hi << 16) | lo) >>> 0;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return v4Public(v4In(g[6], g[7]));       // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Public(v4In(g[6], g[7]));   // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return v4Public(v4In(g[1], g[2]));                                             // 2002::/16 6to4 carries an IPv4 address
  if ((g[0] & 0xe000) !== 0x2000) return false;                                                        // only 2000::/3 is global unicast
  if (g[0] === 0x2001 && g[1] < 0x200) return false;                                                   // 2001::/23 protocol assignments (Teredo...)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                                                // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;                                                  // 3fff::/20 documentation
  return true;
}

/** Is this IP literal an address on the public internet? Anything that does not parse is NOT public. */
function isPublicAddress(ip) {
  if (typeof ip !== 'string') return false;
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const kind = net.isIP(bare);
  if (kind === 4) return v4Public(parseIPv4(bare));
  if (kind === 6) return v6Public(parseIPv6(bare));
  return false;
}

/** The hostname of a parsed URL without the brackets an IPv6 literal carries. */
const bareHost = (hostname) => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

/** A name that is the local machine whatever DNS says (RFC 6761): refused before the person is asked about it. */
const isLocalName = (hostname) => { const h = bareHost(hostname).toLowerCase().replace(/\.$/, ''); return h === 'localhost' || h.endsWith('.localhost'); };

// ---- the pinned transport -------------------------------------------------------------------------------------------------------------

const NULL_BODY = new Set([101, 204, 205, 304]);
const DECODERS = { gzip: 'createGunzip', 'x-gzip': 'createGunzip', deflate: 'createInflate', br: 'createBrotliDecompress' };

/**
 * A `fetch`-shaped function over node's http/https that connects ONLY to `init.pin.address`. It returns a real `Response` (so the
 * broker reads it as it read the engine's), with `content-encoding` already undone. It never follows a redirect: the broker does.
 */
function createPinnedFetch({ http = require('http'), https = require('https'), zlib = require('zlib'), Readable = require('stream').Readable } = {}) {
  return function pinnedFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch { reject(new TypeError('not an address')); return; }
      const pin = init.pin;
      if (!pin || typeof pin.address !== 'string' || (pin.family !== 4 && pin.family !== 6)) { reject(new TypeError('no pinned address: refusing to resolve for myself')); return; }
      const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!mod) { reject(new TypeError('only http(s) addresses can be fetched')); return; }
      const host = bareHost(u.hostname);
      if (net.isIP(host) && host !== pin.address) { reject(new TypeError('the pinned address is not the one in the URL')); return; }

      const headers = { accept: '*/*', 'user-agent': 'node', 'accept-encoding': 'gzip, deflate, br' };
      for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
      headers['accept-encoding'] = 'gzip, deflate, br';
      const method = String(init.method || 'GET').toUpperCase();
      const body = typeof init.body === 'string' ? init.body : null;
      if (body !== null) headers['content-length'] = String(Buffer.byteLength(body));
      else if (method === 'POST' || method === 'PUT' || method === 'PATCH') headers['content-length'] = '0';

      const req = mod.request({
        protocol: u.protocol, hostname: host, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`,
        method, headers, agent: false, signal: init.signal,
        servername: net.isIP(host) ? undefined : host,
        // Whatever the connection asks to resolve, the answer is the address the broker checked.
        lookup: (_h, opts, cb) => {
          const done = typeof opts === 'function' ? opts : cb;
          if (opts && typeof opts === 'object' && opts.all) done(null, [{ address: pin.address, family: pin.family }]);
          else done(null, pin.address, pin.family);
        },
      }, (res) => { try { onResponse(res); } catch (err) { res.destroy(); reject(err); } });
      // (a server-chosen status text or header the Response class refuses must reject this promise, never throw out of an event handler)
      const onResponse = (res) => {
        const status = res.statusCode;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) { if (Array.isArray(v)) v.forEach(x => out.append(k, x)); else if (v !== undefined) out.append(k, String(v)); }
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        if (enc && enc !== 'identity') {
          if (!DECODERS[enc]) { res.destroy(); reject(new Error(`the server answered in an encoding this panel can't read (${enc.slice(0, 20)})`)); return; }
          stream = res.pipe(zlib[DECODERS[enc]]());
          res.on('error', (e) => stream.destroy(e));
          out.delete('content-encoding'); out.delete('content-length');
        }
        if (NULL_BODY.has(status) || method === 'HEAD') { res.resume(); resolve(new Response(null, { status, statusText: res.statusMessage || '', headers: out })); return; }
        resolve(new Response(Readable.toWeb(stream), { status, statusText: res.statusMessage || '', headers: out }));
      };
      req.on('error', reject);
      if (body !== null) req.write(body);
      req.end();
    });
  };
}

module.exports = { isPublicAddress, isLocalName, bareHost, parseIPv4, parseIPv6, createPinnedFetch };
