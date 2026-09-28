'use strict';
/**
 * Incremental, disk-cached per-FILE totals (BACKLOG D #16 item 4): the roster's
 * lifetime-tokens-across-ALL-projects sort needs to read every subagent
 * transcript on the machine, and doing that from scratch on every host launch
 * would be the exact cost host/agent-stats.js already accepts for ONE project
 * -- multiplied by however many projects `~/.claude/projects/` holds. This
 * module is what makes a repeat scan cheap: a file whose path+size+mtime match
 * what was cached is trusted outright; anything new, grown, shrunk, or gone is
 * re-read (or dropped) rather than assumed.
 *
 * GENERIC ON PURPOSE. `incrementalScan` knows nothing about tokens, agents, or
 * transcripts -- it takes a list of file paths and a `readFile(path)` function
 * and caches whatever that function returns, keyed on the file's own
 * path+size+mtime. `lifetimeAgentTokens` is the concrete use (readTranscript
 * from host/agent-stats.js, identity resolution shared with
 * host/roster-index.js's `scanProjects`). Kept generic because the REQUIRED
 * property (BACKLOG: "the cached total equals a from-scratch total for any
 * sequence of file adds/grows") is a property of the CACHE, not of transcripts
 * specifically.
 *
 * NEVER SILENTLY GOES DOWN. A file that shrank or changed in any way that
 * moves its size or mtime is re-read, never left at its old (possibly larger)
 * cached value; a file missing from the caller's current listing is dropped
 * from the returned entries entirely -- it does not linger at its last known
 * total. The caller decides what "missing" means (this module does no
 * directory walking of its own), which is what lets a single implementation
 * serve both "the file was deleted" and "the file was outside the scan this
 * time" without either being confused for the other.
 *
 * A FAILED READ (Dexter F1, PR #59 R1 -- High) IS NOT A STALE READ, and the two
 * used to be handled identically wrong: `readTranscript` (and any other
 * `readFile`) THROWS on anything but ENOENT, by design -- its own callers are
 * supposed to catch and count (host/agent-stats.js does, for its one-project
 * career panel). `incrementalScan` used to call `readFile` with no try/catch at
 * all, so a single EBUSY/EPERM/EISDIR among 1232 real transcripts rejected the
 * WHOLE roster scan. A per-file failure now counts (`failures`/`failedFiles`)
 * and is deliberately NOT cached -- caching it under the file's current stat
 * would skip retrying it once the transient hazard clears. Logged, once, with
 * the path and error code (Dexter N4, PR #59 R2): before this a DETERMINISTIC
 * bug (a `TypeError` on an unexpected line shape, say) looked identical to a
 * transient antivirus lock -- silently retried forever, "≥" shown on every
 * launch, with nothing anywhere naming which file or why.
 *
 * AN AGENT WHOSE ONLY TRANSCRIPT FAILED TO READ IS NOT "NEVER USED" (Dexter N2,
 * PR #59 R2): a run that genuinely happened but couldn't be measured this pass
 * must stay distinguishable from a definition that has never run at all --
 * `unreadableAgents` carries exactly that set, resolved via the SAME identity
 * lookup as a successful run (a failed content read says nothing about
 * identity, which lives in `.meta.json`, a separate file).
 *
 * PERSISTED THE SAME WAY host/openrouter.js's catalogue cache is: write to a
 * `.tmp` sibling, then `renameWithRetryAsync` -- host/atomic-write.js's own
 * header explains why the retry is load-bearing on this machine. The temp name
 * is keyed on `process.pid` (Dexter F7): this cache file lives under the
 * install-wide `HARNESS_DIR`, so two host processes could otherwise race on a
 * SHARED fixed temp name and rename a spliced, invalid file into place.
 *
 * SCHEMA-VERSIONED (Dexter F6): a cache entry is a function of the CODE that
 * produced it, not just the file it describes -- a later counting fix (like
 * the message-id dedup host/agent-stats.js's header describes) would otherwise
 * apply to every transcript touched from now on but never to one whose
 * size+mtime stop changing. Bumping `CACHE_VERSION` invalidates the whole
 * cache at once rather than serving stale values forever.
 *
 * THE SEED IS A LOWER BOUND ONLY IF ITS FILES STILL EXIST (Dexter N1, PR #59
 * R2): the per-agent SUMMARY alone (`readCacheSummary`) is NOT safe to publish
 * as "≥" -- Claude Code's own transcript retention can delete an OLD
 * transcript between host launches, and a summary built while that file still
 * existed can then be LARGER than the true current total, which is the
 * opposite of what "≥" is allowed to claim. `readCacheSeed` fixes this by
 * persisting a per-FILE `agent` attribution (`files`) alongside the per-file
 * `entries`, and re-summing ONLY the files that still exist (a cheap `stat`,
 * no content read) at seed time -- a genuine lower bound, never an overstatement.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { renameWithRetryAsync } = require('./atomic-write');
const { readTranscript } = require('./agent-stats');
const { scanProjects } = require('./roster-index');

function defaultProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }

const CACHE_VERSION = 1;

function statKey(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameStat(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Scan `filePaths` (absolute paths the CALLER has already enumerated),
 * re-using `prevEntries[file]` whenever that file's on-disk size+mtime still
 * match what was cached, and calling `readFile(file)` for everything else.
 *
 * Returns `{ entries, reread, failures, failedFiles }`:
 *   entries      Map-shaped plain object, `file -> { stat: {size, mtimeMs},
 *                value }`, where `value` is whatever `readFile` resolved to.
 *                Contains ONLY the files in `filePaths` that could be stat'd
 *                AND read successfully -- a file absent from `filePaths`, one
 *                that vanished between listing and stat, and one whose read
 *                THREW are all simply not a key here, never a stale
 *                carry-over and never a fabricated value.
 *   reread       how many files were actually read this pass (successfully or
 *                not), so a caller (or a test) can assert the cache is doing
 *                its job rather than quietly re-reading everything every time.
 *   failures     how many of those reads THREW (Dexter F1) -- the file exists
 *                (it was just stat'd) but could not be read: EBUSY/EPERM/
 *                EISDIR, the same transient hazard host/atomic-write.js
 *                documents on this machine. Counted, never rethrown: one bad
 *                file among thousands must not abort the whole scan. Each is
 *                logged once, with its path and error code/message (Dexter N4).
 *   failedFiles  the SPECIFIC paths that threw (Dexter N2) -- a caller needs
 *                to know WHICH file failed, not just how many, to attribute
 *                the failure to the right agent rather than only to a global
 *                count.
 */
async function incrementalScan(filePaths, readFile, prevEntries = {}) {
  const entries = {};
  let reread = 0;
  const failedFiles = [];
  for (const file of filePaths) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue; // vanished between listing and stat: nothing to count, not a stale carry-over
    }
    const key = statKey(stat);
    const prev = prevEntries[file];
    if (prev && sameStat(prev.stat, key)) {
      entries[file] = prev;
      continue;
    }
    reread++;
    try {
      const value = await readFile(file);
      entries[file] = { stat: key, value };
    } catch (err) {
      // Deliberately NOT cached under this stat: the file didn't change, the
      // READ failed, and caching the failure would skip retrying it once
      // whatever is holding it (antivirus, an indexer) lets go.
      failedFiles.push(file);
      // Dexter N4: named, once, so a deterministic bug (retried forever,
      // otherwise silent) can be told apart from a transient lock by reading
      // the log rather than guessing.
      console.warn('[agent-stats-cache] could not read', file, '-', err && (err.code || err.message));
    }
  }
  return { entries, reread, failures: failedFiles.length, failedFiles };
}

/**
 * The cache file's shape on disk, unwrapped to just the entries -- a missing
 * cache, a corrupt one, or one from a DIFFERENT `CACHE_VERSION` is EMPTY, not
 * a failure: the first scan after it simply re-reads everything, exactly as
 * if this were a fresh install. A cache is an optimisation, never a source of
 * truth an absent (or stale-shaped) one should be mourned for.
 */
async function readCacheFile(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION
        || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return {};
    }
    return parsed.entries;
  } catch {
    return {};
  }
}

/**
 * The per-agent LIFETIME SUMMARY persisted alongside `entries` -- a raw
 * aggregate with no per-file attribution. NOT a safe lower bound on its own
 * (Dexter N1): a caller wanting to SEED a display before a real scan finishes
 * should use `readCacheSeed` instead, which stat-checks the files behind each
 * total. Kept and exported because it is still useful for anything that
 * doesn't need the lower-bound guarantee (diagnostics, tests). Same absence
 * rule as `readCacheFile`: missing, corrupt, or version-mismatched is `{}`.
 */
async function readCacheSummary(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION
        || !parsed.agents || typeof parsed.agents !== 'object' || Array.isArray(parsed.agents)) {
      return {};
    }
    return parsed.agents;
  } catch {
    return {};
  }
}

/**
 * A STAT-CHECKED lower bound built from the on-disk cache (Dexter N1, PR #59
 * R2): for every file the cache remembers contributing to an agent, only
 * counted if that file STILL EXISTS right now. The raw `agents` summary alone
 * is not safe to publish as "≥" once a transcript can be deleted between host
 * launches (Claude Code's own retention cleanup, for instance) -- a total
 * built from a file that is now gone can be LARGER than the true current
 * total, which is the opposite of what "≥" may claim.
 *
 * Cheap: a `stat` per remembered file, no content re-read. Returns
 * `{ agent: { tokens, ms } }`, the same shape as `readCacheSummary`, but
 * computed from only the files that survived, so summing it is always a
 * genuine lower bound. Missing, corrupt, or version-mismatched cache is `{}`.
 */
async function readCacheSeed(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION
      || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    return {};
  }
  const tokens = {};
  const ms = {};
  for (const [filePath, info] of Object.entries(parsed.files)) {
    if (!info || typeof info !== 'object' || typeof info.agent !== 'string' || !info.agent) continue;
    try {
      await fsp.stat(filePath); // existence only -- a stale stat is still fine for a LOWER bound
    } catch {
      continue; // Dexter N1: a vanished file must never inflate the seed
    }
    tokens[info.agent] = (tokens[info.agent] || 0) + numOrZero(info.total);
    ms[info.agent] = (ms[info.agent] || 0) + numOrZero(info.ms);
  }
  const agents = {};
  for (const agent of Object.keys(tokens)) agents[agent] = { tokens: tokens[agent], ms: ms[agent] || 0 };
  return agents;
}

/**
 * Persist `entries` (plus whatever else `extra` carries, e.g. `{ agents, files }`)
 * atomically. A write that fails degrades to "the next launch re-reads
 * everything", never a throw -- same policy host/openrouter.js's catalogue
 * cache states for the identical reason, but SAID rather than silent.
 */
async function writeCacheFile(file, entries, extra = {}) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Dexter F7: keyed on `process.pid` so two host processes sharing this
    // install-wide cache file can't collide on the SAME temp name -- one
    // process's rename landing on bytes another is still mid-write of, which
    // produces invalid JSON that `readCacheFile` then correctly (but
    // needlessly) treats as empty. Two writers in the SAME process can still
    // race on this file; host.js's `rosterIndexPending` coalesce is what
    // prevents that, not this module.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries, ...extra }), 'utf8');
      await renameWithRetryAsync(tmp, file);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* best effort, as elsewhere */ }
      throw err;
    }
  } catch (err) {
    console.warn('[agent-stats-cache] could not write the roster cache:', err && err.message);
  }
}

// A cached (or freshly read) value's numeric field, guarded against a
// schema-drifted or corrupt entry (Dexter F6): `value: {}` must sum as 0, not
// `undefined + n === NaN`, which would silently poison an agent's WHOLE
// lifetime total and then hide as "never used" once `rosterTokenState` sees a
// non-finite number.
function numOrZero(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Lifetime tokens per agent, across EVERY project under `~/.claude/projects/`
 * -- the concrete use `incrementalScan` exists for. Only SUBAGENT transcripts
 * are cached and summed; identity is resolved ONCE, inside
 * host/roster-index.js's `scanProjects` (Dexter N5, PR #59 R2 -- this module
 * used to call `resolveSubagentEntry` a second time itself, which resolved
 * every file's identity twice per scan and double-counted a corrupt
 * meta.json's failure, the exact double-count Miguel's original L2 finding was
 * about, just moved one level down instead of closed).
 *
 * Returns `{ agents: Map(agent -> tokens), ms: Map(agent -> ms),
 * unresolvedAgents: Set<string>, unreadableAgents: Set<string>, unreadable,
 * entries }`.
 *
 *   unresolvedAgents (Dexter F3 / Miguel L1) -- agents whose tokens include at
 *   least one run resolved only to a hook LABEL, never confirmed against a
 *   real `subagent_type`.
 *
 *   unreadableAgents (Dexter N2, PR #59 R2) -- agents who DID run, but whose
 *   contribution this pass includes at least one transcript that could not be
 *   read (Dexter F1's per-file failure). Without this, a run that genuinely
 *   happened but is unmeasurable THIS PASS produced `tokens: null` exactly
 *   like a definition that has never run at all -- a third state ("ran, but
 *   unreadable") collapsed into "never used". A caller can now draw and sort
 *   these differently.
 *
 *   unreadable -- this pass's own per-file CONTENT-read failures (Dexter F1).
 *   Identity-resolution failures (a corrupt meta.json) are counted inside
 *   `scanProjects` itself now and reach this module through `scan.errors`
 *   only when this function built its OWN scan (`ownScan`); when a caller
 *   shares one `scan` with host/roster-index.js's `wholeRoster`, ONLY
 *   `wholeRoster` adds `scan.errors` to its total (Miguel L2), so this
 *   function's contribution in that case is content-read failures alone.
 *
 * `readFile`, `prevEntries`, and `scan` are all overridable for tests -- the
 * real caller (host/host.js) supplies `scan` (shared with `wholeRoster`) and
 * `cacheFile`, and gets `readTranscript` plus whatever the cache last held.
 */
async function lifetimeAgentTokens({
  projectsDir, cacheFile, prevEntries, readFile = readTranscript, scan,
} = {}) {
  const ownScan = !scan;
  const resolvedScan = scan || await scanProjects(projectsDir || defaultProjectsDir());
  const carried = prevEntries || (cacheFile ? await readCacheFile(cacheFile) : {});
  const agents = new Map();
  const ms = new Map();
  const unresolvedAgents = new Set();
  const unreadableAgents = new Set();
  let unreadable = ownScan ? resolvedScan.errors : 0;
  const merged = {};
  const fileTotals = {}; // Dexter N1: per-file agent attribution, for a future stat-checked seed

  for (const { files, resolved } of resolvedScan.projects) {
    const subagentFiles = files.filter(f => f.subagent);
    const { entries, failures, failedFiles } = await incrementalScan(subagentFiles.map(f => f.file), readFile, carried);
    Object.assign(merged, entries);
    unreadable += failures; // Dexter F1
    const failedSet = new Set(failedFiles);

    for (const f of subagentFiles) {
      const { agent, source } = resolved.get(f.file); // Dexter N5: resolved ONCE, in scanProjects
      if (!agent) continue;
      const cached = entries[f.file];
      if (!cached) {
        // Either vanished between listing and stat (nothing to attribute --
        // the same as it never having existed this pass) or its READ failed
        // (Dexter N2: a run that happened, but is unmeasurable right now --
        // must not be indistinguishable from "never used").
        if (failedSet.has(f.file)) unreadableAgents.add(agent);
        continue;
      }
      const total = numOrZero(cached.value && cached.value.total);
      const spentMs = numOrZero(cached.value && cached.value.ms);
      agents.set(agent, (agents.get(agent) || 0) + total);
      ms.set(agent, (ms.get(agent) || 0) + spentMs);
      fileTotals[f.file] = { agent, total, ms: spentMs };
      if (source === 'unresolved') unresolvedAgents.add(agent); // Dexter F3
    }
  }

  if (cacheFile) {
    const agentsSummary = {};
    for (const [agent, tokens] of agents) agentsSummary[agent] = { tokens, ms: ms.get(agent) || 0 };
    await writeCacheFile(cacheFile, merged, { agents: agentsSummary, files: fileTotals });
  }
  return { agents, ms, unresolvedAgents, unreadableAgents, unreadable, entries: merged };
}

module.exports = {
  incrementalScan, readCacheFile, writeCacheFile, readCacheSummary, readCacheSeed,
  statKey, sameStat, lifetimeAgentTokens, CACHE_VERSION,
};
