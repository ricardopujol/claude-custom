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
 * WHAT THIS MODULE DOES NOT DO: decide who is "Active" vs "Inactive" (that is
 * today's roster, already known to host/mood-machine.js, minus this list --
 * app/roster-tabs-display.js's job) or compute lifetime TOKEN totals (that is
 * host/agent-stats-cache.js's job, because it needs to be cached and
 * incremental — this module's per-project transcript walk is the identity
 * pass only, deliberately kept separate from the token-total pass so a
 * lifetime rescan never has to re-resolve identity to get a total).
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

/**
 * The agent's declared name, or `fallback` (the filename, extension-less) when
 * there is no frontmatter, or frontmatter with no `name:` key. Exported for a
 * direct unit test of the parsing rule alone.
 */
function nameFromFrontmatter(raw, fallback) {
  const fm = FRONTMATTER_RE.exec(raw || '');
  const body = fm ? fm[1] : (raw || '');
  const m = NAME_KEY_RE.exec(body);
  return m && m[1] ? m[1].trim() : fallback;
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
 * History only: every agent name resolved from every project's transcripts,
 * `~/.claude/projects/*` -- ALL of them, not the current one.
 *
 * Returns `{ names: Set<string>, unreadable }`. `unreadable` is a COUNT, the
 * same shape host/agent-stats.js keeps for the same reason: a directory this
 * could not enumerate hides names, and that is a fact the caller must be able
 * to report rather than silently treat as "nobody has ever run".
 */
async function historyNames({ projectsDir = defaultProjectsDir() } = {}) {
  const names = new Set();
  let unreadable = 0;

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    // No `~/.claude/projects` at all: nothing has ever run anywhere, which is
    // a genuine (if unusual) state, not a failure to report.
    return { names, unreadable };
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);

    const { files, errors } = await transcriptFiles(dir);
    unreadable += errors;
    if (files === null) { unreadable++; continue; }

    const tables = await identityTables(files);
    unreadable += tables.errors;

    for (const file of files) {
      if (!file.subagent) continue;
      const metaPath = file.file.replace(/\.jsonl$/, '.meta.json');
      let meta = null;
      try {
        const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
      } catch {
        // ENOENT (no meta ever written) is ordinary; anything else costs an
        // identity, same distinction agent-stats.js makes, but this pass only
        // reports NAMES -- a run with no resolvable identity contributes
        // nothing here rather than a count agent-stats.js already owns.
      }
      const { agent } = resolveAgent(meta, tables, file.session);
      if (agent) names.add(agent);
    }
  }

  return { names, unreadable };
}

/**
 * The whole roster: definitions UNION history, as a plain array.
 */
async function wholeRoster({ homeDir, cwd, projectsDir } = {}) {
  const [defs, hist] = await Promise.all([
    agentDefinitions({ homeDir, cwd }),
    historyNames({ projectsDir }),
  ]);
  const names = new Set([...defs, ...hist.names]);
  return { names: [...names], unreadable: hist.unreadable };
}

module.exports = {
  agentDefinitions, historyNames, wholeRoster, nameFromFrontmatter,
  defaultHomeDir, defaultProjectsDir,
};
