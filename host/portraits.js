'use strict';
/**
 * Portrait lookup — convention over configuration, tiers deep.
 *
 * Resolved per (agent, state), highest tier wins:
 *
 *   1. UPLOADED  .harness/portraits/<agent>/<state>.<ext>      (user-supplied)
 *                .harness/portraits/<agent>/default.<ext>      (per-agent fallback)
 *   2. FORGE     portraits/<agent>/<state>.png                 (generated, existing)
 *   3. GLOBAL    .harness/portraits/_global/default.<ext>      (the user's default for everyone)
 *   4. FORGE     portraits/_default/<state>.png                (one character for everyone)
 *                portraits/_default/default.png
 *   5. SHIPPED   app/assets/portrait-default.<ext>             (bundled with the app)
 *   6. TEXT      initials-on-a-hue placeholder                 (always available)
 *
 * The FOUR STATES stay in the data model even where only one asset exists per
 * agent -- ext resolution collapses to one file reused across every state,
 * never to fewer states. Ricardo, 2026-09-22: he will upload his own per-state
 * images, GIFs and video later; only the DEFAULT asset is allowed to be one
 * picture standing in for all four today.
 *
 * A display that can't say where a picture came from is this project's
 * signature defect (absence reported as a confident answer). So every file
 * result carries `tier` -- 'uploaded' | 'forge' | 'global' | 'shipped' -- and every
 * placeholder carries `tier: 'text'`. Nothing here decides UI wording; that
 * lives in app/renderer.js's faceHtml.
 *
 * v1 generates ~15 named agents x 4 states. The other ~65 agents must still
 * render, hence placeholders being a first-class result rather than an error.
 */

const fs = require('fs');
const path = require('path');

const BUILTIN_STATES = ['sleeping', 'working', 'happy', 'stressed'];

// Every extension a tier is willing to serve. Order is the tie-break when a
// directory somehow holds more than one for the same name -- deterministic,
// not "whatever readdir felt like today".
const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4'];
const VIDEO_EXTENSIONS = new Set(['webm', 'mp4']);
// Reserved agent segment holding the user-set global default picture.
const GLOBAL_AGENT = '_global';
const mediaKindFor = ext => (VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image');

// `_global` is the folder of the global default picture, not an agent. The
// filesystem it lives on folds case and trims trailing dots and spaces
// (NTFS), so `_GLOBAL`, `_global.` and `_global ` are the same directory:
// the check compares the name the way the filesystem does (Dexter F4 /
// Miguel I3, PR #64).
function isReservedAgent(name) {
  return typeof name === 'string' && name.replace(/[. ]+$/, '').toLowerCase() === GLOBAL_AGENT;
}

// Agent names key straight into a filesystem path. A name is only ever a single
// path segment; anything else is refused rather than resolved.
function safeSegment(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  // "." joins to the parent itself: an upload for agent "." would land in the
  // shared uploads root (Dexter F5, PR #35).
  if (name === '.') return null;
  if (path.isAbsolute(name)) return null;
  return name;
}

// Stable per-agent hue so an agent keeps the same placeholder between frames;
// one that changed colour would read as a different agent entirely.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function placeholderFor(agent) {
  const name = String(agent || '?');
  const words = name.split(/[-_\s]+/).filter(Boolean);
  const initials = (words.length >= 2
    ? words[0][0] + words[1][0]
    : name.slice(0, 2)
  ).toUpperCase();

  return { kind: 'placeholder', tier: 'text', agent: name, initials, hue: hashString(name) % 360 };
}

function listStates({ portraitsDir } = {}) {
  if (portraitsDir) {
    try {
      const raw = fs.readFileSync(path.join(portraitsDir, 'states.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* unconfigured is the normal case */ }
  }
  return [...BUILTIN_STATES];
}

// The one filesystem probe every tier does: does `<dir>/<base>.<ext>` exist,
// for some ext in the allow-list above? Returns { path, ext } or null so a
// tier can tell "found nothing" from "found something", without re-deciding
// what counts as a valid extension in three different places.
function findAsset(dir, base) {
  for (const ext of MEDIA_EXTENSIONS) {
    const file = path.join(dir, `${base}.${ext}`);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) return { path: file, ext, mtimeMs: st.mtimeMs };
    } catch { /* try the next extension */ }
  }
  return null;
}

function fileResult(tier, agent, state, hit) {
  // `mtimeMs` lets the display bust the image cache when a picture is replaced
  // by one of the same extension; `fallback` is what the face draws instead of
  // the file when agent images are turned off (BACKLOG C #18).
  const { initials, hue } = placeholderFor(agent);
  return {
    kind: 'file', tier, media: mediaKindFor(hit.ext), agent, state, path: hit.path,
    mtimeMs: hit.mtimeMs, fallback: { initials, hue },
  };
}

// Tier 1: a real person's own upload, copied in by host/portrait-upload.js.
// A per-state file always wins; a per-agent default.<ext> only ever stands in
// for a state that has no file of its own.
function uploadedFor(safeAgent, safeState, uploadsDir) {
  if (!uploadsDir) return null;
  const agentDir = path.join(uploadsDir, safeAgent);
  return findAsset(agentDir, safeState) || findAsset(agentDir, 'default');
}

// Tier 2: the existing forge output, plus a shared `_default` agent folder --
// where a future "one generated character for everyone" lands. PNG only: the
// forge has never written anything else, and `findAsset` still needs an
// extension list, so this one is pinned rather than reusing the full set.
function pngHit(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { path: file, ext: 'png', mtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}

function forgeOwnFor(safeAgent, safeState, portraitsDir) {
  if (!portraitsDir) return null;
  const hit = pngHit(path.join(portraitsDir, safeAgent, `${safeState}.png`));
  return hit ? fileResult('forge', safeAgent, safeState, hit) : null;
}

function forgeSharedFor(safeAgent, safeState, portraitsDir) {
  if (!portraitsDir) return null;
  const hit = pngHit(path.join(portraitsDir, '_default', `${safeState}.png`))
    || pngHit(path.join(portraitsDir, '_default', 'default.png'));
  return hit ? fileResult('forge', safeAgent, safeState, hit) : null;
}

// Tier 3: a picture shipped with the app itself, for the majority of installs
// that never touch a GPU and never drop a file on a face. Does NOT exist on
// disk today (app/assets/portrait-default.*) -- that is deliberate; this makes
// the lookup real without generating or committing a placeholder image.
function shippedFor(safeAgent, safeState, shippedDir) {
  if (!shippedDir) return null;
  const hit = findAsset(shippedDir, 'portrait-default');
  return hit ? fileResult('shipped', safeAgent, safeState, hit) : null;
}

// The user-set default picture for EVERY agent (BACKLOG C #3), stored by the
// ordinary uploader under the reserved agent segment `_global`. Returns
// { path, ext, file, media } or null when none is set.
function globalPortrait(uploadsDir) {
  if (!uploadsDir) return null;
  const hit = findAsset(path.join(uploadsDir, GLOBAL_AGENT), 'default');
  return hit ? { ...hit, file: path.basename(hit.path), media: mediaKindFor(hit.ext) } : null;
}

function portraitFor(agent, state, { portraitsDir, uploadsDir, shippedDir } = {}) {
  const safeAgent = safeSegment(agent);
  const safeState = safeSegment(state);
  if (!safeAgent || !safeState) return placeholderFor(agent);
  // `_global` is the folder of the global default, not an agent: a real agent
  // that happens to carry the name must not read it as its own upload.
  if (isReservedAgent(safeAgent)) return placeholderFor(agent);

  const uploaded = uploadedFor(safeAgent, safeState, uploadsDir);
  if (uploaded) return fileResult('uploaded', safeAgent, safeState, uploaded);

  const forgedOwn = forgeOwnFor(safeAgent, safeState, portraitsDir);
  if (forgedOwn) return forgedOwn;

  // The user's own explicit choice beats the generated shared character.
  const global = globalPortrait(uploadsDir);
  if (global) return fileResult('global', safeAgent, safeState, global);

  const forgedShared = forgeSharedFor(safeAgent, safeState, portraitsDir);
  if (forgedShared) return forgedShared;

  const shipped = shippedFor(safeAgent, safeState, shippedDir);
  if (shipped) return shipped;

  return placeholderFor(agent);
}

module.exports = {
  portraitFor, placeholderFor, listStates, BUILTIN_STATES,
  safeSegment, MEDIA_EXTENSIONS, GLOBAL_AGENT, globalPortrait, isReservedAgent,
};
