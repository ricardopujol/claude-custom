'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { projectsDisplay, formatTokens } = require('../app/projects-display');

const p = (over = {}) => ({
  path: 'C:/a/thing', name: 'thing', approximate: false,
  lastUsed: Date.now(), tokens: 0, sessions: 1, current: false, ...over,
});

test('the project you are in is marked and not offered as a destination', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ current: true })] });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].current, true);
  assert.strictEqual(rows[0].openable, false, 'clicking it would open the window you are in');
});

test('another project IS offered as a destination', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ current: false })] });
  assert.strictEqual(rows[0].openable, true);
});

test('a failed read says so instead of showing an empty history', () => {
  // `ok:false` means we could not read ~/.claude/projects. Drawing that as "no
  // recent projects" is the absence-reported-as-zero bug in panel form.
  const { note } = projectsDisplay({ ok: false, projects: [] });
  assert.match(note, /could not/i);
});

test('an empty history reads as new, not as broken', () => {
  const { note } = projectsDisplay({ ok: true, projects: [] });
  assert.doesNotMatch(note, /could not/i);
  assert.match(note, /no other/i);
});

test('a path recovered only from a folder name is marked approximate', () => {
  // recent.js cannot always recover the real path: the folder name is a lossy
  // encoding, so "claude-custom" and "claude/custom" are indistinguishable. A
  // row that might be wrong must not look identical to one that is known.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ approximate: true })] });
  assert.strictEqual(rows[0].approximate, true);
  assert.match(rows[0].title, /approximate|guess/i);
});

test('token counts are never invented for a project with none', () => {
  // Number(null) is 0, the trap this codebase names in its own CLAUDE.md. A
  // project whose transcripts carry no usage must not be drawn as "0 tokens",
  // which reads as a fact about the project rather than about our knowledge.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ tokens: null })] });
  assert.doesNotMatch(rows[0].detail, /\b0\b/);
});

test('a real token count IS shown, in the format the code actually emits', () => {
  // Miguel: the previous assertion was /1\.2M|1234567|1,234,567/ -- a
  // three-way alternation accepting two formats this code never produces. Not
  // an overclaim, but a weak assertion by construction: it would pass after a
  // rewrite that changed the output entirely.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ tokens: 1234567 })] });
  assert.strictEqual(rows[0].detail.startsWith('1.2M tokens'), true, rows[0].detail);
});

test('every token-format branch and both boundaries are pinned', () => {
  // Miguel: only the M branch was exercised. The k branch, the bare branch and
  // the 1e3/1e6 boundaries were all unasserted -- and this module is in
  // stryker.conf.json's mutate list now, so every one of them would come back
  // as a survivor. Cheaper to write than to read in a report.
  const detail = (tokens) => projectsDisplay({ ok: true, projects: [p({ tokens })] }).rows[0].detail;
  assert.ok(detail(999).startsWith('999 tokens'), detail(999));
  assert.ok(detail(1000).startsWith('1k tokens'), 'the 1e3 boundary is k, not bare');
  assert.ok(detail(999999).startsWith('1000k tokens'), detail(999999));
  assert.ok(detail(1000000).startsWith('1.0M tokens'), 'the 1e6 boundary is M, not k');
});

test('one session is singular and two are plural', () => {
  const detail = (sessions) =>
    projectsDisplay({ ok: true, projects: [p({ tokens: 5, sessions })] }).rows[0].detail;
  assert.ok(detail(1).includes('1 session') && !detail(1).includes('1 sessions'));
  assert.ok(detail(2).includes('2 sessions'));
});

test('an APPROXIMATE row is not offered as a destination, because it cannot open', () => {
  // Dexter, PR #31 Finding 6. When a project's transcripts yield no cwd (all
  // reads fail, or the only .jsonl is empty), recent.js falls back to the
  // ~/.claude/projects FOLDER NAME and marks the row approximate. That name is
  // not a path -- it is a lossy encoding, `C--Users-ricar-VibeCode-thing` --
  // and it went straight into data-open, so clicking it sent
  // {type:'open', path:'C--Users-…'}, which the host resolved against the
  // CURRENT project and reported as "no such folder:
  // C:\<current project>\C--Users-…", a path that has never existed anywhere.
  //
  // The row was also labelled as if it were real: named after the last
  // dash-segment, with a tooltip saying "approximate -- recovered from the
  // folder name", while `path` was not a recovered path at all.
  const { rows } = projectsDisplay({ ok: true, projects: [p({ approximate: true })] });
  assert.strictEqual(rows[0].openable, false,
    'a row whose path is a guess must not be clickable');
  assert.strictEqual(rows[0].approximate, true, 'but it must still be shown, and marked');
});

test('a known row is still openable', () => {
  const { rows } = projectsDisplay({ ok: true, projects: [p({ approximate: false })] });
  assert.strictEqual(rows[0].openable, true);
});

test('absence renders as NOTHING, and a measured zero still renders as zero', () => {
  // MUTATION-DRIVEN, and the more instructive of the two Criticals. Mortimer:
  // `known` -- this codebase's named `Number(null) === 0` trap turned into a
  // function, and the rule this module's header is written around -- can be
  // replaced with `v => true` and the whole suite passes.
  //
  // THE TEST FOR THIS EXACT RULE IS THE ONE THAT MISSED IT. The test above is
  // called 'token counts are never invented for a project with none' and
  // asserts `doesNotMatch(detail, /\b0\b/)`. With the guard gone,
  // formatTokens(null) falls past both thresholds and returns the string
  // "null tokens" -- which contains no digit 0, so the assertion passes. It
  // checked that the character `0` was absent from the output rather than that
  // the absence produced nothing: it pinned the SPELLING of the bug that was
  // found once, not the rule.
  //
  // That is the coverage-is-a-liar pattern with an assertion standing in for
  // the coverage, and it is the seventh time on these two branches that a
  // test of mine claimed more than it checked.
  for (const absent of [null, undefined, '', '1234', NaN, Infinity, -Infinity, {}, [], true]) {
    assert.strictEqual(formatTokens(absent), null,
      `formatTokens(${JSON.stringify(absent)}) must be null, not a rendered guess`);
  }

  // The pair is the whole point: "we have no usage for this project" and "this
  // project has zero usage" are DIFFERENT CLAIMS and must not collapse.
  assert.strictEqual(formatTokens(0), '0 tokens', 'a measured zero IS zero');

  const row = projectsDisplay({ ok: true, projects: [p({ tokens: null, sessions: null })] }).rows[0];
  assert.strictEqual(row.detail, '',
    `absence must draw nothing, got ${JSON.stringify(row.detail)}`);
});

test('a healthy list explains nothing, and zero sessions is not worth drawing', () => {
  // Mortimer Survivors 10 and 11. `note` is the panel's explanation field, and
  // nothing asserted that a NORMAL list produces no note -- so every mutant
  // that makes one appear survived. And the sessions bit is the same
  // absence-vs-zero family as the tokens bit: a project with a real
  // `sessions: 0` was rendering "0 sessions".
  const { note } = projectsDisplay({ ok: true, projects: [p({ current: false })] });
  assert.strictEqual(note, '', 'a healthy list explains nothing');

  assert.strictEqual(
    projectsDisplay({ ok: true, projects: [p({ tokens: 5, sessions: 0 })] }).rows[0].detail,
    '5 tokens', 'zero sessions is not a bit worth drawing');
  assert.strictEqual(
    projectsDisplay({ ok: true, projects: [p({ tokens: null, sessions: '5' })] }).rows[0].detail,
    '', 'a non-numeric session count is not a session count');
});

test('the row name, separator and pluralisation are exact', () => {
  // Mortimer Survivor 12. The plural mutant survived because the earlier test
  // used includes('1 session') && !includes('1 sessions') -- substring checks
  // that a suffix injection slips straight through. Exact equality is what
  // kills it. And `|| []` survived because every test passes a projects array;
  // a payload with the key ABSENT was untested.
  assert.strictEqual(
    projectsDisplay({ ok: true, projects: [p({ name: 'thing' })] }).rows[0].name, 'thing');
  assert.strictEqual(
    projectsDisplay({ ok: true, projects: [p({ name: '' })] }).rows[0].name, 'C:/a/thing',
    'a nameless row falls back to its path');
  assert.strictEqual(
    projectsDisplay({ ok: true, projects: [p({ tokens: 5, sessions: 1 })] }).rows[0].detail,
    '5 tokens · 1 session', 'exact, because includes() let the plural mutant live');
  assert.deepStrictEqual(projectsDisplay({ ok: true }).rows, [],
    'a payload with no projects list draws no rows');
});
