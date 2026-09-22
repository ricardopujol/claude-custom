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

const { bugVaultDisplay, formatBugRow, formatGroups, STATES, UNKNOWN } = require('../app/bugvault-display');

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
  // Mortimer, re-run: `rows` and `total` were pinned here and `groups` and
  // `detection` were not, so a damaged vault could still draw category bars
  // and a detection breakdown beside its own error. Same shape as the refusal
  // pattern in the host module -- the failure is asserted, the payload
  // travelling with it is not.
  assert.deepStrictEqual(d.groups, []);
  assert.deepStrictEqual(d.detection, []);
});

test('a payload that has not arrived is still "reading", not "unreadable"', () => {
  // Two different unknowns. One resolves on its own in a moment; the other
  // needs a person. Telling them apart is the entire point of this test file.
  assert.strictEqual(bugVaultDisplay(null).state, 'reading');
  assert.strictEqual(bugVaultDisplay({}).state, 'reading');
});

test('every state this module can return is handled in renderer.js', () => {
  // THE DRIFT THIS PREVENTS. Adding a state to the display module without a
  // matching branch in renderer.js draws a healthy count over a broken vault,
  // with every unit test in this file still green because none of them render.
  //
  // REWRITTEN after Mortimer, PR #29 mutation gate. The first version regexed
  // THIS MODULE'S SOURCE TEXT for `state: '...'` -- asserting the spelling of
  // the source rather than a property of the code. It could not survive
  // Stryker's instrumentation (it failed on the UNMUTATED baseline and had to
  // be skipped by name, costing two full runs), and it would equally not
  // survive minification, a formatter switching to double quotes, or a state
  // name moving into a constant. The states are exported as data now, so this
  // reads a fact instead of scraping a file.
  //
  // Its one good property is kept: it fails loudly if the vocabulary comes
  // back empty, rather than passing vacuously over nothing.
  const fs = require('fs');
  const path = require('path');
  const all = Object.values(STATES);
  assert.ok(all.length >= 4, `the state vocabulary must be populated; got ${JSON.stringify(all)}`);

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const render = renderer.slice(renderer.indexOf('function renderBugVault'));
  const NL = String.fromCharCode(10);
  const body = render.slice(0, render.indexOf(NL + '}' + NL) + 1);
  const unhandled = all.filter(st => !body.includes(`'${st}'`));
  assert.deepStrictEqual(unhandled, [],
    `renderBugVault does not mention these states the display module can return: ${unhandled.join(', ')}`);
});

test('bugVaultDisplay only ever returns a state from the declared vocabulary', () => {
  // The other direction, and what makes the check above meaningful: a state
  // returned but never declared would be handled by neither.
  const all = Object.values(STATES);
  const payloads = [
    undefined, null, {}, { bugs: 'nonsense' },
    { bugs: [], summary: {} },
    { bugs: [], summary: { error: 'boom' } },
    { bugs: [{ category: 'a', summary: 'b' }], summary: {} },
  ];
  for (const p of payloads) {
    const st = bugVaultDisplay(p).state;
    assert.ok(all.includes(st), `${JSON.stringify(p)} produced undeclared state ${st}`);
  }
});

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

// --- Mortimer, PR #29 mutation gate: the display survivors --------------------

test('the not-yet-read state shows NOTHING, not three arrays of junk', () => {
  // D1. The existing state test asserted only `Array.isArray(...)`, so the
  // unknown state could hand the renderer arbitrary content and pass. The
  // entire point of this state is that it shows nothing while it is unknown.
  const d = bugVaultDisplay(undefined);
  assert.deepStrictEqual([d.rows, d.groups, d.detection], [[], [], []]);
  assert.strictEqual(d.total, 0);
  assert.strictEqual(d.fixed, 0);
  assert.strictEqual(d.unfixed, 0);
  assert.strictEqual(d.error, null);
});

test('a malformed byDetection is an empty list, like a malformed byCategory', () => {
  // D2. The symmetric guard was covered on one side only.
  assert.deepStrictEqual(bugVaultDisplay({ bugs: [], summary: { byDetection: 'nonsense' } }).detection, []);
  assert.deepStrictEqual(bugVaultDisplay({ bugs: [], summary: { byDetection: 42 } }).detection, []);
});

test('malformed ELEMENTS inside byCategory are dropped, not rendered or thrown on', () => {
  // D3. The guard tests passed a malformed CONTAINER; nothing passed a
  // malformed ELEMENT, so the `g && typeof g === 'object'` filter could be
  // removed wholesale. With it gone a null group throws at num(g.total) and
  // blanks the whole panel.
  const d = bugVaultDisplay({ bugs: [], summary: { byCategory:
    [null, 'x', 42, undefined, { category: 'real', total: 1, fixed: 0, unfixed: 1 }] } });
  assert.strictEqual(d.groups.length, 1);
  assert.strictEqual(d.groups[0].category, 'real');
});

test('a grouping where nothing has a usable total draws no bar, never a NaN width', () => {
  // D4. `widest > 0` mutated to `>=` computes Math.round((0/0) * 100) = NaN,
  // and the renderer emits `width: NaN%`. The existing test always included
  // one group with a real total, so `widest` was never 0 -- the absence-as-zero
  // trap's cousin, inside the function written to avoid it.
  const d = bugVaultDisplay({ bugs: [], summary: { byCategory: [
    { category: 'a', total: null, fixed: null, unfixed: null },
    { category: 'b', total: undefined, fixed: 0, unfixed: 0 },
  ] } });
  assert.strictEqual(d.groups[0].bar, 0);
  assert.ok(Number.isFinite(d.groups[0].bar), 'a width must always be a real number');
});

test('the open-count label is PRESENT when a class has open bugs', () => {
  // D5. Only the absent case was tested, so forcing the label to null always
  // made it vanish from every group with nothing noticing. Half a two-sided
  // rule is not a rule.
  const d = bugVaultDisplay({ bugs: [], summary: { byCategory: [
    { category: 'a', total: 5, fixed: 3, unfixed: 2 },
  ] } });
  assert.strictEqual(d.groups[0].openLabel, '2 open');
});

test('a whitespace-only field renders as the dash, not as blank space', () => {
  // D6. The placeholder test passed `null` only. Dropping `.trim()` leaves
  // '   ' truthy, so a recorded-but-empty field renders as blank -- exactly
  // the "a blank cell and a recorded-but-empty cell must not look alike" rule
  // stated in the function's own comment, and tested nowhere.
  const row = formatBugRow({ category: '   ', whereFound: '  ', detectedBy: '\t', survived: '\n' });
  assert.strictEqual(row.category, UNKNOWN);
  assert.strictEqual(row.whereFound, UNKNOWN);
  assert.strictEqual(row.detectedBy, UNKNOWN);
  assert.strictEqual(row.survived, UNKNOWN);
});

test('a record with no id reports null, not undefined', () => {
  // The tolerance test asserted only `doesNotThrow`, so the id could become
  // undefined -- which reaches the DOM as the string "undefined" in a
  // data-id attribute and makes the toggle button address a row that is not
  // there.
  assert.strictEqual(formatBugRow({}).id, null);
  assert.strictEqual(formatBugRow({ id: 42 }).id, null);
});

test('sorting the rows does not reorder the caller\u2019s array', () => {
  // Mortimer: `bugs.slice()` -> `bugs` makes the sort mutate the host's
  // payload in place. Nothing owns that array here, and the next reader of it
  // would silently see a different order than the host sent.
  const payload = {
    bugs: [{ id: 'a', fixed: true }, { id: 'b', fixed: false }, { id: 'c', fixed: true }],
    summary: {},
  };
  const before = payload.bugs.map(b => b.id);
  bugVaultDisplay(payload);
  assert.deepStrictEqual(payload.bugs.map(b => b.id), before, 'the input must be left alone');
});

test('a null entry in the bug list does not throw in the sort comparator', () => {
  // The count guard was tested; the comparator's own `b && b.fixed` was not.
  const d = bugVaultDisplay({ bugs: [null, { id: 'a', fixed: true }, { id: 'b', fixed: false }], summary: {} });
  assert.strictEqual(d.total, 3);
  assert.strictEqual(d.rows.length, 3);
});

test('a non-string category in a group falls back to the dash', () => {
  assert.strictEqual(formatGroups([{ category: 42, total: 1, fixed: 0, unfixed: 1 }])[0].category, UNKNOWN);
  assert.strictEqual(formatGroups([{ category: null, total: 1, fixed: 0, unfixed: 1 }])[0].category, UNKNOWN);
});

test('NaN and Infinity in a group become 0, not a NaN bar', () => {
  // Mortimer and I disagreed on filing this one, and he is right that it is
  // NOT the wording class. It is an UNREACHABLE-INPUT guard: NaN and Infinity
  // cannot cross the control socket, because JSON.stringify turns both into
  // null and `num(null)` is already 0. The distinction matters because an
  // unreachable-input mutant goes live the moment a second caller appears,
  // and `formatGroups` is a public export of this module. One line, no
  // brittleness, so it is cheaper to assert than to keep reasoning about.
  assert.deepStrictEqual(
    formatGroups([{ category: 'a', total: NaN, fixed: Infinity, unfixed: 0 }])[0],
    { category: 'a', total: 0, fixed: 0, unfixed: 0, bar: 0, openLabel: null });
});
