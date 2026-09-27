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
 * host/roster-index.js). Kept generic because the REQUIRED property (BACKLOG:
 * "the cached total equals a from-scratch total for any sequence of file
 * adds/grows") is a property of the CACHE, not of transcripts specifically.
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
 * A FAILED READ (PR #59 review, Dexter F1 -- High) IS NOT A STALE READ, and the
 * two used to be handled identically wrong: `readTranscript` (and any other
 * `readFile`) THROWS on anything but ENOENT, by design -- its own callers are
 * supposed to catch and count (host/agent-stats.js does, for its one-project
 * career panel). `incrementalScan` used to call `readFile` with no try/catch at
 * all, so a single EBUSY/EPERM/EISDIR among 1232 real transcripts rejected the
 * WHOLE roster scan, the cache was never written, and every attach re-paid the
 * full ~14s cold pass for as long as the fault lasted. A per-file failure now
 * counts (`failures`) and is deliberately NOT cached -- caching it under the
 * file's current stat would skip retrying it once the transient hazard clears,
 * even though nothing about the file itself changed.
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
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { renameWithRetryAsync } = require('./atomic-write');
const { readTranscript } = require('./agent-stats');
const { scanProjects, resolveSubagentEntry } = require('./roster-index');

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
 * Returns `{ entries, reread, failures }`:
 *   entries   Map-shaped plain object, `file -> { stat: {size, mtimeMs}, value }`,
 *             where `value` is whatever `readFile` resolved to. Contains ONLY
 *             the files in `filePaths` that could be stat'd AND read
 *             successfully -- a file absent from `filePaths`, one that
 *             vanished between listing and stat, and one whose read THREW are
 *             all simply not a key here, never a stale carry-over and never a
 *             fabricated value.
 *   reread    how many files were actually read this pass (successfully or
 *             not), so a caller (or a test) can assert the cache is doing its
 *             job rather than quietly re-reading everything every time.
 *   failures  how many of those reads THREW (Dexter F1) -- the file exists
 *             (it was just stat'd) but could not be read: EBUSY/EPERM/EISDIR,
 *             the same transient hazard host/atomic-write.js documents on
 *             this machine. Counted, never rethrown: one bad file among
 *             thousands must not abort the whole scan.
 */
async function incrementalScan(filePaths, readFile, prevEntries = {}) {
  const entries = {};
  let reread = 0;
  let failures = 0;
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
    } catch {
      // Deliberately NOT cached under this stat: the file didn't change, the
      // READ failed, and caching the failure would skip retrying it once
      // whatever is holding it (antivirus, an indexer) lets go.
      failures++;
    }
  }
  return { entries, reread, failures };
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
 * The per-agent LIFETIME SUMMARY persisted alongside `entries` (Dexter F5): a
 * quick, cheap read of "what we knew last time", so a caller can publish a
 * lower-bound roster THE MOMENT the host boots, before the full incremental
 * scan (which still has to re-walk every project's identity tables) resolves.
 * Same absence rule as `readCacheFile`: missing, corrupt, or version-mismatched
 * is `{}`, never a throw.
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
 * Persist `entries` (plus whatever else `extra` carries, e.g. `{ agents }`)
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
 * are cached and summed; identity (which project-scan and which subagent
 * belongs to which resolved type) is shared with host/roster-index.js's
 * `scanProjects`/`resolveSubagentEntry` rather than re-derived, so this module
 * and the whole-roster identity walk can never disagree (Dexter F10) and never
 * read the SAME top-level session transcripts twice per launch (Dexter F5 /
 * Miguel M1) when a caller passes the SAME `scan` to both.
 *
 * Returns `{ agents: Map(agent -> tokens), ms: Map(agent -> ms),
 * unresolvedAgents: Set<string>, unreadable, entries }`.
 *
 *   unresolvedAgents (Dexter F3 / Miguel L1) -- agents whose tokens include at
 *   least one run resolved only to a hook LABEL, never confirmed against a
 *   real `subagent_type`. The tokens are still real and still counted (the
 *   same choice host/roster-index.js's `historyNames` makes for its `names`),
 *   but a caller drawing the roster can hedge instead of treating the row as a
 *   confirmed peer of a real type.
 *
 *   unreadable -- this pass's own per-file failures (a thrown read, Dexter F1;
 *   a corrupt meta.json, Dexter F4). Deliberately EXCLUDES the shared scan's
 *   own enumeration/identity errors when a `scan` is supplied by the caller --
 *   see host/roster-index.js's `wholeRoster` comment for why exactly one of
 *   the two consumers of a shared scan owns reporting those (Miguel L2). When
 *   NO `scan` is given, this function builds its own and DOES fold that scan's
 *   errors in, so a standalone call is still a complete count on its own.
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
  let unreadable = ownScan ? resolvedScan.errors : 0;
  const merged = {};

  for (const { files, tables } of resolvedScan.projects) {
    const subagentFiles = files.filter(f => f.subagent);
    const { entries, failures } = await incrementalScan(subagentFiles.map(f => f.file), readFile, carried);
    Object.assign(merged, entries);
    unreadable += failures; // Dexter F1

    for (const f of subagentFiles) {
      const cached = entries[f.file];
      if (!cached) continue; // vanished, or its read failed this pass: nothing to count
      const { agent, source, readError } = await resolveSubagentEntry(f, tables);
      if (readError) unreadable++; // Dexter F4
      if (!agent) continue;
      agents.set(agent, (agents.get(agent) || 0) + numOrZero(cached.value && cached.value.total));
      ms.set(agent, (ms.get(agent) || 0) + numOrZero(cached.value && cached.value.ms));
      if (source === 'unresolved') unresolvedAgents.add(agent); // Dexter F3
    }
  }

  if (cacheFile) {
    const agentsSummary = {};
    for (const [agent, tokens] of agents) agentsSummary[agent] = { tokens, ms: ms.get(agent) || 0 };
    await writeCacheFile(cacheFile, merged, { agents: agentsSummary });
  }
  return { agents, ms, unresolvedAgents, unreadable, entries: merged };
}

module.exports = {
  incrementalScan, readCacheFile, writeCacheFile, readCacheSummary,
  statKey, sameStat, lifetimeAgentTokens, CACHE_VERSION,
};
