'use strict';
/**
 * host/resume-retry.js: a resumed main session that the CLI refuses ("No conversation found", exit 1, measured with a meta-only
 * transcript, verify/probe-continue.js meta) is started once more, fresh. Nothing else retries.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createResumeWatch, WITHIN_MS } = require('../host/resume-retry');

const REFUSED = '\u001b]0;claude\u0007No conversation found with session ID: 33333333-aaaa-4bbb-8ccc-000000000003\u001b[>4m';

function watchAt(t = { now: 1000 }) {
  return { t, w: createResumeWatch({ now: () => t.now }) };
}

test('exit 1 within the window after the refusal text: start fresh, once', () => {
  const { t, w } = watchAt();
  w.feed(REFUSED);
  t.now += 900;
  assert.strictEqual(w.shouldRetry({ exitCode: 1 }), true);
  assert.strictEqual(w.shouldRetry({ exitCode: 1 }), false, 'never a second time');
});

test('the refusal text may arrive in pieces', () => {
  const { w } = watchAt();
  w.feed('No conversation fo');
  w.feed('und with session ID: x');
  assert.strictEqual(w.shouldRetry({ exitCode: 1 }), true);
});

test('any other exit ends the host as it did: a different code, no refusal text, too late, or a missing code', () => {
  for (const [code, text, later] of [[0, REFUSED, 0], [2, REFUSED, 0], [null, REFUSED, 0], [undefined, REFUSED, 0], [1, 'some other error', 0], [1, '', 0], [1, REFUSED, WITHIN_MS + 1]]) {
    const { t, w } = watchAt();
    w.feed(text);
    t.now += later;
    assert.strictEqual(w.shouldRetry({ exitCode: code }), false, JSON.stringify([code, text.slice(0, 12), later]));
  }
  assert.strictEqual(createResumeWatch().shouldRetry(), false);
});

test('exactly at the window is still in it; the output kept is bounded; junk fed is ignored', () => {
  const { t, w } = watchAt();
  w.feed(REFUSED);
  t.now += WITHIN_MS;
  assert.strictEqual(w.shouldRetry({ exitCode: 1 }), true);
  const big = watchAt();
  big.w.feed(REFUSED);
  big.w.feed('x'.repeat(10000));
  assert.strictEqual(big.w.shouldRetry({ exitCode: 1 }), false, 'the refusal scrolled out of the tail: a later crash is not a refusal');
  const junk = watchAt();
  for (const j of [null, undefined, 5, {}, '']) junk.w.feed(j);
  assert.strictEqual(junk.w.shouldRetry({ exitCode: 1 }), false);
});

test('host.js wires it: only a spawn that asked to resume is watched, the retry starts with no resume id and says why, and a shell host is never watched', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(host, /const \{ createResumeWatch, WITHIN_MS: RESUME_RETRY_MS \} = require\('\.\/resume-retry'\);/);
  assert.match(host, /wireTerm\(term, !SHELL && LAST_SPAWN_RESUMED \? createResumeWatch\(\) : null, retryFresh\);/);
  assert.match(host, /const resumeId = SIDE \|\| SHELL \|\| RESUME_REFUSED \? null :/, 'the retry asks for no resume id');
  assert.match(host, /the CLI refused --resume \(exit 1 within/);
  assert.match(host, /if \(watch && retryFresh && watch\.shouldRetry\(\{ exitCode \}\)\)/);
  assert.match(host, /const retryFresh = \(\) => \{[\s\S]{0,400}RESUME_REFUSED = true;[\s\S]{0,40}term = spawnTimed\(\);/);
});
