'use strict';
/**
 * The git facts behind the git tree (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md): merges
 * into the integration branch, every ref, the worktrees.
 *
 * Read-only and NEVER fetches: the tree shows what this repo's refs already know. The parsers are
 * pure; readHistory runs git through an injected runner (host/branch-health.js pattern) with
 * LC_ALL=C, because git translates its messages and these parsers read its output.
 *
 * Records are split on ASCII unit/record separators (\x1f, \x1e), which never appear in a commit
 * subject or a ref name, so a PR title holding "|" or a newline in a body can't shift a field.
 */

const { execFile } = require('child_process');

const US = '\x1f';
const RS = '\x1e';
// The merge commit GitHub writes: subject "Merge pull request #N from owner/branch", body line 1 =
// the PR title. %P gives both parents; %b the body.
const MERGE_FORMAT = '--format=%H%x1f%ad%x1f%s%x1f%P%x1f%b%x1e';
const REF_FORMAT = '--format=%(refname)%1f%(committerdate:short)%1f%(objectname)';
const PR_MERGE = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/;
const BRANCH_MERGE = /^Merge branch '([^']+)'(?: into \S+)?$/;

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** `git log --merges --first-parent MERGE_FORMAT` -> [{ hash, date, pr|null, branch, title|null, parents }] */
function parseMerges(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(RS)) {
    // git ends each record with a newline before the next one starts
    const r = raw.replace(/^[\r\n]+/, '');
    if (!r.trim()) continue;
    const [hash, date, subject = '', parents = '', body = ''] = r.split(US);
    const p = parents.trim().split(/\s+/).filter(Boolean);
    if (p.length < 2) continue;
    const s = subject.trim();
    let m = PR_MERGE.exec(s);
    let pr = null;
    let branch;
    if (m) { pr = Number(m[1]); branch = m[2]; }
    else if ((m = BRANCH_MERGE.exec(s))) branch = m[1];
    else continue;
    const title = body.split(/\r?\n/).map(l => l.trim()).find(Boolean) || null;
    out.push({ hash, date, pr, branch, title, parents: p.slice(0, 2) });
  }
  return out;
}

/** `git for-each-ref REF_FORMAT refs/heads refs/remotes` -> [{ name, ref, remote, date }] */
function parseRefs(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const [ref, date = '', tip = null] = line.split(US);
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      out.push({ name: ref.slice('refs/heads/'.length), ref, remote: false, date, tip });
    } else if (ref.startsWith('refs/remotes/')) {
      // refs/remotes/<remote>/<branch...>: the branch may itself hold slashes
      const name = ref.split('/').slice(3).join('/');
      if (name && name !== 'HEAD') out.push({ name, ref, remote: true, date, tip });
    }
  }
  return out;
}

/** `git worktree list --porcelain` -> [{ path, branch|null }] (null: detached) */
function parseWorktrees(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n\r?\n/).map(block => {
    const p = /^worktree (.+)$/m.exec(block);
    if (!p) return null;
    const b = /^branch refs\/heads\/(.+)$/m.exec(block);
    return { path: p[1].trim(), branch: b ? b[1].trim() : null };
  }).filter(Boolean);
}

/** The branch every lane merges into: develop, else main, else master; local refs only. */
function integrationOf(refs) {
  const local = new Set(refs.filter(r => !r.remote).map(r => r.name));
  return ['develop', 'main', 'master'].find(n => local.has(n)) || null;
}

// A count git can't give is null, never 0: "unknown" drawn as "no commits" is the absence-as-zero
// bug (host/branch-health.js, same rule).
async function countOrNull(run, args, cwd) {
  let out;
  try {
    out = await run(args, cwd);
  } catch {
    return null;
  }
  const s = typeof out === 'string' ? out.trim() : '';
  return /^\d+$/.test(s) ? Number(s) : null;
}

const errorText = err => (err && err.message) || String(err);

/**
 * How far an unmerged ref is ahead of the integration branch, and its first commit's subject.
 * Two git spawns per branch (~50ms each on Windows) on every read added up to 1.5s warm on this
 * repo, so the answer is cached under BOTH tips: it can only change when one of them moves.
 * Nothing is cached when a tip is unknown or the count failed.
 */
async function laneFacts(run, cwd, cache, integration, integrationTip, r) {
  const key = r.tip && integrationTip ? `lane:${r.ref}:${r.tip}:${integrationTip}` : null;
  if (key && cache.has(key)) return cache.get(key);
  const ahead = await countOrNull(run, ['rev-list', '--count', `${integration}..${r.ref}`], cwd);
  let first = null;
  if (ahead) {
    // the FIRST commit says what the branch set out to do; its last is often "merge develop in"
    try {
      const subjects = await run(['log', '--reverse', '--no-merges', '--format=%s', `${integration}..${r.ref}`], cwd);
      first = (typeof subjects === 'string' && subjects.split(/\r?\n/)[0].trim()) || null;
    } catch {
      first = null;
    }
  }
  const facts = { ahead, first };
  if (key && ahead !== null) cache.set(key, facts);
  return facts;
}
const NOT_LANES = new Set(['develop', 'main', 'master']);

/**
 * { ok: true, integration, merges, unmerged, worktrees, mainMerges } | { ok: false, error }
 *
 * opts.run    (args, cwd) => Promise<stdout>
 * opts.counts a Map the caller keeps across reads: merge hash -> commit count (a merge never
 *             changes, so it's asked once per host lifetime) and laneFacts' keys. Failures are
 *             never cached.
 */
async function readHistory(cwd, { run = defaultRun, counts = new Map() } = {}) {
  let refs;
  let worktrees;
  try {
    refs = parseRefs(await run(['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'], cwd));
    worktrees = parseWorktrees(await run(['worktree', 'list', '--porcelain'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  const integration = integrationOf(refs);
  if (!integration) return { ok: false, error: 'no develop, main or master branch' };

  let merges;
  try {
    merges = parseMerges(await run(['log', '--merges', '--first-parent', '--reverse', '--date=short',
      MERGE_FORMAT, integration], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  for (const m of merges) {
    if (counts.has(m.hash)) {
      m.commits = counts.get(m.hash);
      continue;
    }
    m.commits = await countOrNull(run, ['rev-list', '--count', `${m.parents[0]}..${m.parents[1]}`], cwd);
    if (m.commits !== null) counts.set(m.hash, m.commits);
  }

  const merged = new Set(merges.map(m => m.branch));
  const integrationTip = (refs.find(r => !r.remote && r.name === integration) || {}).tip || null;
  const listed = new Set();
  const unmerged = [];
  // for-each-ref sorts by refname, so refs/heads/* come before refs/remotes/*: a local branch wins
  // over its remote twin, and the twin is skipped.
  for (const r of refs) {
    if (NOT_LANES.has(r.name) || merged.has(r.name) || listed.has(r.name)) continue;
    // left behind by Agent isolation worktrees (DESIGN_GIT_TREE.md decision 8)
    if (r.name.startsWith('worktree-agent-')) continue;
    listed.add(r.name);
    const { ahead, first } = await laneFacts(run, cwd, counts, integration, integrationTip, r);
    const wt = worktrees.find(w => w.branch === r.name);
    unmerged.push({ name: r.name, remote: r.remote, date: r.date, ahead, first, worktree: wt ? wt.path : null });
  }

  const hasMain = refs.some(r => !r.remote && r.name === 'main');
  const mainMerges = hasMain && integration !== 'main'
    ? await countOrNull(run, ['rev-list', '--count', '--merges', '--first-parent', 'main'], cwd)
    : null;
  return { ok: true, integration, merges, unmerged, worktrees, mainMerges };
}

module.exports = {
  parseMerges, parseRefs, parseWorktrees, integrationOf, readHistory, defaultRun, MERGE_FORMAT, REF_FORMAT,
};
