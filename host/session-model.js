'use strict';
/**
 * The model an agent (or the main session) ACTUALLY used, read from its own
 * transcript.
 *
 * MEASURED (2026-09-22) on this project's real transcripts, under
 * ~/.claude/projects/<encoded-cwd>/:
 *
 *   - The main session transcript `<session>.jsonl` carries `message.model` on
 *     every assistant line -- `claude-opus-5` (2805x), `claude-sonnet-5`
 *     (221x), and `<synthetic>` (1x) in one real project's history. `<synthetic>`
 *     is a sentinel, not a model, and must be filtered.
 *   - Each subagent transcript `<session>/subagents/<id>.jsonl` carries the
 *     SAME field, per line -- this is what actually ran, e.g.
 *     `claude-fable-5-1`.
 *   - The parent's `Agent` tool_input carries an undocumented `model` field
 *     (e.g. `"opus"`) -- the model REQUESTED for the spawn, never the one that
 *     ran. It is never read here; only the subagent's own transcript is truth.
 *
 * The transcript format is Claude Code's internal implementation detail and can
 * change between versions -- see verify/probe-model-field.js, which pins this
 * against a real transcript rather than a fixture. Absence degrades to `null`,
 * never to a guessed or default string: a wrong "which model" is worse than an
 * honest "not read yet".
 *
 * IDENTITY IS NOT RE-SOLVED HERE. Filing a subagent transcript under the wrong
 * label is the exact "named spawn" defect host/agent-stats.js already has a
 * tested, reused answer for (`identityTables` / `resolveAgent`); a second
 * walker here would be a second place for it to go silently wrong. What that
 * module does NOT already do is read `message.model` -- so this module reuses
 * its identity resolution and adds the one read agent-stats.js has no reason
 * to make.
 *
 * Scoped to ONE session's own files (its top-level transcript plus the
 * subagents it directly spawned), not the whole project: `identityTables`
 * reads each candidate file in FULL to find `Agent` tool_use blocks -- that
 * cost is fine for one session's data and would not be for a whole project's
 * history re-read on every SubagentStop.
 *
 * The model field itself is read with a TAIL read, not a full parse: these
 * transcripts run tens of MB, the latest line is what is wanted, and reading
 * the whole file to find it would repeat the exact cost host/usage.js was
 * built to avoid. Mirrors that module's fail-closed shape (gone vs. absent) at
 * a much smaller scale.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { transcriptFiles } = require('./transcripts');
const { identityTables, resolveAgent } = require('./agent-stats');

// Not a model -- a sentinel Claude Code writes for at least one internally
// generated turn. Filtering it here is the one contract the docs refuse to
// give in writing; verify/probe-model-field.js pins it against a real
// transcript.
const SYNTHETIC = '<synthetic>';

// Bytes read from the END of a transcript. The newest line wins and it is
// always near EOF (transcripts are append-only), so this bounds the cost on a
// tens-of-MB file to one small read rather than a full parse.
const TAIL_BYTES = 128 * 1024;

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The latest real model, given parsed JSONL objects in FILE ORDER.
 *
 * Pure: no I/O, no clock. "Latest" means last-in-file, not latest-timestamp --
 * a missing or clock-skewed timestamp on the true last line must not lose to
 * an earlier one that happens to claim a later stamp. Skips `<synthetic>`,
 * every non-assistant line, and any assistant line with no usable
 * `message.model`.
 *
 * Returns `null` when nothing qualified -- never a guess, never `''`.
 */
function latestModel(entries) {
  if (!Array.isArray(entries)) return null;
  let best = null;
  for (const obj of entries) {
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type !== 'assistant') continue;
    const message = obj.message;
    const model = message && typeof message.model === 'string' ? message.model : null;
    if (!model || model === SYNTHETIC) continue;
    const at = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    best = { model, at };
  }
  return best;
}

/**
 * Whether candidate run `a` is newer than the current pick `b`, across FILES.
 *
 * Within one file "latest" is last-in-file (see latestModel). Across the several
 * transcripts one agent type can have in a session, file order means nothing:
 * subagent ids are random hex, so readdir order is alphabetical noise, and
 * last-writer-wins over it showed an older run's model (Dexter, PR #34,
 * Finding 1). The timestamp is the only ordering there is.
 *
 * A run with no parseable timestamp cannot be ordered, so it never displaces
 * one that can. Ties -- equal stamps, or neither stamped -- fall to the file
 * name, which is arbitrary but STABLE: the answer must not depend on the order
 * the directory happened to be read in.
 *
 * Pure. `a`/`b` are `{ at, file }`.
 */
function isNewerRun(a, b) {
  const ta = typeof a.at === 'string' ? Date.parse(a.at) : NaN;
  const tb = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
  const hasA = Number.isFinite(ta);
  const hasB = Number.isFinite(tb);
  if (hasA !== hasB) return hasA;
  if (hasA && ta !== tb) return ta > tb;
  return String(a.file) > String(b.file);
}

/**
 * The parsed JSONL records in the last `TAIL_BYTES` of `file`, in file order.
 *
 * Returns `{ entries, gone }`:
 *
 *   gone: true    the file does not exist, or is not a file. Contributes
 *                 nothing, and that IS the correct answer -- same split as
 *                 host/usage.js's readFileUsage.
 *   gone: false, entries: null   the file IS there and could not be read (a
 *                 lock, a permissions problem). This is a FAILURE the caller
 *                 must count, not a silent "no model".
 *   gone: false, entries: [...]  zero or more parsed records. A record that
 *                 fails JSON.parse (a line truncated by the tail cut, or a
 *                 genuinely partial final write) is simply dropped -- it is
 *                 not ours to guess at.
 */
async function tailEntries(file, openFile) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    return { entries: null, gone: !err || err.code === 'ENOENT' };
  }
  if (!stat.isFile()) return { entries: null, gone: true };

  let fh;
  try {
    fh = await openFile(file, 'r');
  } catch {
    // stat() succeeded, so the file is there and we could not open it: a lock,
    // not an absence.
    return { entries: null, gone: false };
  }
  try {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return { entries: [], gone: false };
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The tail can begin mid-line. Drop everything up to and including the
      // first newline so a truncated fragment is never handed to JSON.parse as
      // if it were a complete record -- it would either throw (harmless) or,
      // worse, parse into a wrong-shaped object that happens to validate.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const entries = text.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return { entries, gone: false };
  } catch {
    return { entries: null, gone: false };
  } finally {
    try { await fh.close(); } catch { /* already gone */ }
  }
}

/**
 * The model each agent in ONE session actually used -- the main session plus
 * every subagent it directly spawned (transitively, since a nested spawn's
 * identity lives in the outer agent's own transcript, which is included).
 *
 * Returns `{ session: {model, at}, agents: {[agentType]: {model, at,
 * unresolved?}}, errors }`. `errors` counts readdir/parse failures on files
 * known to exist; it is never folded into a confident zero or a missing key --
 * see the module header.
 */
async function readSessionModel({
  projectsDir, projectDir, sessionId,
  // Injectable for the same reason host/usage.js's is: a locked file is not
  // reproducible portably.
  openFile = (f, flags) => fsp.open(f, flags),
} = {}) {
  const session = { model: null, at: null };
  const agents = {};

  if (typeof sessionId !== 'string' || !sessionId || !projectsDir || !projectDir) {
    return { session, agents, errors: 0 };
  }

  const dir = path.join(projectsDir, projectDir);
  // `errors` is folded in, as all three sibling readers do: a subagents folder
  // that could not be LISTED hides transcripts, and dropping the count made
  // that read as a clean "this session ran no agents" (Dexter, PR #34,
  // Finding 2). transcriptFiles counts across the whole project folder, not
  // per session, so this can over-report by another session's failure --
  // the conservative direction, and the same trade its siblings make.
  const { files, errors: enumErrors } = await transcriptFiles(dir);
  if (files === null) {
    // The project folder itself could not be read. Mirrors
    // host/agent-stats.js's readAgentStats: absence, counted, never a zero.
    return { session, agents, errors: 1 };
  }

  // This session's own top-level transcript plus the subagents it directly
  // spawned. A nested agent's identity still resolves: identityTables walks
  // these same files, and the inner Agent block lives in the outer agent's
  // transcript, which is one of them.
  const mine = files.filter(f => f.session === sessionId);
  const tables = await identityTables(mine);
  let errors = enumErrors + tables.errors;
  // Which run each agent's row came from, so a later file can be compared
  // against it rather than simply overwriting it -- see isNewerRun.
  const picked = new Map();

  for (const entry of mine) {
    const { entries, gone } = await tailEntries(entry.file, openFile);
    if (gone) continue;                        // vanished: correctly nothing
    if (entries === null) { errors++; continue; }   // exists, unreadable: a failure

    const latest = latestModel(entries);
    if (!latest) continue;                      // nothing usable yet: absence

    if (!entry.subagent) {
      session.model = latest.model;
      session.at = latest.at;
      continue;
    }

    const metaPath = entry.file.replace(/\.jsonl$/, '.meta.json');
    let meta = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      // A truncated or schema-drifted meta can be valid JSON carrying no
      // identity at all -- see host/agent-stats.js's identical guard.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
      else errors++;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') errors++;
    }

    const { agent, source } = resolveAgent(meta, tables, entry.session);
    if (!agent) continue;                       // nothing to file it under

    const current = picked.get(agent);
    const candidate = { at: latest.at, file: entry.file };
    if (current && !isNewerRun(candidate, current)) continue;
    picked.set(agent, candidate);

    const row = { model: latest.model, at: latest.at };
    if (source === 'unresolved') row.unresolved = true;
    agents[agent] = row;
  }

  return { session, agents, errors };
}

module.exports = {
  latestModel, isNewerRun, readSessionModel, defaultProjectsDir, SYNTHETIC, TAIL_BYTES,
};
