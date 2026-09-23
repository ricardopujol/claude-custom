'use strict';
/**
 * Portrait lookup — convention over configuration, three tiers deep.
 *
 * Resolved per (agent, state), highest tier wins:
 *
 *   1. UPLOADED  .harness/portraits/<agent>/<state>.<ext>      (user-supplied)
 *                .harness/portraits/<agent>/default.<ext>      (per-agent fallback)
 *   2. FORGE     portraits/<agent>/<state>.png                 (generated, existing)
 *                portraits/_default/<state>.png                (one character for everyone)
 *                portraits/_default/default.png
 *   3. SHIPPED   app/assets/portrait-default.<ext>             (bundled with the app)
 *   4. TEXT      initials-on-a-hue placeholder                 (always available)
 *
 * The FOUR STATES stay in the data model even where only one asset exists per
 * agent -- ext resolution collapses to one file reused across every state,
 * never to fewer states. Ricardo, 2026-09-22: he will upload his own per-state
 * images, GIFs and video later; only the DEFAULT asset is allowed to be one
 * picture standing in for all four today.
 *
 * A display that can't say where a picture came from is this project's
 * signature defect (absence reported as a confident answer). So every file
 * result carries `tier` -- 'uploaded' | 'forge' | 'shipped' -- and every
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
const mediaKindFor = ext => (VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image');

// Agent names key straight into a filesystem path. A name is only ever a single
// path segment; anything else is refused rather than resolved.
function safeSegment(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
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
      if (fs.statSync(file).isFile()) return { path: file, ext };
    } catch { /* try the next extension */ }
  }
  return null;
}

function fileResult(tier, agent, state, hit) {
  return { kind: 'file', tier, media: mediaKindFor(hit.ext), agent, state, path: hit.path };
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
function forgeFor(safeAgent, safeState, portraitsDir) {
  if (!portraitsDir) return null;
  const own = path.join(portraitsDir, safeAgent, `${safeState}.png`);
  try {
    if (fs.statSync(own).isFile()) return { kind: 'file', tier: 'forge', media: 'image', agent: safeAgent, state: safeState, path: own };
  } catch { /* fall through */ }

  const sharedState = path.join(portraitsDir, '_default', `${safeState}.png`);
  try {
    if (fs.statSync(sharedState).isFile()) return { kind: 'file', tier: 'forge', media: 'image', agent: safeAgent, state: safeState, path: sharedState };
  } catch { /* fall through */ }

  const sharedDefault = path.join(portraitsDir, '_default', 'default.png');
  try {
    if (fs.statSync(sharedDefault).isFile()) return { kind: 'file', tier: 'forge', media: 'image', agent: safeAgent, state: safeState, path: sharedDefault };
  } catch { /* fall through */ }

  return null;
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

function portraitFor(agent, state, { portraitsDir, uploadsDir, shippedDir } = {}) {
  const safeAgent = safeSegment(agent);
  const safeState = safeSegment(state);
  if (!safeAgent || !safeState) return placeholderFor(agent);

  const uploaded = uploadedFor(safeAgent, safeState, uploadsDir);
  if (uploaded) return fileResult('uploaded', safeAgent, safeState, uploaded);

  const forged = forgeFor(safeAgent, safeState, portraitsDir);
  if (forged) return forged;

  const shipped = shippedFor(safeAgent, safeState, shippedDir);
  if (shipped) return shipped;

  return placeholderFor(agent);
}

module.exports = {
  portraitFor, placeholderFor, listStates, BUILTIN_STATES,
  safeSegment, MEDIA_EXTENSIONS,
};
