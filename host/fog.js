'use strict';
/**
 * Fog of war — the project as a map, with the unexplored parts dark.
 *
 * Three tiers: never touched (dark), read (dim), edited (bright), with
 * brightness decaying so stale knowledge fades.
 *
 * THE VALUE IS THE DARK REGIONS. They are blind spots, and this project's own
 * history records a fix landing inside the largest zero-coverage region in
 * scope -- invisible twice over.
 *
 * READ FROM TRANSCRIPTS, NOT FROM HOOKS. Hooking Read/Grep/Edit would put the
 * helper in the critical path of every file operation at a measured ~23ms a
 * call -- what the narrow `Agent|Task|Bash` matcher exists to avoid. Claude
 * Code already records every tool_use with its file_path, so the data is free
 * and covers sessions this harness never hosted.
 *
 * ASYNCHRONOUS, AND YIELDING, ON PURPOSE. A cold read is ~175ms, and the active
 * session transcript alone is 38MB and changes every turn, so the mtime cache
 * never covers the largest file. The host's event loop is what accepts the hook
 * helper's named-pipe connection, and that helper gives up after 80ms -- a
 * 125ms synchronous span drops hook events, which is the incident that cost 31
 * of 35 of them. `setImmediate` does NOT fix this: it moves work to the check
 * phase of the SAME loop turn, and the loop stays blocked either way. So this
 * awaits between files and between line batches, bounding any single
 * synchronous span to a few milliseconds.
 *
 * Bash is deliberately ignored. It is most tool calls here (798 in one
 * project) and the files it touches live inside shell strings that cannot be
 * parsed reliably. A map that guessed would be confidently wrong.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { projectDirName } = require('./project-dir');

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

// The floor for an EDITED file, because zero means NEVER TOUCHED. A file edited
// a year ago is still one you have seen, and collapsing the two erases the only
// signal here. Each tier's floor is this scaled by its peak, so the tier
// ordering holds at every age -- see FLOOR_FOR.
const MIN_BRIGHTNESS = 0.18;

const TIER_PEAK = { [TIERS.EDITED]: 1, [TIERS.READ]: 0.55, [TIERS.DARK]: 0 };
const FLOOR_FOR = tier => MIN_BRIGHTNESS * (TIER_PEAK[tier] / TIER_PEAK[TIERS.EDITED]);

// Lines parsed between yields. 500 lines of JSON.parse is a few milliseconds,
// comfortably under the helper's 80ms connect timeout.
const PARSE_BATCH = 500;

const normalize = p => String(p == null ? '' : p).replace(/\\/g, '/');
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

function brightness(tier, ageMs) {
  // An unknown tier is a bug, not a READ file. Silently treating DARK as a
  // fresh read is how a never-touched file would light up at 0.55.
  if (!Object.prototype.hasOwnProperty.call(TIER_PEAK, tier)) {
    throw new Error(`brightness: unknown tier ${JSON.stringify(tier)}`);
  }
  const peak = TIER_PEAK[tier];
  if (peak === 0) return 0;                 // dark is dark, at every age

  // An unusable age means "we do not know how old this is", which must fall to
  // the floor. `Number(x) || 0` would instead light the whole map at full
  // brightness the moment a clock returned NaN.
  const n = Number(ageMs);
  if (!Number.isFinite(n)) return FLOOR_FOR(tier);
  const age = Math.max(0, n);               // clock skew between machines is real

  return Math.min(1, Math.max(FLOOR_FOR(tier), peak * Math.pow(0.5, age / DECAY_HALFLIFE_MS)));
}

// Only files inside the project. Reading ~/.claude/agents/x.md says nothing
// about this project's map.
//
// The index is measured on the SAME string it slices. Comparing a lowercased
// prefix and then slicing the original is an off-by-N wherever a character
// changes length when folded -- 'İ'.toLowerCase() is two code units, which
// silently turned 'src/a.js' into 'rc/a.js'.
function relativeTo(root, file) {
  const r = normalize(root).replace(/\/+$/, '');
  const f = normalize(file);
  if (f.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null;
  if (f.charAt(r.length) !== '/') return null;    // '/proj-other' must not match '/proj'
  return f.slice(r.length + 1);
}

// Parsed transcripts, keyed by absolute path, invalidated on mtime+size. Old
// sessions never change, so almost every re-read of them is free. The ACTIVE
// session does change every turn and is the largest file, which is why the
// cache alone is not enough and the read also yields.
const parsedCache = new Map();

function extract(entry, root, touched) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return;
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

async function parseTranscript(file, root, onParse) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { entries: new Map(), ok: false };
  }
  const cached = parsedCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
      && cached.root === root) {
    return { entries: cached.entries, ok: true };
  }

  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // One unreadable transcript must not be reported as "those files were never
    // opened". The caller counts this so the UI can say so out loud.
    return { entries: new Map(), ok: false };
  }

  const entries = new Map();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && trimmed.indexOf('tool_use') !== -1) {
      try {
        extract(JSON.parse(trimmed), root, entries);
      } catch { /* appended live: a partial final line is normal */ }
    }
    // Yield, so the pty and the hook bridge are not queued behind this.
    if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
  }

  if (onParse) onParse(file);
  parsedCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, root, entries });
  return { entries, ok: true };
}

// Two entries for the same file from different sessions must merge, not
// overwrite: the tier is the strongest ever seen, the timestamp the latest.
function mergeInto(target, entries) {
  for (const [rel, entry] of entries) {
    const seen = target.get(rel);
    if (!seen) {
      target.set(rel, { ...entry });     // copy: the source object lives in the cache
      continue;
    }
    seen.touches += entry.touches;
    if (entry.tier === TIERS.EDITED) seen.tier = TIERS.EDITED;
    seen.lastTouched = Math.max(seen.lastTouched, entry.lastTouched);
  }
}

// Top-level sessions AND subagent transcripts. Subagents write to
// <session-uuid>/subagents/*.jsonl, and the parent transcript records only the
// Agent tool_use and the agent's final message -- never the inner Read/Edit
// blocks. Missing them biases the map toward darkness on exactly the repos
// whose work is agent-driven, which is the failure this feature exists to
// prevent. (.meta.json siblings are not transcripts.)
async function transcriptFiles(dir) {
  const out = [];
  let top;
  try {
    top = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;                 // ABSENT is not EMPTY; the caller reports it
  }
  for (const item of top) {
    if (item.isFile() && item.name.endsWith('.jsonl')) {
      out.push(path.join(dir, item.name));
      continue;
    }
    if (!item.isDirectory()) continue;
    const sub = path.join(dir, item.name, 'subagents');
    try {
      for (const f of await fsp.readdir(sub)) {
        if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
      }
    } catch { /* a session with no subagents is the normal case */ }
  }
  return out;
}

async function readFog({ cwd, projectsDir, now = Date.now, tracked, onParse } = {}) {
  const root = normalize(cwd);
  const dir = path.join(projectsDir || path.join(os.homedir(), '.claude', 'projects'),
    projectDirName(root));

  const files = await transcriptFiles(dir);

  // Status travels WITH the data. Every failure here otherwise renders as a
  // confident map: a missing directory reads as "nothing explored", and a
  // missing `tracked` list reads as "everything explored, zero blind spots" --
  // deleting the only thing the feature is for, in the direction that makes
  // you stop looking.
  const status = {
    transcriptsFound: files === null ? 0 : files.length,
    transcriptErrors: 0,
    transcriptsMissing: files === null,
    trackedOk: Array.isArray(tracked) && tracked.length > 0,
  };

  const touched = new Map();
  for (const file of (files || [])) {
    const parsed = await parseTranscript(file, root, onParse);
    if (!parsed.ok) status.transcriptErrors++;
    mergeInto(touched, parsed.entries);
    await yieldToLoop();
  }

  // Drop cache entries for transcripts that no longer exist, so a long-running
  // host does not hold parsed data for sessions Claude Code has expired.
  if (files) {
    const live = new Set(files);
    for (const key of parsedCache.keys()) {
      if (key.startsWith(dir) && !live.has(key)) parsedCache.delete(key);
    }
  }

  const t = now();
  const out = [...touched.values()].map(entry => ({
    ...entry,
    brightness: brightness(entry.tier, t - entry.lastTouched),
  }));

  // Every project file nobody has opened. The caller says which files exist
  // (git ls-files); this module never invents one. De-duplicated via the Set,
  // because `git ls-files` prints an unmerged path once per stage during a
  // merge conflict and would otherwise give one file three rows.
  const trackedSet = new Set((Array.isArray(tracked) ? tracked : []).map(normalize));
  for (const rel of trackedSet) {
    if (touched.has(rel)) continue;
    out.push({ path: rel, tier: TIERS.DARK, lastTouched: 0, touches: 0, brightness: 0 });
  }

  // Coverage measured against the PROJECT, not against everything touched.
  // Reading fifty screenshots under .harness/ is not exploring the project, and
  // counting them inflated both halves of the ratio.
  const explored = trackedSet.size
    ? [...trackedSet].filter(rel => touched.has(rel)).length
    : touched.size;
  const total = trackedSet.size || touched.size;

  // Brightest first, so what you actually know reads top-down and the dark
  // edges collect at the bottom where they can be counted at a glance.
  out.sort((a, b) => b.brightness - a.brightness || a.path.localeCompare(b.path));
  return { root, files: out, explored, total, status };
}

module.exports = {
  readFog, brightness, relativeTo, TIERS, TIER_PEAK,
  DECAY_HALFLIFE_MS, MIN_BRIGHTNESS, FLOOR_FOR, PARSE_BATCH,
};
