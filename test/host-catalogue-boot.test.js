'use strict';
/**
 * The OpenRouter catalogue is warmed once at boot (BACKLOG E #5, step 2).
 *
 * SOURCE assertions, same reasoning as test/host-listen.test.js: host.js is
 * ~1300 lines of module-level wiring that cannot be required in a unit test
 * without spawning a pty. These are coarse, and they are what fails when the
 * boot warm-up is deleted, or grows into the interval timer the spec
 * explicitly forbids. verify/probe-models.js exercises the real behaviour
 * end to end.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the catalogue is fetched once at boot, at module level (not inside a request handler)', () => {
  // "At module level" is the point: this must run once, when the host
  // process starts, not only in response to a client's 'models' message.
  const bootLine = /^currentCatalogue\(\)\.catch\(/m;
  assert.ok(bootLine.test(HOST),
    'host.js must call currentCatalogue() unconditionally at boot, at column 0 (module scope)');
});

test('the boot warm-up is a single call, never an interval timer', () => {
  // The spec is explicit: "NO interval timer." A setInterval anywhere near
  // the catalogue would silently reintroduce a background poll.
  const section = HOST.slice(HOST.indexOf('const CATALOGUE_CACHE'), HOST.indexOf('function currentCatalogue') + 400);
  assert.doesNotMatch(section, /setInterval/, 'no polling timer belongs anywhere near the catalogue');
});

test('the boot fetch failure is swallowed, same as usage/agentStats -- offline at launch is not fatal', () => {
  const start = HOST.indexOf('currentCatalogue().catch(');
  assert.ok(start !== -1, 'precondition: the boot call must exist for this to mean anything');
  const line = HOST.slice(start, HOST.indexOf('\n', start));
  assert.match(line, /catch\(\(\) => \{\}\)/, 'a boot-time catalogue failure must not throw or crash the host');
});

test('currentCatalogue still dedupes: a tab opened while the boot fetch is in flight reuses it', () => {
  // Not a NEW property (loadCatalogue.test.js covers loadCatalogue itself),
  // but a regression this boot call could break if `force` defaulted wrong.
  const fn = HOST.slice(HOST.indexOf('function currentCatalogue'), HOST.indexOf('function currentCatalogue') + 300);
  assert.match(fn, /if \(cataloguePending && !force\) return cataloguePending;/,
    'the boot warm-up must share the same in-flight promise a tab-open request would reuse');
});
