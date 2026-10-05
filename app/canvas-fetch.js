'use strict';
/**
 * The only way anything leaves Claude's panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md).
 *
 * WHY A BROKER. verify/probe-canvas-sandbox.js measured, on Electron 33 / Chromium 130, that a sandboxed page with a
 * strict CSP still reaches the network three ways: WebRTC over UDP, WebRTC TURN over TCP (a raw connection to any
 * host:port, loopback included) and `<link rel=dns-prefetch>` (a DNS query that carries a name of the page's choosing).
 * So the panel's own network is shut instead: connect-src 'none', a dead proxy on its session, no DNS for it (app/main.js).
 * What the page calls `fetch` is a message to main, and main makes the request: here, and only to a host the person
 * approved for THIS panel.
 *
 * What this enforces, each pinned by test/canvas-fetch.test.js:
 *   - the URL is plain http(s) with no credentials, and its ORIGIN must be approved. The request goes out as the URL
 *     the platform parsed (`href`), never the string the page wrote, so what was checked is what is requested.
 *   - an unknown host asks (once; the caller remembers the answer), a denied host never asks again.
 *   - redirects are followed by hand, same origin only. A redirect to another host is refused and nothing is sent there:
 *     only the person adds a host, a server never does.
 *   - the method is one of six, the body is a string under a cap, headers are plain tokens and cookie/host are not the
 *     page's to set, the response is capped, a slow host times out. Failure is an answer, never a throw.
 */
const { hostOrigin } = require('./canvas-csp');

const LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 2 * 1024 * 1024, redirects: 5, timeoutMs: 15000, headers: 50 });
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'cookie2', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect', 'keep-alive']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);

const fail = (error) => ({ ok: false, error });

function cleanInit(init) {
  if (init === undefined || init === null) init = {};
  if (typeof init !== 'object' || Array.isArray(init)) return { error: 'the request options are not an object' };
  const method = String(init.method === undefined ? 'GET' : init.method).toUpperCase();
  if (!METHODS.has(method)) return { error: `method ${method} is not allowed` };
  let body;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string') return { error: 'the body must be a string' };
    if (method === 'GET' || method === 'HEAD') return { error: `a ${method} request has no body` };
    if (Buffer.byteLength(init.body) > LIMITS.requestBytes) return { error: `the request body is too big (the limit is ${LIMITS.requestBytes / 1024} KB)` };
    body = init.body;
  }
  const headers = {};
  const given = init.headers === undefined || init.headers === null ? {} : init.headers;
  if (typeof given !== 'object' || Array.isArray(given)) return { error: 'the headers are not an object' };
  const names = Object.keys(given);
  if (names.length > LIMITS.headers) return { error: 'too many headers' };
  for (const name of names) {
    const value = given[name];
    if (!TOKEN.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) return { error: `header "${String(name).slice(0, 40)}" is not valid` };
    if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return { method, body, headers };
}

async function readCapped(res) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = []; let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.responseBytes) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * @param req   { url, init? } from the panel (untrusted)
 * @param opts  { decide(origin) -> 'allow'|'deny'|'ask', ask(origin) -> Promise<'allow'|'deny'>, fetchImpl }
 * @returns     { ok: true, status, statusText, headers, bodyBase64 } | { ok: false, error }
 */
async function brokerFetch(req, { decide, ask, fetchImpl = fetch } = {}) {
  try {
    if (req === null || typeof req !== 'object') return fail('not a request');
    if (typeof req.url !== 'string' || !/^https?:\/\//i.test(req.url.trim())) return fail('only http(s) addresses can be fetched');
    const origin = hostOrigin(req.url);
    if (!origin) return fail('that address cannot be fetched');
    let first;
    try { first = new URL(req.url.trim()); } catch { return fail('that address cannot be fetched'); }

    const init = cleanInit(req.init);
    if (init.error) return fail(init.error);

    let verdict = decide(origin);
    if (verdict === 'ask') verdict = await ask(origin);
    if (verdict !== 'allow') return fail(`${origin} is not allowed for this panel`);

    let url = first.href;
    let { method, body } = init;
    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
      const res = await fetchImpl(url, { method, headers: init.headers, body, redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
      if (REDIRECTS.has(res.status) && res.headers.get('location')) {
        let next;
        try { next = new URL(res.headers.get('location'), url); } catch { return fail('the server sent a redirect that is not an address'); }
        if (hostOrigin(next.href) !== origin) return fail(`the server redirected to another host (${hostOrigin(next.href) || 'unknown'}); only the person can allow a host`);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        url = next.href;
        continue;
      }
      const bytes = NULL_BODY.has(res.status) ? Buffer.alloc(0) : await readCapped(res);
      if (bytes === null) return fail(`the response is too big (the limit is ${LIMITS.responseBytes / 1024 / 1024} MB)`);
      const headers = {};
      let n = 0;
      for (const [k, v] of res.headers) { if (k !== 'set-cookie' && n++ < LIMITS.headers) headers[k] = v; }
      return { ok: true, status: res.status, statusText: res.statusText || '', headers, bodyBase64: bytes.toString('base64') };
    }
    return fail('too many redirects');
  } catch (err) {
    return fail(err && err.message ? String(err.message).slice(0, 200) : 'the request failed');
  }
}

module.exports = { brokerFetch, LIMITS };
