'use strict';
/**
 * The repo browser's path guard (#45 / #32).
 *
 *   lexical(root, input)                -> { ok: true, abs, rel } | { ok: false, why }       (pure)
 *   guardPath(root, input, { realpath }) -> { ok: true, abs, rel, real } | { ok: false, why } (async)
 *
 * ONE RULE: a path may be read, dragged out or revealed only if, after `..`, `.`, mixed slashes, case,
 * symlinks and junctions, it is INSIDE the worktree root of the tab that asked. The page is not trusted to
 * have kept to that (a stale row, a hand-made message, a link planted in the repo), so the HOST re-runs it
 * on every read and MAIN re-runs it on every reveal and drag.
 *
 * Two halves, because they fail differently:
 *   lexical    needs no disk. Refuses what can't be inside by spelling alone: another drive, UNC, device
 *              paths (\\?\, \\.\), rooted or drive-relative paths, alternate data streams, NUL, names that
 *              end in a dot or space, anything over MAX_INPUT. It reuses app/file-link.js's safePath, the
 *              one place those rules are written, so the terminal-link rule and this one can't drift.
 *   guardPath  then asks the disk for the REAL path of the root and of the file and requires the file's to
 *              be inside the root's. That is what catches a junction inside the worktree that leads out.
 *
 * Not covered, same stance as file-link.js: a link planted in the worktree that points at a SHARE is
 * followed by realpath before it is refused (it is then outside, so it is refused, but the lookup happened).
 * Planting one needs write access to the disk.
 *
 * `abs` is the path as spelled (what main hands to showItemInFolder / startDrag); `real` is what was
 * checked. `rel` is relative to the root with forward slashes ('' for the root itself).
 */
const fs = require('fs');
const path = require('path');
const { safePath } = require('../app/file-link');

const win = path.win32;
const MAX_INPUT = 4096;

const refuse = (why) => ({ ok: false, why });

// Windows: relative() compares case-insensitively and answers an absolute path across drives.
function relativeInside(root, abs) {
  const rel = win.relative(root, abs);
  if (win.isAbsolute(rel) || rel === '..' || rel.startsWith('..\\')) return null;
  return rel;
}

function lexical(root, input) {
  if (typeof input !== 'string' || input === '') return refuse('not a path');
  if (input.length > MAX_INPUT) return refuse('path too long');
  if (typeof root !== 'string' || !/^[A-Za-z]:[\\/]/.test(root)) return refuse('the worktree root is not a drive path');
  const rootN = win.normalize(root).replace(/\\+$/, '') || root;
  const abs = safePath(input, rootN);
  if (!abs) return refuse('not a path the browser will touch');
  const rel = relativeInside(rootN, abs);
  if (rel === null) return refuse('outside the worktree');
  return { ok: true, abs: abs.length > 3 ? abs.replace(/\\+$/, '') : abs, rel: rel.split('\\').join('/') };
}

// util.promisify(fs.realpath.native): the OS's own answer, so 8.3 short names and case come back canonical.
const nativeRealpath = (p) => new Promise((resolve, reject) => {
  fs.realpath.native(p, (err, real) => (err ? reject(err) : resolve(real)));
});

async function guardPath(root, input, { realpath = nativeRealpath } = {}) {
  const lex = lexical(root, input);
  if (!lex.ok) return lex;
  let realRoot;
  try {
    realRoot = await realpath(win.normalize(root).replace(/\\+$/, '') || root);
  } catch {
    return refuse('the worktree itself is unreadable');
  }
  let real;
  try {
    real = await realpath(lex.abs);
  } catch (err) {
    return refuse(err && err.code === 'ENOENT' ? 'gone' : 'unreadable');
  }
  if (relativeInside(String(realRoot), String(real)) === null) return refuse('outside the worktree (a link leads out)');
  return { ok: true, abs: lex.abs, rel: lex.rel, real: String(real) };
}

module.exports = { lexical, guardPath, MAX_INPUT };
