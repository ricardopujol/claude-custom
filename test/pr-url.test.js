'use strict';
/**
 * The GitHub page of a PR, from `origin`'s URL (documentation/DESIGN_GIT_TREE.md, "Enhancement #46":
 * *Open PR #N*). No remote, or a remote that isn't GitHub, is null -- the action is then disabled and
 * says why. A remote's URL can carry a token (`https://user:token@github.com/o/r.git`): it never
 * reaches a page, a message or a browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { repoUrl, prUrl, parseRemoteUrl } = require('../host/pr-url');

test('https, with or without .git, a trailing slash or a newline', () => {
  assert.strictEqual(repoUrl('https://github.com/ricardopujol/claude-custom.git'), 'https://github.com/ricardopujol/claude-custom');
  assert.strictEqual(repoUrl('https://github.com/ricardopujol/claude-custom'), 'https://github.com/ricardopujol/claude-custom');
  assert.strictEqual(repoUrl('https://github.com/o/r/\n'), 'https://github.com/o/r');
  assert.strictEqual(repoUrl('  https://github.com/o/r.git  '), 'https://github.com/o/r');
});

test('scp-like and ssh remotes', () => {
  assert.strictEqual(repoUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.strictEqual(repoUrl('git@github.com:o/r'), 'https://github.com/o/r');
  assert.strictEqual(repoUrl('ssh://git@github.com/o/r.git'), 'https://github.com/o/r');
  assert.strictEqual(repoUrl('ssh://git@github.com:22/o/r.git'), 'https://github.com/o/r');
  assert.strictEqual(repoUrl('git://github.com/o/r.git'), 'https://github.com/o/r');
});

test('credentials in the remote never come out', () => {
  const out = repoUrl('https://ricardo:ghp_SECRETTOKEN@github.com/o/r.git');
  assert.strictEqual(out, 'https://github.com/o/r');
  assert.ok(!/ghp_|ricardo|@/.test(out));
});

test('names with dots, dashes and underscores; the host is case-insensitive', () => {
  assert.strictEqual(repoUrl('https://GitHub.com/my-org/my_repo.js.git'), 'https://github.com/my-org/my_repo.js');
});

test('not GitHub, not a remote, not a string: null', () => {
  for (const bad of ['https://gitlab.com/o/r.git', 'git@bitbucket.org:o/r.git', 'https://github.com.evil.example/o/r', 'https://evil.example/github.com/o/r',
    'https://github.com/o', 'https://github.com/', 'https://github.com/o/r/extra', 'file:///C:/repo', 'C:\\repo', '', '   ', null, undefined, 42, {}]) {
    assert.strictEqual(repoUrl(bad), null, String(bad));
  }
});

test('a repo name that would climb out of the path is refused', () => {
  assert.strictEqual(repoUrl('https://github.com/o/..'), null);
  assert.strictEqual(repoUrl('https://github.com/../r'), null);
  assert.strictEqual(repoUrl('https://github.com/o/r?x=1'), null);
  assert.strictEqual(repoUrl('https://github.com/o/r#frag'), null);
});

test('prUrl: the pull page, for a positive whole PR number only', () => {
  assert.strictEqual(prUrl('https://github.com/o/r', 91), 'https://github.com/o/r/pull/91');
  for (const bad of [0, -1, 1.5, NaN, Infinity, '91', null, undefined]) assert.strictEqual(prUrl('https://github.com/o/r', bad), null, String(bad));
  assert.strictEqual(prUrl(null, 91), null, 'no remote');
});

test('parseRemoteUrl: owner and repo', () => {
  assert.deepStrictEqual(parseRemoteUrl('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.strictEqual(parseRemoteUrl('nope'), null);
});

test('property: whatever the remote spelling, the result is https://github.com/<owner>/<repo> with no credentials', () => {
  const part = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,12}$/).filter(s => s !== '.' && s !== '..' && !s.endsWith('.git'));
  const spell = fc.constantFrom(
    (o, r) => `https://github.com/${o}/${r}.git`, (o, r) => `https://github.com/${o}/${r}`, (o, r) => `git@github.com:${o}/${r}.git`,
    (o, r) => `ssh://git@github.com/${o}/${r}.git`, (o, r) => `https://u:p@github.com/${o}/${r}.git`);
  fc.assert(fc.property(part, part, spell, (o, r, f) => {
    assert.strictEqual(repoUrl(f(o, r)), `https://github.com/${o}/${r}`);
  }));
});
