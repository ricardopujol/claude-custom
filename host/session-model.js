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
const { claudeProjectsDir } = require('./claude-config-dir');
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

// How far the window may WIDEN when it holds no model-bearing line. "Always
// near EOF" is usually true and not always: a subagent killed right after a
// huge Read ends on one tool_result longer than the whole window (Dexter, PR
// #34, Finding 5). Doubling from TAIL_BYTES reaches 8 MiB in six reads; past
// that the model is reported as unread (and the host keeps what it knew)
// rather than paying for a full parse of a tens-of-MB transcript on every
// SubagentStop.
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

function defaultProjectsDir() {
  return claudeProjectsDir();
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
 * The complete JSONL records in the last `window` bytes of a file of `size`.
 *
 * Reads ONE byte more than the window. The tail can begin mid-line, so
 * everything up to and including the first newline is dropped -- a truncated
 * fragment must never reach JSON.parse, where it could parse into a
 * wrong-shaped object that happens to validate. Starting a byte early makes
 * that drop exact: if the window begins precisely on a line boundary, the extra
 * byte IS the previous line's newline, and dropping it keeps the first line
 * whole. Without it, that complete line was thrown away as a fragment (Dexter,
 * PR #34, Finding 5).
 */
async function readWindow(fh, size, window) {
  const start = Math.max(0, size - window);
  const from = start > 0 ? start - 1 : 0;
  const len = size - from;
  if (len <= 0) return [];
  const buf = Buffer.allocUnsafe(len);
  await fh.read(buf, 0, len, from);
  let text = buf.toString('utf8');
  // Gated on where the read BEGAN, not where the window did: at start === 1 the
  // read starts at byte 0, there is no fragment, and dropping to the first
  // newline threw away a complete first line (Dexter, PR #34 round 1, F4).
  if (from > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The parsed JSONL records in the tail of `file`, in file order: the last
 * `TAIL_BYTES` first, doubling up to `TAIL_MAX_BYTES` until `until(entries)`
 * holds (or the whole file has been read).
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
async function tailEntries(file, openFile, { until = () => true } = {}) {
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
    let window = TAIL_BYTES;
    for (;;) {
      const entries = await readWindow(fh, stat.size, window);
      // Stop at what the caller wanted, at the start of the file, or at the cap.
      // `+ 1` because readWindow reads one byte before the window: at
      // window + 1 === size that read began at byte 0 and saw the whole file
      // (Dexter, PR #34 r4).
      if (until(entries) || window + 1 >= stat.size) return { entries, gone: false };
      // Stopped by the cap with what was wanted still unfound: the rest of the
      // file was never read, so this is UNREAD, not absent. `capped` lets the
      // caller count it -- otherwise a read that skipped a run looks clean
      // (Dexter, PR #34 round 3).
      if (window >= TAIL_MAX_BYTES) return { entries, gone: false, capped: true };
      window = Math.min(window * 2, TAIL_MAX_BYTES);
    }
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
  // host/agent-stats.js's createStatsMemo: the identity walk then re-reads only files whose (mtime, size)
  // changed. This runs on every SessionStart and SubagentStop (Miguel M3, PR #131). One memo per project.
  memo,
} = {}) {
  const session = { model: null, at: null };
  // A Map, turned into an object only on the way out: `agents[agent] = row`
  // with an agent labelled `__proto__` swaps the prototype instead of adding a
  // key (Miguel, PR #34, I1). fromEntries defines own properties.
  const agents = new Map();

  if (typeof sessionId !== 'string' || !sessionId || !projectsDir || !projectDir) {
    return { session, agents: {}, errors: 0 };
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
    return { session, agents: {}, errors: 1 };
  }

  // This session's own top-level transcript plus the subagents it directly
  // spawned. A nested agent's identity still resolves: identityTables walks
  // these same files, and the inner Agent block lives in the outer agent's
  // transcript, which is one of them.
  const mine = files.filter(f => f.session === sessionId);
  const tables = await identityTables(mine, memo);
  let errors = enumErrors + tables.errors;
  // Which run each agent's row came from, so a later file can be compared
  // against it rather than simply overwriting it -- see isNewerRun.
  const picked = new Map();

  for (const entry of mine) {
    const { entries, gone, capped } = await tailEntries(entry.file, openFile, { until: (e) => latestModel(e) !== null });
    if (gone) continue;                        // vanished: correctly nothing
    if (entries === null) { errors++; continue; }   // exists, unreadable: a failure

    const latest = latestModel(entries);
    if (!latest) {
      if (capped) errors++;                     // never reached a model line: UNREAD
      continue;                                 // whole file, no model yet: absence
    }

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
    agents.set(agent, row);
  }

  return { session, agents: Object.fromEntries(agents), errors };
}

const emptyModel = () => ({ session: { model: null, at: null }, agents: {}, errors: 0 });

/**
 * Fold a fresh read into what is already known about the SAME session.
 *
 * A known model is never downgraded to unknown by a later read. A read that
 * failed -- or half-failed: one unlistable folder, one oversized tail -- comes
 * back missing rows it did not manage to see, and replacing the whole map with
 * it flipped every card to "—" (Dexter, PR #34, Finding 3). The renderer fixed
 * the same class for careers in `mergeAgentStats`.
 *
 * What the new read DID see wins: it is a full read, and readSessionModel has
 * already picked each agent's newest run. `errors` is the new read's own, so a
 * failure is still reported even though nothing was lost.
 *
 * Built through a Map and `Object.fromEntries`, never `obj[agent] = row`: an
 * agent labelled `__proto__` would otherwise swap the object's prototype
 * instead of becoming a key (Miguel, PR #34, I1). fromEntries defines own
 * properties, and JSON round-trips them.
 */
function mergeSessionModel(prev, next) {
  // An unresolved row is a label a half-failed read fell back to; once a later
  // read resolves the same run to its type, keeping the label would show one
  // run twice under two names for the rest of the session (Dexter, PR #34
  // round 1, F3). But only a CLEAN read has the standing to evict it: a failed
  // or partial read that simply did not see the run would otherwise wipe it
  // or hand it an older run (Dexter r2 #1, Miguel r2 G1). A clean read that
  // still can't resolve the label re-reports it, so nothing real is lost.
  //
  // "Clean" = errors === 0, which counts unreadable files AND runs the tail
  // cap stopped short of (Dexter r3). One skip is still uncounted, knowingly:
  // a subagent whose `.meta.json` is missing (ENOENT) and whose identity the
  // tables can't resolve is skipped as "nothing to file it under". Claude Code
  // writes the meta beside the transcript, so that needs a half-written pair.
  const cleanRead = !!next && next.errors === 0;
  const rows = new Map(Object.entries((prev && prev.agents) || {})
    .filter(([, row]) => !(cleanRead && row && row.unresolved)));
  for (const [agent, row] of Object.entries((next && next.agents) || {})) {
    // A fresh read replaces a known row unless the known one is strictly
    // NEWER. A partial read that could not open an agent's latest transcript
    // still sees its older runs, and letting that overwrite put an older
    // model back on the card -- Finding 1 again, one layer up (Dexter r1 F1,
    // Miguel r1 N1). Same ordering as within a read; the empty file names make
    // a tie go to the fresh read.
    const known = rows.get(agent);
    if (known && isNewerRun({ at: known.at, file: '' }, { at: row && row.at, file: '' })) continue;
    rows.set(agent, row);
  }
  const nextSession = next && next.session;
  const session = nextSession && typeof nextSession.model === 'string'
    ? nextSession
    : (prev && prev.session) || { model: null, at: null };
  return {
    session,
    agents: Object.fromEntries(rows),
    // A read that did not report a count has an UNKNOWN count, not zero --
    // the same input `cleanRead` above already refuses to call clean.
    errors: next && Number.isInteger(next.errors) ? next.errors : null,
  };
}

/**
 * The host's refresh of the session model, as a unit it can test.
 *
 * Coalesces concurrent refreshes -- a read walks the whole main transcript and
 * takes seconds -- but NOT by handing a later event the read already in
 * flight. That read started before the event, so it cannot contain what the
 * event announced: a subagent that spawned and finished mid-read never
 * appeared, and a /clear mid-read showed the old session's agents under the
 * new id (Dexter, PR #34, Finding 4). Instead an event during a read marks it
 * dirty, and ONE follow-up read runs after it settles; every caller gets the
 * state after the last read. A result for a session that is no longer current
 * is discarded rather than merged.
 *
 *   read(sessionId)      -> Promise<readSessionModel result>
 *   currentSessionId()   -> the id to read now, or null before SessionStart
 *   onChange(state)      -> called once per settled change, never for a no-op
 */
function createSessionModelRefresher({ read, currentSessionId, onChange = () => {}, log = console.error } = {}) {
  let state = emptyModel();
  let stateSession = null;
  let pending = null;
  let dirty = false;

  async function run() {
    do {
      dirty = false;
      const sid = currentSessionId();
      if (!sid) break;
      // A new session owns none of the old one's rows. Drop them now, before
      // the read, so nothing that asks in the meantime (a client's hello) is
      // handed the previous session's agents under the new id.
      resetIfSessionChanged(sid);
      let result;
      try {
        result = await read(sid);
      } catch (err) {
        log('[host] session model read failed:', err && err.message);
        continue;                                // keep what is known; retry only if dirty
      }
      // The session changed while this read ran: its answer is about the wrong
      // session. Go round again for the current one instead of merging it.
      if (currentSessionId() !== sid) { dirty = true; continue; }
      const base = stateSession === sid ? state : emptyModel();
      const before = JSON.stringify(state);
      state = mergeSessionModel(base, result);
      stateSession = sid;
      if (JSON.stringify(state) !== before) onChange(state);
    } while (dirty);
    return state;
  }

  // Drop the old session's rows the moment a new id is seen. Called from
  // refresh() as well as run(): run() may be parked on the OLD session's read
  // for seconds, and until it wakes, current() -- what a client's hello gets --
  // would still hand out the old agents under the new id (Dexter r1 F2).
  function resetIfSessionChanged(sid) {
    if (stateSession !== null && stateSession !== sid) {
      state = emptyModel();
      stateSession = sid;
      onChange(state);
    }
  }

  function refresh() {
    const sid = currentSessionId();
    if (!sid) return Promise.resolve(state);
    resetIfSessionChanged(sid);
    if (pending) { dirty = true; return pending; }
    pending = run().finally(() => { pending = null; });
    return pending;
  }

  return { refresh, current: () => state };
}

module.exports = {
  latestModel, isNewerRun, readSessionModel, defaultProjectsDir, SYNTHETIC, TAIL_BYTES, TAIL_MAX_BYTES,
  mergeSessionModel, createSessionModelRefresher,
};
