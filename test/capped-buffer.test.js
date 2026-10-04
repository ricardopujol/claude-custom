'use strict';
/**
 * The child-output buffer.
 *
 * This exists as its own module because the version inlined in host.js could
 * not be tested -- requiring host.js boots a pty and a WebSocket server, so the
 * fix for a blocker landed in a region nothing could reach. That is the same
 * "zero-coverage region" trap this project has hit before, one level up: the
 * fix looked complete in the diff and was scored by nothing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createCappedBuffer } = require('../host/capped-buffer');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);

test('output under the cap is returned verbatim', () => {
  const buf = createCappedBuffer(100);
  buf.push('hello ');
  buf.push('world');
  assert.strictEqual(buf.text(), 'hello world');
  assert.strictEqual(buf.dropped, 0);
});

test('the HEAD is kept, which is where node:test puts its counters', () => {
  // The defect this module exists to fix: a blind tail lost the counter block.
  const buf = createCappedBuffer(10);
  buf.push('COUNTERS--' + 'x'.repeat(500) + '--END');
  assert.ok(buf.text().startsWith('COUNTERS--'), buf.text().slice(0, 20));
});

test('the TAIL is kept, which is where pytest puts its counts', () => {
  // cap 30, because the summary being preserved is 18 characters long -- a cap
  // smaller than the thing you expect to survive tests nothing.
  const buf = createCappedBuffer(30);
  buf.push('start-----' + 'x'.repeat(500) + '1 failed, 1 passed');
  assert.ok(buf.text().endsWith('1 failed, 1 passed'), buf.text().slice(-30));
});

test('BOTH ends survive at once', () => {
  const buf = createCappedBuffer(20);
  buf.push('HEAD'.padEnd(20, '.') + 'y'.repeat(1000) + 'TAIL'.padStart(20, '.'));
  const out = buf.text();
  assert.ok(out.startsWith('HEAD'), out.slice(0, 24));
  assert.ok(out.endsWith('TAIL'), out.slice(-24));
});

test('what was dropped is MARKED, not silently spliced', () => {
  // A parser handed a silently spliced stream would report a confident wrong
  // answer instead of an unparseable one.
  const buf = createCappedBuffer(10);
  buf.push('a'.repeat(10) + 'b'.repeat(500) + 'c'.repeat(10));
  assert.match(buf.text(), /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
  assert.ok(buf.dropped > 0);
});

test('nothing is marked when nothing was dropped', () => {
  const buf = createCappedBuffer(10);
  buf.push('a'.repeat(10));
  buf.push('b'.repeat(10));
  assert.strictEqual(buf.text(), 'a'.repeat(10) + 'b'.repeat(10));
  assert.ok(!/omitted/.test(buf.text()));
});

test('memory stays bounded however much is pushed', () => {
  // The RangeError hazard: an unbounded `out +=` in the host throws inside a
  // 'data' listener and kills the user's live session.
  const cap = 1000;
  const buf = createCappedBuffer(cap);
  for (let i = 0; i < 5000; i++) buf.push('z'.repeat(1000));
  // head + tail + marker, never the 5MB pushed.
  assert.ok(buf.text().length < cap * 2 + 64, String(buf.text().length));
});

test('a chunk split across the head boundary is not lost', () => {
  // The boundary that the first, garbled implementation got wrong.
  const buf = createCappedBuffer(5);
  buf.push('abcdefgh');
  assert.strictEqual(buf.text(), 'abcdefgh');
});

test('many small chunks reassemble exactly', () => {
  const buf = createCappedBuffer(1000);
  const whole = 'the quick brown fox jumps over the lazy dog';
  for (const ch of whole) buf.push(ch);
  assert.strictEqual(buf.text(), whole);
});

test('empty and null chunks are harmless', () => {
  const buf = createCappedBuffer(10);
  buf.push('');
  buf.push(null);
  buf.push(undefined);
  buf.push('ok');
  assert.strictEqual(buf.text(), 'ok');
});

test('a cap of zero or less is refused rather than silently dropping everything', () => {
  assert.throws(() => createCappedBuffer(0), /positive/);
  assert.throws(() => createCappedBuffer(-1), /positive/);
});

// --- the real defect, end to end ---------------------------------------------

test('a REAL red node:test run still parses as critical after capping', () => {
  // Measured: 120 failures produces 116KB of output with the counter block
  // 2,845 bytes in. The last 64KB therefore contains no counters at all, and
  // the old blind tail reported "unknown" -- the worst suite in the repo
  // indistinguishable from one that never ran.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { parseResults, healthFrom } = require('../host/health');

  const dir = tmpDir('cc-cap-real-');
  const lines = ["const test=require('node:test');const assert=require('node:assert');"];
  for (let i = 0; i < 5; i++) lines.push(`test('ok ${i}', () => assert.ok(true));`);
  for (let i = 0; i < 120; i++) {
    lines.push(`test('broken ${i}', () => assert.deepStrictEqual({a:${i},b:'x'.repeat(40)}, {c:${i}}));`);
  }
  fs.writeFileSync(path.join(dir, 's.test.js'), lines.join(NL), 'utf8');

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let out;
  try {
    out = execFileSync(process.execPath, ['--test', 's.test.js'],
      { encoding: 'utf8', cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    out = String((err && err.stdout) || '');
  }

  const CAP = 64 * 1024;
  assert.ok(out.length > CAP, `fixture too small to exercise the cap: ${out.length}`);

  const buf = createCappedBuffer(CAP);
  buf.push(out);
  const capped = healthFrom(parseResults('node-test', buf.text()));
  assert.strictEqual(capped.state, 'critical');
  assert.strictEqual(capped.failed, 120);

  // And the old behaviour, asserted so the regression is visible if reinstated.
  const tailOnly = healthFrom(parseResults('node-test', out.slice(-CAP)));
  assert.strictEqual(tailOnly.state, 'unknown',
    'a blind tail should still lose the counters -- if not, this fixture stopped exercising the bug');
});
