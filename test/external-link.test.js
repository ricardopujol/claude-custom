'use strict';
/**
 * What a link clicked in the terminal may open in the person's browser
 * (fix/terminal-links). Only http(s). Everything else -- above all the
 * `about:blank` xterm's own default handler produced, which Windows has no app
 * for -- is refused rather than handed to the OS.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { externalUrl } = require('../app/external-link');

test('an http or https link is opened, normalised', () => {
  assert.strictEqual(externalUrl('https://claude.ai/code/artifact/abc'), 'https://claude.ai/code/artifact/abc');
  assert.strictEqual(externalUrl('http://localhost:5173/'), 'http://localhost:5173/');
  assert.strictEqual(externalUrl('  https://github.com/ricardopujol/claude-custom/pull/80  '),
    'https://github.com/ricardopujol/claude-custom/pull/80');
  assert.strictEqual(externalUrl('HTTPS://Example.com/a b'), 'https://example.com/a%20b');
});

test('about:blank -- what the default handler sent -- is never opened', () => {
  assert.strictEqual(externalUrl('about:blank'), null);
});

test('no other scheme reaches the OS', () => {
  for (const u of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy',
    'data:text/html,<b>x</b>', 'vbscript:x', 'mailto:a@b.c', 'C:\\Windows\\notepad.exe', '\\\\server\\share',
    'ftp://example.com/', 'chrome://settings']) {
    assert.strictEqual(externalUrl(u), null, u);
  }
});

test('nothing usable is null, never a throw', () => {
  for (const u of [null, undefined, '', '   ', 42, {}, 'not a url', 'https://', 'http:// spaces']) {
    assert.strictEqual(externalUrl(u), null, String(u));
  }
});

test('Miguel #2: a link with credentials in it is refused (https://github.com@evil.example reads as GitHub)', () => {
  for (const u of ['https://github.com@evil.example/login', 'https://user:pass@example.com/', 'http://a:@example.com/',
    'https://:p@example.com/']) {
    assert.strictEqual(externalUrl(u), null, u);
  }
});

test('an absurdly long link is refused', () => {
  assert.strictEqual(externalUrl(`https://example.com/${'a'.repeat(9000)}`), null);
});

test('Dexter F3 (PR #81): the cap holds for the NORMALISED link too (percent-encoding can grow it 9x)', () => {
  const u = `https://a.example/${String.fromCharCode(0x20ac).repeat(1000)}`;    // 1018 chars in, 9018 out
  assert.ok(u.length < 8192);
  assert.strictEqual(externalUrl(u), null);
});

test('Miguel #7 PROPERTY: an accepted link is accepted again unchanged (normalising is idempotent)', () => {
  fc.assert(fc.property(fc.oneof(fc.webUrl(), fc.string()), (u) => {
    const once = externalUrl(u);
    return once === null || externalUrl(once) === once;
  }), { numRuns: 500 });
});

test('PROPERTY: whatever comes in, what goes out is null or an http(s) URL', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.constantFrom('about:blank', 'file:///x', 'javascript:1')), (u) => {
    const out = externalUrl(u);
    return out === null || /^https?:\/\//.test(out);
  }), { numRuns: 500 });
});
