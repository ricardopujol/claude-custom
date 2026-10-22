'use strict';
/**
 * host/cron-next.js: a small 5-field cron matcher and the next-run search behind the Schedules panel (BACKLOG #119 A7).
 * The properties are the point: a computed next run MATCHES its expression, lies in the FUTURE, and is the EARLIEST such minute.
 * Anything the matcher does not understand is null, never a guessed time.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { parseCron, matches, nextRun } = require('../host/cron-next');

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('parseCron accepts the standard forms and refuses what it cannot honour', () => {
  for (const ok of ['* * * * *', '*/5 * * * *', '0 6 * * *', '30 14 28 2 *', '0,15,30,45 9-17 * * 1-5', '0 0 1 */3 *', '5-30/10 * * * 7', '0 0 * * 0']) {
    assert.ok(parseCron(ok), ok);
  }
  for (const bad of ['', '   ', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8',
    '@daily', '0 0 L * *', '0 0 * * MON', '0 0 * JAN *', '0 0 ? * *', '5-1 * * * *', '*/0 * * * *', '*/-2 * * * *', 'a b c d e', '1.5 * * * *', '0 0 * * 5#2']) {
    assert.strictEqual(parseCron(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(parseCron(null), null);
  assert.strictEqual(parseCron(undefined), null);
  assert.strictEqual(parseCron(42), null);
});

test('nextRun: concrete answers', () => {
  const from = local(2026, 10, 19, 22, 10);
  assert.strictEqual(nextRun('*/5 * * * *', from), local(2026, 10, 19, 22, 15));
  assert.strictEqual(nextRun('10 22 * * *', from), local(2026, 10, 20, 22, 10), 'strictly after: the minute it is now does not count');
  assert.strictEqual(nextRun('0 6 * * *', from), local(2026, 10, 20, 6, 0));
  assert.strictEqual(nextRun('30 14 28 2 *', from), local(2027, 2, 28, 14, 30));
  assert.strictEqual(nextRun('0 9 * * 1', from), local(2026, 10, 26, 9, 0), '2026-10-19 is a Monday; 09:00 has passed, so next Monday');
  assert.strictEqual(nextRun('0 9 * * 7', from), local(2026, 10, 25, 9, 0), '7 is Sunday');
  assert.strictEqual(nextRun('0 0 29 2 *', local(2026, 3, 1)), local(2028, 2, 29), 'a leap day waits for a leap year');
});

test('nextRun: a time inside the current second-of-minute is still the NEXT minute', () => {
  const from = local(2026, 10, 19, 22, 10) + 45_000;
  assert.strictEqual(nextRun('* * * * *', from), local(2026, 10, 19, 22, 11));
});

test('day-of-month and day-of-week are ORed when both are restricted, ANDed with a star (the Vixie rule)', () => {
  // 2026-11-01 is a Sunday. "the 15th OR a Monday"
  const from = local(2026, 11, 1, 12, 0);
  assert.strictEqual(nextRun('0 0 15 * 1', from), local(2026, 11, 2, 0, 0), 'Monday the 2nd beats the 15th');
  // "every day of month 15, any weekday" -> only the 15th
  assert.strictEqual(nextRun('0 0 15 * *', from), local(2026, 11, 15, 0, 0));
  // "any day of month, Mondays" -> only Mondays
  assert.strictEqual(nextRun('0 0 * * 1', from), local(2026, 11, 2, 0, 0));
});

test('an expression that can never fire is null, not a wrong date', () => {
  assert.strictEqual(nextRun('0 0 31 2 *', Date.now()), null);
  assert.strictEqual(nextRun('0 0 30 2 *', Date.now()), null);
  assert.strictEqual(nextRun('not cron', Date.now()), null);
  assert.strictEqual(nextRun('* * * * *', NaN), null);
  assert.strictEqual(nextRun('* * * * *', null), null, 'absence is not the epoch (Number(null) is 0)');
  assert.strictEqual(nextRun('* * * * *', undefined), null);
});

// --- properties ---------------------------------------------------------------------------------------------------------------

const num = (lo, hi) => fc.integer({ min: lo, max: hi });
function field(lo, hi) {
  const single = num(lo, hi).map(String);
  const range = fc.tuple(num(lo, hi), num(lo, hi)).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`);
  const stepRange = fc.tuple(num(lo, hi), num(lo, hi), num(1, 12)).map(([a, b, s]) => `${Math.min(a, b)}-${Math.max(a, b)}/${s}`);
  const star = fc.constant('*');
  const stepStar = num(1, 12).map(s => `*/${s}`);
  const item = fc.oneof(single, range, stepRange, star, stepStar);
  return fc.array(item, { minLength: 1, maxLength: 3 }).map(a => a.join(','));
}
const exprArb = fc.tuple(field(0, 59), field(0, 23), field(1, 31), field(1, 12), field(0, 7)).map(a => a.join(' '));
// from: anywhere in 2025..2029, local
const fromArb = fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2029, 11, 31) });

test('PROPERTY: a computed next run is minute-aligned, in the future, and matches its own expression', () => {
  fc.assert(fc.property(exprArb, fromArb, (expr, from) => {
    const parsed = parseCron(expr);
    assert.ok(parsed, expr);
    const r = nextRun(expr, from);
    if (r === null) return true;                       // an impossible date (31 Feb, ...) is allowed to be null
    assert.ok(r > from, `${expr}: ${r} is not after ${from}`);
    assert.strictEqual(r % 60_000, 0);
    assert.ok(matches(parsed, new Date(r)), `${expr} does not match ${new Date(r).toString()}`);
    return true;
  }), { numRuns: 400 });
});

test('PROPERTY: it is the EARLIEST matching minute (nothing between from and the answer matches)', () => {
  fc.assert(fc.property(exprArb, fromArb, (expr, from) => {
    const parsed = parseCron(expr);
    const r = nextRun(expr, from);
    if (r === null || r - from > 2 * 86_400_000) return true;   // brute force only the near answers
    for (let t = Math.floor(from / 60_000) * 60_000 + 60_000; t < r; t += 60_000) {
      assert.ok(!matches(parsed, new Date(t)), `${expr}: ${new Date(t).toString()} matches before ${new Date(r).toString()}`);
    }
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: the answer is stable: asking again from the answer gives a LATER one, and from just before it gives the same one', () => {
  fc.assert(fc.property(exprArb, fromArb, (expr, from) => {
    const r = nextRun(expr, from);
    if (r === null) return true;
    assert.strictEqual(nextRun(expr, r - 1), r);
    const again = nextRun(expr, r);
    assert.ok(again === null || again > r);
    return true;
  }), { numRuns: 200 });
});

test('PROPERTY: an every-minute expression answers the next whole minute', () => {
  fc.assert(fc.property(fromArb, (from) => {
    assert.strictEqual(nextRun('* * * * *', from), Math.floor(from / 60_000) * 60_000 + 60_000);
    return true;
  }), { numRuns: 100 });
});
