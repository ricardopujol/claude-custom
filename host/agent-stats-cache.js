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
 * path+size+mtime. host/roster-lifetime.js is the caller that gives it
 * meaning (readTranscript from host/agent-stats.js, and identity resolution
 * from host/roster-index.js's history pass). Kept generic because the
 * REQUIRED property (BACKLOG: "the cached total equals a from-scratch total
 * for any sequence of file adds/grows") is a property of the CACHE, not of
 * transcripts specifically, and is cheaper to state and check as one.
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
 * PERSISTED THE SAME WAY host/openrouter.js's catalogue cache is: write to a
 * `.tmp` sibling, then `renameWithRetryAsync` -- host/atomic-write.js's own
 * header explains why the retry is load-bearing on this machine (a
 * momentarily-held handle from antivirus/indexing turns an un-retried rename
 * into a cache that is silently never written at all).
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { renameWithRetryAsync } = require('./atomic-write');
const { transcriptFiles } = require('./transcripts');
const { identityTables, resolveAgent, readTranscript } = require('./agent-stats');

function defaultProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }

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
 * Returns `{ entries, reread }`:
 *   entries  Map-shaped plain object, `file -> { stat: {size, mtimeMs}, value }`,
 *            where `value` is whatever `readFile` resolved to. Contains ONLY
 *            the files in `filePaths` that could still be stat'd -- a file
 *            absent from `filePaths`, or one that vanished between listing
 *            and stat, is simply not a key here, never a stale carry-over.
 *   reread   how many files were actually read this pass, so a caller (or a
 *            test) can assert the cache is doing its job rather than quietly
 *            re-reading everything every time.
 */
async function incrementalScan(filePaths, readFile, prevEntries = {}) {
  const entries = {};
  let reread = 0;
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
    const value = await readFile(file);
    entries[file] = { stat: key, value };
  }
  return { entries, reread };
}

/**
 * The cache file's shape on disk, unwrapped to just the entries -- a missing
 * or corrupt cache is EMPTY, not a failure: the first scan after it simply
 * re-reads everything, exactly as if this were a fresh install. A cache is an
 * optimisation, never a source of truth an absent one should be mourned for.
 */
async function readCacheFile(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.entries
        || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return {};
    }
    return parsed.entries;
  } catch {
    return {};
  }
}

/**
 * Persist `entries` atomically. A write that fails degrades to "the next
 * launch re-reads everything", never a throw -- same policy
 * host/openrouter.js's catalogue cache states for the identical reason, but
 * SAID rather than silent: a swallowed failure here is indistinguishable from
 * a cache that is working, and that was exactly the defect Dexter's Finding 5
 * found in the catalogue cache before the retry existed.
 */
async function writeCacheFile(file, entries) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ entries }), 'utf8');
      await renameWithRetryAsync(tmp, file);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* best effort, as elsewhere */ }
      throw err;
    }
  } catch (err) {
    console.warn('[agent-stats-cache] could not write the roster cache:', err && err.message);
  }
}

/**
 * Lifetime tokens per agent, across EVERY project under `~/.claude/projects/`
 * -- the concrete use `incrementalScan` exists for. Only SUBAGENT transcripts
 * are cached and summed (the same files host/agent-stats.js sums for one
 * project); top-level session files are still read in full every pass to
 * build each project's identity tables, because a NAMED spawn's true type can
 * only be resolved from its parent session's `Agent` tool_use blocks -- but
 * that read is comparatively cheap (a targeted substring pre-filter before any
 * JSON.parse, see identityTables' own header) next to summing every token in
 * every subagent transcript on the machine, which is the actual cost this
 * cache exists to avoid paying twice.
 *
 * Returns `{ agents: Map(agent -> tokens), ms: Map(agent -> ms), unreadable,
 * entries }`. `entries` is the merged per-file cache, in the exact shape
 * `readCacheFile`/`writeCacheFile` persist -- a caller wanting to chain scans
 * in memory (as the tests here do) passes it back in as `prevEntries` without
 * touching disk at all.
 *
 * `readFile` and `prevEntries` are both overridable for tests -- the real
 * caller (host/host.js) supplies neither and gets `readTranscript` plus
 * whatever `cacheFile` last held.
 */
async function lifetimeAgentTokens({
  projectsDir = defaultProjectsDir(), cacheFile, prevEntries, readFile = readTranscript,
} = {}) {
  const carried = prevEntries || (cacheFile ? await readCacheFile(cacheFile) : {});
  const agents = new Map();
  const ms = new Map();
  let unreadable = 0;
  const merged = {};

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    // No `~/.claude/projects` at all: nothing has ever run anywhere.
    return { agents, ms, unreadable, entries: merged };
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue; // stray files beside the project dirs are not projects
    const dir = path.join(projectsDir, dirEntry.name);

    const { files, errors } = await transcriptFiles(dir);
    unreadable += errors;
    if (files === null) { unreadable++; continue; }

    const tables = await identityTables(files);
    unreadable += tables.errors;

    const subagentFiles = files.filter(f => f.subagent);
    const { entries } = await incrementalScan(subagentFiles.map(f => f.file), readFile, carried);
    Object.assign(merged, entries);

    for (const f of subagentFiles) {
      const cached = entries[f.file];
      if (!cached) continue; // vanished between listing and stat: nothing to count
      const metaPath = f.file.replace(/\.jsonl$/, '.meta.json');
      let meta = null;
      try {
        const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
      } catch {
        // ENOENT (no meta ever written) is ordinary; anything else is the same
        // "identity may be lost" case host/agent-stats.js already counts under
        // `tables.errors`/`readErrors` for its own project -- not duplicated
        // here, since this pass only needs the resolved TYPE, not a count.
      }
      const { agent } = resolveAgent(meta, tables, f.session);
      if (!agent) continue;
      agents.set(agent, (agents.get(agent) || 0) + (cached.value ? cached.value.total : 0));
      ms.set(agent, (ms.get(agent) || 0) + (cached.value ? cached.value.ms : 0));
    }
  }

  if (cacheFile) await writeCacheFile(cacheFile, merged);
  return { agents, ms, unreadable, entries: merged };
}

module.exports = {
  incrementalScan, readCacheFile, writeCacheFile, statKey, sameStat, lifetimeAgentTokens,
};
