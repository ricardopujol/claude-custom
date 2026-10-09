'use strict';
/**
 * Where the default agent picture lives now: ONE user-wide folder in the user profile
 * (BACKLOG #3 follow-up, Ricardo 2026-10-09: "user-wide, one for everything"), shared by every
 * project, worktree and install. A per-agent picture still wins (host/portraits.js).
 *
 * Before this, the picture sat in each checkout's own `.harness\portraits\_global\`, so every
 * worktree had its own. `migrateGlobalDefault` adopts the newest of those into the user-wide
 * folder the first time it finds the user-wide one empty. It COPIES -- it never deletes or
 * moves the old files -- and the copy is the uploader's own temp-then-rename.
 */

const fs = require('fs');
const path = require('path');
const { GLOBAL_AGENT, MEDIA_EXTENSIONS } = require('./portraits');
const { isMarked, writeMarker } = require('./global-migration-marker');

const HARNESS_FOLDER = '.harness';
const PORTRAITS_FOLDER = 'portraits';

// The user-wide root (it holds `_global\default.<ext>`). The same `.claude-custom` folder in the
// profile that the worktree port blocks use. Overrides, for probes and tests: an explicit one
// wins, and a probe that already points CLAUDE_CUSTOM_UPLOADS at a throwaway folder gets its
// global picture there too, never in the real profile.
function userGlobalDir({ env = process.env, home } = {}) {
  if (env.CLAUDE_CUSTOM_GLOBAL_PORTRAITS) return env.CLAUDE_CUSTOM_GLOBAL_PORTRAITS;
  if (env.CLAUDE_CUSTOM_UPLOADS) return env.CLAUDE_CUSTOM_UPLOADS;
  return path.join(home, '.claude-custom', PORTRAITS_FOLDER);
}

// Every checkout's per-install uploads folder: `<sibling>\.harness\portraits` for each directory
// beside the one holding `hostDir`'s parent (the repo's `dev\` and its sibling worktrees), this
// install included even when the parent can't be listed.
function installDirsBeside(hostDir) {
  const install = path.resolve(hostDir, '..');
  const own = path.join(install, HARNESS_FOLDER, PORTRAITS_FOLDER);
  const out = [own];
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(install), { withFileTypes: true });
  } catch { /* keep this install only */ }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const dir = path.join(path.dirname(install), d.name, HARNESS_FOLDER, PORTRAITS_FOLDER);
    if (dir !== own && fs.existsSync(dir)) out.push(dir);
  }
  return out;
}

// The newest plain-file default in `<root>\_global`, or null.
function newestDefaultIn(root) {
  if (!root || typeof root !== 'string') return null;
  let best = null;
  for (const ext of MEDIA_EXTENSIONS) {
    const file = path.join(root, GLOBAL_AGENT, `default.${ext}`);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, ext, mtimeMs: st.mtimeMs };
    } catch { /* not there */ }
  }
  return best;
}

// Where the migration may look. A probe (CLAUDE_CUSTOM_UPLOADS or the global override set) is
// isolated: it reads only its own uploads folder, never the developer's real sibling checkouts
// (PR #151 D3). Only probes set these variables; no launcher in app/, bin/ or build/ does.
function migrationCandidates({ env = process.env, uploadsDir, hostDir } = {}) {
  if (env.CLAUDE_CUSTOM_UPLOADS || env.CLAUDE_CUSTOM_GLOBAL_PORTRAITS) return [uploadsDir];
  return [uploadsDir, ...installDirsBeside(hostDir)];
}

// Adopts the newest per-install default into an EMPTY user-wide folder, once.
//
// Once = the marker (host/global-migration-marker.js), which Reset leaves alone. Never
// check-then-overwrite: the copy goes to a temp file and is published with an exclusive link, after
// a re-check that no default of ANY format is there, so a picture another window set meanwhile is
// kept and nothing of theirs is removed. (An unlocked set-global landing between that re-check and
// the link can still be beaten by us for one format; the window is two syscalls wide.)
// `beforeCommit` is a test seam standing in for that other window.
function migrateGlobalDefault({
  userDir, candidateDirs = [], copyFile = fs.copyFileSync, link = fs.linkSync, beforeCommit = () => {},
} = {}) {
  if (!userDir) return { migrated: false, from: null, reason: 'no user-wide folder is configured' };
  if (isMarked(userDir)) return { migrated: false, from: null, reason: 'the default was already decided' };
  if (newestDefaultIn(userDir)) {
    writeMarker(userDir);
    return { migrated: false, from: null, reason: 'a user-wide default already exists' };
  }

  const resolvedUser = path.resolve(userDir);
  let best = null;
  for (const dir of candidateDirs) {
    if (!dir || typeof dir !== 'string' || path.resolve(dir) === resolvedUser) continue;
    const hit = newestDefaultIn(dir);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  if (!best) return { migrated: false, from: null, reason: 'no per-install default found' };

  const dest = path.join(userDir, GLOBAL_AGENT, `default.${best.ext}`);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFile(best.file, tmp);
    beforeCommit();
    if (newestDefaultIn(userDir)) {
      return { migrated: false, from: best.file, reason: 'a user-wide default was set meanwhile' };
    }
    link(tmp, dest);
    // The picture's cache-busting version is its mtime, and copyFile keeps the source's.
    try { const now = Date.now() / 1000; fs.utimesSync(dest, now, now); } catch { /* best effort */ }
  } catch (err) {
    const reason = err && err.code === 'EEXIST' ? 'a user-wide default was set meanwhile' : `copy failed: ${err && err.message}`;
    return { migrated: false, from: best.file, reason };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
  }
  writeMarker(userDir);
  return { migrated: true, from: best.file, reason: null };
}

// The startup call: scanning and copying are best effort, so nothing in them can abort the host
// (PR #151 Miguel I1). `candidateDirs` is a function so a throwing scan is caught here too.
function adoptOnStart({ userDir, candidateDirs, log = () => {}, migrate = migrateGlobalDefault } = {}) {
  let out;
  try {
    out = migrate({ userDir, candidateDirs: candidateDirs() });
  } catch (err) {
    out = { migrated: false, from: null, reason: `migration failed: ${err && err.message}` };
  }
  if (out.migrated) log(`[host] default picture adopted from ${out.from}`);
  else if (out.from || /failed/.test(out.reason || '')) log(`[host] default picture not adopted: ${out.reason}`);
  return out;
}

module.exports = { userGlobalDir, installDirsBeside, migrationCandidates, migrateGlobalDefault, adoptOnStart };
