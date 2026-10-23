'use strict';
/**
 * The Markdown reader's link rule (BACKLOG #119 A9): which href opens where. This is the one piece of logic in the
 * rendered view, so it is pinned example by example and by property.
 *   file    a path inside the worktree, relative to the folder of the file being read: opens in the reader
 *   http    an http(s) URL without credentials: opens in the browser (app/external-link.js is the rule)
 *   anchor  #heading: scrolls inside the page
 *   inert   everything else (mailto:, javascript:, file:, data:, absolute and drive paths, UNC, a path that climbs
 *           out of the worktree): shown dim, does nothing
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { classifyHref } = require('../app/markdown-links');

const from = 'documentation/handoffs/CURRENT.md';
const c = (href, f = from) => classifyHref(href, { fromFile: f });

test('a relative link resolves against the folder of the file being read', () => {
  assert.deepStrictEqual(c('other.md'), { kind: 'file', target: 'documentation/handoffs/other.md', fragment: '' });
  assert.deepStrictEqual(c('./other.md'), { kind: 'file', target: 'documentation/handoffs/other.md', fragment: '' });
  assert.deepStrictEqual(c('../BUILD_LOG.md#status'), { kind: 'file', target: 'documentation/BUILD_LOG.md', fragment: 'status' });
  assert.deepStrictEqual(c('../../app/main.js'), { kind: 'file', target: 'app/main.js', fragment: '' });
  assert.deepStrictEqual(c('sub/dir/x.js', 'README.md'), { kind: 'file', target: 'sub/dir/x.js', fragment: '' });
});

test('backslashes, a query string and percent-escapes are handled', () => {
  assert.strictEqual(c('..\\app\\main.js').target, 'documentation/app/main.js');
  assert.strictEqual(c('a%20b.md').target, 'documentation/handoffs/a b.md');
  assert.strictEqual(c('x.md?plain=1').target, 'documentation/handoffs/x.md');
});

test('a link that climbs out of the worktree is inert', () => {
  assert.strictEqual(c('../../../etc/passwd').kind, 'inert');
  assert.strictEqual(c('../../..').kind, 'inert');
  assert.strictEqual(c('..%2F..%2F..%2Fx.md').kind, 'inert');
  assert.strictEqual(c('a/../../../../x').kind, 'inert');
  assert.strictEqual(c('../x.md', 'README.md').kind, 'inert');
});

test('absolute, drive, UNC and rooted paths are inert', () => {
  for (const h of ['/etc/passwd', '\\windows\\win.ini', 'C:\\Users\\x.md', 'C:/Users/x.md', '\\\\server\\share\\f.md', '//server/share/f.md', 'file:///C:/x.md']) {
    assert.strictEqual(c(h).kind, 'inert', h);
  }
});

test('only http and https open outside, and not with credentials', () => {
  assert.deepStrictEqual(c('https://example.com/a?b=1#c'), { kind: 'http', target: 'https://example.com/a?b=1#c' });
  assert.strictEqual(c('http://example.com').target, 'http://example.com/');
  assert.strictEqual(c('HTTPS://EXAMPLE.com/x').kind, 'http');
  assert.strictEqual(c('https://github.com@evil.example/').kind, 'inert');
  assert.strictEqual(c('https://user:pw@example.com/').kind, 'inert');
  for (const h of ['mailto:a@b.c', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'ms-settings:', 'tel:123', 'ftp://x/y', 'blob:https://x/y']) {
    assert.strictEqual(c(h).kind, 'inert', h);
  }
});

test('control characters hide no scheme (a browser strips tabs and newlines inside one)', () => {
  for (const h of ['java\tscript:alert(1)', 'java\nscript:alert(1)', ' \u0001javascript:alert(1)', 'ja\u0000vascript:1', '\u200bjavascript:1', 'x\u0000.md', 'a\nb.md']) {
    assert.strictEqual(c(h).kind, 'inert', JSON.stringify(h));
  }
});

test('a leading space is trimmed (Markdown allows it), so a padded http link still opens', () => {
  assert.strictEqual(c('  https://example.com/  ').kind, 'http');
  assert.strictEqual(c('  other.md ').kind, 'file');
});

test('an anchor scrolls in the page; a bare # or an empty href does nothing', () => {
  assert.deepStrictEqual(c('#the-plan'), { kind: 'anchor', target: 'the-plan' });
  assert.strictEqual(c('#The%20Plan').target, 'The Plan');
  assert.strictEqual(c('#').kind, 'inert');
  assert.strictEqual(c('').kind, 'inert');
  assert.strictEqual(c('   ').kind, 'inert');
});

test('names Windows would rewrite, alternate data streams and folders are inert', () => {
  for (const h of ['x.md.', 'x.md%20', 'dir./x.md', 'dir%20/x.md', 'x.md:stream', 'folder/', '.', '..', './']) {
    assert.strictEqual(c(h).kind, 'inert', h);
  }
});

test('junk input never throws', () => {
  for (const h of [undefined, null, 5, {}, [], '%', '%zz', '%E0%A4%A', 'a'.repeat(20000)]) {
    assert.strictEqual(c(h).kind, 'inert');
  }
  assert.strictEqual(classifyHref('x.md').kind, 'inert', 'no file to resolve against');
  assert.strictEqual(classifyHref('x.md', { fromFile: '' }).kind, 'inert');
});

// ---- properties ----

const SCHEMES = fc.stringMatching(/^[A-Za-z][A-Za-z0-9+.-]{0,12}$/).filter((s) => !/^https?$/i.test(s));

test('PROPERTY: any href whose scheme is not http/https is inert', () => {
  fc.assert(fc.property(SCHEMES, fc.string({ maxLength: 40 }), (scheme, rest) => {
    assert.strictEqual(c(`${scheme}:${rest}`).kind, 'inert');
  }), { numRuns: 500 });
});

const SEG = fc.constantFrom('a', 'b', 'dir', '..', '..', '.', 'x.md', '%2e%2e', '%2E', 'c d');
test('PROPERTY: a relative link never resolves outside the worktree root', () => {
  fc.assert(fc.property(fc.array(SEG, { minLength: 1, maxLength: 9 }), fc.constantFrom('/', '\\'), fc.constantFrom('a.md', 'documentation/x/y.md', 'deep/er/than/that/z.md'), (segs, sep, file) => {
    const r = c(segs.join(sep), file);
    if (r.kind !== 'file') return;
    const parts = r.target.split('/');
    assert.ok(!parts.includes('..') && !parts.includes('.') && !parts.includes(''), r.target);
    assert.ok(!r.target.startsWith('/') && !/^[A-Za-z]:/.test(r.target) && !r.target.includes('\\'), r.target);
  }), { numRuns: 1000 });
});

test('PROPERTY: whatever the input, the result has a known kind, and only http targets are URLs', () => {
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 60 }), fc.string({ unit: 'binary', maxLength: 30 }), fc.webUrl()), (h) => {
    const r = c(h);
    assert.ok(['file', 'http', 'anchor', 'inert'].includes(r.kind));
    if (r.kind === 'http') {
      const u = new URL(r.target);
      assert.ok(u.protocol === 'http:' || u.protocol === 'https:');
      assert.strictEqual(u.username + u.password, '');
    }
    if (r.kind === 'file') assert.ok(!/[\u0000-\u001f\u007f:]/.test(r.target));
  }), { numRuns: 1000 });
});
