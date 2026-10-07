'use strict';
/**
 * Per-agent career stats, scoped to the PROJECT.
 *
 * Ricardo: "Next to the agents it should say how many tokens they have spent IN
 * THAT PROJECT, and it should say also how much time they have worked IN THAT
 * PROJECT. Not in that context window or session, in the project."
 *
 * So this is a career record, not a session gauge: the same "this folder, all
 * of its history" scope the project token counter uses.
 *
 * WHERE THE DATA IS. Every subagent gets its own transcript beside its parent
 * session, with a `.meta.json` sibling:
 *
 *   <projects>/<encoded-cwd>/<session>/subagents/agent-*.jsonl
 *   <projects>/<encoded-cwd>/<session>/subagents/agent-*.meta.json
 *
 * The transcript carries `message.usage` per line and an ISO `timestamp`, so
 * both figures fall straight out of it.
 *
 * IDENTITY IS THE HARD PART, and guessing it would have been the `Agent`-vs-
 * `Task` mistake again: an aggregate that looks perfectly reasonable while
 * attributing one agent's work to four strangers. MEASURED against 30 real
 * subagent transcripts rather than assumed:
 *
 *   - An ordinary spawn writes `{ toolUseId, agentType: "code-reviewer" }`, and
 *     `agentType` is already the true type.           19 of 30 here.
 *   - A NAMED spawn runs as `requestShape: "background"`, has NO `toolUseId` at
 *     all, and puts THE NAME in `agentType` -- so this project's 14
 *     `code-reviewer` runs were also filed under `miguel-usage`,
 *     `miguel-review`, `miguel-merged-settings`...   11 of 30 here.
 *
 * Both are recoverable because the parent's `Agent` tool_use block carries
 * `subagent_type` on EVERY spawn (26 of 26 measured, named ones included), next
 * to `input.name`. So there are two join keys, and between them they resolved
 * all 30 with none left over.
 *
 * TIME WORKED is last timestamp minus first, within one transcript, summed over
 * runs. Deliberately NOT wall-clock from spawn to SubagentStop, which would
 * count time an agent spent queued. Two agents running in parallel therefore
 * both count their own minutes, which is correct: it is time WORKED, not time
 * elapsed.
 */

const fsp = require('fs/promises');
const path = require('path');
const { claudeProjectsDir } = require('./claude-config-dir');
const { projectDirName } = require('./project-dir');
const { transcriptFiles, readMeta, SUBAGENTS } = require('./transcripts');

const PARSE_BATCH = 500;

// The longest gap between two entries that still counts as working.
//
// MEASURED, and this is why it exists: one real transcript here spans 641
// minutes, of which a SINGLE gap is 637 -- an agent spawned overnight that
// finished the next morning. Every other gap in it is under half a minute. So
// first-to-last is wall-clock wearing the label "time worked", and it reported
// 10.7 hours of labour for about four minutes of it.
//
// Summing gaps instead, each capped here, bounds the error in both directions:
// an overnight wait contributes five minutes rather than eleven hours, and a
// genuinely long tool call contributes five minutes rather than nothing. The
// total can therefore never exceed turns x 5 minutes, which is the honest
// ceiling for a figure derived from timestamps alone.
const IDLE_GAP_MS = 5 * 60 * 1000;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function defaultProjectsDir() {
  return claudeProjectsDir();
}

/**
 * The two identity tables, built from every transcript in the project --
 * subagent transcripts included, because an agent can spawn an agent and the
 * inner `Agent` block then lives in the outer agent's transcript rather than in
 * the session's.
 *
 * Returns `{ byToolUse, byName }`:
 *
 *   byToolUse  Map(toolUseId -> subagent_type). Project-global, correctly:
 *              `toolu_*` ids are unique, so there is nothing to scope.
 *   byName     Map(name -> Map(session -> subagent_type | null)). SESSION-
 *              SCOPED, and `null` marks a name that meant two different types
 *              within one session. See the comment at the `bySession.set`
 *              below for why both of those are load-bearing.
 */
async function identityTables(files) {
  const byToolUse = new Map();
  // name -> Map(session -> type | null). SESSION-SCOPED on purpose: Dexter,
  // logic review 2026-09-14 -- a flat name->type map merges two agents'
  // careers the moment a name is reused for a different type ANYWHERE in the
  // project's history, and readdir order (not anything meaningful) decides
  // which type wins. Worse, it can resolve an orphaned run -- its own parent
  // session pruned -- to a completely unrelated agent's type while reporting
  // `resolved: true`. A name only means what it meant WITHIN the session that
  // established it. `null` marks a name reused for two different types within
  // the SAME session too: refusing to resolve is strictly better than
  // silently picking whichever spawn was parsed last.
  const byName = new Map();
  // Dexter and Miguel, 2026-09-15: this was the one read site left swallowing
  // its failures, and it is the most expensive one to lose. A TOP-LEVEL
  // session transcript is read only here, so a failure was invisible by
  // construction -- and when it fails, every NAMED spawn recorded in it loses
  // its identity and scatters back under its label, which is the exact
  // "one agent's career split across four strangers" this module exists to
  // prevent. Losing identity is worse than losing a total: a total that is
  // short looks short, a career filed under a stranger looks correct.
  let errors = 0;

  for (const entry of files) {
    let raw;
    try {
      raw = await fsp.readFile(entry.file, 'utf8');
    } catch (err) {
      // Same split as readTranscript: vanished is nothing, unreadable is a
      // failure.
      if (!err || err.code !== 'ENOENT') errors++;
      continue;
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Cheap pre-filter: most lines are not tool calls at all, and this runs
      // over the whole project.
      if (line.indexOf('"tool_use"') !== -1 && line.indexOf('"Agent"') !== -1) {
        try {
          const obj = JSON.parse(line);
          const content = obj && obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || block.type !== 'tool_use' || block.name !== 'Agent') continue;
              const input = block.input || {};
              if (!input.subagent_type) continue;
              if (block.id) byToolUse.set(block.id, input.subagent_type);
              if (input.name) {
                let bySession = byName.get(input.name);
                if (!bySession) { bySession = new Map(); byName.set(input.name, bySession); }
                // Tests PRESENCE, not truthiness. `null` is the collision
                // marker and is itself falsy, so an `existing && ...` guard
                // takes the else branch once poisoned and writes a concrete
                // type back -- the marker survived exactly until the next
                // spawn of that name. Miguel and Dexter both caught this at
                // the 2026-09-15 merge gate: A, B, A resolved to A and
                // reported `resolved: true`, which is the "silently picking
                // whichever spawn was parsed last" this exists to prevent.
                // Poisoning must be one-way: null !== any type, so once set
                // it stays set.
                if (!bySession.has(entry.session)) {
                  bySession.set(entry.session, input.subagent_type);
                } else if (bySession.get(entry.session) !== input.subagent_type) {
                  bySession.set(entry.session, null);
                }
              }
            }
          }
        } catch { /* a partial final line is normal */ }
      }
      if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
    }
  }
  return { byToolUse, byName, errors };
}

/**
 * The true agent type for one subagent transcript.
 *
 * Returns `{ agent, source }`. `source` is kept because the fallback is a
 * GUESS -- a name we could not resolve -- and a caller that cannot tell a
 * resolved type from an unresolved label will happily draw them side by side as
 * if they were peers.
 *
 * @param meta    the run's `.meta.json`, or null if it had none
 * @param tables  from `identityTables`: `{ byToolUse: Map(id -> type),
 *                byName: Map(name -> Map(session -> type | null)) }`, where a
 *                `null` marks a name that meant two different types in that
 *                session and therefore resolves to neither
 * @param session the session the RUN belongs to. Name resolution is scoped to
 *                it: a name only means what it meant within the session that
 *                established it. Omitting it is not an error and cannot cause a
 *                wrong attribution -- every named run simply degrades to an
 *                unresolved label, which is the safe direction but is also a
 *                silent, project-wide downgrade, so callers must pass it.
 */
function resolveAgent(meta, tables, session) {
  const label = (meta && meta.agentType) || null;
  if (meta && meta.toolUseId && tables.byToolUse.has(meta.toolUseId)) {
    return { agent: tables.byToolUse.get(meta.toolUseId), source: 'tool-use' };
  }
  if (label) {
    const bySession = tables.byName.get(label);
    const resolved = bySession && bySession.get(session);
    // `resolved` is falsy both when this session never used the name (an
    // orphan whose parent session is gone) and when it used the name for two
    // different types (a same-session collision) -- both cases must degrade
    // to the unresolved label, never guess.
    if (resolved) return { agent: resolved, source: 'name' };
  }
  return { agent: label, source: label ? 'unresolved' : 'unknown' };
}

async function readTranscript(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    // ENOENT -- vanished between the listing and the read -- contributes
    // nothing, and that IS the correct total. Anything else (EISDIR because
    // `transcripts.js` enumerates by name and can list a directory; EPERM; a
    // corrupt filesystem entry) is a failure the caller must count: the run's
    // tokens are real and simply unread, not absent. Dexter, logic review
    // 2026-09-14 -- a run vanishing here was previously indistinguishable
    // from one that genuinely never happened.
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const stamps = [];
  // One message is one API call with one usage figure, but Claude Code writes
  // each content block on its own line and repeats the usage on every one. A
  // turn with a thinking block and a tool call would otherwise be counted
  // twice -- measured project-wide at a 44.3% overcount. Entries with no id are
  // always counted, so this cannot turn into a silent undercount.
  const seen = new Set();

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      try {
        const obj = JSON.parse(trimmed);
        const at = Date.parse(obj && obj.timestamp);
        if (Number.isFinite(at)) stamps.push(at);
        const message = obj && obj.message;
        const id = message && message.id;
        const already = id ? seen.has(id) : false;
        if (id) seen.add(id);
        const u = already ? null : (message && message.usage);
        if (u && typeof u === 'object') {
          acc.input += num(u.input_tokens);
          acc.output += num(u.output_tokens);
          acc.cacheWrite += num(u.cache_creation_input_tokens);
          acc.cacheRead += num(u.cache_read_input_tokens);
        }
      } catch { /* a partial final line is normal */ }
    }
    if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
  }

  const total = acc.input + acc.output + acc.cacheWrite + acc.cacheRead;

  // Sorted, because entries are not guaranteed in order and clock skew is real:
  // an unsorted scan produces negative gaps that subtract from the career.
  stamps.sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < stamps.length; i++) {
    ms += Math.min(stamps[i] - stamps[i - 1], IDLE_GAP_MS);
  }
  // A single-entry transcript is 0ms, which is the honest answer rather than a
  // missing one.
  return { ...acc, total, ms, timed: stamps.length > 0 };
}

/**
 * Career stats for every agent that has ever run in this project folder.
 *
 * Returns `{ ok, agents, unresolved }`, agents sorted by spend. `ok` is false
 * when the project folder itself could not be read, OR when a meta or
 * transcript file that DOES exist could not be read or parsed -- ABSENCE, not
 * zero, for the same reason host/usage.js draws that line. A missing meta
 * file (ENOENT) is the ordinary case for a run whose identity was never
 * recorded and does not count against `ok`; a meta or transcript that exists
 * but is unreadable or corrupt does.
 */
async function readAgentStats({ cwd, projectsDir } = {}) {
  const root = projectsDir || defaultProjectsDir();
  const dir = path.join(root, projectDirName(cwd));

  const { files, errors: enumErrors } = await transcriptFiles(dir);
  if (files === null) {
    // The project folder itself could not be read: every field an honest
    // caller might sum must still be present, or a consumer reading
    // `unreadable` gets `undefined` on the one path that matters most.
    return { ok: false, agents: [], unresolved: 0, unreadable: 1,
      enumErrors: 1, identityErrors: 0, readErrors: 0 };
  }

  const tables = await identityTables(files);

  const byAgent = new Map();
  let unresolved = 0;
  // Read/parse failures on a file we KNOW exists (transcriptFiles listed it),
  // as opposed to the ordinary absence of a meta sibling that was simply
  // never written. Dexter, logic review 2026-09-14: previously uncounted, so
  // `ok` could report the roster complete while runs worth millions of tokens
  // were silently dropped.
  let readErrors = 0;

  for (const entry of files) {
    if (!entry.subagent) continue;

    // The meta sits beside the transcript, same basename.
    // PARSING IS NOT UNDERSTANDING (Dexter, 2026-09-15): `JSON.parse('null')`
    // succeeds, and so do `0`, `""` and `[]` -- valid JSON carrying no identity
    // is corruption, not absence. ENOENT (no meta was ever written) is the
    // ordinary case, and a transcript with no identity still has tokens worth
    // counting, filed as an unresolved label below. Anything else is a failure.
    // The rule lives in host/transcripts.js's readMeta, shared with the log.
    const { meta, error: metaError } = await readMeta(entry.file);
    if (metaError) readErrors++;

    const { agent, source } = resolveAgent(meta, tables, entry.session);
    if (!agent) continue;                 // nothing to file it under
    if (source === 'unresolved') unresolved++;

    let read;
    try {
      read = await readTranscript(entry.file);
    } catch (err) {
      // BOUND and logged, not a bare catch. Dexter, 2026-09-15: swallowing the
      // error silently means a future TypeError from inside the parse loop
      // gets counted as a disk problem, for every transcript, forever, with
      // `ok:false` and no message anywhere saying why.
      readErrors++;                       // exists but could not be read: absence, not zero
      console.error('[agent-stats] unreadable transcript:',
        entry.file, err && (err.code || err.message));
      continue;
    }
    if (!read) continue;                  // gone between listing and read: correctly nothing

    const row = byAgent.get(agent) || {
      agent, runs: 0, tokens: 0, ms: 0,
      input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
      resolved: true,
    };
    row.runs += 1;
    row.tokens += read.total;
    row.ms += read.ms;
    row.input += read.input;
    row.output += read.output;
    row.cacheWrite += read.cacheWrite;
    row.cacheRead += read.cacheRead;
    // One unresolved run makes the whole row a label rather than a type, and the
    // UI should be able to say so instead of implying a clean identity.
    if (source === 'unresolved') row.resolved = false;
    byAgent.set(agent, row);
  }

  const agents = [...byAgent.values()].sort((a, b) => b.tokens - a.tokens);
  // COUNTS, not just a boolean. host/usage.js returns `{ ok, absent, stale,
  // unreadable }` precisely so its UI can say "3 transcripts could not be read
  // — this is a lower bound"; a bare `ok` can never say how much is missing,
  // and "one corrupt meta" and "an entire session unreadable" are not the same
  // news. Dexter F7 / Miguel I3, 2026-09-15.
  const unreadable = enumErrors + tables.errors + readErrors;
  return {
    ok: unreadable === 0,
    agents,
    unresolved,
    unreadable,
    // Broken out because they fail differently: a directory we could not
    // enumerate may hide whole runs, an identity source we could not read
    // costs identities rather than totals, and a run-level failure costs one
    // run. Same reason usage.js keeps `absent` and `stale` apart.
    enumErrors,
    identityErrors: tables.errors,
    readErrors,
  };
}

// readTranscript is exported for tests only: its ENOENT-vs-throw split is
// the load-bearing half of this module's absence/zero distinction, and a
// mutation of it was measured surviving the whole suite when it was private.
module.exports = {
  readAgentStats, resolveAgent, identityTables, readTranscript, SUBAGENTS, IDLE_GAP_MS,
  // Shared with host/agent-log-session.js so "where are the transcripts" is
  // stated once (it was module-private; the log's default depended on it).
  defaultProjectsDir,
};
