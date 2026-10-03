'use strict';
/**
 * Review verdicts for the Git drawer (documentation/DESIGN_GIT_TREE.md, "Enhancement #46"). The reports
 * live in ~/.claude/reviews/<project>/YYYY-MM-DD-<branch-dir>-<reviewer>[-rN].md. The rules are the merge
 * gate's own (the worktree skill's review-status.ps1): the LATEST round per reviewer, and a verdict line
 * read best effort -- "report, no verdict line" when it can't be found. Pure, with the file system injected.
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

test('latest: the highest round per reviewer, then the later date', () => {
  const names = [
    '2026-10-01-feat-x-dexter-r1.md', '2026-10-02-feat-x-dexter-r2.md', '2026-10-03-feat-x-dexter-r1.md',
    '2026-10-01-feat-x-miguel.md', '2026-10-02-feat-x-miguel.md', '2026-10-02-feat-y-miguel-r9.md',
    'notes.md',
  ];
  const got = R.latest(names, 'feat-x');
  assert.deepStrictEqual(got.map(g => [g.reviewer, g.round, g.date, g.file]), [
    ['dexter', 2, '2026-10-02', '2026-10-02-feat-x-dexter-r2.md'],
    ['miguel', 1, '2026-10-02', '2026-10-02-feat-x-miguel.md'],
  ]);
});

test('property: exactly one entry per reviewer present, each the maximum round of its files', () => {
  const reviewer = fc.constantFrom('dexter', 'miguel', 'mortimer');
  fc.assert(fc.property(fc.array(fc.record({ reviewer, round: fc.integer({ min: 1, max: 6 }), day: fc.integer({ min: 1, max: 28 }) }), { maxLength: 20 }),
    (files) => {
      const names = files.map(f => `2026-10-${String(f.day).padStart(2, '0')}-feat-x-${f.reviewer}-r${f.round}.md`);
      const got = R.latest(names, 'feat-x');
      const who = new Set(files.map(f => f.reviewer));
      assert.strictEqual(got.length, who.size);
      for (const g of got) {
        const max = Math.max(...files.filter(f => f.reviewer === g.reviewer).map(f => f.round));
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
