'use strict';
/**
 * git prints `--date=short` and `%(committerdate:short)` in the zone STORED in the commit, not the
 * viewer's (Dexter, PR #88 F1). The ledger's days are the viewer's local days (host/branch-ledger.js
 * localDay), so the git side must ask for `short-local` or a merge stored in another zone lands on a
 * different day than the work before it. A real repo with a merge dated in -0800, read in a child
 * process whose TZ is Auckland: the stored day and the local day differ.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { tmpDir } = require('./tmp-dir');

function git(cwd, args, date) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

test('merge and ref days are the viewer\'s local day, whatever zone the commit was stored in', () => {
  const dir = tmpDir('cc-gh-');
  const stored = '2026-09-20T23:30:00-0800'; // = 2026-09-21T07:30Z = 2026-09-21 20:30 in Auckland
  git(dir, ['init', '-q', '-b', 'develop']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'root'], stored);
  git(dir, ['checkout', '-q', '-b', 'feat/x']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'work'], stored);
  git(dir, ['checkout', '-q', 'develop']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from o/feat/x', 'feat/x'], stored);

  const script = `
    const { readHistory, defaultRun, REF_FORMAT, parseRefs } = require(${JSON.stringify(path.resolve(__dirname, '../host/git-history'))});
    (async () => {
      const h = await readHistory(${JSON.stringify(dir)});
      const refs = parseRefs(await defaultRun(['for-each-ref', REF_FORMAT, 'refs/heads'], ${JSON.stringify(dir)}));
      process.stdout.write(JSON.stringify({ merge: h.merges[0].date, ref: refs.find(r => r.name === 'feat/x').date }));
    })();`;
  const env = { ...process.env, TZ: 'Pacific/Auckland' };
  delete env.ELECTRON_RUN_AS_NODE;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
  assert.deepStrictEqual(out, { merge: '2026-09-21', ref: '2026-09-21' });
});
