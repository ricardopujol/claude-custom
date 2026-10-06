'use strict';
/**
 * app/canvas-csp.js: the page Claude wrote for its panel, wrapped in the host's policy (BACKLOG #71).
 *
 * The page is untrusted. Its CSP is the first wall: nothing may be loaded or connected to (connect-src 'none'), because the
 * panel's `fetch` is a message to main (app/canvas-fetch.js), where the approved-host check lives. The policy goes
 * BEFORE the page, so a looser <meta> the page adds can't loosen it. That Chromium enforces what is built here is shown,
 * in a real window, by verify/probe-canvas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { hostOrigin, buildCsp, buildPage, PANEL_SHIM, CSP_DIRECTIVES } = require('../app/canvas-csp');

test('hostOrigin: a bare host is https, an explicit scheme and port are kept, case is folded', () => {
  assert.strictEqual(hostOrigin('api.open-meteo.com'), 'https://api.open-meteo.com');
  assert.strictEqual(hostOrigin('HTTPS://API.Open-Meteo.com/v1/forecast?x=1'), 'https://api.open-meteo.com');
  assert.strictEqual(hostOrigin('http://127.0.0.1:8080/path'), 'http://127.0.0.1:8080');
  assert.strictEqual(hostOrigin('https://example.com:443/'), 'https://example.com');
});

test('hostOrigin: anything that is not a plain http(s) host is refused', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,hi',
    'file:///c:/x', 'https://user:pw@example.com', 'https://*.example.com', '*', 'https://a.com; script-src *',
    'https://a.com b.com', "https://a.com'", 'https://', 'https://exa mple.com', 'about:srcdoc', 'blob:https://a.com/x']) {
    assert.strictEqual(hostOrigin(bad), null, JSON.stringify(bad));
  }
});

test('property: an origin is only ever scheme://host[:port], whatever the input', () => {
  const noisy = fc.oneof(fc.string(), fc.webUrl(), fc.domain(), fc.constantFrom('a.com; script-src *', "x.com 'unsafe-eval'", '*',
    'https://*.x.com', 'https://a.com\n;connect-src *', 'http://[::1]:80'));
  fc.assert(fc.property(noisy, (s) => {
    const o = hostOrigin(s);
    if (o !== null) assert.match(o, /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d+)?$/);
  }), { numRuns: 500 });
});

test('buildCsp: nothing is loadable or connectable, and the fixed directives never move', () => {
  const csp = buildCsp();
  const parts = csp.split('; ');
  assert.strictEqual(parts.length, CSP_DIRECTIVES);
  for (const want of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data:', 'font-src data:',
    "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(parts.includes(want), want);
  assert.doesNotMatch(csp, /https?:/);
});

test('buildPage: the host policy comes first, then the page verbatim; the page cannot precede or replace it', () => {
  const page = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *"></head><body>hi</body></html>';
  const doc = buildPage(page);
  assert.ok(doc.startsWith('<!doctype html>'), 'a doctype first keeps the page out of quirks mode');
  const hostMeta = doc.indexOf('Content-Security-Policy');
  assert.ok(hostMeta > 0);
  assert.ok(doc.indexOf(page) > hostMeta, "Claude's page, loose CSP included, comes after the host's");
});

test('buildPage: the shim is in the head, before the page, and the page is the last thing in the document', () => {
  const doc = buildPage('<p id="x">hello</p>');
  assert.ok(doc.indexOf(PANEL_SHIM) > 0);
  assert.ok(doc.indexOf(PANEL_SHIM) < doc.indexOf('<p id="x">'));
  assert.ok(doc.endsWith('<p id="x">hello</p>'));
});

test('the shim routes fetch through the panel bridge', () => {
  assert.match(PANEL_SHIM, /window\.claudePanel/);
  assert.match(PANEL_SHIM, /window\.fetch\s*=/);
  assert.doesNotMatch(PANEL_SHIM, /<\/script/i, 'a closing tag would end the shim early');
});

test('buildPage: a non-string page is an empty one, never "undefined"', () => {
  assert.ok(buildPage(undefined).endsWith('</head><body>'));
  assert.ok(buildPage(null).endsWith('</head><body>'));
});

test("buildPage: a page that tries to close our script is after the shim's own closing tag", () => {
  const doc = buildPage('</script><script>window.fetch = 1</script>');
  assert.ok(doc.indexOf('</script>') < doc.indexOf('window.fetch = 1'));
  assert.strictEqual(doc.split(PANEL_SHIM).length, 2);
});

// ---- the shim, run for real in a vm (PR #122 Miguel Y3): the tests above read its text, these run it ------------------------------------

const vm = require('node:vm');

function pageWith(answer) {
  const calls = [];
  const ctx = { Response, Request, atob, Uint8Array, TypeError, Promise, Object, Array, String, claudePanel: { fetch: (url, init) => { calls.push({ url, init }); return typeof answer === 'function' ? answer(url, init) : Promise.resolve(answer); } } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(PANEL_SHIM, ctx);
  return { fetch: (...a) => vm.runInContext('window.fetch', ctx)(...a), calls, ctx };
}
const settles = (p) => Promise.race([p.then(() => 'resolved', (e) => 'rejected:' + (e && e.constructor && e.constructor.name)), new Promise(r => setTimeout(() => r('HUNG'), 300))]);
const good = { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, bodyBase64: Buffer.from('pong').toString('base64') };

test('the shim: an answer from main becomes a real Response with the status, headers and body', async () => {
  const p = pageWith(good);
  const res = await p.fetch('https://a.example.com/x', { method: 'POST', body: 'b', headers: { 'X-A': '1' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'text/plain');
  assert.strictEqual(await res.text(), 'pong');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.calls[0])), { url: 'https://a.example.com/x', init: { method: 'POST', headers: { 'X-A': '1' }, body: 'b' } });
});

test('the shim: a response the Response class refuses rejects the fetch, it does not leave it pending forever', async () => {
  for (const bad of [{ ...good, status: 600 }, { ...good, status: 99 }, { ...good, status: 1000 }, { ...good, statusText: 'bad\nstatus' }, { ...good, headers: { 'bad name': 'x' } },
    { ...good, headers: { 'x-a': 'line\nbreak' } }, { ...good, bodyBase64: '%%%' }]) {
    const out = await settles(pageWith(bad).fetch('https://a.example.com/'));
    assert.match(out, /^rejected:/, JSON.stringify(bad).slice(0, 80));
  }
});

test('the shim: a refusal or a failure from main is a TypeError, and a non-string body never reaches main', async () => {
  assert.strictEqual(await settles(pageWith({ ok: false, error: 'not allowed' }).fetch('https://a.example.com/')), 'rejected:TypeError');
  assert.strictEqual(await settles(pageWith(() => Promise.reject(new Error('gone'))).fetch('https://a.example.com/')), 'rejected:TypeError');
  assert.strictEqual(await settles(pageWith(() => { throw new Error('sync'); }).fetch('https://a.example.com/')), 'rejected:Error');
  const p = pageWith(good);
  assert.strictEqual(await settles(p.fetch('https://a.example.com/', { method: 'POST', body: new Uint8Array(2) })), 'rejected:TypeError');
  assert.strictEqual(p.calls.length, 0);
});

test('the shim: a 204 has no body', async () => {
  const res = await pageWith({ ...good, status: 204, bodyBase64: '' }).fetch('https://a.example.com/');
  assert.strictEqual(res.status, 204);
  assert.strictEqual(await res.text(), '');
});
