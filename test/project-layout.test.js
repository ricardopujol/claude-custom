'use strict';
/**
 * Project layout: where a folder sits in the worktree model (window = project,
 * tab = git worktree). Design: documentation/PLAN_WORKTREE_TABS.md.
 *
 * Paths arrive from three sources that disagree on spelling -- git prints
 * `C:/a/b`, Node gives `C:\a\b`, users type either case -- so every comparison
 * goes through one helper, tested first here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fc = require('fast-check');

const {
  normPath, samePath, isInside, layoutOf, projectOf, stateRoot,
} = require('../host/project-layout');
const { tmpDir } = require('./tmp-dir');

const WIN = process.platform === 'win32';

test('samePath ignores separator style, case and trailing separators on Windows', { skip: !WIN }, () => {
  assert.strictEqual(samePath('C:/Users/r/VibeCode/x/dev', 'c:\\users\\r\\vibecode\\X\\dev\\'), true);
  assert.strictEqual(samePath('C:/a/dev', 'C:/a/dev2'), false);
});

test('samePath is false when either side is not a usable path', () => {
  assert.strictEqual(samePath(null, 'C:/a'), false);
  assert.strictEqual(samePath('C:/a', null), false);
  assert.strictEqual(samePath(null, null), false);
  assert.strictEqual(samePath('', ''), false);
  assert.strictEqual(samePath(undefined, 42), false);
});

test('normPath returns null for anything that is not a non-empty string', () => {
  for (const v of [null, undefined, '', 0, 42, {}, [], true]) {
    assert.strictEqual(normPath(v), null, `normPath(${JSON.stringify(v)})`);
  }
});

test('normPath keeps a drive root intact instead of stripping its separator', { skip: !WIN }, () => {
  assert.strictEqual(normPath('C:\\'), 'c:\\');
  assert.strictEqual(normPath('C:/'), 'c:\\');
});

test('isInside is strict: a child, not the parent itself', { skip: !WIN }, () => {
  assert.strictEqual(isInside('C:/a/dev/src', 'C:\\a\\dev'), true);
  assert.strictEqual(isInside('C:/a/dev', 'C:/a/dev/'), false);
});

test('isInside does not mistake a shared name prefix for containment', { skip: !WIN }, () => {
  assert.strictEqual(isInside('C:/a/dev2', 'C:/a/dev'), false);
  assert.strictEqual(isInside('C:/a/dev-x/y', 'C:/a/dev'), false);
});

// normPath keeps a drive root's separator, so a naive `parent + sep` prefix
// would be `c:\\` and nothing would ever be inside a drive root.
test('isInside works when the parent is a drive root', { skip: !WIN }, () => {
  assert.strictEqual(isInside('C:/a', 'C:/'), true);
  assert.strictEqual(isInside('C:/', 'C:/'), false);
  assert.strictEqual(isInside('D:/a', 'C:/'), false);
});

test('isInside is false when either side is not a usable path', () => {
  assert.strictEqual(isInside(null, 'C:/a'), false);
  assert.strictEqual(isInside('C:/a/b', null), false);
});

test('PROPERTY: normPath is idempotent', () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('a', 'B', 'dev', 'x y', '.claude'), { minLength: 1, maxLength: 6 }),
    fc.constantFrom('/', '\\'),
    (parts, sep) => {
      const p = 'C:' + sep + parts.join(sep);
      return normPath(normPath(p)) === normPath(p);
    }));
});

// Appending one or more segments makes a path inside; appending none makes it
// the same path. Never both, never neither.
test('PROPERTY: a descendant is inside and not the same; the path itself is the same and not inside', { skip: !WIN }, () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('a', 'B', 'dev', 'x y'), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom('a', 'B', 'dev', 'x y'), { minLength: 0, maxLength: 3 }),
    fc.constantFrom('/', '\\'),
    fc.boolean(),
    (base, extra, sep, upper) => {
      const parent = 'C:' + sep + base.join(sep);
      let child = extra.length ? parent + sep + extra.join(sep) : parent;
      if (upper) child = child.toUpperCase();
      return isInside(child, parent) === (extra.length > 0)
        && samePath(child, parent) === (extra.length === 0);
    }));
});

// ---------------------------------------------------------------------------
// Classify and fold. Fixtures are built by hand, like git-branch.test.js, so
// they pass on a machine with no git; the last test cross-checks real git.
// They assume %TEMP% is not itself inside a repo, as git-branch.test.js does.

function makeRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

// <root>/dev is the main checkout; <root>/feat-x is a sibling worktree whose
// `.git` is a FILE pointing back into dev's git-dir.
function makeContainer() {
  const root = tmpDir('project-layout-test-');
  const dev = path.join(root, 'dev');
  makeRepo(dev);
  fs.mkdirSync(path.join(dev, 'src', 'deep'), { recursive: true });
  const wt = path.join(root, 'feat-x');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dev, '.git', 'worktrees', 'feat-x')}\n`);
  return { root, dev, wt };
}

function makeFlat() {
  const root = tmpDir('project-layout-test-');
  makeRepo(root);
  fs.mkdirSync(path.join(root, 'sub'));
  return root;
}

test('layoutOf tells a container, a flat repo and anything else apart', () => {
  const c = makeContainer();
  const flat = makeFlat();
  assert.strictEqual(layoutOf(c.root), 'container');
  assert.strictEqual(layoutOf(c.dev), 'flat');        // dev on its own is an ordinary repo
  assert.strictEqual(layoutOf(c.wt), 'none');         // a worktree's `.git` is a file
  assert.strictEqual(layoutOf(flat), 'flat');
  assert.strictEqual(layoutOf(tmpDir('project-layout-test-')), 'none');
});

test('layoutOf is none for anything that is not a non-empty string', () => {
  for (const v of [null, undefined, '', 42, {}]) assert.strictEqual(layoutOf(v), 'none');
});

test('an empty .git directory (no HEAD) is not a repo', () => {
  const dir = tmpDir('project-layout-test-');
  fs.mkdirSync(path.join(dir, '.git'));
  assert.strictEqual(layoutOf(dir), 'none');
  assert.strictEqual(projectOf(dir), null);
});

test('a dev folder without a .git does not make a container', () => {
  const root = tmpDir('project-layout-test-');
  fs.mkdirSync(path.join(root, 'dev'));
  assert.strictEqual(layoutOf(root), 'none');
  assert.strictEqual(projectOf(root), null);
  assert.strictEqual(projectOf(path.join(root, 'dev')), null);
});

test('projectOf folds the container, dev, anything under dev and a sibling worktree to the same container', () => {
  const c = makeContainer();
  const expected = { kind: 'container', root: c.root, dev: c.dev };
  for (const p of [c.root, c.dev, path.join(c.dev, 'src', 'deep'), c.wt, path.join(c.wt, 'sub')]) {
    assert.deepStrictEqual(projectOf(p), expected, p);
  }
});

// Dexter F7: a plain folder inside the container is in no repo of its own,
// but it is still in the project -- and must not climb past the container to
// some enclosing repo (a home dotfiles repo, say).
test('projectOf folds a plain folder inside the container to the container', () => {
  const c = makeContainer();
  const notes = path.join(c.root, 'notes', 'deep');
  fs.mkdirSync(notes, { recursive: true });
  const expected = { kind: 'container', root: c.root, dev: c.dev };
  assert.deepStrictEqual(projectOf(path.join(c.root, 'notes')), expected);
  assert.deepStrictEqual(projectOf(notes), expected);
});

test('a container inside an enclosing repo still wins for paths under it', () => {
  const outer = makeFlat();
  const inner = path.join(outer, 'box');
  makeRepo(path.join(inner, 'dev'));
  fs.mkdirSync(path.join(inner, 'notes'));
  assert.deepStrictEqual(projectOf(path.join(inner, 'notes')),
    { kind: 'container', root: inner, dev: path.join(inner, 'dev') });
});

test('projectOf gives a flat repo and its subfolders as flat, with dev = root', () => {
  const flat = makeFlat();
  const expected = { kind: 'flat', root: flat, dev: flat };
  assert.deepStrictEqual(projectOf(flat), expected);
  assert.deepStrictEqual(projectOf(path.join(flat, 'sub')), expected);
});

test('projectOf is null for a folder in no repo, and for non-strings', () => {
  assert.strictEqual(projectOf(tmpDir('project-layout-test-')), null);
  for (const v of [null, undefined, '', 42]) assert.strictEqual(projectOf(v), null);
});

test('an empty .git directory inside a repo is climbed past, not taken as the boundary', () => {
  const flat = makeFlat();
  fs.mkdirSync(path.join(flat, 'sub', '.git'));
  assert.deepStrictEqual(projectOf(path.join(flat, 'sub')), { kind: 'flat', root: flat, dev: flat });
});

// A repo that happens to hold a nested repo named `dev` is still one flat
// repo. Were it read as a container, projectOf(<repo>) and projectOf(<repo>\src)
// would fold to different projects and the fold would not be idempotent.
test('a folder with its own repo is never a container, even with a dev repo inside', () => {
  const outer = makeFlat();
  makeRepo(path.join(outer, 'dev'));
  assert.strictEqual(layoutOf(outer), 'flat');
  assert.deepStrictEqual(projectOf(outer), { kind: 'flat', root: outer, dev: outer });
  assert.deepStrictEqual(projectOf(path.join(outer, 'sub')), { kind: 'flat', root: outer, dev: outer });
  const nested = path.join(outer, 'dev');
  assert.deepStrictEqual(projectOf(nested), { kind: 'flat', root: nested, dev: nested });
});

// Same reason, for a worktree (a `.git` FILE) that holds a `dev` repo.
test('a worktree folder is never a container, even with a dev repo inside', () => {
  const c = makeContainer();
  makeRepo(path.join(c.wt, 'dev'));
  assert.strictEqual(layoutOf(c.wt), 'none');
  assert.deepStrictEqual(projectOf(c.wt), { kind: 'container', root: c.root, dev: c.dev });
});

test('stateRoot is the project\'s dev folder, and null without a project', () => {
  const c = makeContainer();
  const flat = makeFlat();
  assert.strictEqual(stateRoot(projectOf(c.wt)), c.dev);
  assert.strictEqual(stateRoot(projectOf(flat)), flat);
  assert.strictEqual(stateRoot(null), null);
});

// Every fixture path, plus up to two made-up segments below it (projectOf must
// climb through folders that don't exist yet), in any separator style and case.
function fixturePathArb() {
  const c = makeContainer();
  const flat = makeFlat();
  const outer = makeFlat();
  makeRepo(path.join(outer, 'dev'));
  const plain = tmpDir('project-layout-test-');
  const box = path.join(outer, 'box');
  makeRepo(path.join(box, 'dev'));
  const bases = [c.root, c.dev, path.join(c.dev, 'src', 'deep'), c.wt, flat, path.join(flat, 'sub'),
    outer, path.join(outer, 'dev'), plain, path.join(c.root, 'notes'), box, path.join(box, 'dev')];
  return fc.tuple(
    fc.constantFrom(...bases),
    fc.array(fc.constantFrom('zz', 'new folder', 'dev'), { maxLength: 2 }),
    fc.boolean(),
    fc.boolean(),
  ).map(([base, extra, slashes, upper]) => {
    let p = path.join(base, ...extra);
    if (WIN && slashes) p = p.replace(/\\/g, '/');
    if (WIN && upper) p = p.toUpperCase();
    return p;
  });
}

test('PROPERTY: the fold is idempotent -- a project\'s root folds to that same project', () => {
  fc.assert(fc.property(fixturePathArb(), (p) => {
    const a = projectOf(p);
    if (a === null) return true;
    assert.deepStrictEqual(projectOf(a.root), a);
    return true;
  }));
});

test('PROPERTY: how a path is spelled never changes which project it folds to', { skip: !WIN }, () => {
  fc.assert(fc.property(fixturePathArb(), (p) => {
    const a = projectOf(p);
    const b = projectOf(p.replace(/\//g, '\\').toLowerCase());
    if (a === null || b === null) return a === b;
    return a.kind === b.kind && samePath(a.root, b.root) && samePath(a.dev, b.dev);
  }));
});

// Trust but verify against real git on THIS checkout, whichever layout it is
// in (the repo moved to a container on 2026-09-28, so this is not pinned to
// one answer): a flat project's root is git's toplevel; a container's dev is
// the main worktree (the folder holding the common git-dir), and the checkout
// is dev or a direct child of the container.
test('cross-check: this checkout folds the way real git sees it', (t) => {
  let top;
  let common;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('git not available');
    return;
  }
  const project = projectOf(process.cwd());
  assert.ok(project, 'this checkout is in a repo, so it must fold to a project');
  if (project.kind === 'container') {
    assert.ok(samePath(project.dev, path.dirname(common)), `${project.dev} vs ${common}`);
    assert.ok(samePath(path.dirname(top), project.root), `${top} vs ${project.root}`);
  } else {
    assert.ok(samePath(project.root, top), `${project.root} vs ${top}`);
  }
});
