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
 * ONE SHARED PROJECT SCAN (Dexter F5 / Miguel M1, PR #59 R1). `scanProjects`
 * walks `~/.claude/projects/` and builds each project's `{ files, tables }`
 * ONCE. host/agent-stats-cache.js's `lifetimeAgentTokens` takes the SAME scan
 * (host.js computes it once and hands it to both) rather than re-enumerating
 * and re-resolving identity a second time.
 *
 * EVERY SUBAGENT'S IDENTITY IS ALSO RESOLVED ONCE, INSIDE `scanProjects`
 * ITSELF (Dexter N5, PR #59 R2 -- L2's residual): R1 had `resolveSubagentEntry`
 * as a function BOTH `historyNames` and `lifetimeAgentTokens` called
 * independently, which resolved each file's identity twice per scan and, worse,
 * counted a corrupt meta.json's `readError` TWICE -- exactly the double-count
 * Miguel's original L2 finding was about, just moved one level down instead of
 * closed. Now `scanProjects` calls it once per subagent file and attaches the
 * result to `project.resolved` (a `Map(file -> {agent, source})`); a
 * `readError` is folded into the shared `scan.errors` at that single call site,
 * and neither consumer below re-derives or re-counts it.
 *
 * A NON-ENOENT FAILURE TO ENUMERATE IS NEVER SILENT (Dexter N6, PR #59 R2): the
 * R1 version of `scanProjects` (and `readAgentDefDir` below, F8's residual)
 * caught EVERY `readdir` failure the same way ENOENT is handled -- "nothing
 * here", counting zero errors. An EPERM or EBUSY on `~/.claude/projects`
 * itself, or on an agents directory, produced a roster that looked complete
 * and clean (`ok:true`) while actually being empty from a failure, which is
 * this repo's own named "absence reported as zero" trap one level up: a
 * FAILURE reported as "there is nothing to know", rather than "there is
 * something here we could not read".
 *
 * WHAT THIS MODULE DOES NOT DO: decide who is "Active" vs "Inactive" (that is
 * today's roster, already known to host/mood-machine.js, minus this list --
 * app/roster-tabs-display.js's job) or compute lifetime TOKEN totals (that is
 * host/agent-stats-cache.js's job, because it needs to be cached and
 * incremental).
 */

const fsp = require('fs/promises');
const path = require('path');
const { claudeConfigDir, claudeProjectsDir } = require('./claude-config-dir');
const { transcriptFiles } = require('./transcripts');
const { identityTables, resolveAgent } = require('./agent-stats');

function defaultProjectsDir() { return claudeProjectsDir(); }

// A `readdir`/`readFile` failure that means "genuinely not there" vs. one that
// means "something is wrong and we could not look". Shared by every ENOENT
// check in this module so the distinction reads the same everywhere.
function isRealFailure(err) {
  return !err || err.code !== 'ENOENT';
}

// Frontmatter is the region between the first two `---` lines, exactly how
// Claude Code's own agent files are written. Anything before the first `---`
// or a file with none at all has no frontmatter to read.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*/;
const NAME_KEY_RE = /^\s*name:\s*(.+?)\s*$/m;

// A YAML scalar may be quoted: `name: "code-reviewer"` and `name: 'x'` both
// mean the bare string. Dexter F8 (PR #59 R1): keeping the quotes made a
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

// --- persona and function (BACKLOG #76) --------------------------------------
// Both are read from the agent file's `description:`, which Claude Code itself
// uses to decide when to spawn the agent. Pure string work, no file access.

function unescapeDouble(s) {
  return s.replace(/\\(["\\/]|n|t)/g, (_m, c) => (c === 'n' || c === 't' ? ' ' : c));
}

// `>`, `|`, an indent digit and a chomping sign in either order, then an optional comment: `>`, `|+`, `>2-`, `>-2`, `> # x`.
const BLOCK_INDICATOR_RE = /^[>|](?:[+-]\d?|\d[+-]?)?\s*(?:#.*)?$/;

/**
 * The agent's `description:` as one line of text, or '' when the file has no
 * frontmatter or no such key. Reads the scalar shapes seen on a real install:
 * double-quoted, single-quoted, plain (with indented continuation lines) and a
 * `>` / `|` block scalar, blank lines inside included. Never throws, never answers null.
 */
function descriptionFromFrontmatter(raw) {
  if (typeof raw !== 'string') return '';
  const fm = FRONTMATTER_RE.exec(raw);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return '';
  const first = lines[at].replace(/^description:\s*/, '').trim();
  const cont = [];
  // Blank lines belong to the value; the first unindented line (the next key) ends it.
  for (let i = at + 1; i < lines.length && /^(?:\s*|\s+\S.*)$/.test(lines[i]); i++) {
    if (lines[i].trim()) cont.push(lines[i].trim());
  }
  if (BLOCK_INDICATOR_RE.test(first)) return cont.join(' ').trim();
  const value = [first, ...cont].join(' ').trim();
  const dq = /^"([\s\S]*)"$/.exec(value);
  if (dq) return unescapeDouble(dq[1]).trim();
  const sq = /^'([\s\S]*)'$/.exec(value);
  if (sq) return sq[1].replace(/''/g, "'").trim();
  return value;
}

// A name is one capitalised word (any script: José, Álvaro, Zoë) or several in
// a row ("Murray Bones"); the first lowercase word ("or", "in") ends it.
const NAME_WORD = "\\p{Lu}[\\p{L}\\p{M}\\w'’-]*";
const NAME_RUN = `${NAME_WORD}(?:[ \\t]+${NAME_WORD}){0,2}`;
const MENTIONS_ALL_RE = new RegExp(`\\bmentions[ \\t]+(${NAME_RUN})`, 'gu');
// The leading form is ONE word: "Peter — ..." is a name, "Elite Reviewer — ..." is a job title.
const LEADING_NAME_RE = new RegExp(`^(${NAME_WORD})[ \\t]+[—–][ \\t]+`, 'u');

// Not people: an ACRONYM ("MCP") or a well-known product a description might mention ("mentions Docker or Kubernetes").
// A heuristic with a known limit: an unlisted product name still reads as a persona.
const NOT_A_NAME = new Set(['docker', 'kubernetes', 'python', 'javascript', 'typescript', 'java', 'rust', 'react', 'vue',
  'angular', 'node', 'django', 'flask', 'git', 'github', 'gitlab', 'linux', 'windows', 'macos', 'aws', 'azure', 'claude',
  'openai', 'anthropic', 'ollama', 'postgres', 'mysql', 'redis', 'kafka', 'terraform', 'ansible', 'jenkins']);
function isNotAName(word) {
  return /^\p{Lu}{2,}$/u.test(word) || NOT_A_NAME.has(word.toLowerCase());
}

// The words of a matched run up to the first one that isn't a name, joined; null when the first isn't.
function nameFromRun(run) {
  const words = [];
  for (const w of run.split(/[ \t]+/)) {
    if (isNotAName(w)) break;
    words.push(w);
  }
  return words.length ? words.join(' ') : null;
}

/**
 * The persona a description names: "...whenever the user mentions Miguel in the
 * context of..." gives 'Miguel', and a leading "Peter — ..." gives 'Peter'.
 * null when there is none.
 */
function personaFromDescription(description) {
  if (typeof description !== 'string') return null;
  // Keep looking when a "mentions" names a product or acronym: a later one, or the leading form, may be the persona.
  for (const m of description.matchAll(MENTIONS_ALL_RE)) {
    const name = nameFromRun(m[1]);
    if (name) return name;
  }
  const lead = LEADING_NAME_RE.exec(description.trim());
  return lead ? nameFromRun(lead[1]) : null;
}

const FN_LEAD_RE = /^(?:use this agent when you need(?: to)?|use this agent when|use this agent for|use when)(?:\s+|$)/i;
const FN_MAX = 300;
// A full stop after one of these does not end a sentence, even before a capital: "Django vs. Flask", "Mr. Smith".
const ABBREVIATION_RE = /(?:^|[\s(])(?:vs|e\.g|i\.e|etc|mr|mrs|ms|dr|prof|st|cf|approx)\.$/i;

// The text up to the first real sentence end: . ! or ? followed by a capitalised word or the end.
function firstSentence(text) {
  const re = /[.!?](?=\s+\p{Lu}|\s*$)/gu;
  let m;
  while ((m = re.exec(text))) {
    const upto = text.slice(0, m.index + 1);
    if (text[m.index] === '.' && m.index + 1 < text.length && ABBREVIATION_RE.test(upto)) continue;
    return upto;
  }
  return text;
}

/**
 * The function line: the description's first sentence, a leading persona
 * ("Peter — ") and "Use this agent when you need to" trimmed, the first letter
 * capitalised, capped at 300 characters. '' only for an empty description.
 */
function functionFromDescription(description) {
  if (typeof description !== 'string') return '';
  let text = description.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const lead = LEADING_NAME_RE.exec(text);
  if (lead && nameFromRun(lead[1])) text = text.slice(lead[0].length) || text;
  let fn = firstSentence(text).replace(FN_LEAD_RE, '').trim();
  if (!fn) fn = text; // the lead-in WAS the whole sentence: show it rather than nothing
  if (fn.length > FN_MAX) {
    let cut = fn.slice(0, FN_MAX - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never half of a surrogate pair
    fn = cut.trimEnd() + '…';
  }
  return fn.replace(/^[\s\S]/u, (c) => c.toUpperCase());
}

/** `{ persona, fn }` for a whole agent file; both null when it says nothing. */
function agentInfo(raw) {
  const description = descriptionFromFrontmatter(raw);
  return { persona: personaFromDescription(description), fn: functionFromDescription(description) || null };
}

/**
 * Every `.md` in one agents directory. Returns `{ names, infos, unreadable }`:
 *   unreadable  a REAL failure -- a non-ENOENT `readdir` on the directory
 *               itself (Dexter N6), or a definition file that exists but
 *               could not be read (Dexter F8 residual: previously silently
 *               fell back to the filename with nothing counted).
 */
// `readFile` is overridable for tests (Dexter F8 residual, PR #59 R2): a real
// permission-denied on a `.md` FILE (as opposed to a directory masquerading as
// one, which `entry.isFile()` already excludes) is not reliably reproducible
// across platforms without root/admin tricks, so the failure path is exercised
// by injection here, the same pattern host/agent-stats-cache.js's
// `lifetimeAgentTokens` already uses for its own `readFile`.
async function readAgentDefDir(dir, { readFile = (p) => fsp.readFile(p, 'utf8') } = {}) {
  const names = [];
  const infos = new Map();
  let unreadable = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT is the ordinary case -- not every project (or even every
    // install) has defined any custom agents at all. Anything else means the
    // directory may hold definitions this could not see.
    if (isRealFailure(err)) unreadable++;
    return { names, infos, unreadable };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fallback = entry.name.slice(0, -3);
    let raw = '';
    try {
      raw = await readFile(path.join(dir, entry.name));
    } catch (err) {
      // Unreadable definition: still a real file on disk, so it still counts
      // as an agent -- just under its filename, the same as no frontmatter --
      // but the read failure itself must not vanish uncounted.
      if (isRealFailure(err)) unreadable++;
    }
    const name = nameFromFrontmatter(raw, fallback);
    names.push(name);
    const info = agentInfo(raw);
    infos.set(name, info);
  }
  return { names, infos, unreadable };
}

/**
 * Definitions only: every `.md` under the global agents directory and, when a
 * project `cwd` is given, its own `.claude/agents` too.
 *
 * Returns `{ names: Set<string>, unreadable }` -- the caller decides what to
 * do with duplicate NAMES across the two directories, which this already
 * resolves by construction; `unreadable` is the sum of both directories' own
 * failures (Dexter N6 / F8).
 */
async function agentDefinitions({ configDir = claudeConfigDir(), cwd, readFile } = {}) {
  const dirs = [path.join(configDir, 'agents')];
  if (cwd) dirs.push(path.join(cwd, '.claude', 'agents'));
  const names = new Set();
  const infos = new Map(); // name -> { persona, fn }; a project definition overrides the global one
  let unreadable = 0;
  for (const dir of dirs) {
    const r = await readAgentDefDir(dir, readFile ? { readFile } : undefined);
    for (const n of r.names) names.add(n);
    for (const [n, info] of r.infos) infos.set(n, info);
    unreadable += r.unreadable;
  }
  return { names, infos, unreadable };
}

/**
 * One subagent transcript's identity, resolved exactly once -- called ONLY
 * from `scanProjects` (Dexter N5, PR #59 R2). Exported for a direct unit test
 * of the resolution rule alone.
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
    if (isRealFailure(err)) readError = true;
  }
  const { agent, source } = resolveAgent(meta, tables, file.session);
  return { agent, source, readError };
}

/**
 * Every project under `projectsDir`, enumerated and identity-resolved ONCE --
 * including every subagent's IDENTITY (not its tokens; that stays
 * host/agent-stats-cache.js's job).
 *
 * Returns `{ projects: [{ dir, files, tables, resolved }], errors }`.
 *   resolved  `Map(file.file -> { agent, source })` -- one entry per subagent
 *             file in `files`, computed HERE and only here (Dexter N5) so
 *             `historyNames` and `lifetimeAgentTokens` read the same answer
 *             for the same file instead of each resolving (and each
 *             possibly mis-counting) it independently.
 *   errors    the enumeration/identity-table/meta-read failure count --
 *             `transcriptFiles`' own errors, `identityTables`' own, AND every
 *             subagent's `readError` from `resolveSubagentEntry` -- summed
 *             across every project. This is the ONLY place any of those
 *             counts is produced; callers that share one `scan` must add it
 *             to their own total EXACTLY ONCE (see `wholeRoster`'s comment).
 *
 * Dexter N6: a non-ENOENT failure to even list `projectsDir` now counts as
 * one error rather than reading identically to "no such directory".
 */
async function scanProjects(projectsDir = defaultProjectsDir()) {
  const projects = [];
  let errors = 0;

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT: no `~/.claude/projects` at all -- nothing has ever run
    // anywhere, a genuine (if unusual) state. Anything else (EPERM, EBUSY):
    // there may be a whole roster's worth of history behind that failure.
    if (isRealFailure(err)) errors++;
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

    const resolved = new Map();
    for (const file of files) {
      if (!file.subagent) continue;
      const r = await resolveSubagentEntry(file, tables);
      if (r.readError) errors++;
      resolved.set(file.file, { agent: r.agent, source: r.source });
    }

    projects.push({ dir, files, tables, resolved });
  }

  return { projects, errors };
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
 *   unreadable      `scan.errors` when this function built its OWN scan
 *                   (a standalone call, complete on its own), or `0` when a
 *                   caller supplied `scan` (Dexter N5: identity resolution,
 *                   readError included, all happened inside `scanProjects`
 *                   already -- this function has nothing left of its own to
 *                   count, and re-adding `scan.errors` here too would be
 *                   exactly the double-count Miguel's L2 named).
 */
async function historyNames({ scan, projectsDir } = {}) {
  const ownScan = !scan;
  const resolvedScan = scan || await scanProjects(projectsDir);
  const names = new Set();
  const unresolvedNames = new Set();

  for (const { files, resolved } of resolvedScan.projects) {
    for (const file of files) {
      if (!file.subagent) continue;
      const { agent, source } = resolved.get(file.file);
      if (!agent) continue; // nothing to file it under
      names.add(agent);
      if (source === 'unresolved') unresolvedNames.add(agent);
    }
  }

  return { names, unresolvedNames, unreadable: ownScan ? resolvedScan.errors : 0 };
}

/**
 * The whole roster: definitions UNION history.
 *
 * `unreadable` folds in the scan's own errors (enumeration, identity tables,
 * AND per-subagent identity resolution -- everything `scanProjects` counts)
 * plus the definitions pass's own (Dexter N6 / F8), EXACTLY ONCE -- this
 * function is the one that owns reporting the scan's count, whether it built
 * the scan itself or was handed one a caller already had (host.js shares one
 * `scan` between this and `lifetimeAgentTokens`; only ONE of the two may add
 * `scan.errors` to its total, and this is that one).
 */
async function wholeRoster({ configDir, cwd, projectsDir, scan } = {}) {
  const resolvedScan = scan || await scanProjects(projectsDir);
  const [defs, hist] = await Promise.all([
    agentDefinitions({ configDir, cwd }),
    historyNames({ scan: resolvedScan }),
  ]);
  const names = new Set([...defs.names, ...hist.names]);
  return {
    names: [...names],
    infos: defs.infos,
    unresolvedNames: hist.unresolvedNames,
    unreadable: resolvedScan.errors + hist.unreadable + defs.unreadable,
  };
}

module.exports = {
  agentDefinitions, historyNames, wholeRoster, nameFromFrontmatter,
  descriptionFromFrontmatter, personaFromDescription, functionFromDescription, agentInfo,
  scanProjects, resolveSubagentEntry,
  defaultProjectsDir,
};
