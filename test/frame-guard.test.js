'use strict';
/**
 * app/frame-guard.js: which navigations a tab page's frames may make (BACKLOG #71).
 *
 * Measured in verify/probe-canvas-sandbox.js: CSP has no `navigate-to`, so an iframe that sets its own `location`
 * reaches a denied server (hits: 1) until main refuses it. The only frame navigation the app ever wants is the panel's
 * own `srcdoc` load.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { allowFrameNavigation } = require('../app/frame-guard');

test('a subframe may load its own srcdoc and nothing else', () => {
  assert.strictEqual(allowFrameNavigation({ isMainFrame: false, url: 'about:srcdoc' }), true);
  for (const url of ['https://example.com/', 'http://127.0.0.1:9/?self-nav', 'about:blank', 'data:text/html,hi',
    'javascript:alert(1)', 'file:///c:/x', 'blob:https://a.com/x', 'about:srcdoc#x', 'ABOUT:SRCDOC', 'about:srcdoc ', '']) {
    assert.strictEqual(allowFrameNavigation({ isMainFrame: false, url }), false, url);
  }
});

test("the page's own (main frame) navigation is not this guard's business", () => {
  assert.strictEqual(allowFrameNavigation({ isMainFrame: true, url: 'file:///app/renderer.html?x=1' }), true);
});

test('anything that is not clearly the main frame is treated as a subframe', () => {
  for (const d of [undefined, null, {}, { url: 'https://x.com' }, { isMainFrame: 'true', url: 'https://x.com' },
    { isMainFrame: 1, url: 'https://x.com' }, 'https://x.com', 42]) {
    assert.strictEqual(allowFrameNavigation(d), false, JSON.stringify(d));
  }
});

test('property: a subframe passes only for exactly about:srcdoc, whatever the string', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.constant('about:srcdoc')), (url) => {
    assert.strictEqual(allowFrameNavigation({ isMainFrame: false, url }), url === 'about:srcdoc');
  }), { numRuns: 500 });
});

test('main.js registers the guard on every tab view and cancels what it refuses', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const view = src.slice(src.indexOf('function createTabView('), src.indexOf('function destroyTabView('));
  assert.match(view, /wc\.on\('will-frame-navigate', \(d\) => \{\s*if \(!allowFrameNavigation\(d\)\) d\.preventDefault\(\);/);
  assert.match(src, /require\('\.\/frame-guard'\)/);
});
