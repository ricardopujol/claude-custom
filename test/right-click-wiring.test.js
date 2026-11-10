'use strict';
// Wiring of app/right-click-guard.js (BACKLOG #194). Not in stryker's command: it reads the filter's page and renderer.js as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test("renderer.js no longer intercepts any mouse event in the page for this (no capture listener, no stopPropagation on #term)", () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.ok(!/installRightClickGuard/.test(js));
});

test('the page loads the filter before renderer.js and renderer.js drops reports on BOTH of xterm\'s send paths, off for shell tabs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.ok(html.indexOf('right-click-guard.js') > 0 && html.indexOf('right-click-guard.js') < html.indexOf('src="./renderer.js"'));
  assert.match(js, /createRightClickFilter\(\(\) => hostKind !== 'shell'\)/);
  assert.match(js, /term\.onData\(\(data\) => \{\s*if \(rightClickFilter\.drop\(data\)\) return;/);
  assert.match(js, /term\.onBinary\(\(data\) => \{\s*if \(rightClickFilter\.drop\(data\)\) return;/);
  assert.ok(!/installRightClickGuard/.test(js));
});
