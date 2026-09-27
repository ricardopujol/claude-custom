'use strict';
/**
 * The WHOLE roster (BACKLOG D #16): every agent Claude Code could possibly be,
 * not just the ones seen in this host's lifetime.
 *
 *   DEFINITIONS  every `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`
 *                -- name from frontmatter `name:`, falling back to the filename.
 *                A definition on disk is a real agent Ricardo can spawn even if
 *                it never has been.
 *   HISTORY      every agent name resolved out of a transcript, across EVERY
 *                project under `~/.claude/projects/` -- not just the one this
 *                host happens to be running in, because the roster this backlog
 *                item wants is "everyone who has ever worked", not "everyone
 *                who has worked here".
 *
 * IDENTITY IS REUSED, NOT RE-DERIVED. host/agent-stats.js's header explains why
 * a NAMED spawn (`agentType: "miguel-usage"`, no `toolUseId`) must resolve to
 * its true `subagent_type` rather than being filed under the label -- that is
 * MEASURED behaviour, not a guess, and re-implementing it here would be a
 * second copy of the exact bug that module exists to prevent. So this module
 * imports `identityTables`/`resolveAgent` from agent-stats.js and
 * `transcriptFiles` from transcripts.js rather than walking `.jsonl` files on
 * its own.
 *
 * ONE SHARED PROJECT SCAN (Dexter F5 / Miguel M1, PR #59 review). `scanProjects`
 * walks `~/.claude/projects/` and builds each project's `{ files, tables }`
 * ONCE. host/agent-stats-cache.js's `lifetimeAgentTokens` takes the SAME scan
 * (host.js computes it once and hands it to both) rather than re-enumerating
 * and re-resolving identity a second time -- before this, every host launch
 * read and parsed every top-level session transcript on the machine TWICE,
 * once per module, and the two walks could disagree if the tree changed
 * between them (Dexter F10: a brand-new agent's first run landing mid-scan
 * could appear in one module's result and not the other's).
 *
 * `resolveSubagentEntry` reads one subagent's `.meta.json` and resolves its
 * identity EXACTLY ONCE per file, shared the same way, so `historyNames` and
 * `lifetimeAgentTokens` can never disagree about a given run's identity or its
 * read-failure count either (Dexter F4: a corrupt meta.json used to vanish a
 * run's tokens from BOTH modules while `unreadable` stayed 0 in each).
 *
 * WHAT THIS MODULE DOES NOT DO: decide who is "Active" vs "Inactive" (that is
 * today's roster, already known to host/mood-machine.js, minus this list --
 * app/roster-tabs-display.js's job) or compute lifetime TOKEN totals (that is
 * host/agent-stats-cache.js's job, because it needs to be cached and
 * incremental).
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { transcriptFiles } = require('./transcripts');
const { identityTables, resolveAgent } = require('./agent-stats');

function defaultHomeDir() { return os.homedir(); }
function defaultProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }

// Frontmatter is the region between the first two `---` lines, exactly how
// Claude Code's own agent files are written. Anything before the first `---`
// or a file with none at all has no frontmatter to read.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*/;
const NAME_KEY_RE = /^\s*name:\s*(.+?)\s*$/m;

// A YAML scalar may be quoted: `name: "code-reviewer"` and `name: 'x'` both
// mean the bare string. Dexter F8 (PR #59 review): keeping the quotes made a
// USED definition draw as TWO rows -- `code-reviewer` (with tokens, from
// history, which never carries quotes) and `"code-reviewer"` (never used,
// sorted last) -- for what is really one agent.
function stripQuotes(s) {
  const m = /^(['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

/**
 * The agent's declared name, or `fallback` (the filename, extension-less) when
 * there is no frontmatter, or frontmatter with no `name:` key. Exported for a
 * direct unit test of the parsing rule alone.
 */
function nameFromFrontmatter(raw, fallback) {
  const fm = FRONTMATTER_RE.exec(raw || '');
  const body = fm ? fm[1] : (raw || '');
  const m = NAME_KEY_RE.exec(body);
  return m && m[1] ? stripQuotes(m[1].trim()) : fallback;
}

async function readAgentDefDir(dir) {
  const names = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // No such directory is the ordinary case -- not every project (or even
    // every install) has defined any custom agents at all.
    return names;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fallback = entry.name.slice(0, -3);
    let raw = '';
    try {
      raw = await fsp.readFile(path.join(dir, entry.name), 'utf8');
    } catch {
      // Unreadable definition: still a real file on disk, so it still counts
      // as an agent -- just under its filename, the same as no frontmatter.
    }
    names.push(nameFromFrontmatter(raw, fallback));
  }
  return names;
}

/**
 * Definitions only: every `.md` under the global agents directory and, when a
 * project `cwd` is given, its own `.claude/agents` too.
 *
 * Returns a `Set<string>` -- the caller decides what to do with duplicates
 * across the two directories, which this already resolves by construction.
 */
async function agentDefinitions({ homeDir = defaultHomeDir(), cwd } = {}) {
  const dirs = [path.join(homeDir, '.claude', 'agents')];
  if (cwd) dirs.push(path.join(cwd, '.claude', 'agents'));
  const names = new Set();
  for (const dir of dirs) {
    for (const n of await readAgentDefDir(dir)) names.add(n);
  }
  return names;
}

/**
 * Every project under `projectsDir`, enumerated and identity-resolved ONCE.
 *
 * Returns `{ projects: [{ dir, files, tables }], errors }`. `errors` is the
 * enumeration/identity-table failure count -- `transcriptFiles`' own errors
 * plus `identityTables`' own -- summed across every project. This is the
 * ONLY place that count is produced; callers that share one `scan` must add
 * it to their own total EXACTLY ONCE (see `wholeRoster`'s comment) rather
 * than each re-deriving and re-counting it (Miguel L2, PR #59 review).
 */
async function scanProjects(projectsDir = defaultProjectsDir()) {
  const projects = [];
  let errors = 0;

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    // No `~/.claude/projects` at all: nothing has ever run anywhere.
    return { projects, errors };
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue; // stray files beside the project dirs are not projects
    const dir = path.join(projectsDir, entry.name);

    const { files, errors: enumErrors } = await transcriptFiles(dir);
    errors += enumErrors;
    if (files === null) { errors++; continue; }

    const tables = await identityTables(files);
    errors += tables.errors;

    projects.push({ dir, files, tables });
  }

  return { projects, errors };
}

/**
 * One subagent transcript's identity, resolved exactly once -- shared by
 * `historyNames` here and host/agent-stats-cache.js's `lifetimeAgentTokens` so
 * the two can never disagree about a run's identity or its read-failure count.
 *
 * Returns `{ agent, source, readError }`:
 *   agent      the resolved TYPE, an unresolved hook LABEL, or `null`
 *              (`resolveAgent`'s own return shape)
 *   source     `resolveAgent`'s provenance: `'tool-use' | 'name' | 'unresolved'
 *              | 'unknown'`
 *   readError  the meta.json EXISTED but could not be parsed or understood --
 *              CORRUPTION, not absence (Dexter F4; the same distinction
 *              host/agent-stats.js draws for its own `readErrors`). A missing
 *              meta (ENOENT -- no meta ever written) is the ordinary case for
 *              an unnamed run and is NOT an error.
 */
async function resolveSubagentEntry(file, tables) {
  const metaPath = file.file.replace(/\.jsonl$/, '.meta.json');
  let meta = null;
  let readError = false;
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    // PARSING IS NOT UNDERSTANDING (agent-stats.js's own phrase): `null`, `0`,
    // `""` and `[]` are all valid JSON that carries no identity at all.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
    else readError = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') readError = true;
  }
  const { agent, source } = resolveAgent(meta, tables, file.session);
  return { agent, source, readError };
}

/**
 * History only: every agent name resolved from every project's transcripts,
 * across ALL of them, not the current one.
 *
 * Returns `{ names, unresolvedNames, unreadable }`:
 *   names           every resolved name (types AND unresolved labels alike --
 *                   a run that really happened is still real history, the
 *                   same choice host/agent-stats.js makes for its per-project
 *                   rows)
 *   unresolvedNames (Dexter F3 / Miguel L1) the subset of `names` that are
 *                   ONLY a hook label, never confirmed against a real
 *                   `subagent_type` -- `resolveAgent`'s own contract warns
 *                   that a caller which can't tell these apart "will happily
 *                   draw them side by side as if they were peers". A caller
 *                   drawing the roster can hedge on these instead of guessing.
 *   unreadable      ONLY this pass's own per-file failures (a corrupt
 *                   meta.json) -- deliberately NOT `scan.errors`
 *                   (enumeration/identity failures), which belongs to
 *                   whichever caller OWNS the scan (`wholeRoster` below) so
 *                   two consumers sharing one scan never double-count the
 *                   SAME failure (Miguel L2).
 */
async function historyNames({ scan, projectsDir } = {}) {
  const resolvedScan = scan || await scanProjects(projectsDir);
  const names = new Set();
  const unresolvedNames = new Set();
  let unreadable = 0;

  for (const { files, tables } of resolvedScan.projects) {
    for (const file of files) {
      if (!file.subagent) continue;
      const { agent, source, readError } = await resolveSubagentEntry(file, tables);
      if (readError) unreadable++;
      if (!agent) continue; // nothing to file it under
      names.add(agent);
      if (source === 'unresolved') unresolvedNames.add(agent);
    }
  }

  return { names, unresolvedNames, unreadable };
}

/**
 * The whole roster: definitions UNION history.
 *
 * `unreadable` folds in the scan's own enumeration/identity errors EXACTLY
 * ONCE -- this function is the one that owns reporting them, whether it built
 * the scan itself or was handed one a caller already had (host.js shares one
 * `scan` between this and `lifetimeAgentTokens`; only ONE of the two may add
 * `scan.errors` to its total, and this is that one).
 */
async function wholeRoster({ homeDir, cwd, projectsDir, scan } = {}) {
  const resolvedScan = scan || await scanProjects(projectsDir);
  const [defs, hist] = await Promise.all([
    agentDefinitions({ homeDir, cwd }),
    historyNames({ scan: resolvedScan }),
  ]);
  const names = new Set([...defs, ...hist.names]);
  return {
    names: [...names],
    unresolvedNames: hist.unresolvedNames,
    unreadable: resolvedScan.errors + hist.unreadable,
  };
}

module.exports = {
  agentDefinitions, historyNames, wholeRoster, nameFromFrontmatter,
  scanProjects, resolveSubagentEntry,
  defaultHomeDir, defaultProjectsDir,
};
