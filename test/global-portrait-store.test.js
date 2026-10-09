'use strict';
/**
 * BACKLOG #3 follow-up: the default agent picture is USER-WIDE. It lives in one folder in the
 * user profile, shared by every project, worktree and install; a per-agent picture still wins;
 * the first run adopts the newest per-install default and never deletes the old files.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { userGlobalDir, migrateGlobalDefault, installDirsBeside } = require('../host/global-portrait-store');
const { portraitFor, globalPortrait } = require('../host/portraits');

function put(root, name, body, mtimeSec) {
  const file = path.join(root, '_global', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

test('userGlobalDir: an explicit env override wins, then the uploads override, then the profile folder', () => {
  const home = path.join('C:', 'Users', 'someone');
  assert.strictEqual(userGlobalDir({ env: { CLAUDE_CUSTOM_GLOBAL_PORTRAITS: 'X:\\g' }, home }), 'X:\\g');
  assert.strictEqual(
    userGlobalDir({ env: { CLAUDE_CUSTOM_UPLOADS: 'X:\\throwaway' }, home }), 'X:\\throwaway');
  assert.strictEqual(
    userGlobalDir({ env: { CLAUDE_CUSTOM_UPLOADS: 'X:\\u', CLAUDE_CUSTOM_GLOBAL_PORTRAITS: 'X:\\g' }, home }), 'X:\\g');
  assert.strictEqual(userGlobalDir({ env: {}, home }), path.join(home, '.claude-custom', 'portraits'));
});

test('lookup order: a per-agent picture beats the user-wide default, which beats nothing', () => {
  const uploads = tmpDir('cc-gps-up-');
  const user = tmpDir('cc-gps-user-');
  assert.strictEqual(portraitFor('coder', 'working', { uploadsDir: uploads, globalDir: user }).tier, 'text');

  put(user, 'default.png', 'u');
  const g = portraitFor('coder', 'working', { uploadsDir: uploads, globalDir: user });
  assert.strictEqual(g.tier, 'global');
  assert.strictEqual(g.path, path.join(user, '_global', 'default.png'));

  fs.mkdirSync(path.join(uploads, 'coder'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'coder', 'default.png'), 'own');
  assert.strictEqual(portraitFor('coder', 'working', { uploadsDir: uploads, globalDir: user }).tier, 'uploaded');
});

test('lookup order: the old per-install _global is no longer read once a globalDir is given', () => {
  const uploads = tmpDir('cc-gps-up-');
  const user = tmpDir('cc-gps-user-');
  put(uploads, 'default.png', 'old');
  assert.strictEqual(portraitFor('coder', 'working', { uploadsDir: uploads, globalDir: user }).tier, 'text');
  assert.strictEqual(globalPortrait(user), null);
});

test('migration: with no user-wide default, the newest per-install default is adopted', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  const b = tmpDir('cc-gps-b-');
  const oldA = put(a, 'default.png', 'older', 1_000_000);
  const oldB = put(b, 'default.webm', 'newer', 2_000_000);
  const out = migrateGlobalDefault({ userDir: user, candidateDirs: [a, b] });
  assert.strictEqual(out.migrated, true);
  assert.strictEqual(out.from, oldB);
  const got = globalPortrait(user);
  assert.strictEqual(got.file, 'default.webm');
  assert.strictEqual(fs.readFileSync(got.path, 'utf8'), 'newer');
  // never deletes the old files
  assert.ok(fs.existsSync(oldA));
  assert.ok(fs.existsSync(oldB));
});

test('migration: an existing user-wide default is never replaced, even by a newer install default', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(user, 'default.png', 'mine', 1_000_000);
  put(a, 'default.png', 'newer', 9_000_000);
  const out = migrateGlobalDefault({ userDir: user, candidateDirs: [a] });
  assert.strictEqual(out.migrated, false);
  assert.strictEqual(fs.readFileSync(path.join(user, '_global', 'default.png'), 'utf8'), 'mine');
});

test('migration: nothing to adopt is a quiet no-op and creates nothing', () => {
  const user = path.join(tmpDir('cc-gps-root-'), 'not-yet');
  const empty = tmpDir('cc-gps-e-');
  const out = migrateGlobalDefault({ userDir: user, candidateDirs: [empty, path.join(empty, 'missing'), null, ''] });
  assert.deepStrictEqual(out, { migrated: false, from: null, reason: 'no per-install default found' });
  assert.strictEqual(fs.existsSync(user), false);
});

test('migration: the user-wide folder is the same as a candidate -> nothing to do', () => {
  const user = tmpDir('cc-gps-user-');
  put(user, 'default.png', 'x');
  fs.unlinkSync(path.join(user, '_global', 'default.png'));
  const out = migrateGlobalDefault({ userDir: user, candidateDirs: [user] });
  assert.strictEqual(out.migrated, false);
});

test('migration: a failed copy reports the reason and leaves no half-written default', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'x');
  const out = migrateGlobalDefault({
    userDir: user, candidateDirs: [a],
    apply: () => { throw new Error('disk full'); },
  });
  assert.strictEqual(out.migrated, false);
  assert.match(out.reason, /disk full/);
  assert.strictEqual(globalPortrait(user), null);
});

test('migration: a newest-looking candidate that is not a plain file is skipped', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  const b = tmpDir('cc-gps-b-');
  fs.mkdirSync(path.join(a, '_global', 'default.png'), { recursive: true });
  put(b, 'default.gif', 'real', 1_000_000);
  const out = migrateGlobalDefault({ userDir: user, candidateDirs: [a, b] });
  assert.strictEqual(out.migrated, true);
  assert.strictEqual(globalPortrait(user).file, 'default.gif');
});

test('installDirsBeside: finds every sibling checkout\'s .harness/portraits, this install included', () => {
  const parent = tmpDir('cc-gps-par-');
  for (const n of ['dev', 'feat-x']) fs.mkdirSync(path.join(parent, n, '.harness', 'portraits'), { recursive: true });
  fs.mkdirSync(path.join(parent, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'file.txt'), '');
  const got = installDirsBeside(path.join(parent, 'dev', 'host')).sort();
  assert.deepStrictEqual(got, [
    path.join(parent, 'dev', '.harness', 'portraits'),
    path.join(parent, 'feat-x', '.harness', 'portraits'),
  ]);
});

test('installDirsBeside: an unreadable parent gives only this install', () => {
  const lone = path.join(tmpDir('cc-gps-lone-'), 'only', 'host');
  assert.deepStrictEqual(installDirsBeside(lone), [path.join(lone, '..', '.harness', 'portraits')].map(p => path.resolve(p)));
});
