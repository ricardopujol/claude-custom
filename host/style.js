'use strict';
/**
 * Per-project LOOK storage: the colours, darkness and background image a
 * person picked for one project folder.
 *
 * It lives IN the project, at `<project>/.claude-custom/`:
 *
 *   look.json          the look (shape and meaning: host/look.js)
 *   background.<ext>   a COPY of the chosen image
 *   .gitignore         `*`, written once, so the folder never shows up in
 *                      `git status`. Delete it to commit a look on purpose.
 *
 * In the project rather than in the harness's .harness/ because the look
 * belongs to the folder: every session opened there, from any launcher,
 * finds it without the harness needing a path-keyed registry, and a renamed
 * or moved folder keeps its look. (FF6 first stored this harness-side, keyed
 * by normalised path; that never merged.)
 *
 * The image is copied rather than referenced in place -- a moved or deleted
 * source file must not silently revert the look out from under someone.
 * Every write is temp-then-rename (host/atomic-write.js): never open the
 * destination before the new bytes are known good.
 *
 * Every read defaults. A missing folder, a corrupt look.json or a hand-edited
 * background name resolve to "the registry theme and the generated art",
 * never a throw on the attach path and never a trusted arbitrary path -- the
 * file name is structurally a bare `background.<ext>` (host/look.js).
 */

const fs = require('fs');
const path = require('path');
const { renameWithRetry } = require('./atomic-write');
const { sanitizeLook, ACCEPTED_EXTENSIONS } = require('./look');

// 25MB, per the FF6 brief. Pinned by an explicit boundary test, the way
// host/control.js's MAX_TERMINAL_DIM is.
const MAX_BYTES = 25 * 1024 * 1024;

const LOOK_DIR_NAME = '.claude-custom';
const LOOK_FILE = 'look.json';
const GITIGNORE_BODY =
  '# claude-custom per-project look. Ignored by default; delete this file to commit it.\n*\n';

// The fields a person sets through the Style tab. `background` is absent on
// purpose: only setBackground/resetBackground may change it, so a control
// message can never point the look at a file the harness did not copy.
const PATCHABLE = Object.freeze(['appColor', 'textColor', 'darkness']);

function lookDir(cwd) {
  return path.join(String(cwd), LOOK_DIR_NAME);
}

function extOf(p) {
  const raw = path.extname(String(p || ''));
  return raw ? raw.slice(1).toLowerCase() : '';
}

/**
 * PURE decision: may this candidate become the project's background, and if
 * so, where would the copy live? `size` is injected so a refusal can be
 * decided before anything is statted, and so this stays testable without a
 * real file. The destination is always `<project>/.claude-custom/background.<ext>`.
 */
function planBackgroundChoice({ source, cwd, size } = {}) {
  const src = typeof source === 'string' ? source.trim() : '';
  if (!src) return { ok: false, reason: 'no file was given' };
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, reason: 'no project is open' };

  const ext = extOf(src);
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      reason: `"${ext || '(no extension)'}" is not a supported image type -- ` +
        `use ${ACCEPTED_EXTENSIONS.join(', ')}`,
    };
  }

  if (typeof size === 'number' && Number.isFinite(size) && size > MAX_BYTES) {
    return {
      ok: false,
      reason: `that image is ${(size / (1024 * 1024)).toFixed(1)}MB -- ` +
        `${Math.round(MAX_BYTES / (1024 * 1024))}MB is the limit`,
    };
  }

  return { ok: true, dest: path.join(lookDir(cwd), `background.${ext}`), ext };
}

function ensureLookDir(cwd, fsImpl) {
  const dir = lookDir(cwd);
  fsImpl.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  // Written once, never overwritten: a person who edited it (to commit their
  // look, say) keeps their edit. 'wx' makes "only if absent" atomic.
  if (!fsImpl.existsSync(ignore)) {
    try { fsImpl.writeFileSync(ignore, GITIGNORE_BODY, { flag: 'wx' }); } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  return dir;
}

/** The project's look, sanitized. A background whose copy is gone is dropped. */
function readLook(cwd, { fsImpl = fs } = {}) {
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(path.join(lookDir(cwd), LOOK_FILE), 'utf8'));
  } catch {
    return sanitizeLook(null);
  }
  const look = sanitizeLook(raw);
  if (look.background && !fsImpl.existsSync(path.join(lookDir(cwd), look.background.file))) {
    look.background = null;
  }
  return look;
}

/** Sanitize and write atomically. Returns what was written. */
function writeLook(cwd, look, { fsImpl = fs } = {}) {
  const clean = sanitizeLook(look);
  const dir = ensureLookDir(cwd, fsImpl);
  const file = path.join(dir, LOOK_FILE);
  const temp = `${file}.tmp${process.pid}`;
  try {
    fsImpl.writeFileSync(temp, JSON.stringify(clean, null, 2) + '\n');
    renameWithRetry(temp, file, { rename: fsImpl.renameSync });
  } catch (err) {
    try { fsImpl.unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  return clean;
}

/**
 * Merge a partial look from the Style tab. Only PATCHABLE keys are read; a key
 * present with `null` resets that field to the registry theme.
 */
function setLook({ cwd, patch, fsImpl = fs } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, reason: 'nothing to change' };
  }
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, reason: 'no project is open' };
  const next = { ...readLook(cwd, { fsImpl }) };
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  try {
    return { ok: true, look: writeLook(cwd, next, { fsImpl }) };
  } catch (err) {
    return { ok: false, reason: `could not save the look: ${err.message}` };
  }
}

/**
 * Copy `source` in as the project's background: stat, decide, copy
 * temp-then-rename, drop any older copy in another format, then record it --
 * in that order, so a refused or failed choice never touches look.json.
 */
function setBackground({ source, cwd, fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(source);
  } catch {
    return { ok: false, reason: 'that file could not be read' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'that is not a file' };

  const plan = planBackgroundChoice({ source, cwd, size: stat.size });
  if (!plan.ok) return plan;

  const temp = `${plan.dest}.tmp${process.pid}`;
  try {
    ensureLookDir(cwd, fsImpl);
    fsImpl.copyFileSync(source, temp);
    renameWithRetry(temp, plan.dest, { rename: fsImpl.renameSync });
  } catch (err) {
    try { fsImpl.unlinkSync(temp); } catch { /* best effort */ }
    return { ok: false, reason: `could not copy the image: ${err.message}` };
  }

  const file = path.basename(plan.dest);
  let siblings = [];
  try { siblings = fsImpl.readdirSync(lookDir(cwd)); } catch { /* nothing to tidy */ }
  for (const name of siblings) {
    if (name !== file && /^background\.[a-z0-9]+$/i.test(name)) {
      try { fsImpl.unlinkSync(path.join(lookDir(cwd), name)); } catch { /* best effort */ }
    }
  }

  const setAt = new Date().toISOString();
  try {
    const look = writeLook(cwd, { ...readLook(cwd, { fsImpl }), background: { file, setAt } }, { fsImpl });
    return { ok: true, dest: plan.dest, setAt, look };
  } catch (err) {
    return { ok: false, reason: `could not save the look: ${err.message}` };
  }
}

/** Back to the generated art. The colours are kept. */
function resetBackground({ cwd, fsImpl = fs } = {}) {
  const look = readLook(cwd, { fsImpl });
  if (!look.background) return { ok: true, removed: false };
  writeLook(cwd, { ...look, background: null }, { fsImpl });
  // Safe by construction: sanitizeLook only ever yields a bare background.<ext>.
  try { fsImpl.unlinkSync(path.join(lookDir(cwd), look.background.file)); } catch { /* already gone */ }
  return { ok: true, removed: true };
}

/**
 * What this project should show right now. `fallbackBackground` is the
 * generated art's path (host/background.js), used whenever there is no copy.
 */
function resolveStyle(cwd, fallbackBackground, { fsImpl = fs } = {}) {
  const look = readLook(cwd, { fsImpl });
  if (!look.background) {
    return { background: fallbackBackground, source: 'generated', setAt: null, look };
  }
  return {
    background: path.join(lookDir(cwd), look.background.file),
    source: 'override',
    setAt: look.background.setAt,
    look,
  };
}

module.exports = {
  planBackgroundChoice, setBackground, resetBackground, resolveStyle, setLook,
  readLook, writeLook, lookDir, ACCEPTED_EXTENSIONS, MAX_BYTES, LOOK_DIR_NAME,
};
