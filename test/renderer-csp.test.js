'use strict';
/**
 * BACKLOG #56: the tab page (app/renderer.html) carries a Content-Security-Policy. This pins the policy's shape.
 * It cannot prove the page still works under it -- a blocked resource is a console message, not a test failure --
 * so verify/probe-csp-violations.js loads the real page in a real window and counts the violations.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

function policy() {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i);
  assert.ok(m, 'renderer.html must carry a <meta http-equiv="Content-Security-Policy">');
  const out = new Map();
  for (const part of m[1].split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    out.set(name, values);
  }
  return out;
}

test('the policy is in the head, before any script or stylesheet loads', () => {
  const meta = html.search(/http-equiv="Content-Security-Policy"/i);
  assert.ok(meta > 0);
  assert.ok(meta < html.search(/<link /i), 'the meta must precede the first <link>');
  assert.ok(meta < html.search(/<style/i), 'the meta must precede the <style> block');
  assert.ok(meta < html.search(/<script/i), 'the meta must precede the first <script>');
});

test('script-src admits our own files only: no unsafe-inline, no unsafe-eval, no wildcard', () => {
  const src = policy().get('script-src');
  assert.deepStrictEqual(src, ["'self'"]);
});

test('no directive allows eval or a bare wildcard', () => {
  for (const [name, values] of policy()) {
    assert.ok(!values.includes("'unsafe-eval'"), `${name} must not allow unsafe-eval`);
    assert.ok(!values.includes('*'), `${name} must not be a bare wildcard`);
    assert.ok(!values.includes('http:') && !values.includes('https:'), `${name} must not open the web`);
  }
});

test('plugins and <base> are shut, and everything else defaults to self', () => {
  const p = policy();
  assert.deepStrictEqual(p.get('default-src'), ["'self'"]);
  assert.deepStrictEqual(p.get('object-src'), ["'none'"]);
  assert.deepStrictEqual(p.get('base-uri'), ["'none'"]);
  assert.deepStrictEqual(p.get('form-action'), ["'none'"]);
});

test('no frames, workers or manifests: none exist in app/, and on a file: page self would admit any file:/// one', () => {
  const p = policy();
  for (const name of ['frame-src', 'worker-src', 'manifest-src']) {
    assert.deepStrictEqual(p.get(name), ["'none'"], `${name} must be 'none'`);
  }
});

test('only the directives this test knows about are present (a new one is a deliberate edit here)', () => {
  const known = ['default-src', 'script-src', 'style-src', 'connect-src', 'object-src', 'base-uri', 'form-action',
    'frame-src', 'worker-src', 'manifest-src', 'img-src', 'media-src', 'font-src'];
  for (const name of policy().keys()) assert.ok(known.includes(name), `unexpected directive ${name}`);
});

test('the only network the page may open is the local WebSocket to the host', () => {
  const connect = policy().get('connect-src');
  assert.deepStrictEqual(connect, ['ws://127.0.0.1:*']);
});

test('the page has no inline script and no inline event handler', () => {
  const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1]));
  assert.deepStrictEqual(inline.map((m) => m[0]), [], 'every <script> must have a src');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<style[\s\S]*?<\/style>/gi, '')), 'no on*= handler attributes');
  assert.ok(!/javascript:/i.test(html), 'no javascript: URLs');
});

test('local media (file:/// backgrounds and portraits) needs no widening: img and media stay on self', () => {
  // Measured (verify/probe-csp-violations.js): 'self' on a file: page matches file:/// URLs, UNC paths included, so a
  // `file:` source would only be a wider door than the page uses. Absent (default-src 'self') or exactly 'self'.
  const p = policy();
  for (const name of ['img-src', 'media-src', 'font-src']) {
    const v = p.get(name);
    assert.ok(v === undefined || (v.length === 1 && v[0] === "'self'"), `${name} must stay on 'self' (got ${v && v.join(' ')})`);
  }
});

test("styles keep unsafe-inline (the page's own <style>, style attributes, xterm and CodeMirror), and only styles do", () => {
  const p = policy();
  assert.deepStrictEqual(p.get('style-src'), ["'self'", "'unsafe-inline'"]);
  for (const [name, values] of p) {
    if (name !== 'style-src') assert.ok(!values.includes("'unsafe-inline'"), `${name} must not allow unsafe-inline`);
  }
});
