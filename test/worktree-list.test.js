'use strict';
/**
 * `git worktree list --porcelain` into tab candidates. Design:
 * documentation/PLAN_WORKTREE_TABS.md (tab = git worktree, `dev` first).
 *
 * The sample is the real output of this repo on 2026-09-29, rewritten under a
 * fake container, plus the record kinds it happened not to contain (detached,
 * prunable, bare, locked). Pure: no fs, no git.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fc = require('fast-check');

const { parsePorcelain, tabWorktrees, isSibling } = require('../host/worktree-list');
const { samePath, isInside } = require('../host/project-layout');
const { isValidBranchName } = require('../host/git-branch');

const C = path.resolve('/fake/proj');
const DEV = path.join(C, 'dev');
const git = (p) => p.replace(/\\/g, '/');          // git prints forward slashes
const at = (...parts) => git(path.join(C, ...parts));

const SAMPLE = [
  `worktree ${at('dev')}`,
  'HEAD 765ee008ee548055970882a0062f31933838d8ce',
  'branch refs/heads/develop',
  '',
  `worktree ${at('dev', '.claude', 'worktrees', 'agent-a170cc9475319264e')}`,
  'HEAD 03263a79c0236152213afb800252f994c63b65a0',
  'branch refs/heads/feat/vault-format-2',
  '',
  `worktree ${at('feat-worktree-model')}`,
  'HEAD 167d27e7914c1b067c799d2d90dc870785cc619c',
  'branch refs/heads/feat/worktree-model',
  '',
  `worktree ${at('fix-resumed-agent')}`,
  'HEAD a8b08a634eb10ffacd4937345dd739e7c24f6c4c',
  'branch refs/heads/fix/resumed-agent-activity',
  '',
  `worktree ${at('gate-2026-09-28')}`,
  'HEAD 765ee008ee548055970882a0062f31933838d8ce',
  'detached',
  '',
].join('\n');

function record(p, lines) {
  return [`worktree ${git(p)}`, 'HEAD 765ee008ee548055970882a0062f31933838d8ce', ...lines, ''].join('\n');
}
const devRecord = record(DEV, ['branch refs/heads/develop']);

// ---------------------------------------------------------------------------
// parsePorcelain

test('parsePorcelain reads every field of the real sample', () => {
  const entries = parsePorcelain(SAMPLE);
  assert.strictEqual(entries.length, 5);
  assert.deepStrictEqual(entries[0], {
    path: at('dev'), head: '765ee008ee548055970882a0062f31933838d8ce', branch: 'refs/heads/develop',
    bare: false, detached: false, locked: false, lockReason: null, prunable: false,
  });
  assert.deepStrictEqual(entries[4], {
    path: at('gate-2026-09-28'), head: '765ee008ee548055970882a0062f31933838d8ce', branch: null,
    bare: false, detached: true, locked: false, lockReason: null, prunable: false,
  });
});

test('parsePorcelain accepts CRLF exactly as LF', () => {
  assert.deepStrictEqual(parsePorcelain(SAMPLE.replace(/\n/g, '\r\n')), parsePorcelain(SAMPLE));
});

test('parsePorcelain reads bare, and locked / prunable with or without a reason', () => {
  const text = [
    record(path.join(C, 'a'), ['bare']),
    record(path.join(C, 'b'), ['branch refs/heads/b', 'locked']),
    record(path.join(C, 'c'), ['branch refs/heads/c', 'locked moved to a USB drive']),
    record(path.join(C, 'd'), ['branch refs/heads/d', 'prunable gitdir file points to non-existent location']),
  ].join('\n');
  const [a, b, c, d] = parsePorcelain(text);
  assert.strictEqual(a.bare, true);
  assert.strictEqual(b.locked, true);
  assert.strictEqual(b.lockReason, null);
  assert.strictEqual(c.locked, true);
  assert.strictEqual(c.lockReason, 'moved to a USB drive');
  assert.strictEqual(d.prunable, true);
  assert.strictEqual(d.locked, false);
});

test('parsePorcelain keeps the last record when the text has no trailing blank line', () => {
  const entries = parsePorcelain(SAMPLE.trimEnd());
  assert.strictEqual(entries.length, 5);
  assert.strictEqual(entries[4].detached, true);
});

test('parsePorcelain ignores unknown lines and drops a record with no worktree line', () => {
  const text = [
    'HEAD 03263a79c0236152213afb800252f994c63b65a0',
    'branch refs/heads/orphan',
    '',
    `worktree ${at('dev')}`,
    'some-future-attribute yes',
    'branch refs/heads/develop',
    '',
  ].join('\n');
  const entries = parsePorcelain(text);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, at('dev'));
  assert.strictEqual(entries[0].branch, 'refs/heads/develop');
});

test('parsePorcelain drops a worktree line with no path', () => {
  const text = ['worktree ', 'branch refs/heads/a', '', devRecord].join('\n');
  const entries = parsePorcelain(text);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, at('dev'));
});

// path.resolve('') is the cwd; an empty path must never become "wherever the
// host happens to run" and land a tab there.
test('an entry with an empty path gets no tab even when the cwd is a sibling', (t) => {
  const fs = require('fs');
  const { tmpDir } = require('./tmp-dir');
  const container = tmpDir('worktree-list-test-');
  const sibling = path.join(container, 'feat-cwd');
  fs.mkdirSync(sibling);
  const before = process.cwd();
  process.chdir(sibling);
  t.after(() => process.chdir(before));
  const entries = [
    { path: git(path.join(container, 'dev')), branch: 'refs/heads/develop' },
    { path: '', branch: 'refs/heads/a' },
  ];
  assert.deepStrictEqual(tabWorktrees(entries, container).map(x => x.isDev), [true]);
  assert.strictEqual(isSibling(container, ''), false);
});

test('parsePorcelain keeps a path with spaces whole', () => {
  const [e] = parsePorcelain(record(path.join(C, 'feat x y'), ['branch refs/heads/x']));
  assert.strictEqual(e.path, at('feat x y'));
});

test('parsePorcelain returns [] for anything that is not a string', () => {
  for (const v of [null, undefined, 42, {}, [], true]) assert.deepStrictEqual(parsePorcelain(v), []);
  assert.deepStrictEqual(parsePorcelain(''), []);
  assert.deepStrictEqual(parsePorcelain('garbage\nmore garbage\n'), []);
});

// ---------------------------------------------------------------------------
// tabWorktrees

// Every entry is a worktree git still LISTS (so an open tab on it stays);
// `openable` says whether a NEW tab may open for it. Keeping the two apart is
// what stops a rebase (detached HEAD) from reading as "the worktree is gone"
// and killing its session (Dexter F1 / Miguel F1, 2026-09-29).
const openable = (p, branch) => ({ path: p, branch, isDev: false, openable: true });
const listedOnly = (p, branch = null) => ({ path: p, branch, isDev: false, openable: false });
const devTab = (branch = 'develop') => ({ path: DEV, branch, isDev: true, openable: true });

test('tabWorktrees on the real sample: dev first, then the siblings in list order', () => {
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(SAMPLE), C), [
    devTab(),
    openable(path.join(C, 'feat-worktree-model'), 'feat/worktree-model'),
    openable(path.join(C, 'fix-resumed-agent'), 'fix/resumed-agent-activity'),
    listedOnly(path.join(C, 'gate-2026-09-28')),
  ]);
});

test('a detached sibling is listed but not openable; a detached dev is still the anchor', () => {
  const text = [
    record(DEV, ['detached']),
    record(path.join(C, 'gate-2026-09-28'), ['detached']),
  ].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C),
    [devTab(null), listedOnly(path.join(C, 'gate-2026-09-28'))]);
});

test('prunable, bare and non-branch-ref siblings are listed but not openable', () => {
  const text = [
    devRecord,
    record(path.join(C, 'gone'), ['branch refs/heads/gone', 'prunable gitdir file points to non-existent location']),
    record(path.join(C, 'bare-one'), ['bare']),
    record(path.join(C, 'odd-ref'), ['branch refs/remotes/origin/x']),
  ].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C), [
    devTab(),
    listedOnly(path.join(C, 'gone'), 'gone'),
    listedOnly(path.join(C, 'bare-one')),
    listedOnly(path.join(C, 'odd-ref')),
  ]);
});

test('subagent, outside, nested worktrees and the container itself are not listed at all', () => {
  const text = [
    devRecord,
    record(path.join(DEV, '.claude', 'worktrees', 'agent-x'), ['branch refs/heads/agent']),
    record(path.resolve('/elsewhere/other'), ['branch refs/heads/other']),
    record(path.join(C, 'feat-x', 'inner'), ['branch refs/heads/inner']),
    record(C, ['branch refs/heads/container-itself']),
  ].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C), [devTab()]);
});

test('a locked worktree is still openable', () => {
  const text = [devRecord, record(path.join(C, 'feat-l'), ['branch refs/heads/feat/l', 'locked'])].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C)[1], openable(path.join(C, 'feat-l'), 'feat/l'));
});

// `git worktree add` locks the new worktree with reason "initializing" until
// its checkout is done: no host is spawned into a half-written folder (Dexter F6).
test('a worktree still being created (locked initializing) is listed but not openable', () => {
  const text = [devRecord, record(path.join(C, 'feat-new'), ['branch refs/heads/feat/new', 'locked initializing'])].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C)[1], listedOnly(path.join(C, 'feat-new'), 'feat/new'));
});

test('a path with spaces is openable', () => {
  const text = [devRecord, record(path.join(C, 'feat x y'), ['branch refs/heads/feat/x'])].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C)[1], openable(path.join(C, 'feat x y'), 'feat/x'));
});

// Reftable's HEAD stub; see host/git-branch.js, point 4.
test('an invalid branch name is not openable, and leaves dev with no branch name', () => {
  const text = [
    record(DEV, ['branch refs/heads/.invalid']),
    record(path.join(C, 'feat-bad'), ['branch refs/heads/.invalid']),
  ].join('\n');
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(text), C), [devTab(null), listedOnly(path.join(C, 'feat-bad'))]);
});

test('dev is first even when git lists it later', () => {
  const text = [record(path.join(C, 'feat-a'), ['branch refs/heads/a']), devRecord].join('\n');
  const tabs = tabWorktrees(parsePorcelain(text), C);
  assert.deepStrictEqual(tabs.map(t => t.isDev), [true, false]);
});

test('the same worktree spelled twice is one tab', { skip: process.platform !== 'win32' }, () => {
  const text = [
    devRecord,
    record(path.join(C, 'feat-a'), ['branch refs/heads/a']),
    record(path.join(C, 'FEAT-A').replace(/\//g, '\\'), ['branch refs/heads/a']),
    record(DEV.toUpperCase(), ['branch refs/heads/develop']),
  ].join('\n');
  assert.strictEqual(tabWorktrees(parsePorcelain(text), C).length, 2);
});

test('tabWorktrees is [] when dev is missing, or the input is not usable', () => {
  const noDev = record(path.join(C, 'feat-a'), ['branch refs/heads/a']);
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(noDev), C), []);
  assert.deepStrictEqual(tabWorktrees(parsePorcelain(SAMPLE), null), []);
  for (const v of [null, undefined, 'x', {}]) assert.deepStrictEqual(tabWorktrees(v, C), []);
  assert.deepStrictEqual(tabWorktrees([null, 42, { path: 7 }], C), []);
});

// ---------------------------------------------------------------------------
// isSibling (PR 3: a path new-worktree.ps1 returns must be one)

test('isSibling: a direct child of the container, nothing deeper, nothing else', () => {
  assert.strictEqual(isSibling(C, path.join(C, 'feat-a')), true);
  for (const p of [C, path.join(C, 'feat-x', 'inner'), path.join(DEV, '.claude', 'worktrees', 'agent-x'),
    path.resolve('/elsewhere/other'), null, '', 42]) {
    assert.strictEqual(isSibling(C, p), false, String(p));
  }
});

// ---------------------------------------------------------------------------
// Properties over generated worktree lists.

const nameArb = fc.array(fc.constantFrom('a', 'b', 'feat', '-', 'x y', '2'), { minLength: 1, maxLength: 4 })
  .map(parts => parts.join(''));
const pathArb = fc.oneof(
  fc.constant(DEV),
  nameArb.map(n => path.join(C, n)),                                  // a sibling worktree
  nameArb.map(n => path.join(C, n, 'inner')),                         // nested
  nameArb.map(n => path.join(DEV, '.claude', 'worktrees', n)),        // subagent
  nameArb.map(n => path.resolve('/elsewhere', n)),                    // another folder
  fc.constant(C),
);
const refArb = fc.oneof(
  nameArb.map(n => `branch refs/heads/feat/${n}`),
  fc.constant('branch refs/heads/.invalid'),
  fc.constant('branch refs/remotes/origin/x'),
  fc.constant('detached'),
  fc.constant('bare'),
);
const recordArb = fc.record({
  p: pathArb,
  ref: refArb,
  locked: fc.constantFrom(null, 'locked', 'locked initializing', 'locked on a USB drive'),
  prunable: fc.boolean(),
  upper: fc.boolean(),
});
const listArb = fc.tuple(fc.array(recordArb, { maxLength: 8 }), fc.boolean()).map(([recs, crlf]) => {
  const text = recs.map(r => {
    let p = r.p;
    if (process.platform === 'win32' && r.upper) p = p.toUpperCase();
    const lines = [r.ref];
    if (r.locked) lines.push(r.locked);
    if (r.prunable) lines.push('prunable gone');
    return record(p, lines);
  }).join('\n');
  return { recs, text: crlf ? text.replace(/\n/g, '\r\n') : text };
});

test('PROPERTY: dev is first and exactly once when listed; otherwise there are no tabs', () => {
  fc.assert(fc.property(listArb, ({ recs, text }) => {
    const tabs = tabWorktrees(parsePorcelain(text), C);
    const devListed = recs.some(r => samePath(r.p, DEV));
    if (!devListed) return tabs.length === 0;
    return tabs[0].isDev && samePath(tabs[0].path, DEV) && tabs.filter(t => t.isDev).length === 1;
  }));
});

test('PROPERTY: no two tabs are the same folder', () => {
  fc.assert(fc.property(listArb, ({ text }) => {
    const tabs = tabWorktrees(parsePorcelain(text), C);
    return tabs.every((t, i) => tabs.every((u, j) => i === j || !samePath(t.path, u.path)));
  }));
});

test('PROPERTY: every non-dev entry is a direct child of the container; an openable one is on a named branch', () => {
  fc.assert(fc.property(listArb, ({ text }) => {
    const tabs = tabWorktrees(parsePorcelain(text), C);
    return tabs.filter(t => !t.isDev).every(t =>
      samePath(path.dirname(t.path), C) && !isInside(t.path, DEV)
      && (!t.openable || (typeof t.branch === 'string' && t.branch.length > 0)));
  }));
});

// The other half of F1: whatever state a sibling is in (detached mid-rebase,
// prunable, bare, locked), while git lists it, it is in the result -- so the
// reducer never reads it as gone.
test('PROPERTY: every sibling git lists is in the result when dev is listed', () => {
  fc.assert(fc.property(listArb, ({ recs, text }) => {
    const tabs = tabWorktrees(parsePorcelain(text), C);
    if (!recs.some(r => samePath(r.p, DEV))) return true;
    return recs.filter(r => samePath(path.dirname(r.p), C))
      .every(r => tabs.some(t => samePath(t.path, r.p)));
  }));
});

test('PROPERTY: openable exactly when on a valid branch, not bare, not prunable, not initializing', () => {
  fc.assert(fc.property(listArb, ({ recs, text }) => {
    const tabs = tabWorktrees(parsePorcelain(text), C);
    return tabs.filter(t => !t.isDev).every(t => {
      // The first record for this folder is the one kept.
      const r = recs.find(x => samePath(x.p, t.path));
      const valid = r.ref.startsWith('branch refs/heads/') && isValidBranchName(r.ref.slice('branch refs/heads/'.length));
      return t.openable === (valid && !r.prunable && r.locked !== 'locked initializing');
    });
  }));
});

test('PROPERTY: isSibling holds only for a direct child of the container', () => {
  fc.assert(fc.property(pathArb, (p) => !isSibling(C, p) || samePath(path.dirname(path.resolve(p)), C)));
});
