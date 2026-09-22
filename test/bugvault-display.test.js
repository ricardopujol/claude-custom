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
  // This used to assert `d.groups` deep-equalled the raw `byCategory`, which
  // pinned OBJECT IDENTITY rather than the property named in the title. The
  // rows now carry presentation fields (see formatGroups), so identity is
  // gone and was never the point: what must hold is that the host's ranking
  // survives untouched and no count is invented.
  const byCategory = [{ category: 'a', total: 3, fixed: 1, unfixed: 2 }, { category: 'b', total: 1, fixed: 0, unfixed: 1 }];
  const d = bugVaultDisplay({ bugs: [bug()], summary: { total: 1, byCategory, byDetection: [] } });
  assert.deepStrictEqual(d.groups.map(g => g.category), ['a', 'b']);
  assert.deepStrictEqual(d.groups.map(g => g.total), [3, 1]);
  assert.deepStrictEqual(d.groups.map(g => g.unfixed), [2, 1]);
});

test('the bar is proportional to the biggest class, with a floor so one bug is still visible', () => {
  const d = bugVaultDisplay({ bugs: [bug()], summary: { byCategory: [
    { category: 'big', total: 10, fixed: 0, unfixed: 10 },
    { category: 'half', total: 5, fixed: 0, unfixed: 5 },
    { category: 'one', total: 1, fixed: 1, unfixed: 0 },
  ] } });
  assert.strictEqual(d.groups[0].bar, 100);
  assert.strictEqual(d.groups[1].bar, 50);
  assert.ok(d.groups[2].bar >= 4, 'a single-bug class must still draw a bar, not nothing');
});

test('a missing total does not become a confident zero that also sizes a bar', () => {
  // `Number(null)` is 0 -- the absence-as-zero trap this codebase keeps
  // paying for. A group with no usable total must not claim a share.
  const d = bugVaultDisplay({ bugs: [bug()], summary: { byCategory: [
    { category: 'real', total: 4, fixed: 0, unfixed: 4 },
    { category: 'broken', total: null, fixed: null, unfixed: null },
  ] } });
  assert.strictEqual(d.groups[1].total, 0);
  assert.strictEqual(d.groups[1].bar, 4);
  assert.strictEqual(d.groups[1].openLabel, null);
});

test('the open-count label is absent, not "0 open", when a class is fully fixed', () => {
  const d = bugVaultDisplay({ bugs: [bug()], summary: { byCategory: [
    { category: 'done', total: 3, fixed: 3, unfixed: 0 },
  ] } });
  assert.strictEqual(d.groups[0].openLabel, null);
});

test('a group with no category name is labelled, not rendered blank', () => {
  const d = bugVaultDisplay({ bugs: [bug()], summary: { byCategory: [
    { category: '  ', total: 2, fixed: 0, unfixed: 2 },
  ] } });
  assert.strictEqual(d.groups[0].category, '—');
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

// --- the fourth state --------------------------------------------------------
//
// Dexter, PR #29 review, F1, display half. The vault now refuses to overwrite
// a file it could not read, and reports why. If the panel renders that as
// `empty`, the user sees "no bugs recorded yet -- add one below" over a vault
// that is sitting on disk, damaged, full of their records. They would then
// start typing into a store that is refusing every write.
//
// This module's own header already says three states, not two, because
// collapsing "not known yet" into "none" is the bug this project keeps
// catching. A vault that could not be read is the fourth, and it is the one
// where the difference is destructive rather than merely misleading.

test('a vault that could not be read is not reported as empty', () => {
  const d = bugVaultDisplay({ bugs: [], summary: { error: 'the vault file is corrupt and was left untouched' } });
  assert.strictEqual(d.state, 'unreadable');
  assert.notStrictEqual(d.state, 'empty');
});

test('the failure text travels to the panel, so the user learns which file to look at', () => {
  const d = bugVaultDisplay({ bugs: [], summary: { error: 'the vault file is corrupt and was left untouched' } });
  assert.match(d.error, /corrupt/);
});

test('a real empty vault is still empty, and carries no error', () => {
  const d = bugVaultDisplay({ bugs: [], summary: { error: null } });
  assert.strictEqual(d.state, 'empty');
  assert.strictEqual(d.error, null);
});

test('a vault with bugs in it is still ready, and carries no error', () => {
  const d = bugVaultDisplay({ bugs: [{ category: 'a', summary: 'x' }], summary: {} });
  assert.strictEqual(d.state, 'ready');
  assert.strictEqual(d.error, null);
});

test('an unreadable vault offers no rows, so nothing looks like a record that survived', () => {
  const d = bugVaultDisplay({ bugs: [], summary: { error: 'unreadable' } });
  assert.deepStrictEqual(d.rows, []);
  assert.strictEqual(d.total, 0);
});

test('a payload that has not arrived is still "reading", not "unreadable"', () => {
  // Two different unknowns. One resolves on its own in a moment; the other
  // needs a person. Telling them apart is the entire point of this test file.
  assert.strictEqual(bugVaultDisplay(null).state, 'reading');
  assert.strictEqual(bugVaultDisplay({}).state, 'reading');
});

test('every state this module can return is handled in renderer.js', () => {
  // THE DRIFT THIS PR ALMOST SHIPPED. Adding `unreadable` to the display
  // module without a matching branch in renderer.js would have fallen through
  // to the `ready` path and drawn "0 bug classes recorded -- 0 open, 0 fixed"
  // over a damaged vault: the absence-as-zero bug, reintroduced by the fix FOR
  // the absence-as-zero bug, with every unit test in this file still green
  // because none of them render anything.
  //
  // Same instrument as test/control.test.js's allow-list scan and store.js's
  // header check: a cross-file claim asserted against source rather than
  // trusted. It reads the states out of THIS module rather than listing them,
  // so a fifth state is covered the day it is added.
  const fs = require('fs');
  const path = require('path');
  const APP = path.join(__dirname, '..', 'app');
  const mod = fs.readFileSync(path.join(APP, 'bugvault-display.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');

  const states = [...mod.matchAll(/state:\s*'([a-z]+)'/g)].map(m => m[1]);
  const ternary = [...mod.matchAll(/state:\s*[^,]*\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'/g)]
    .flatMap(m => [m[1], m[2]]);
  const all = [...new Set([...states, ...ternary])];
  assert.ok(all.length >= 4, `the scan must find the states; found ${JSON.stringify(all)}`);

  const render = renderer.slice(renderer.indexOf('function renderBugVault'));
  const body = render.slice(0, render.indexOf('\n}\n') + 1);
  const unhandled = all.filter(st => !body.includes(`'${st}'`));
  assert.deepStrictEqual(unhandled, [],
    `renderBugVault does not mention these states the display module can return: ${unhandled.join(', ')}`);
});

// --- the grouping the panel computed and never drew --------------------------
//
// The PR is titled "recurring defect classes, grouped by category and
// detection method". Detection was rendered; CATEGORY never was. `groups` is
// computed on the host by groupByCategory, shipped over the wire in
// `summary.byCategory`, passed through this module, unit-tested on both sides
// -- and referenced nowhere in renderer.js.
//
// Everything about it worked except being on screen, which is the one part
// no unit test was in a position to notice. Stripping it would have meant
// deleting a working, tested function to match an accidental omission: fitting
// the spec to the bug. It is drawn instead.

test('the category groups reach the panel in the order the host ranked them', () => {
  // That ordering IS the feature -- "six found by measurement, none by
  // reading" only reads as a fact if the biggest class is not buried under
  // insertion order. The host sorts; this module must not resort or reverse it.
  const byCategory = [
    { category: 'silent failure', total: 4, fixed: 3, unfixed: 1 },
    { category: 'off by one', total: 1, fixed: 1, unfixed: 0 },
  ];
  const d = bugVaultDisplay({ bugs: [{ category: 'silent failure', summary: 'x' }], summary: { byCategory } });
  assert.deepStrictEqual(d.groups.map(g => g.category), ['silent failure', 'off by one']);
  assert.strictEqual(d.groups[0].total, 4);
});

test('an absent grouping is an empty list, not a thrown error', () => {
  assert.deepStrictEqual(bugVaultDisplay({ bugs: [], summary: {} }).groups, []);
  assert.deepStrictEqual(bugVaultDisplay({ bugs: [], summary: { byCategory: 'nonsense' } }).groups, []);
});

test('renderer.js actually draws the groups, not just the detection breakdown', () => {
  // THE GAP THIS CLOSES, asserted against source rather than trusted. Every
  // other test here could pass with `groups` going nowhere -- and did.
  const fs = require('fs');
  const path = require('path');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const fn = renderer.slice(renderer.indexOf('function renderBugVault'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /d\.groups/,
    'renderBugVault must use d.groups -- the panel computes the grouping and the PR promises it');
});

test('the element the groups are drawn into exists in renderer.html', () => {
  // The mirror of the side-tabs drift test: a render target that is not in the
  // document silently draws nothing, and renderBugVault returns early when an
  // element is missing, so the WHOLE panel would go blank rather than just the
  // groups.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  assert.match(html, /id="bugvault-groups"/);
});
