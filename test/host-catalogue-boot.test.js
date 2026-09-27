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
  const section = HOST.slice(HOST.indexOf('const CATALOGUE_CACHE'), HOST.indexOf('const currentCatalogue') + 400);
  assert.doesNotMatch(section, /setInterval/, 'no polling timer belongs anywhere near the catalogue');
});

test('the boot fetch failure is swallowed, same as usage/agentStats -- offline at launch is not fatal', () => {
  const start = HOST.indexOf('currentCatalogue().catch(');
  assert.ok(start !== -1, 'precondition: the boot call must exist for this to mean anything');
  const line = HOST.slice(start, HOST.indexOf('\n', start));
  assert.match(line, /catch\(\(\) => \{\}\)/, 'a boot-time catalogue failure must not throw or crash the host');
});

test('the in-flight dedupe itself lives in host/catalogue-cache.js, not reimplemented inline', () => {
  // Dexter/Miguel, PR #60 review, F5/S1: the dedupe bookkeeping used to live
  // inline here, untestable, and shipped a real bug (a settling promise could
  // null the shared slot out from under a still-running one). It moved to its
  // own module so host/catalogue-cache.test.js can pin the actual behaviour;
  // this only pins that host.js still WIRES it rather than growing a second,
  // divergent copy.
  assert.match(HOST, /require\(['"]\.\/catalogue-cache['"]\)/,
    'host.js must delegate the catalogue in-flight dedupe to host/catalogue-cache.js');
  assert.match(HOST, /createCatalogueCache\(\s*\{[^}]*loadCatalogue[^}]*cacheFile[^}]*normalize[^}]*\}\s*\)/,
    'currentCatalogue must be built from createCatalogueCache, wired to loadCatalogue/normalizeCatalogue');
  assert.doesNotMatch(HOST, /let cataloguePending/,
    'the old inline pending-promise variable must be gone, not left dangling alongside the new module');
});
