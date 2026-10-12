'use strict';
/**
 * Review verdicts for the Git drawer (documentation/DESIGN_GIT_TREE.md, "Enhancement #46"). The reports
 * live in ~/.claude/reviews/<project>/YYYY-MM-DD-<branch-dir>-<reviewer>[-rN].md. The LATEST report per
 * reviewer (latest date, then round: PR #93 Dexter F7), and a verdict line read the merge gate's way
 * (review-status.ps1), best effort -- "report, no verdict line" when it can't be found. Pure, with the file system injected.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const path = require('path');
const R = require('../host/review-reports');

test('branchDir: the worktree layout\'s folder name for a branch', () => {
  assert.strictEqual(R.branchDir('feat/git-tree-living'), 'feat-git-tree-living');
  assert.strictEqual(R.branchDir('fix/a/b'), 'fix-a-b');
  assert.strictEqual(R.branchDir('plain'), 'plain');
});

test('parseName: date, reviewer and round for this branch; round defaults to 1', () => {
  assert.deepStrictEqual(R.parseName('2026-10-02-feat-tab-marks-dexter-r2.md', 'feat-tab-marks'),
    { date: '2026-10-02', reviewer: 'dexter', round: 2 });
  assert.deepStrictEqual(R.parseName('2026-10-02-feat-tab-marks-miguel.md', 'feat-tab-marks'),
    { date: '2026-10-02', reviewer: 'miguel', round: 1 });
  assert.deepStrictEqual(R.parseName('2026-10-02-fix-x-mortimer-r10.md', 'fix-x'),
    { date: '2026-10-02', reviewer: 'mortimer', round: 10 });
});

test('parseName: only the three reviewers, only .md, only this branch\'s exact folder name', () => {
  assert.strictEqual(R.parseName('2026-10-02-feat-tab-marks-paris-r1.md', 'feat-tab-marks'), null);
  assert.strictEqual(R.parseName('2026-10-02-feat-tab-marks-dexter-r1.txt', 'feat-tab-marks'), null);
  assert.strictEqual(R.parseName('2026-10-02-feat-tab-marks-dexter-r1.md.bak', 'feat-tab-marks'), null);
  // feat/git-tree must not claim the reports of feat/git-tree-living
  assert.strictEqual(R.parseName('2026-10-01-feat-git-tree-living-dexter-r1.md', 'feat-git-tree'), null);
  assert.notStrictEqual(R.parseName('2026-10-01-feat-git-tree-living-dexter-r1.md', 'feat-git-tree-living'), null);
  assert.strictEqual(R.parseName('feat-tab-marks-dexter-r1.md', 'feat-tab-marks'), null, 'no date');
  assert.strictEqual(R.parseName('x2026-10-02-feat-tab-marks-dexter-r1.md', 'feat-tab-marks'), null, 'anchored at the start');
});

test('parseName: a branch name is data -- regex characters in it are literal', () => {
  assert.strictEqual(R.parseName('2026-10-02-fix-a.b-dexter-r1.md', 'fix-a.b') !== null, true);
  assert.strictEqual(R.parseName('2026-10-02-fix-aXb-dexter-r1.md', 'fix-a.b'), null);
  assert.strictEqual(R.parseName('2026-10-02-x-dexter-r1.md', '(x|y)+'), null);
});

test('verdictLine: the forms review-status.ps1 reads', () => {
  assert.strictEqual(R.verdictLine('# t\n\n## Verdict: **DEFECTIVE**\n'), 'DEFECTIVE');
  assert.strictEqual(R.verdictLine('x\n**Verdict: DEFECTIVE.** Finding 1 is a counterexample\n'), 'DEFECTIVE. Finding 1 is a counterexample');
  assert.strictEqual(R.verdictLine('x\n## Veredicto: APROBADO CON CAMBIOS MENORES\ny'), 'APROBADO CON CAMBIOS MENORES');
  assert.strictEqual(R.verdictLine('x\n## Verdict\n\nCLEAN: ship it\n'), 'CLEAN: ship it');
  assert.strictEqual(R.verdictLine('x\n**Verdict**\nNeeds work'), 'Needs work');
});

test('verdictLine: a bare "Verdict: X" line (Miguel\'s r1 style) counts, but a sentence that starts with the word does not', () => {
  assert.strictEqual(R.verdictLine('# Miguel review\n\nVerdict: APROBADO CON CAMBIOS MENORES\n\n## Rojos'), 'APROBADO CON CAMBIOS MENORES');
  assert.strictEqual(R.verdictLine('Verdicts are given below.\nnothing else'), null);
});

test('verdictLine: the first verdict wins, CRLF is fine, and none is null (the drawer says "report, no verdict line")', () => {
  assert.strictEqual(R.verdictLine('## Verdict: **A**\r\n## Verdict: **B**\r\n'), 'A');
  assert.strictEqual(R.verdictLine('no such thing here'), null);
  assert.strictEqual(R.verdictLine(''), null);
  assert.strictEqual(R.verdictLine(undefined), null);
  assert.strictEqual(R.verdictLine('## Verdict\n\n\n'), null, 'a heading with nothing after it is no verdict');
});

test('verdictLine: a very long line is cut so the drawer stays small', () => {
  const v = R.verdictLine(`## Verdict: ${'word '.repeat(200)}`);
  assert.ok(v.length <= R.MAX_VERDICT_CHARS + 1, String(v.length));
});

// PR #93 Dexter F7: a round number is unique only within its date (-r2 is added when the same DATED file
// exists), so the latest report is the latest date, then the highest round on it.
test('latest: the latest date per reviewer, then the highest round on that date', () => {
  const names = [
    '2026-10-01-feat-x-dexter-r1.md', '2026-10-02-feat-x-dexter-r2.md', '2026-10-03-feat-x-dexter-r1.md',
    '2026-10-01-feat-x-miguel.md', '2026-10-02-feat-x-miguel.md', '2026-10-02-feat-y-miguel-r9.md',
    '2026-10-02-feat-x-mortimer.md', '2026-10-02-feat-x-mortimer-r2.md',
    'notes.md',
  ];
  const got = R.latest(names, 'feat-x');
  assert.deepStrictEqual(got.map(g => [g.reviewer, g.round, g.date, g.file]), [
    ['dexter', 1, '2026-10-03', '2026-10-03-feat-x-dexter-r1.md'],
    ['miguel', 1, '2026-10-02', '2026-10-02-feat-x-miguel.md'],
    ['mortimer', 2, '2026-10-02', '2026-10-02-feat-x-mortimer-r2.md'],
  ]);
});

test("Dexter F7: a re-review the next day (round 1 again) beats yesterday's round 2", () => {
  const got = R.latest(['2026-10-01-feat-x-dexter.md', '2026-10-01-feat-x-dexter-r2.md', '2026-10-02-feat-x-dexter.md'], 'feat-x');
  assert.deepStrictEqual(got.map(g => [g.reviewer, g.date, g.round]), [['dexter', '2026-10-02', 1]]);
  // whatever order the folder lists them in
  const back = R.latest(['2026-10-02-feat-x-dexter.md', '2026-10-01-feat-x-dexter-r2.md', '2026-10-01-feat-x-dexter.md'], 'feat-x');
  assert.deepStrictEqual(back.map(g => [g.date, g.round]), [['2026-10-02', 1]]);
});

test('property: exactly one entry per reviewer present, each the latest (date, round) of its files', () => {
  const reviewer = fc.constantFrom('dexter', 'miguel', 'mortimer', 'gordo', 'vladimir');
  fc.assert(fc.property(fc.array(fc.record({ reviewer, round: fc.integer({ min: 1, max: 6 }), day: fc.integer({ min: 1, max: 28 }) }), { maxLength: 20 }),
    (files) => {
      const names = files.map(f => `2026-10-${String(f.day).padStart(2, '0')}-feat-x-${f.reviewer}-r${f.round}.md`);
      const got = R.latest(names, 'feat-x');
      const who = new Set(files.map(f => f.reviewer));
      assert.strictEqual(got.length, who.size);
      for (const g of got) {
        const mine = files.filter(f => f.reviewer === g.reviewer);
        const day = Math.max(...mine.map(f => f.day));
        const max = Math.max(...mine.filter(f => f.day === day).map(f => f.round));
        assert.strictEqual(g.date, `2026-10-${String(day).padStart(2, '0')}`);
        assert.strictEqual(g.round, max);
      }
    }));
});

function fakeFs(files) {
  return {
    readdirSync: (dir) => { if (!(dir in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return Object.keys(files[dir]); },
    readFileSync: (p) => {
      const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      const dir = p.slice(0, slash);
      const name = p.slice(slash + 1);
      if (!(dir in files) || !(name in files[dir])) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[dir][name];
    },
  };
}

test('read: the latest report per reviewer with its verdict, from the project\'s review folder', () => {
  const dir = path.join('/home/r/.claude/reviews', 'proj');
  const fs = fakeFs({ [dir]: {
    '2026-10-01-feat-a-dexter-r1.md': '## Verdict: **DEFECTIVE**',
    '2026-10-02-feat-a-dexter-r2.md': '## Verdict: **CLEAN**',
    '2026-10-02-feat-a-miguel.md': 'prose, no verdict',
    '2026-10-02-feat-b-miguel.md': '## Verdict: **OTHER BRANCH**',
  } });
  const got = R.read({ reviewsRoot: '/home/r/.claude/reviews', project: 'proj', branch: 'feat/a', fs });
  assert.deepStrictEqual(got, [
    { reviewer: 'Dexter', round: 2, date: '2026-10-02', verdict: 'CLEAN' },
    { reviewer: 'Miguel', round: 1, date: '2026-10-02', verdict: null },
  ]);
});

test('read: no folder, an unreadable folder or an unreadable file is "no reports" / "no verdict", never a throw', () => {
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: 'nope', branch: 'feat/a', fs: fakeFs({}) }), []);
  const dir = '/x/proj';
  const fs = { readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'], readFileSync: () => { throw new Error('EBUSY'); } };
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: 'proj', branch: 'feat/a', fs }),
    [{ reviewer: 'Dexter', round: 1, date: '2026-10-02', verdict: null }]);
  assert.ok(dir);
});

test('read: a project name that is a path is refused (it would walk out of the reviews folder)', () => {
  const fs = fakeFs({ [path.join('/x', '..')]: { '2026-10-02-feat-a-dexter-r1.md': '## Verdict: **X**' } });
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: '..', branch: 'feat/a', fs }), []);
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: 'a/b', branch: 'feat/a', fs }), []);
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: '', branch: 'feat/a', fs }), []);
});

test('createReader: a report is read once while its size and time are unchanged', () => {
  const dir = '/x/proj';
  let reads = 0;
  let mtime = 1;
  const fs = {
    readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'],
    statSync: () => ({ mtimeMs: mtime, size: 10 }),
    readFileSync: () => { reads += 1; return `## Verdict: **V${reads}**`; },
  };
  const read = R.createReader({ reviewsRoot: '/x', project: 'proj', fs });
  assert.strictEqual(read('feat/a')[0].verdict, 'V1');
  assert.strictEqual(read('feat/a')[0].verdict, 'V1');
  assert.strictEqual(reads, 1);
  mtime = 2;
  assert.strictEqual(read('feat/a')[0].verdict, 'V2', 'a changed report is read again');
  assert.ok(dir);
});

test('createReader: lists the folder once per call of refresh(), not once per branch', () => {
  let lists = 0;
  const fs = {
    readdirSync: () => { lists += 1; return ['2026-10-02-feat-a-dexter-r1.md', '2026-10-02-feat-b-miguel.md']; },
    statSync: () => ({ mtimeMs: 1, size: 1 }),
    readFileSync: () => '## Verdict: **V**',
  };
  const read = R.createReader({ reviewsRoot: '/x', project: 'proj', fs });
  read.refresh();
  read('feat/a'); read('feat/b'); read('feat/c');
  assert.strictEqual(lists, 1);
  read.refresh();
  read('feat/a');
  assert.strictEqual(lists, 2);
});

// --- Mortimer, release PR #101 gate (backlog #58) --------------------------------------------------------------

test('parseName: a name or folder that is not a string, or a folder that is empty, is no report (never a throw)', () => {
  const valid = '2026-10-02-x-dexter.md';
  assert.notStrictEqual(R.parseName(valid, 'x'), null, 'the baseline matches');
  // a non-string that would coerce to a matching name must not match
  assert.strictEqual(R.parseName({ toString: () => valid }, 'x'), null);
  assert.strictEqual(R.parseName(42, 'x'), null);
  assert.strictEqual(R.parseName(null, 'x'), null);
  // a non-string folder
  assert.doesNotThrow(() => R.parseName(valid, 5));
  assert.strictEqual(R.parseName(valid, 5), null);
  assert.strictEqual(R.parseName(valid, null), null);
  assert.strictEqual(R.parseName(valid, undefined), null);
  assert.strictEqual(R.parseName(valid, { toString: () => 'x', replace: () => 'x' }), null);
  // an empty folder name would match a name with nothing between the date and the reviewer
  assert.strictEqual(R.parseName('2026-10-02--dexter.md', ''), null);
});

test('verdictLine: every accepted spelling gives the text, and near-misses give nothing', () => {
  const v = (s) => R.verdictLine(s);
  // accepted
  assert.strictEqual(v('## Verdict: A'), 'A');
  assert.strictEqual(v('### Verdict: A'), 'A');
  assert.strictEqual(v('# Verdict: A'), 'A');
  assert.strictEqual(v('##Verdict: A'), 'A', 'no space after the hashes');
  assert.strictEqual(v('##   Verdict: A'), 'A', 'several spaces after the hashes');
  assert.strictEqual(v('## Verdict:A'), 'A', 'no space after the colon');
  assert.strictEqual(v('## Verdict : A'), 'A', 'a space before the colon');
  assert.strictEqual(v('## Verdict:**A**'), 'A');
  assert.strictEqual(v('## Verdict   A'), 'A', 'no colon at all');
  assert.strictEqual(v('## Veredicto: A'), 'A');
  assert.strictEqual(v('## Verdicto: A'), 'A');
  assert.strictEqual(v('**Verdict: A**'), 'A');
  assert.strictEqual(v('Verdict: A'), 'A');
  assert.strictEqual(v('Veredicto: A'), 'A');
  assert.strictEqual(v('Verdict:A'), 'A');
  assert.strictEqual(v('Verdict : A'), 'A');
  assert.strictEqual(v('Verdict:   A'), 'A');
  // near-misses
  assert.strictEqual(v('see ## Verdict: A'), null, 'a heading must start the line');
  assert.strictEqual(v('see **Verdict: A**'), null, 'bold must start the line');
  assert.strictEqual(v('see Verdict: A'), null, 'a bare verdict must start the line');
  assert.strictEqual(v('#### Verdict: A'), null, 'four hashes is not a heading it reads');
  assert.strictEqual(v('Verdict A'), null, 'a bare verdict needs its colon');
  assert.strictEqual(v('Verdicts: A'), null);
  assert.strictEqual(v('Veridict: A'), null);
});

test('verdictLine: a verdict that is only emphasis takes the next non-blank line, however blank the lines between are', () => {
  assert.strictEqual(R.verdictLine('## Verdict: ** **\nCLEAN'), 'CLEAN');
  assert.strictEqual(R.verdictLine('## Verdict\n   \n\t\nCLEAN: ship it'), 'CLEAN: ship it');
  assert.strictEqual(R.verdictLine('## Verdict\n   \n'), null, 'only blank lines after it');
  assert.strictEqual(R.verdictLine('## Verdict\n  **  \nCLEAN'), null, 'a line of bare emphasis is the verdict line, and it is empty');
});

test('verdictLine: the text is trimmed of its emphasis and its edges', () => {
  assert.strictEqual(R.verdictLine('## Verdict:    DEFECTIVE   '), 'DEFECTIVE');
  assert.strictEqual(R.verdictLine('## Verdict\n   DEFECTIVE   \n'), 'DEFECTIVE');
  assert.strictEqual(R.verdictLine('## Verdict: **DEFECTIVE** and **bold**'), 'DEFECTIVE and bold');
});

test('verdictLine: exactly MAX_VERDICT_CHARS characters are kept whole; one more is cut with an ellipsis, trimmed at the cut', () => {
  const n = R.MAX_VERDICT_CHARS;
  const whole = 'a'.repeat(n);
  assert.strictEqual(R.verdictLine(`## Verdict: ${whole}`), whole);
  assert.strictEqual(R.verdictLine(`## Verdict: ${whole}b`), `${whole}…`);
  const spaced = `${'a'.repeat(n - 1)} ${'b'.repeat(10)}`;
  assert.strictEqual(R.verdictLine(`## Verdict: ${spaced}`), `${'a'.repeat(n - 1)}…`, 'the space at the cut is dropped');
});

test('latest: two files of the same reviewer, date and round keep the one listed first', () => {
  const got = R.latest(['2026-10-02-x-dexter.md', '2026-10-02-x-dexter-r1.md'], 'x');
  assert.deepStrictEqual(got.map(g => g.file), ['2026-10-02-x-dexter.md']);
  const back = R.latest(['2026-10-02-x-dexter-r1.md', '2026-10-02-x-dexter.md'], 'x');
  assert.deepStrictEqual(back.map(g => g.file), ['2026-10-02-x-dexter-r1.md']);
});

// The project name is a path component: only a plain folder name is allowed through. Both entry points ask
// the file system NOTHING for a refused name (a fs that would answer anything proves it).
test('a project name that is not a plain folder name is refused by read AND by createReader, before any file system call', () => {
  for (const project of ['', '.', '..', 'a/b', 'a\\b', '/abs', 'x/', '..\\x', null, undefined, 42, {}, ['proj']]) {
    const calls = [];
    const fs = {
      readdirSync: (d) => { calls.push(['readdir', d]); return ['2026-10-02-feat-a-dexter-r1.md']; },
      readFileSync: (p) => { calls.push(['read', p]); return '## Verdict: **X**'; },
      statSync: () => ({ mtimeMs: 1, size: 1 }),
    };
    assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project, branch: 'feat/a', fs }), [], `read(${JSON.stringify(project)})`);
    assert.deepStrictEqual(R.createReader({ reviewsRoot: '/x', project, fs })('feat/a'), [], `reader(${JSON.stringify(project)})`);
    assert.deepStrictEqual(calls, [], `${JSON.stringify(project)} must not reach the file system`);
  }
  const ok = { readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'], readFileSync: () => '## Verdict: **X**', statSync: () => ({ mtimeMs: 1, size: 1 }) };
  assert.strictEqual(R.read({ reviewsRoot: '/x', project: 'claude-custom', branch: 'feat/a', fs: ok }).length, 1);
  assert.strictEqual(R.read({ reviewsRoot: '/x', project: '...', branch: 'feat/a', fs: ok }).length, 1, 'three dots is a plain name');
  assert.strictEqual(R.createReader({ reviewsRoot: '/x', project: 'claude-custom', fs: ok })('feat/a').length, 1);
});

test('without a reviewsRoot the reports are looked for under ~/.claude/reviews/<project>', () => {
  const os = require('os');
  const expected = path.join(os.homedir(), '.claude', 'reviews', 'proj');
  const asked = [];
  const fs = { readdirSync: (d) => { asked.push(d); return []; }, readFileSync: () => '', statSync: () => ({ mtimeMs: 1, size: 1 }) };
  R.read({ project: 'proj', branch: 'feat/a', fs });
  R.createReader({ project: 'proj', fs })('feat/a');
  assert.deepStrictEqual(asked, [expected, expected]);
});

test('a report is read as utf8 text', () => {
  const encodings = [];
  const fs = {
    readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'],
    readFileSync: (p, enc) => { encodings.push(enc); return '## Verdict: **X**'; },
    statSync: () => ({ mtimeMs: 1, size: 1 }),
  };
  assert.strictEqual(R.read({ reviewsRoot: '/x', project: 'proj', branch: 'feat/a', fs })[0].verdict, 'X');
  R.createReader({ reviewsRoot: '/x', project: 'proj', fs })('feat/a');
  assert.deepStrictEqual(encodings, ['utf8', 'utf8']);
});

test('createReader: a report whose stat fails is never served from the cache, even if it was cached before', () => {
  let reads = 0;
  let statWorks = true;
  const fs = {
    readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'],
    statSync: () => { if (!statWorks) throw new Error('EBUSY'); return { mtimeMs: 1, size: 10 }; },
    readFileSync: () => { reads += 1; return `## Verdict: **V${reads}**`; },
  };
  const reader = R.createReader({ reviewsRoot: '/x', project: 'proj', fs });
  assert.strictEqual(reader('feat/a')[0].verdict, 'V1');
  assert.strictEqual(reader('feat/a')[0].verdict, 'V1');
  assert.strictEqual(reads, 1);
  statWorks = false;
  assert.strictEqual(reader('feat/a')[0].verdict, 'V2', 'nothing says it is unchanged, so it is read again');
  assert.strictEqual(reader('feat/a')[0].verdict, 'V3');
});

test('createReader: a size change alone, with the same time, is a changed report', () => {
  let size = 10;
  let reads = 0;
  const fs = {
    readdirSync: () => ['2026-10-02-feat-a-dexter-r1.md'],
    statSync: () => ({ mtimeMs: 5, size }),
    readFileSync: () => { reads += 1; return `## Verdict: **V${reads}**`; },
  };
  const reader = R.createReader({ reviewsRoot: '/x', project: 'proj', fs });
  assert.strictEqual(reader('feat/a')[0].verdict, 'V1');
  size = 11;
  assert.strictEqual(reader('feat/a')[0].verdict, 'V2');
});

test('read: a folder that cannot be listed is no reports', () => {
  const fs = { readdirSync: () => { throw new Error('EACCES'); }, readFileSync: () => '' };
  assert.deepStrictEqual(R.read({ reviewsRoot: '/x', project: 'proj', branch: 'feat/a', fs }), []);
  assert.deepStrictEqual(R.createReader({ reviewsRoot: '/x', project: 'proj', fs })('feat/a'), []);
});

test('cast: Gordo and Vladimir reports are found, with their rounds', () => {
  assert.deepStrictEqual(R.parseName('2026-10-10-feat-x-gordo.md', 'feat-x'), { date: '2026-10-10', reviewer: 'gordo', round: 1 });
  assert.deepStrictEqual(R.parseName('2026-10-10-feat-x-gordo-r2.md', 'feat-x'), { date: '2026-10-10', reviewer: 'gordo', round: 2 });
  assert.deepStrictEqual(R.parseName('2026-10-10-feat-x-vladimir.md', 'feat-x'), { date: '2026-10-10', reviewer: 'vladimir', round: 1 });
});

test('cast: REVIEWERS keeps its original order and the new two come after', () => {
  assert.deepStrictEqual(R.REVIEWERS, ['dexter', 'miguel', 'mortimer', 'gordo', 'vladimir']);
});

test('cast: read shows El Gordo and Vladimir by display name, after the original three', () => {
  const dir = path.join('/home/r/.claude/reviews', 'proj');
  const fs = fakeFs({ [dir]: {
    '2026-10-10-feat-a-vladimir.md': '## Verdict: **HARSH**',
    '2026-10-10-feat-a-gordo.md': '## Verdict: **LEAN**',
    '2026-10-10-feat-a-dexter.md': '## Verdict: **CLEAN**',
  } });
  const got = R.read({ reviewsRoot: '/home/r/.claude/reviews', project: 'proj', branch: 'feat/a', fs });
  assert.deepStrictEqual(got.map(g => [g.reviewer, g.verdict]), [['Dexter', 'CLEAN'], ['El Gordo', 'LEAN'], ['Vladimir', 'HARSH']]);
});
