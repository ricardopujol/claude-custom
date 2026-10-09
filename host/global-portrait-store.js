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
const { applyPortraitUpload } = require('./portrait-upload');

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

function migrateGlobalDefault({ userDir, candidateDirs = [], apply = applyPortraitUpload } = {}) {
  if (!userDir) return { migrated: false, from: null, reason: 'no user-wide folder is configured' };
  if (newestDefaultIn(userDir)) return { migrated: false, from: null, reason: 'a user-wide default already exists' };

  const resolvedUser = path.resolve(userDir);
  let best = null;
  for (const dir of candidateDirs) {
    if (!dir || typeof dir !== 'string' || path.resolve(dir) === resolvedUser) continue;
    const hit = newestDefaultIn(dir);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  if (!best) return { migrated: false, from: null, reason: 'no per-install default found' };

  try {
    apply({ source: best.file, dest: path.join(userDir, GLOBAL_AGENT, `default.${best.ext}`) });
  } catch (err) {
    return { migrated: false, from: best.file, reason: `copy failed: ${err && err.message}` };
  }
  return { migrated: true, from: best.file, reason: null };
}

module.exports = { userGlobalDir, installDirsBeside, migrateGlobalDefault };
