'use strict';
// BACKLOG #217: host/host.js builds host/boot-retry.js's chain with its own collaborators and uses it on the claude spawn, and only there.
// The behaviour (retry, bound, single flight, clock) is tested in boot-retry.test.js with a fake clock; this pins only the wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const startSession = host.slice(host.indexOf('function startSession()'), host.indexOf('// --- attach surface'));
const build = host.slice(host.indexOf('const bootRetry = createBootRetry('), host.indexOf('function startSession()'));
const boot = host.slice(host.indexOf('const [processStartedAt, excluded]'), host.indexOf('const gate = gateFromAcquire(await acquireSessionLock'));

test('the host requires the chain from host/boot-retry and builds it from its own collaborators', () => {
  assert.match(host, /require\('\.\/boot-retry'\)/);
  assert.match(build, /now: \(\) => performance\.now\(\)/, 'a monotonic clock, not the wall clock');
  assert.match(build, /setTimer: \(fn, ms\) => setTimeout\(fn, ms\)/);
  assert.match(build, /say: sayInTab/);
  assert.match(build, /end: \(reason\) => endHost\(1, null, \{ error: reason \}, FAILED_START_LINGER_MS\)/);
  assert.match(build, /prepare: prepareMod/);
  assert.match(build, /unreadable: \(\) => modVersionUnreadable/);
  assert.match(build, /binExisted: \(\) => CLAUDE_BIN_EXISTED/);
  assert.match(build, /startSession: \(\) => startSession\(\)/);
});

test('the claude spawn (not the shell one) is wrapped: a failure goes to the chain and is rethrown when it is not ours', () => {
  assert.match(startSession, /\} else \{\s*\n\s*\/\/ BACKLOG #217[^\n]*\n\s*\/\/[^\n]*\n\s*try \{\s*\n\s*term = spawnTimed\(\);\s*\} catch \(err\) \{\s*if \(!bootRetry\.failed\(err\)\) throw err;\s*return;\s*\}/);
  assert.match(startSession, /startShellPty\(spawnTimed\)/, 'the shell path is untouched');
});

test('a spawn that worked tells the chain, so the clock is freed', () => {
  assert.match(startSession, /bootRetry\.started\(\);\s*trackExit\(term\)/);
});

test('the boot reads an unreadable version again before the session starts, so a spawn that then works still loads the mod (Dexter 1)', () => {
  assert.match(boot, /await settleVersion\(\{ prepare: prepareMod, unreadable: \(\) => modVersionUnreadable, sleep: \(ms\) => new Promise\(\(r\) => setTimeout\(r, ms\)\) \}\);/);
});

test('prepareMod says whether the version was unreadable (and only then)', () => {
  const prep = host.slice(host.indexOf('async function prepareMod()'), host.indexOf('// One record from the mod'));
  assert.match(prep, /modVersionUnreadable = enabled && !forced && !Array\.isArray\(version\);/);
  assert.match(host, /let modVersionUnreadable = false;/);
});

test('CLAUDE_BIN_EXISTED is read once, at boot, from the resolved path', () => {
  assert.match(host, /const CLAUDE_BIN_EXISTED = fs\.existsSync\(CLAUDE_BIN\);/);
});
