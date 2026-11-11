'use strict';
/**
 * Which tests may read app/main.js RAW (a facts-about-main's-own-top-level pin), and which must go through test/main-source.js.
 *
 * Since the per-project code moved into app/project-window.js, a test that reads only main.js and pins "X is absent" (or scans
 * "every Y") silently passes for the code that moved. The next PR moves more out of main, so the readers are an allow-list:
 * each entry below was checked to pin a fact that stays in main.js (app-wide code, main's own top-level, or a negative scan that
 * is also run over both files elsewhere). A new reader fails here until someone adds it, with the reason, or switches to
 * mainProcessSource() / mainOnly() from test/main-source.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ALLOWED = new Set([
  'bridge-contract.test.js',                // createSecretService's project (main's own registerIpc)
  'cache-dirs.test.js',                     // useOwnCaches, main's top-level
  'cc-mod-style-wiring.test.js',            // app-wide settings handlers
  'clipboard-bridge.test.js',               // app-wide bridge registration
  'favourites-bridge.test.js',              // app-wide bridge registration
  'fonts-bridge.test.js',                   // app-wide bridge registration
  'global-propagation-wiring.test.js',      // app-wide watchers
  'main-shell-wiring.test.js',              // one raw read: the comment before tab:raise
  'project-layout-store.test.js',           // registerIpc's layout store
  'renderer-backgrounding-wiring.test.js',  // a switch at main's top level
  'renderer-games-wiring.test.js',          // app-wide games handlers
  'renderer-resources-viewing-wiring.test.js', // app-wide resources handlers
  'source-contracts.test.js',               // handlers in main (tab:repo*, tab:readerDirty), createVault
  'tab-shell-merged.test.js',               // the tab:boxState handler
  'usage-counters.test.js',                 // the usage counters' construction
]);
const SELF = new Set(['main-source.js', 'main-raw-readers.test.js']);

// A string that is exactly a main.js path ('main.js', 'app/main.js', '../app/main.js'): the argument of whatever reads it.
const READS_MAIN = /['"`](?:\.\.\/)?(?:app\/)?main\.js['"`]/;
// ...on a line that also calls a reader (read(..), readFileSync(..), a test's own app('main.js') helper, path.join(..)): a fixture string isn't a read.
const READS_CALL = /(?:\bread\w*|\bapp|\bjoin)\(/;
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

test('only the listed tests read app/main.js raw; every other one goes through test/main-source.js', () => {
  const dir = __dirname;
  const readers = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || SELF.has(f)) continue;
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (src.split('\n').some((line) => READS_MAIN.test(line) && READS_CALL.test(line))) readers.push(f);
  }
  assert.ok(readers.length >= 10, `the scan finds the readers (${readers.length})`);
  const unlisted = readers.filter((f) => !ALLOWED.has(f));
  assert.deepStrictEqual(unlisted, [], 'read app/main.js through mainProcessSource() / mainOnly() (test/main-source.js), or add the file to ALLOWED with the reason');
  const stale = [...ALLOWED].filter((f) => !readers.includes(f));
  assert.deepStrictEqual(stale, [], 'these are allowed but no longer read main.js raw: remove them from ALLOWED');
});
