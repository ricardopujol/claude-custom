'use strict';
/**
 * How the bug vault panel should be DRAWN, given what the host has sent.
 *
 * Same reason `app/usage-display.js` exists: a decision living inside
 * `renderer.js` is a decision nothing can test, and reviewers have rejected
 * PRs in this repo for exactly that (non-negotiable #5 in this project's
 * CLAUDE.md).
 */
const test = require('node:test');
const assert = require('node:assert');

const { bugVaultDisplay, formatBugRow, UNKNOWN } = require('../app/bugvault-display');

const bug = (over = {}) => ({
  id: 'bug_1', category: 'silent failure', summary: 'exit 0 masked a failure',
  whereFound: 'tune.py', detectedBy: 'measurement', survived: 'one run',
  wouldHaveCaught: 'checking the real exit code', fixed: false, foundAt: '2026-01-01T00:00:00.000Z',
  fixedAt: null, ...over,
});

// --- the top-level state --------------------------------------------------------

test('no payload from the host yet is "reading", never an empty vault', () => {
  // The defect this project keeps shipping: absence drawn as zero. Before the
  // host's first message lands there is no way to know whether the vault is
  // empty or simply not yet read, and those must not render the same.
  assert.strictEqual(bugVaultDisplay(undefined).state, 'reading');
  assert.strictEqual(bugVaultDisplay(null).state, 'reading');
  assert.strictEqual(bugVaultDisplay({}).state, 'reading');
  assert.strictEqual(bugVaultDisplay({ bugs: null }).state, 'reading');
});

test('a real, genuinely empty vault is its own state, distinct from "reading"', () => {
  const d = bugVaultDisplay({ bugs: [], summary: { total: 0, byCategory: [], byDetection: [] } });
  assert.strictEqual(d.state, 'empty');
});

test('a vault with bugs is "ready" and carries the totals', () => {
  const d = bugVaultDisplay({
    bugs: [bug(), bug({ id: 'bug_2', fixed: true })],
    summary: { total: 2, byCategory: [], byDetection: [] },
  });
  assert.strictEqual(d.state, 'ready');
  assert.strictEqual(d.total, 2);
  assert.strictEqual(d.unfixed, 1);
  assert.strictEqual(d.fixed, 1);
});

test('every state returns a usable shape', () => {
  for (const payload of [undefined, null, {}, { bugs: [] }, { bugs: [bug()] }]) {
    const d = bugVaultDisplay(payload);
    assert.ok(typeof d.state === 'string' && d.state, JSON.stringify(payload));
    assert.ok(Array.isArray(d.rows), JSON.stringify(payload));
    assert.ok(Array.isArray(d.groups), JSON.stringify(payload));
    assert.ok(Array.isArray(d.detection), JSON.stringify(payload));
  }
});

// --- category groups and the detection breakdown, passed through for display ---

test('category groups from the host summary are carried through, most frequent first already', () => {
  const byCategory = [{ category: 'a', total: 3, fixed: 1, unfixed: 2 }, { category: 'b', total: 1, fixed: 0, unfixed: 1 }];
  const d = bugVaultDisplay({ bugs: [bug()], summary: { total: 1, byCategory, byDetection: [] } });
  assert.deepStrictEqual(d.groups, byCategory);
});

test('a detection method that was never recorded is labelled, not left as a raw null', () => {
  const byDetection = [{ detectedBy: 'measurement', count: 4 }, { detectedBy: null, count: 2 }];
  const d = bugVaultDisplay({ bugs: [bug()], summary: { total: 1, byCategory: [], byDetection } });
  const unknownRow = d.detection.find(r => r.count === 2);
  assert.strictEqual(unknownRow.label, 'not recorded');
  const known = d.detection.find(r => r.count === 4);
  assert.strictEqual(known.label, 'measurement');
});

// --- formatBugRow ----------------------------------------------------------------

test('an unfixed bug gets the bug icon and a fixed bug gets the check icon', () => {
  // The ART PLACEHOLDER RULE: until a class has a generated portrait, it gets
  // an emoji, stored as data next to the record rather than hardcoded markup.
  assert.strictEqual(formatBugRow(bug({ fixed: false })).icon, '🐛');
  assert.strictEqual(formatBugRow(bug({ fixed: true })).icon, '✅');
});

test('every optional field missing on the record renders as the UNKNOWN placeholder, not blank', () => {
  const row = formatBugRow(bug({ whereFound: null, detectedBy: null, survived: null, wouldHaveCaught: null }));
  assert.strictEqual(row.whereFound, UNKNOWN);
  assert.strictEqual(row.detectedBy, UNKNOWN);
  assert.strictEqual(row.survived, UNKNOWN);
  assert.strictEqual(row.wouldHaveCaught, UNKNOWN);
});

test('a present field is passed through untouched', () => {
  const row = formatBugRow(bug());
  assert.strictEqual(row.category, 'silent failure');
  assert.strictEqual(row.summary, 'exit 0 masked a failure');
  assert.strictEqual(row.whereFound, 'tune.py');
  assert.strictEqual(row.detectedBy, 'measurement');
});

test('the fixed status is a word, not just carried as a boolean the template must remember to check', () => {
  assert.strictEqual(formatBugRow(bug({ fixed: true })).statusLabel, 'fixed');
  assert.strictEqual(formatBugRow(bug({ fixed: false })).statusLabel, 'open');
});

test('formatBugRow tolerates a malformed record instead of throwing mid-render', () => {
  // One bad record must not blank the whole panel -- same reasoning as
  // `rendererScripts()` guards elsewhere in this project.
  assert.doesNotThrow(() => formatBugRow(null));
  assert.doesNotThrow(() => formatBugRow({}));
});

// --- rows are sorted unfixed-first, so the open work is not buried under fixed history ---

test('unfixed bugs sort before fixed ones', () => {
  const d = bugVaultDisplay({
    bugs: [bug({ id: 'a', fixed: true }), bug({ id: 'b', fixed: false })],
    summary: { total: 2, byCategory: [], byDetection: [] },
  });
  assert.deepStrictEqual(d.rows.map(r => r.id), ['b', 'a']);
});
