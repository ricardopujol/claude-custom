'use strict';
/**
 * app/preview-guard.js: the Preview panel's one URL rule (BACKLOG #119 A4). Loopback http only, an explicit port in 1-65535,
 * no credentials. The properties run it over random hosts, ports and schemes: whatever the input, an accepted URL names one of
 * three loopback hosts, and nothing else is ever accepted.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const guard = require('../app/preview-guard');

test('the three loopback hosts are accepted with a port', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const r = guard.previewUrl(`http://${host}:3000/`);
    assert.strictEqual(r.ok, true, host);
    assert.strictEqual(r.url, `http://${host}:3000/`);
    assert.strictEqual(r.port, 3000);
  }
});

test('a missing port means port 80, spelled out the way the URL class would', () => {
  const r = guard.previewUrl('http://localhost/');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.port, 80);
});

test('https is refused: a dev server on loopback is plain http, and the rule has one scheme', () => {
  assert.strictEqual(guard.previewUrl('https://localhost:3000/').ok, false);
});

test('other hosts are refused, including look-alikes', () => {
  for (const u of [
    'http://example.com:3000/', 'http://127.0.0.1.evil.example:3000/', 'http://localhost.evil.example:3000/', 'http://localhost.:3000/',
    'http://evil.example/@127.0.0.1:3000/', 'http://192.168.1.5:3000/', 'http://0.0.0.0:3000/', 'http://[::]:3000/', 'http://[::ffff:8.8.8.8]:3000/',
    'http://10.0.0.1:3000/', 'http://127.0.0.1@evil.example:3000/',
  ]) assert.strictEqual(guard.previewUrl(u).ok, false, u);
});

test('credentials in the URL are refused', () => {
  assert.strictEqual(guard.previewUrl('http://user:pw@localhost:3000/').ok, false);
  assert.strictEqual(guard.previewUrl('http://user@localhost:3000/').ok, false);
});

test('other schemes are refused', () => {
  for (const u of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://localhost:21/', 'ws://localhost:3000/', 'about:blank', 'view-source:http://localhost:3000/', 'blob:http://localhost:3000/x']) {
    assert.strictEqual(guard.previewUrl(u).ok, false, u);
  }
});

test('junk is refused, never thrown on', () => {
  for (const v of [null, undefined, 42, {}, [], '', '   ', 'http://', 'not a url', 'x'.repeat(20000)]) assert.strictEqual(guard.previewUrl(v).ok, false);
});

test('a refusal carries a reason', () => {
  const r = guard.previewUrl('http://example.com:3000/');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

test('port 0 and 65536 are refused, 1 and 65535 are accepted', () => {
  assert.strictEqual(guard.previewUrl('http://localhost:0/').ok, false);
  assert.strictEqual(guard.previewUrl('http://localhost:65536/').ok, false);
  assert.strictEqual(guard.previewUrl('http://localhost:1/').ok, true);
  assert.strictEqual(guard.previewUrl('http://localhost:65535/').ok, true);
});

test('typed shorthand: a bare port, :port, host:port and a full URL all land on http://<host>:<port>/', () => {
  assert.strictEqual(guard.fromTyped('3000').url, 'http://localhost:3000/');
  assert.strictEqual(guard.fromTyped(':3000').url, 'http://localhost:3000/');
  assert.strictEqual(guard.fromTyped('localhost:3000/app').url, 'http://localhost:3000/app');
  assert.strictEqual(guard.fromTyped('127.0.0.1:8080').url, 'http://127.0.0.1:8080/');
  assert.strictEqual(guard.fromTyped('  http://localhost:5173/x?y=1  ').url, 'http://localhost:5173/x?y=1');
  assert.strictEqual(guard.fromTyped('example.com').ok, false);
  assert.strictEqual(guard.fromTyped('example.com:3000').ok, false);
  assert.strictEqual(guard.fromTyped('0').ok, false);
  assert.strictEqual(guard.fromTyped('99999').ok, false);
});

test('forPort builds the loopback URL for a listening port, and refuses a bad port', () => {
  assert.strictEqual(guard.forPort(20003).url, 'http://localhost:20003/');
  for (const p of [0, -1, 65536, 1.5, NaN, '3000', null, undefined]) assert.strictEqual(guard.forPort(p).ok, false, String(p));
});

test('blockedLabel names the host the page reached for, short and plain', () => {
  assert.strictEqual(guard.blockedLabel('https://example.com/a/b?c=1'), 'blocked: example.com');
  assert.strictEqual(guard.blockedLabel('file:///C:/secret.txt'), 'blocked: a file address');
  assert.strictEqual(guard.blockedLabel('javascript:alert(1)'), 'blocked: a javascript: address');
  assert.strictEqual(guard.blockedLabel('nonsense'), 'blocked: an address that is not a web address');
  assert.ok(guard.blockedLabel('http://' + 'a'.repeat(500) + '.example/').length <= 80);
  assert.doesNotMatch(guard.blockedLabel('http://user:secret@example.com/'), /secret/);
});

test('typedLabel names what a typed address reached for, the way blockedLabel does for a page', () => {
  assert.strictEqual(guard.typedLabel('example.com'), 'blocked: example.com');
  assert.strictEqual(guard.typedLabel('example.com:8080/x'), 'blocked: example.com');
  assert.strictEqual(guard.typedLabel('https://example.com/a'), 'blocked: example.com');
  assert.strictEqual(guard.typedLabel('javascript:alert(1)'), 'blocked: a javascript: address');
  assert.strictEqual(guard.typedLabel('file:///C:/x'), 'blocked: a file address');
  assert.strictEqual(guard.typedLabel('99999'), 'blocked: a port that is not 1-65535');
  assert.strictEqual(guard.typedLabel('0'), 'blocked: a port that is not 1-65535');
  assert.strictEqual(guard.typedLabel(''), 'blocked: an address that is not a web address');
  assert.strictEqual(guard.typedLabel(5), 'blocked: an address that is not a web address');
  assert.doesNotMatch(guard.typedLabel('user:secret@example.com'), /secret/);
});

test('openExternalTarget: only http(s), through the shared external-link rule', () => {
  assert.strictEqual(guard.openExternalTarget('http://localhost:3000/'), 'http://localhost:3000/');
  assert.strictEqual(guard.openExternalTarget('file:///C:/x'), null);
  assert.strictEqual(guard.openExternalTarget('ms-settings:'), null);
});

// ---- properties -----------------------------------------------------------------------------------------------------------

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

test('property: any accepted URL names a loopback host, http, and a port in range', () => {
  fc.assert(fc.property(fc.webUrl({ validSchemes: ['http', 'https', 'ftp'], withQueryParameters: true, withFragments: true }), (u) => {
    const r = guard.previewUrl(u);
    if (r.ok) {
      const parsed = new URL(r.url);
      assert.strictEqual(parsed.protocol, 'http:');
      assert.ok(LOOPBACK.includes(parsed.hostname));
      assert.ok(r.port >= 1 && r.port <= 65535);
    }
    return true;
  }), { numRuns: 500 });
});

test('property: a random non-loopback host is never accepted, whatever port and path', () => {
  const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
  const host = fc.array(label, { minLength: 1, maxLength: 4 }).map(a => a.join('.')).filter(h => h !== 'localhost');
  fc.assert(fc.property(host, fc.integer({ min: 1, max: 65535 }), fc.stringMatching(/^[a-z0-9/]{0,12}$/), (h, port, path) => {
    return guard.previewUrl(`http://${h}:${port}/${path}`).ok === false;
  }), { numRuns: 500 });
});

test('property: a loopback host with any port in 1-65535 is accepted, and any other port (or one of the app own ports 7700-7799) refused', () => {
  fc.assert(fc.property(fc.constantFrom(...LOOPBACK), fc.integer({ min: -10, max: 70000 }), (host, port) => {
    const r = guard.previewUrl(`http://${host}:${port}/`);
    return r.ok === (port >= 1 && port <= 65535 && !(port >= 7700 && port < 7800));
  }), { numRuns: 500 });
});

test('property: the accepted URL is a fixed point (checking it again gives it back)', () => {
  fc.assert(fc.property(fc.constantFrom(...LOOPBACK), fc.integer({ min: 7800, max: 65535 }), fc.stringMatching(/^[a-zA-Z0-9/._~-]{0,16}$/), (host, port, path) => {
    const first = guard.previewUrl(`http://${host}:${port}/${path}`);
    assert.strictEqual(first.ok, true);
    const second = guard.previewUrl(first.url);
    return second.ok === true && second.url === first.url;
  }), { numRuns: 300 });
});

test('property: nothing but http is accepted, whatever the scheme', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9+.-]{0,10}$/).filter(s => s !== 'http'), (scheme) => {
    return guard.previewUrl(`${scheme}://localhost:3000/`).ok === false;
  }), { numRuns: 300 });
});

test('property: previewUrl and blockedLabel never throw on any string', () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
    guard.previewUrl(s); guard.fromTyped(s); guard.blockedLabel(s);
    return true;
  }), { numRuns: 500 });
});

// ---- what the panel's page may request (the session filter, behind the navigation rule) ----------------------------------------

test('requestAllowed: loopback http and ws on any port, plus the page-internal data: and blob:', () => {
  for (const u of ['http://localhost:3000/a.js', 'http://127.0.0.1:1/', 'http://[::1]:65535/x', 'ws://localhost:3000/hmr', 'ws://127.0.0.1:24678/', 'data:image/png;base64,AAA', 'blob:http://localhost:3000/1234', 'devtools://devtools/bundled/x.js']) {
    assert.strictEqual(guard.requestAllowed(u), true, u);
  }
});

test('requestAllowed: everything that leaves this computer is refused, including by IP literal (no DNS needed to reach it)', () => {
  for (const u of ['https://example.com/', 'http://example.com/', 'http://8.8.8.8/', 'http://[2001:db8::1]/', 'ws://example.com/', 'wss://localhost:3000/', 'https://localhost:3000/', 'ftp://localhost/', 'file:///C:/x', 'about:blank', 'chrome://gpu', 'http://localhost.evil.example/', 'http://user:pw@localhost:3000/', '', 'nonsense', null, undefined, 7]) {
    assert.strictEqual(guard.requestAllowed(u), false, String(u));
  }
});

test('property: requestAllowed accepts a http/ws URL iff its host is one of the three loopback names', () => {
  const host = fc.oneof(fc.constantFrom(...LOOPBACK), fc.stringMatching(/^[a-z][a-z0-9-]{0,8}(\.[a-z]{2,5}){1,2}$/));
  fc.assert(fc.property(fc.constantFrom('http', 'ws'), host, fc.integer({ min: 7800, max: 65535 }), (scheme, h, port) => {
    return guard.requestAllowed(`${scheme}://${h}:${port}/x`) === LOOPBACK.includes(h);
  }), { numRuns: 500 });
});

test('property: requestAllowed never throws', () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => { guard.requestAllowed(s); return true; }), { numRuns: 300 });
});

// ---- PR #198 fix pass ------------------------------------------------------------------------------------------------------------

test('the app\'s own ports are refused by navigation, request and label, and extra ports can be named (Miguel Y3)', () => {
  for (const p of [7700, 7750, 7799]) {
    assert.strictEqual(guard.previewUrl(`http://localhost:${p}/`).ok, false, String(p));
    assert.strictEqual(guard.requestAllowed(`http://127.0.0.1:${p}/x`), false, String(p));
    assert.strictEqual(guard.requestAllowed(`ws://localhost:${p}/`), false, String(p));
    assert.strictEqual(guard.blockedLabel(`http://localhost:${p}/`), 'blocked: a port this app uses');
  }
  for (const p of [7699, 7800]) assert.strictEqual(guard.requestAllowed(`http://localhost:${p}/`), true, String(p));
  assert.strictEqual(guard.requestAllowed('http://localhost:4321/', { denyPorts: [4321] }), false);
  assert.strictEqual(guard.previewUrl('http://localhost:4321/', { denyPorts: [4321] }).ok, false);
  assert.strictEqual(guard.requestAllowed('blob:http://localhost:7701/abc'), false);
});

test('long loopback addresses are allowed up to 32768 and cut with a reason beyond it (Dexter 5)', () => {
  assert.strictEqual(guard.MAX_LENGTH, 32768);
  assert.strictEqual(guard.previewUrl('http://localhost:3000/?q=' + 'x'.repeat(9000)).ok, true);
  assert.strictEqual(guard.requestAllowed('http://localhost:3000/api?q=' + 'x'.repeat(9000)), true);
  const long = 'http://localhost:3000/api?q=' + 'x'.repeat(33000);
  assert.deepStrictEqual(guard.requestVerdict(long), { ok: false, tooLong: true });
  assert.deepStrictEqual(guard.requestVerdict('https://example.com/'), { ok: false });
  assert.match(guard.blockedLabel(long), /longer than 32768 characters/);
});

test('one frame rule: loopback pages, blob: of the loopback origin, data: and srcdoc/blank pass; other sites, files and foreign blobs do not (Dexter 2 / Miguel Y4)', () => {
  for (const u of ['http://localhost:3000/frame', 'blob:http://localhost:3000/abc-123', 'blob:http://127.0.0.1:3000/x', 'data:text/html,<p>hi</p>', 'about:srcdoc', 'about:blank']) {
    assert.strictEqual(guard.frameAllowed(u), true, u);
  }
  for (const u of ['https://example.com/', 'http://example.com/', 'file:///C:/x', 'blob:https://example.com/abc', 'blob:http://localhost.evil.example/x', 'javascript:alert(1)', 'about:config', 'http://localhost:7701/', '', null, 5]) {
    assert.strictEqual(guard.frameAllowed(u), false, String(u));
  }
});

test('property: the frame rule never allows more than the request filter plus srcdoc/blank and loopback pages', () => {
  fc.assert(fc.property(fc.oneof(fc.webUrl(), fc.string({ maxLength: 60 })), (u) => {
    return !guard.frameAllowed(u) || guard.requestAllowed(u) || guard.previewUrl(u).ok || u === 'about:srcdoc' || u === 'about:blank';
  }), { numRuns: 500 });
});
