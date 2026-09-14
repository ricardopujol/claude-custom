'use strict';
/**
 * Fog of war — the project as a map, with the unexplored parts dark.
 *
 * Three tiers: never touched (black), read (dim), edited (bright), with
 * brightness decaying so stale knowledge fades.
 *
 * THE VALUE IS THE DARK REGIONS. They are blind spots, and this project's own
 * history records a fix landing inside the largest zero-coverage region in
 * scope -- invisible twice over. This makes that visible by default.
 *
 * READ FROM TRANSCRIPTS, NOT FROM HOOKS. The original design assumed hooking
 * Read/Grep/Edit, which would put the helper in the critical path of every
 * file operation -- exactly what the narrow `Agent|Task|Bash` matcher exists to
 * avoid, at a measured ~23ms per call. Claude Code already writes every
 * tool_use with its file_path into the session transcript, so the same data
 * costs nothing, needs no new hook, and covers sessions this harness never
 * hosted.
 *
 * Bash is deliberately ignored. It accounts for most tool calls here (798 of
 * them in one project), and the files it touches live inside shell strings that
 * cannot be parsed reliably. A map that guessed at them would be confidently
 * wrong, which is worse than a map that admits it only tracks structured tools.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// DARK is the tier that matters. A map of only what you have already seen is a
// history, not a map -- the unexplored regions are the entire signal, so they
// are first-class output rather than an absence the caller has to infer.
const TIERS = { EDITED: 'edited', READ: 'read', DARK: 'dark' };

// Tools that name a file in `file_path`. Grep and Glob take a directory and a
// pattern rather than a file, so they say "looked around here", not "read
// this" -- a weaker claim than this map makes, so they are left out.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);

// A working day. Knowledge of a file you edited this morning is real; the same
// edit three weeks ago is a memory of having been there.
const DECAY_HALFLIFE_MS = 8 * 60 * 60 * 1000;

// Floor, because zero means NEVER TOUCHED. A file edited a year ago is still a
// file you have seen, and collapsing the two erases the only signal here.
const MIN_BRIGHTNESS = 0.18;

const TIER_PEAK = { [TIERS.EDITED]: 1, [TIERS.READ]: 0.55 };

function projectDirName(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/[/:]/g, '-');
}

const normalize = p => String(p || '').replace(/\\/g, '/');

function brightness(tier, ageMs) {
  const peak = TIER_PEAK[tier] || TIER_PEAK[TIERS.READ];
  // Clock skew between machines writing the same project folder is real, so a
  // negative age must not amplify anything.
  const age = Math.max(0, Number(ageMs) || 0);
  const decayed = peak * Math.pow(0.5, age / DECAY_HALFLIFE_MS);
  return Math.min(1, Math.max(MIN_BRIGHTNESS * (peak / TIER_PEAK[TIERS.EDITED]), decayed));
}

// Only files inside the project. Reading ~/.claude/agents/x.md says nothing
// about this project's map, and including it would put another repo's paths in
// the tree.
function relativeTo(root, file) {
  const r = normalize(root).replace(/\/+$/, '').toLowerCase();
  const f = normalize(file);
  if (!f.toLowerCase().startsWith(r + '/')) return null;
  return f.slice(r.length + 1);
}

// Parsed transcripts, keyed by path, invalidated on mtime+size. A full read
// costs ~180ms across this project's sessions, and the host's event loop is
// what delivers hook events -- this project has already measured the cost of
// blocking it, when a spawnSync in the server dropped 31 of 35 events. Sessions
// are append-only and old ones never change, so almost every re-read is free.
const parsedCache = new Map();

function parseTranscript(file, root, onParse) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Map();
  }
  const cached = parsedCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
      && cached.root === root) {
    return cached.entries;
  }
  const entries = new Map();
  collect(file, root, entries);
  if (onParse) onParse(file);
  parsedCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, root, entries });
  return entries;
}

// Two entries for the same file from different sessions have to merge, not
// overwrite: the tier is the strongest ever seen and the timestamp the latest.
function mergeInto(target, entries) {
  for (const [rel, entry] of entries) {
    const seen = target.get(rel);
    if (!seen) {
      target.set(rel, { ...entry });
      continue;
    }
    seen.touches += entry.touches;
    if (entry.tier === TIERS.EDITED) seen.tier = TIERS.EDITED;
    seen.lastTouched = Math.max(seen.lastTouched, entry.lastTouched);
  }
}

function collect(file, root, touched) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('tool_use') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;              // transcripts are appended live; a partial last line is normal
    }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;

    const at = Date.parse(entry.timestamp);
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const isEdit = EDIT_TOOLS.has(block.name);
      if (!isEdit && !READ_TOOLS.has(block.name)) continue;

      const filePath = block.input && block.input.file_path;
      if (!filePath) continue;
      const rel = relativeTo(root, filePath);
      if (!rel) continue;

      const seen = touched.get(rel) || { path: rel, tier: TIERS.READ, lastTouched: 0, touches: 0 };
      seen.touches += 1;
      // EDITED wins permanently. Reading a file after editing it does not make
      // you know it less, so the tier must not follow whichever came last.
      if (isEdit) seen.tier = TIERS.EDITED;
      if (Number.isFinite(at)) seen.lastTouched = Math.max(seen.lastTouched, at);
      touched.set(rel, seen);
    }
  }
}

function readFog({ cwd, projectsDir, now = Date.now, tracked, onParse } = {}) {
  const root = normalize(cwd);
  const dir = path.join(projectsDir || path.join(os.homedir(), '.claude', 'projects'),
    projectDirName(root));

  const touched = new Map();
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
      mergeInto(touched, parseTranscript(path.join(dir, f), root, onParse));
    }
  } catch { /* a project with no transcripts is simply all fog */ }

  const t = now();
  const out = [...touched.values()].map(entry => ({
    ...entry,
    brightness: brightness(entry.tier, t - entry.lastTouched),
  }));

  // Every project file nobody has opened. This is the point of the feature, so
  // it is the caller's job to say which files exist (git ls-files, typically)
  // and this module's job never to invent them.
  const explored = out.length;
  for (const file of (Array.isArray(tracked) ? tracked : [])) {
    const rel = normalize(file);
    if (touched.has(rel)) continue;
    out.push({ path: rel, tier: TIERS.DARK, lastTouched: 0, touches: 0, brightness: 0 });
  }

  // Brightest first, so what you actually know reads top-down and the dark
  // edges collect at the bottom where they can be counted at a glance.
  out.sort((a, b) => b.brightness - a.brightness || a.path.localeCompare(b.path));
  return { root, files: out, explored, total: out.length };
}

module.exports = { readFog, brightness, TIERS, DECAY_HALFLIFE_MS, MIN_BRIGHTNESS };
