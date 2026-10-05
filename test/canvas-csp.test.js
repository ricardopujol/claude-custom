'use strict';
/**
 * app/canvas-csp.js: the policy that wraps the page Claude wrote for its panel (BACKLOG #71).
 *
 * The page is untrusted. The CSP is the one thing that stops it reaching the network, so the property that matters
 * is the one the design names: the policy never lists a host that is not on the approved list, whatever strings the
 * list is built from. Real-window proof that Chromium enforces it is verify/probe-canvas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { hostOrigin, buildCsp, buildSrcdoc, violationHost, CSP_DIRECTIVES } = require('../app/canvas-csp');

test('hostOrigin: a bare host is https, an explicit scheme and port are kept, case is folded', () => {
  assert.strictEqual(hostOrigin('api.open-meteo.com'), 'https://api.open-meteo.com');
  assert.strictEqual(hostOrigin('HTTPS://API.Open-Meteo.com/v1/forecast?x=1'), 'https://api.open-meteo.com');
  assert.strictEqual(hostOrigin('http://127.0.0.1:8080/path'), 'http://127.0.0.1:8080');
  assert.strictEqual(hostOrigin('https://example.com:443/'), 'https://example.com');
});

test('hostOrigin: anything that is not a plain http(s) host is refused', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,hi',
    'file:///c:/x', 'https://user:pw@example.com', 'https://*.example.com', '*', "https://a.com; script-src *",
    'https://a.com b.com', "https://a.com'", 'https://', 'https://exa mple.com', 'about:srcdoc', 'blob:https://a.com/x']) {
    assert.strictEqual(hostOrigin(bad), null, JSON.stringify(bad));
  }
});

test('violationHost: the URL a blocked fetch names becomes the host to ask about; the inline/eval markers do not', () => {
  assert.strictEqual(violationHost('https://api.example.com/v1/x?y=1'), 'https://api.example.com');
  assert.strictEqual(violationHost('http://127.0.0.1:9/ping'), 'http://127.0.0.1:9');
  for (const none of ['inline', 'eval', 'data', 'blob', 'about', '', null, undefined, 'wss://x.com']) {
    assert.strictEqual(violationHost(none), null, String(none));
  }
});

test('buildCsp: nothing is reachable by default, and the fixed directives never move', () => {
  const csp = buildCsp([]);
  assert.match(csp, /(^|; )default-src 'none'(;|$)/);
  assert.match(csp, /(^|; )connect-src 'none'(;|$)/);
  assert.match(csp, /(^|; )form-action 'none'(;|$)/);
  assert.match(csp, /(^|; )base-uri 'none'(;|$)/);
  assert.match(csp, /(^|; )img-src data:(;|$)/);
  assert.match(csp, /(^|; )script-src 'unsafe-inline'(;|$)/);
});

test('buildCsp: approved hosts are listed once each, in order, and invalid entries are dropped', () => {
  const csp = buildCsp(['https://a.example.com', 'b.example.com', 'https://a.example.com', 'javascript:alert(1)', '*']);
  assert.match(csp, /connect-src https:\/\/a\.example\.com https:\/\/b\.example\.com(;|$)/);
});

test('buildCsp: a non-array allow-list is an empty one', () => {
  assert.match(buildCsp(undefined), /connect-src 'none'/);
  assert.match(buildCsp('https://a.com'), /connect-src 'none'/);
});

// The property the design asks for: for ANY strings, connect-src holds only 'none' or origins that hostOrigin makes
// from the input, and the policy keeps exactly its fixed directive count (no input can add a directive).
test('property: the CSP never emits a host that is not on the allow-list, for any strings', () => {
  const noisy = fc.oneof(fc.string(), fc.webUrl(), fc.domain(), fc.constantFrom("a.com; script-src *", "x.com 'unsafe-eval'",
    '*', 'https://*.x.com', 'https://a.com\n;connect-src *', 'http://[::1]:80'));
  fc.assert(fc.property(fc.array(noisy, { maxLength: 8 }), (hosts) => {
    const csp = buildCsp(hosts);
    const parts = csp.split('; ');
    assert.strictEqual(parts.length, CSP_DIRECTIVES, 'no input may add a directive: ' + csp);
    const connect = parts.find(p => p.startsWith('connect-src '));
    const listed = connect.slice('connect-src '.length).split(' ');
    const allowed = new Set(hosts.map(hostOrigin).filter(Boolean));
    if (allowed.size === 0) return assert.deepStrictEqual(listed, ["'none'"]);
    for (const tok of listed) assert.ok(allowed.has(tok), `${tok} is not an approved host in ${csp}`);
    assert.strictEqual(listed.length, allowed.size);
  }), { numRuns: 400 });
});

test('buildSrcdoc: the host policy comes first, then the page verbatim; the page cannot precede or replace it', () => {
  const page = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>hi</body></html>';
  const doc = buildSrcdoc(page, ['https://a.example.com']);
  assert.ok(doc.startsWith('<!doctype html>'), 'a doctype first keeps the frame out of quirks mode');
  const hostMeta = doc.indexOf('Content-Security-Policy');
  assert.ok(hostMeta > 0);
  assert.ok(doc.indexOf(page) > hostMeta, "Claude's page, loose CSP included, comes after the host's");
  assert.ok(doc.includes("connect-src https://a.example.com"));
});

test('buildSrcdoc: the shim reports a blocked connection to the parent and nothing else', () => {
  const doc = buildSrcdoc('<p>x</p>', []);
  assert.match(doc, /securitypolicyviolation/);
  assert.match(doc, /canvas-need-host/);
  assert.doesNotMatch(doc, /allow-same-origin/);
});

test('buildSrcdoc: a non-string page is an empty one, never "undefined"', () => {
  assert.doesNotMatch(buildSrcdoc(undefined, []), /undefined/);
  assert.doesNotMatch(buildSrcdoc(null, []), /null/);
});
