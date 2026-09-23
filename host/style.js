'use strict';
/**
 * Per-project background OVERRIDE: the user's own image, instead of the
 * generated one from host/background.js.
 *
 * The chosen image is COPIED into the harness's own directory rather than
 * referenced in place -- a moved or deleted source file must not silently
 * revert the look out from under someone. Copy is temp-write-then-rename,
 * mirroring host/store.js and host/atomic-write.js: never open the
 * destination with 'w' before the copy is known good.
 *
 * State lives at the store key 'style', shaped:
 *
 *   { [normalisedProjectPath]: { background: { file, setAt } } }
 *
 * keyed by the SAME normalise-a-project-path convention as host/themes.js and
 * host/background.js (forward slashes, no trailing slash, lowercase) -- the
 * project path IS the scope, the same way host/store.js's header explains
 * '.harness/state' is install-wide by itself.
 *
 * Every read defaults. `resolveStyle` never throws on the hot path: a
 * missing key, a corrupt style.json (store.js already turns that into the
 * fallback `{}`) or a hand-edited entry pointing somewhere outside the
 * harness's own style directory all resolve to "generated", never a crash
 * and never a trusted arbitrary path.
 */

const fs = require('fs');
const path = require('path');
const { renameWithRetry } = require('./atomic-write');

// Mirrors host/background.js's own accepted-image assumption, widened to the
// formats this feature actually accepts. Refused, not sanitised -- the panel
// says why rather than silently coercing.
const ACCEPTED_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

// 25MB, per the brief. A module-scope constant -- pinned by an explicit
// boundary test, the way host/control.js's MAX_TERMINAL_DIM is, because a
// bare literal drifts unnoticed under this project's mutation-testing setup.
const MAX_BYTES = 25 * 1024 * 1024;

const STORE_KEY = 'style';

// Same convention as host/themes.js normalize() / host/background.js
// normalize(): forward slashes, no trailing slash, lowercase. Kept as its own
// small copy rather than importing either -- both of those files already
// keep their own local copy for the same reason (themes.js does not import
// background.js's), and this one is not the SVG-only namer either.
function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Identical algorithm to host/background.js's hash32 -- FNV-1a, 32-bit --
// duplicated rather than imported for the same reason its own comment gives
// for keeping fileNameFor here: this module names files by a DIFFERENT
// input shape (an arbitrary extension, not always .svg).
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function slugFor(projectPath) {
  const norm = normalize(projectPath);
  return (norm.split('/').filter(Boolean).pop() || 'project')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 40) || 'project';
}

// Mirrors host/background.js's fileNameFor, with the extension as a
// parameter -- a background override keeps the format it was uploaded in,
// unlike the generated art, which is always SVG.
function fileNameFor(projectPath, ext) {
  const norm = normalize(projectPath);
  return `${slugFor(projectPath)}-${hash32(norm).toString(16).padStart(8, '0')}.${ext}`;
}

function extOf(p) {
  const raw = path.extname(String(p || ''));
  return raw ? raw.slice(1).toLowerCase() : '';
}

// A file-path containment check, the same shape as host/drop.js's isInside:
// compare NORMALISED keys, never the display string, and a directory is
// "inside" itself.
function isInside(file, dir) {
  const f = normalize(file);
  const d = normalize(dir);
  return !!d && !!f && (f === d || f.startsWith(d + '/'));
}

/**
 * PURE decision: may this candidate become the project's background, and if
 * so, where would the copy live? No filesystem access at all -- `size` is
 * injected so this stays testable without a real file, and so a refusal can
 * be decided before anything is statted.
 *
 * Returns `{ ok, reason }` on refusal, `{ ok: true, dest, ext }` on success.
 * `dest` is always `path.join(dir, <safe filename>)` -- constructed the same
 * way host/background.js's own filenames are, so it can never climb out of
 * `dir` no matter what `source` or `cwd` contain.
 */
function planBackgroundChoice({ source, cwd, size, dir } = {}) {
  const src = typeof source === 'string' ? source.trim() : '';
  if (!src) return { ok: false, reason: 'no file was given' };
  if (!cwd || !String(cwd).trim()) return { ok: false, reason: 'no project is open' };
  if (!dir || !String(dir).trim()) return { ok: false, reason: 'nowhere to store the image' };

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

  return { ok: true, dest: path.join(dir, fileNameFor(cwd, ext)), ext };
}

/**
 * The thin fs layer. Stats the source, decides via `planBackgroundChoice`,
 * copies temp-then-rename, and records the override in the store -- in that
 * order, so a refused or failed choice never touches style.json at all.
 */
function setBackground({ source, cwd, dir, store, fsImpl = fs } = {}) {
  if (!store) throw new Error('setBackground: store is required');

  let stat;
  try {
    stat = fsImpl.statSync(source);
  } catch {
    return { ok: false, reason: 'that file could not be read' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'that is not a file' };

  const plan = planBackgroundChoice({ source, cwd, size: stat.size, dir });
  if (!plan.ok) return plan;

  fsImpl.mkdirSync(dir, { recursive: true });
  const temp = `${plan.dest}.tmp${process.pid}`;
  try {
    fsImpl.copyFileSync(source, temp);
    renameWithRetry(temp, plan.dest, fsImpl.renameSync ? { rename: fsImpl.renameSync } : undefined);
  } catch (err) {
    try { fsImpl.unlinkSync(temp); } catch { /* best effort */ }
    return { ok: false, reason: `could not copy the image: ${err.message}` };
  }

  const key = normalize(cwd);
  const state = readState(store);
  state[key] = { background: { file: plan.dest, setAt: new Date().toISOString() } };
  store.write(STORE_KEY, state);

  return { ok: true, dest: plan.dest, source: 'override' };
}

/**
 * Reset to the generated background: removes the override (best-effort
 * unlink of the copy) and reports whether there was one to remove.
 *
 * The unlink is refused, not attempted, for a file that does not resolve
 * inside `dir` -- a hand-edited style.json must not be able to make this
 * host delete an arbitrary path.
 */
function resetBackground({ cwd, dir, store, fsImpl = fs } = {}) {
  if (!store) throw new Error('resetBackground: store is required');

  const key = normalize(cwd);
  const state = readState(store);
  const entry = state[key];
  if (!entry) return { ok: true, removed: false };

  const next = { ...state };
  delete next[key];
  store.write(STORE_KEY, next);

  const file = entry.background && typeof entry.background.file === 'string'
    ? entry.background.file : null;
  if (file && dir && isInside(file, dir)) {
    try { fsImpl.unlinkSync(file); } catch { /* best effort -- already gone is fine */ }
  }
  return { ok: true, removed: true };
}

// A defensive read: store.read('style', {}) already defaults on a corrupt
// file, but a *valid* JSON file whose top level is not a plain object (an
// array, a string, null written by hand) must not propagate into `state[key]`
// lookups below and throw there instead.
function readState(store) {
  const raw = store.read(STORE_KEY, {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

/**
 * What background should this project actually show right now?
 *
 * `fallbackBackground` is the generated image's path (host/background.js's
 * `backgroundFor(cwd).path`) -- the caller resolves that first, since it is
 * cheap and always succeeds, and this function decides whether to use it.
 *
 * `styleDir`, if given, is the closure check for the invariant this module
 * exists to hold: an override is only ever trusted if it resolves inside the
 * harness's own style directory. Every legitimate write from `setBackground`
 * satisfies that by construction (`dest` is built from `dir` itself), so this
 * only ever fires against a style.json edited or corrupted by hand.
 */
function resolveStyle(store, cwd, fallbackBackground, { styleDir } = {}) {
  const generated = { background: fallbackBackground, source: 'generated' };
  if (!store) return generated;

  const state = readState(store);
  const entry = state[normalize(cwd)];
  const file = entry && entry.background && typeof entry.background.file === 'string'
    ? entry.background.file : null;
  if (!file) return generated;

  if (styleDir && !isInside(file, styleDir)) {
    return {
      ...generated,
      note: 'the stored background is outside the harness directory -- using the generated background',
    };
  }

  return {
    background: file,
    source: 'override',
    setAt: (entry.background && entry.background.setAt) || null,
  };
}

module.exports = {
  planBackgroundChoice, setBackground, resetBackground, resolveStyle,
  ACCEPTED_EXTENSIONS, MAX_BYTES, normalize, fileNameFor, isInside, STORE_KEY,
};
