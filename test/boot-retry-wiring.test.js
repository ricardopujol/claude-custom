'use strict';
// BACKLOG #217: host/host.js uses host/boot-retry.js on the claude spawn, and only there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const startSession = host.slice(host.indexOf('function startSession()'), host.indexOf('// --- attach surface'));
const retryFn = host.slice(host.indexOf('function retrySpawnLater'), host.indexOf('function startSession()'));

test('the host requires the retry decision from host/boot-retry', () => {
  assert.match(host, /require\('\.\/boot-retry'\)/);
});

test('the claude spawn (not the shell one) is wrapped: a failure goes to retrySpawnLater and is rethrown when it is not ours', () => {
  assert.match(startSession, /try \{\s*term = spawnTimed\(\);\s*\} catch \(err\) \{\s*if \(!retrySpawnLater\(err\)\) throw err;\s*return;\s*\}/);
  assert.match(startSession, /startShellPty\(spawnTimed\)/, 'the shell path is untouched');
});

test('a spawn that worked resets the clock, so the next outage gets its own two minutes', () => {
  assert.match(startSession, /bootFirstFailedAt = null;\s*trackExit\(term\)/);
});

test('the tab says it is retrying once, on the first failure only', () => {
  assert.match(retryFn, /if \(step\.first\) sayInTab\(BOOT_RETRY_LINE\)/);
});

test('the retry re-reads the CLI version (the mod) before it starts again, only while the mod is not up', () => {
  assert.match(retryFn, /if \(modPort === null && !SHELL\) await prepareMod\(\);\s*startSession\(\);/);
});

test('past the bound the host ends with the error frame the restart state is built on', () => {
  assert.match(retryFn, /step\.action === 'give-up'[\s\S]*endHost\(1, null, \{ error: bootGiveUpLine\(err\) \}, FAILED_START_LINGER_MS\)/);
});
