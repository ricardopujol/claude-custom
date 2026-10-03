'use strict';
/**
 * The ledger's days are LOCAL days, like git's `%ad --date=short` (backlog #38, PR #85 Dexter F10).
 * Keyed by the UTC date, a branch's last day of work and its merge day (local) fell on different
 * days near midnight, and a week arc in app/git-rings.js could split.
 *
 * The machine's zone must not decide the outcome, so the pinned cases run in a child process with
 * TZ set: the same timestamp is a different local day in each zone.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { addLines, emptyRecord } = require('../host/branch-ledger');

const ROOT = 'C:\\p';
const line = (id, ts) => JSON.stringify({
  type: 'assistant', gitBranch: 'feat/a', cwd: 'C:\\p\\dev', timestamp: ts,
  message: { id, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0 } },
});

// -> { first, last } of feat/a after addLines over `stamps`, in a fresh process whose zone is `tz`
function daysIn(tz, stamps) {
  const script = `
    const { addLines, emptyRecord } = require(${JSON.stringify(path.resolve(__dirname, '../host/branch-ledger'))});
    const stamps = ${JSON.stringify(stamps)};
    const line = (id, ts) => JSON.stringify({ type: 'assistant', gitBranch: 'feat/a', cwd: 'C:\\\\p\\\\dev', timestamp: ts,
      message: { id, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0 } } });
    const r = emptyRecord();
    addLines(r, stamps.map((t, i) => line('m' + i, t)).join('\\n') + '\\n', 'C:\\\\p');
    const b = r.branches['feat/a'];
    process.stdout.write(JSON.stringify({ first: b.first, last: b.last }));`;
  const env = { ...process.env, TZ: tz };
  delete env.ELECTRON_RUN_AS_NODE;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

test('east of UTC: 22:00Z is already tomorrow, the way git prints it', () => {
  // Auckland is UTC+12/+13: 2026-09-20 22:00Z is 2026-09-21 10:00 (or 11:00) there
  assert.deepStrictEqual(daysIn('Pacific/Auckland', ['2026-09-20T22:00:00Z']), { first: '2026-09-21', last: '2026-09-21' });
});

test('west of UTC: 03:00Z is still yesterday, the way git prints it', () => {
  // Los Angeles is UTC-7/-8: 2026-09-21 03:00Z is 2026-09-20 20:00 (or 19:00) there
  assert.deepStrictEqual(daysIn('America/Los_Angeles', ['2026-09-21T03:00:00Z']), { first: '2026-09-20', last: '2026-09-20' });
});

test('first and last are local days across a midnight', () => {
  assert.deepStrictEqual(
    daysIn('America/Los_Angeles', ['2026-09-21T06:59:00Z', '2026-09-21T07:01:00Z']),
    { first: '2026-09-20', last: '2026-09-21' });
});

test('UTC itself is unchanged', () => {
  assert.deepStrictEqual(daysIn('UTC', ['2026-09-20T23:59:00Z']), { first: '2026-09-20', last: '2026-09-20' });
});

test('no timestamp, or one that is not a date: no day, never a made-up one', () => {
  const r = emptyRecord();
  addLines(r, [
    JSON.stringify({ gitBranch: 'feat/a', cwd: 'C:\\p\\dev', message: { id: 'a', usage: { input_tokens: 1 } } }),
    JSON.stringify({ gitBranch: 'feat/a', cwd: 'C:\\p\\dev', timestamp: null, message: { id: 'b', usage: { input_tokens: 1 } } }),
    JSON.stringify({ gitBranch: 'feat/a', cwd: 'C:\\p\\dev', timestamp: 0, message: { id: 'c', usage: { input_tokens: 1 } } }),
    JSON.stringify({ gitBranch: 'feat/a', cwd: 'C:\\p\\dev', timestamp: '2026-13-45T99:99:99Z', message: { id: 'd', usage: { input_tokens: 1 } } }),
    // a bare date parses as UTC midnight: a different local day west of UTC (Dexter, PR #88 F3)
    JSON.stringify({ gitBranch: 'feat/a', cwd: 'C:\\p\\dev', timestamp: '2026-09-21', message: { id: 'e', usage: { input_tokens: 1 } } }),
  ].join('\n') + '\n', ROOT);
  assert.strictEqual(r.branches['feat/a'].spend, 5);
  assert.strictEqual(r.branches['feat/a'].first, null);
  assert.strictEqual(r.branches['feat/a'].last, null);
});

test('property: the ledger day of an instant is the local date git would print for it, in each zone', () => {
  // git's `short-local` is the viewer's local date as Y-M-D; sv-SE prints the same shape. The oracle
  // runs INSIDE a pinned zone (one east, one west of UTC) so it can tell local from UTC; in the
  // machine's own zone alone a UTC-keyed ledger would pass whenever that zone is UTC.
  const script = `
    const fc = require(${JSON.stringify(require.resolve('fast-check'))});
    const { addLines, emptyRecord } = require(${JSON.stringify(path.resolve(__dirname, '../host/branch-ledger'))});
    const gitDay = ms => new Date(ms).toLocaleDateString('sv-SE');
    fc.assert(fc.property(
      fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
      ms => {
        const r = emptyRecord();
        const line = JSON.stringify({ type: 'assistant', gitBranch: 'feat/a', cwd: 'C:/p/dev', timestamp: new Date(ms).toISOString(),
          message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0 } } });
        addLines(r, line + String.fromCharCode(10), 'C:/p');
        const b = r.branches['feat/a'];
        return b.first === gitDay(ms) && b.last === gitDay(ms);
      }));`;
  for (const tz of ['Pacific/Auckland', 'America/Los_Angeles']) {
    const env = { ...process.env, TZ: tz };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  }
});
