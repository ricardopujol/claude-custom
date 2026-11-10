'use strict';
// BACKLOG #217: a spawn that fails because claude.exe is mid-update is retried, with a bound; any other failure is left alone.
const test = require('node:test');
const assert = require('node:assert');
const {
  isRetryableSpawnError, nextStep, RETRY_EVERY_MS, GIVE_UP_AFTER_MS, RETRY_LINE, giveUpLine,
} = require('../host/boot-retry');

test('the measured failure (node-pty, Windows error 216) is retryable', () => {
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 216')), true);
});

test('the other "binary not usable right now" errors are retryable', () => {
  for (const m of ['Cannot create process, error code: 193', 'Cannot create process, error code: 32', 'File not found: C:\\x\\claude.exe']) {
    assert.strictEqual(isRetryableSpawnError(new Error(m)), true, m);
  }
  for (const code of ['EBUSY', 'EACCES', 'ENOENT', 'EPERM']) {
    assert.strictEqual(isRetryableSpawnError(Object.assign(new Error('x'), { code })), true, code);
  }
});

test('a code is matched whole: 2160 or 1932 is not 216 or 193', () => {
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 2160')), false);
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 1932')), false);
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 5')), false);
});

test('anything else, and anything that is not an error, is not retryable', () => {
  for (const v of [new Error('boom'), new Error(''), null, undefined, 216, {}, 'error code: 216x']) {
    assert.strictEqual(isRetryableSpawnError(v), false, String(v));
  }
  assert.strictEqual(isRetryableSpawnError('Cannot create process, error code: 216'), true, 'a thrown string reads the same');
});

test('the schedule is 5 s for 2 minutes', () => {
  assert.strictEqual(RETRY_EVERY_MS, 5000);
  assert.strictEqual(GIVE_UP_AFTER_MS, 120000);
});

test('a non-retryable failure is not ours', () => {
  assert.deepStrictEqual(nextStep({ err: new Error('boom'), firstFailedAt: null, now: 1000 }), { action: 'fail' });
});

test('the first retryable failure starts the clock and retries after 5 s', () => {
  assert.deepStrictEqual(
    nextStep({ err: new Error('Cannot create process, error code: 216'), firstFailedAt: null, now: 1000 }),
    { action: 'retry', delayMs: 5000, firstFailedAt: 1000, first: true },
  );
});

test('a later failure inside the bound retries again, keeping the clock', () => {
  const r = nextStep({ err: new Error('Cannot create process, error code: 216'), firstFailedAt: 1000, now: 1000 + 60000 });
  assert.deepStrictEqual(r, { action: 'retry', delayMs: 5000, firstFailedAt: 1000, first: false });
});

test('the bound: the failure that cannot be followed by a retry inside 2 minutes gives up', () => {
  const err = new Error('Cannot create process, error code: 216');
  // 115 s in: the next try at 120 s is still inside the bound
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 115000 }).action, 'retry');
  // 116 s in: the next try would land past 120 s
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 116000 }).action, 'give-up');
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 500000 }).action, 'give-up');
});

test('a fake spawn failing N times then succeeding is retried N times; one that never succeeds hits the bound', () => {
  const err = new Error('Cannot create process, error code: 216');
  const run = (failures) => {
    let t = 0, first = null, tries = 0;
    for (;;) {
      tries++;
      if (tries > failures) return { tries, outcome: 'started' };
      const s = nextStep({ err, firstFailedAt: first, now: t });
      if (s.action === 'give-up') return { tries, outcome: 'gave up' };
      first = s.firstFailedAt; t += s.delayMs;
    }
  };
  assert.deepStrictEqual(run(3), { tries: 4, outcome: 'started' });
  const never = run(Infinity);
  assert.strictEqual(never.outcome, 'gave up');
  assert.ok(never.tries >= 24 && never.tries <= 26, 'about 2 minutes of 5 s tries, got ' + never.tries);
});

test('the lines say what is happening, once, on one line', () => {
  assert.strictEqual(RETRY_LINE, 'Claude Code is updating, retrying…');
  const g = giveUpLine(new Error('Cannot create process, error code: 216'));
  assert.match(g, /error code: 216/);
  assert.ok(!/[\r\n\x1b]/.test(giveUpLine(new Error('a\r\n\x1b[31mb'))));
  assert.ok(giveUpLine(new Error('x'.repeat(5000))).length < 400);
  assert.ok(giveUpLine(null).length > 0);
});
