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
const REF_FORMAT = '--format=%(refname)%1f%(committerdate:short)';
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
    const [ref, date = ''] = line.split(US);
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      out.push({ name: ref.slice('refs/heads/'.length), ref, remote: false, date });
    } else if (ref.startsWith('refs/remotes/')) {
      // refs/remotes/<remote>/<branch...>: the branch may itself hold slashes
      const name = ref.split('/').slice(3).join('/');
      if (name && name !== 'HEAD') out.push({ name, ref, remote: true, date });
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

module.exports = { parseMerges, parseRefs, parseWorktrees, integrationOf, defaultRun, MERGE_FORMAT, REF_FORMAT };
