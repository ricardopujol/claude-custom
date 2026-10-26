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

const {
  userGlobalDir, migrateGlobalDefault, installDirsBeside, migrationCandidates, adoptOnStart,
} = require('../host/global-portrait-store');
const { handleGlobalPortraitMessage } = require('../host/portrait-upload');
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
    copyFile: () => { throw new Error('disk full'); },
  });
  assert.strictEqual(out.migrated, false);
  assert.match(out.reason, /^copy failed: disk full$/);
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

// ---- PR #151 review fixes -------------------------------------------------------------------

test('D1/B1: Reset sticks -- migrate, Reset, migrate again (a new host) adopts nothing', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  assert.strictEqual(migrateGlobalDefault({ userDir: user, candidateDirs: [a] }).migrated, true);
  const reset = handleGlobalPortraitMessage({ action: 'reset-global' }, { uploadsDir: user });
  assert.strictEqual(reset.reply.ok, true);
  assert.strictEqual(globalPortrait(user), null);
  const again = migrateGlobalDefault({ userDir: user, candidateDirs: [a] });
  assert.strictEqual(again.migrated, false);
  assert.strictEqual(globalPortrait(user), null);
});

test('D1/B1: a default set by the user and then reset also stops a later adoption', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  const src = path.join(tmpDir('cc-gps-src-'), 'mine.png');
  fs.writeFileSync(src, 'mine');
  put(a, 'default.png', 'old');
  const deps = { uploadsDir: user, stat: (p) => fs.statSync(p), resolve: () => (globalPortrait(user) || {}).path || null };
  assert.strictEqual(handleGlobalPortraitMessage({ action: 'set-global', path: src }, deps).reply.ok, true);
  handleGlobalPortraitMessage({ action: 'reset-global' }, deps);
  assert.strictEqual(migrateGlobalDefault({ userDir: user, candidateDirs: [a] }).migrated, false);
});

test('D1/B1: a refused or no-op Reset does not mark anything', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  handleGlobalPortraitMessage({ action: 'reset-global' }, { uploadsDir: user }); // nothing to remove
  assert.strictEqual(migrateGlobalDefault({ userDir: user, candidateDirs: [a] }).migrated, true);
});

test('D2: a default another window sets between the scan and the write is kept; nothing is removed', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  const theirs = path.join(user, '_global', 'default.gif');
  const out = migrateGlobalDefault({
    userDir: user, candidateDirs: [a],
    beforeCommit: () => { fs.mkdirSync(path.dirname(theirs), { recursive: true }); fs.writeFileSync(theirs, 'theirs'); },
  });
  assert.strictEqual(out.migrated, false);
  assert.deepStrictEqual(fs.readdirSync(path.join(user, '_global')), ['default.gif']);
  assert.strictEqual(fs.readFileSync(theirs, 'utf8'), 'theirs');
});

test('D2: the same format landing in that window is not overwritten either', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  const out = migrateGlobalDefault({
    userDir: user, candidateDirs: [a],
    beforeCommit: () => { put(user, 'default.png', 'theirs'); },
  });
  assert.strictEqual(out.migrated, false);
  assert.strictEqual(fs.readFileSync(path.join(user, '_global', 'default.png'), 'utf8'), 'theirs');
});

test('D2: a lost race leaves no temp file behind', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  migrateGlobalDefault({ userDir: user, candidateDirs: [a], beforeCommit: () => { put(user, 'default.png', 'theirs'); } });
  assert.deepStrictEqual(fs.readdirSync(path.join(user, '_global')), ['default.png']);
});

test('D3: with a probe override set, candidates come only from the probe\'s own uploads', () => {
  const hostDir = path.join(tmpDir('cc-gps-h-'), 'dev', 'host');
  fs.mkdirSync(path.join(hostDir, '..', '..', 'sib', '.harness', 'portraits'), { recursive: true });
  const probe = { CLAUDE_CUSTOM_UPLOADS: 'X:/throwaway' };
  assert.deepStrictEqual(migrationCandidates({ env: probe, uploadsDir: 'X:/throwaway', hostDir }), ['X:/throwaway']);
  assert.deepStrictEqual(
    migrationCandidates({ env: { CLAUDE_CUSTOM_GLOBAL_PORTRAITS: 'X:/g' }, uploadsDir: 'U', hostDir }), ['U']);
  const real = migrationCandidates({ env: {}, uploadsDir: 'U', hostDir });
  assert.strictEqual(real[0], 'U');
  assert.ok(real.length >= 2 && real.some(d => d.includes(`${path.sep}sib${path.sep}`)));
});

test('I1: the startup adoption never throws, and says why when it fails', () => {
  const lines = [];
  const out = adoptOnStart({
    userDir: 'X:/u', candidateDirs: () => { throw new Error('scan boom'); }, log: (l) => lines.push(l),
  });
  assert.strictEqual(out.migrated, false);
  assert.match(out.reason, /scan boom/);
  assert.ok(lines.some(l => /scan boom/.test(l)));
  const out2 = adoptOnStart({ userDir: 'X:/u', candidateDirs: () => [], migrate: () => { throw new Error('mig boom'); }, log: () => {} });
  assert.match(out2.reason, /mig boom/);
});

test('I1: the startup adoption logs what it adopted', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  const file = put(a, 'default.png', 'x');
  const lines = [];
  const out = adoptOnStart({ userDir: user, candidateDirs: () => [a], log: (l) => lines.push(l) });
  assert.strictEqual(out.migrated, true);
  assert.ok(lines.some(l => l.includes(file)));
});

// ---- PR #151 Dexter r2 (L1-L3) ----------------------------------------------------------------

const { isMarked } = require('../host/global-migration-marker');

test('L1: a default set and then Reset by another window inside the first-start copy is not brought back', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  const src = path.join(tmpDir('cc-gps-src-'), 'mine.png');
  fs.writeFileSync(src, 'mine');
  const deps = { uploadsDir: user, stat: (p) => fs.statSync(p), resolve: () => (globalPortrait(user) || {}).path || null };
  const out = migrateGlobalDefault({
    userDir: user, candidateDirs: [a],
    beforeCommit: () => {
      handleGlobalPortraitMessage({ action: 'set-global', path: src }, deps);
      handleGlobalPortraitMessage({ action: 'reset-global' }, deps);
    },
  });
  assert.strictEqual(out.migrated, false);
  assert.strictEqual(globalPortrait(user), null);
});

test('L2: a Reset that removes a default marks the folder, on its own', () => {
  const user = tmpDir('cc-gps-user-');
  put(user, 'default.png', 'x');
  assert.strictEqual(isMarked(user), false);
  handleGlobalPortraitMessage({ action: 'reset-global' }, { uploadsDir: user });
  assert.strictEqual(isMarked(user), true);
});

test('L2: a successful set marks the folder, on its own', () => {
  const user = tmpDir('cc-gps-user-');
  put(user, 'default.png', 'x');
  const src = path.join(tmpDir('cc-gps-src-'), 'mine.png');
  fs.writeFileSync(src, 'mine');
  assert.strictEqual(isMarked(user), false);
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: src }, {
    uploadsDir: user, stat: (p) => fs.statSync(p), resolve: () => (globalPortrait(user) || {}).path || null,
  });
  assert.strictEqual(out.reply.ok, true);
  assert.strictEqual(isMarked(user), true);
});

test('L3: the publish is an exclusive link, never a rename that would overwrite a late default', () => {
  const user = tmpDir('cc-gps-user-');
  const a = tmpDir('cc-gps-a-');
  put(a, 'default.png', 'old');
  const dest = path.join(user, '_global', 'default.png');
  const real = fs.linkSync;
  let called = 0;
  fs.linkSync = (from, to) => { called += 1; fs.writeFileSync(to, 'theirs'); return real(from, to); };
  let out;
  try { out = migrateGlobalDefault({ userDir: user, candidateDirs: [a] }); } finally { fs.linkSync = real; }
  assert.strictEqual(called, 1);
  assert.strictEqual(out.migrated, false);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'theirs');
  assert.deepStrictEqual(fs.readdirSync(path.join(user, '_global')), ['default.png']);
});
