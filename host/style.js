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
const { generateLook, noLookReason, DEFAULT_TERMINAL_FG } = require('./palette-gen');

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
const PATCHABLE = Object.freeze(['appColor', 'textColor', 'accentColor', 'secondaryColor', 'darkness']);

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

/**
 * Where the look folder stands, before anything reads or writes through it:
 *
 *   'absent'   no folder yet -- a write may create it
 *   'ok'       a real directory inside the project
 *   'foreign'  a symlink or junction (or not a directory at all). A cloned
 *              repo can ship `.claude-custom` pointing anywhere; following it
 *              would write look.json and unlink background.* OUTSIDE the
 *              project (Dexter F7), so it is neither read nor written.
 */
function lookDirState(cwd, fsImpl) {
  let st;
  try {
    st = fsImpl.lstatSync(lookDir(cwd));
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'foreign';
  }
  return st.isSymbolicLink() || !st.isDirectory() ? 'foreign' : 'ok';
}

/**
 * The look plus WHY it is what it is -- the distinction store.js draws
 * between "missing" and "corrupt" (Dexter F6). Only a missing or readable
 * look.json may be written over; a corrupt one is the person's data in a
 * state this code does not understand, and replacing it with the default
 * on the next slider move would lose it.
 */
function readLookState(cwd, fsImpl) {
  const dirState = lookDirState(cwd, fsImpl);
  if (dirState === 'foreign') return { status: 'foreign', look: sanitizeLook(null) };
  if (dirState === 'absent') return { status: 'missing', look: sanitizeLook(null) };
  let text;
  try {
    text = fsImpl.readFileSync(path.join(lookDir(cwd), LOOK_FILE), 'utf8');
  } catch (err) {
    return { status: err && err.code === 'ENOENT' ? 'missing' : 'corrupt', look: sanitizeLook(null) };
  }
  let raw;
  try { raw = JSON.parse(text); } catch { return { status: 'corrupt', look: sanitizeLook(null) }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'corrupt', look: sanitizeLook(null) };
  const look = sanitizeLook(raw);
  if (look.background && !fsImpl.existsSync(path.join(lookDir(cwd), look.background.file))) {
    look.background = null;
  }
  return { status: 'ok', look };
}

// The reason a write is refused, or null when it may go ahead.
function refusalFor(state, cwd) {
  if (state.status === 'foreign') {
    return `${LOOK_DIR_NAME} is a link to somewhere else -- not writing through it`;
  }
  if (state.status === 'corrupt') {
    return `look.json can't be read -- fix or delete ${path.join(lookDir(cwd), LOOK_FILE)}`;
  }
  return null;
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

/**
 * The project's look, sanitized -- the default for a missing, corrupt or
 * foreign folder. A background whose copy is gone is dropped.
 */
function readLook(cwd, { fsImpl = fs } = {}) {
  return readLookState(cwd, fsImpl).look;
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

const HEX_RE = /^#[0-9a-f]{6}$/i;

// Why this one patched value is refused, or null. `null` itself is valid: it
// means "back to the registry theme". Anything else malformed is REFUSED
// rather than sanitized to null, which would silently wipe a stored colour
// and report success (Dexter F5).
function patchValueRefusal(key, value) {
  if (value === null) return null;
  if (key === 'darkness') {
    return typeof value === 'number' && Number.isFinite(value) ? null : 'darkness must be a number';
  }
  return typeof value === 'string' && HEX_RE.test(value) ? null : `"${String(value)}" is not a colour -- use #rrggbb`;
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
  const keys = PATCHABLE.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  // Nothing this code sets: refused BEFORE any folder is created, so a stray
  // message does not leave a .claude-custom/ in a project that never had a look.
  if (!keys.length) return { ok: false, reason: 'nothing to change' };
  for (const key of keys) {
    const reason = patchValueRefusal(key, patch[key]);
    if (reason) return { ok: false, reason };
  }
  const state = readLookState(cwd, fsImpl);
  const refused = refusalFor(state, cwd);
  if (refused) return { ok: false, reason: refused };
  const next = { ...state.look };
  for (const key of keys) next[key] = patch[key];
  try {
    return { ok: true, look: writeLook(cwd, next, { fsImpl }) };
  } catch (err) {
    return { ok: false, reason: `could not save the look: ${err.message}` };
  }
}

/**
 * Backlog #15: give a NEW project a random, readable look, once.
 *
 * "New" is two facts, both required: look.json is MISSING (not 'ok', not
 * 'corrupt' -- the person's data in a state we don't understand -- and not
 * 'foreign'), AND the folder has no Claude history. `hasHistory` is a
 * function so it's only asked when the look is missing: a project that
 * already has a look never pays for the transcript-folder scan. The write
 * is create-only (createLook), so a look that appears during the scan is
 * kept rather than patched over. `rng` and `terminalForeground` pass straight to the generator.
 */
function seedLookIfNew({ cwd, hasHistory, rng, terminalForeground, fsImpl = fs } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return { seeded: false, reason: 'no project is open' };
  const state = readLookState(cwd, fsImpl);
  if (state.status !== 'missing') return { seeded: false, reason: `look is ${state.status}` };
  if (typeof hasHistory !== 'function' || hasHistory() !== false) {
    return { seeded: false, reason: 'the folder has Claude history' };
  }
  const look = generateLook(rng, { terminalForeground });
  if (!look) return { seeded: false, reason: noLookReason(terminalForeground || DEFAULT_TERMINAL_FG) };
  try {
    return { seeded: true, look: createLook(cwd, { ...state.look, ...look }, { fsImpl }) };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { seeded: false, reason: 'a look was saved meanwhile -- kept it' };
    return { seeded: false, reason: `could not save the look: ${err && err.message}` };
  }
}

/**
 * writeLook's create-only twin, for the seed (Dexter F5, Miguel #3). "Missing"
 * was read BEFORE the history scan; a look someone saves in that gap must win.
 * So the complete file is written to a temp name and then hard-linked into
 * place: link() refuses an existing destination (EEXIST) atomically, and a
 * reader never sees a half-written look.json. A filesystem without hard links
 * fails the seed, which writes nothing -- the safe direction.
 */
function createLook(cwd, look, { fsImpl = fs } = {}) {
  const clean = sanitizeLook(look);
  const dir = ensureLookDir(cwd, fsImpl);
  const file = path.join(dir, LOOK_FILE);
  const temp = `${file}.seed${process.pid}`;
  try {
    fsImpl.writeFileSync(temp, JSON.stringify(clean, null, 2) + '\n');
    fsImpl.linkSync(temp, file);
  } finally {
    tryUnlink(fsImpl, temp);
  }
  return clean;
}

/**
 * The Style tab's re-roll: a fresh generated look over this project's
 * colours. An explicit ask, so unlike seedLookIfNew it doesn't care whether
 * a look exists -- but it's still a setLook, so a corrupt or foreign look
 * folder is refused and the background image is kept.
 */
function rerollLook({ cwd, rng, terminalForeground, fsImpl = fs } = {}) {
  const look = generateLook(rng, { terminalForeground });
  if (!look) return { ok: false, reason: noLookReason(terminalForeground || DEFAULT_TERMINAL_FG) };
  return setLook({ cwd, patch: look, fsImpl });
}

function tryUnlink(fsImpl, file) {
  try { fsImpl.unlinkSync(file); } catch { /* best effort */ }
}

/**
 * Copy `source` in as the project's background.
 *
 * ORDER IS THE POINT (Dexter F1, Miguel #1). Until look.json names the new
 * copy, the old background must still be whole: it is set aside as a .bak
 * rather than overwritten, and every other older copy is left alone. Only
 * once look.json is written are the .bak and the older copies removed. If
 * the look.json write fails, the new copy is removed and the .bak restored,
 * so the result is either "new background, recorded" or "exactly as before".
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

  const state = readLookState(cwd, fsImpl);
  const refused = refusalFor(state, cwd);
  if (refused) return { ok: false, reason: refused };

  const rename = { rename: fsImpl.renameSync };
  const temp = `${plan.dest}.tmp${process.pid}`;
  const bak = `${plan.dest}.bak${process.pid}`;
  let setAside = false;
  try {
    ensureLookDir(cwd, fsImpl);
    fsImpl.copyFileSync(source, temp);
    if (fsImpl.existsSync(plan.dest)) {
      renameWithRetry(plan.dest, bak, rename);
      setAside = true;
    }
    renameWithRetry(temp, plan.dest, rename);
  } catch (err) {
    tryUnlink(fsImpl, temp);
    if (setAside) { try { renameWithRetry(bak, plan.dest, rename); } catch { /* reported below */ } }
    return { ok: false, reason: `could not copy the image: ${err.message}` };
  }

  const file = path.basename(plan.dest);
  const setAt = new Date().toISOString();
  let look;
  try {
    look = writeLook(cwd, { ...state.look, background: { file, setAt } }, { fsImpl });
  } catch (err) {
    tryUnlink(fsImpl, plan.dest);
    if (setAside) { try { renameWithRetry(bak, plan.dest, rename); } catch { /* best effort */ } }
    return { ok: false, reason: `could not save the look: ${err.message}` };
  }

  // Recorded: now, and only now, the older copies can go.
  if (setAside) tryUnlink(fsImpl, bak);
  let siblings = [];
  try { siblings = fsImpl.readdirSync(lookDir(cwd)); } catch { /* nothing to tidy */ }
  for (const name of siblings) {
    if (name !== file && /^background\.[a-z0-9]+$/i.test(name)) tryUnlink(fsImpl, path.join(lookDir(cwd), name));
  }
  return { ok: true, dest: plan.dest, setAt, look };
}

/**
 * Back to the generated art. The colours are kept. Throws, like writeLook,
 * when the look cannot be written -- the host reports it to the asker.
 */
function resetBackground({ cwd, fsImpl = fs } = {}) {
  const state = readLookState(cwd, fsImpl);
  const refused = refusalFor(state, cwd);
  if (refused) throw new Error(refused);
  const look = state.look;
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
  seedLookIfNew, rerollLook,
  // the branch ledger (host/git-tree-service.js) lives in the same folder, behind the same ignore,
  // and refuses a linked folder the same way
  ensureLookDir, lookDirState,
};
