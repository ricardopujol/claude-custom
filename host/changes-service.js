'use strict';
/**
 * The Changes panel's service (BACKLOG #119 A3): the host side of the `changes` control type. The parsers and rules are pure and live in
 * host/changes.js; this runs git and answers.
 *
 *   createChangesService({ root, execFile, readFile, stat, cap }).handle(msg) -> Promise<reply>   (host/host.js)
 *     list { scope }                  scope: 'auto' | 'working' | 'branch'
 *         -> { ok, scope, base, against, files, total, more, summary, dirty }
 *            base: the integration branch (develop, else main, else master) or null; against: what this list was compared with (HEAD or that branch)
 *     base { scope, path, oldPath? }  the file as it was at the scope's base: HEAD (working) or the merge-base with the integration branch (branch)
 *         -> { ok, text } | { ok: false, why: 'new' | 'too-large' | 'binary' | ... }
 *
 * READ-ONLY, BY CONSTRUCTION. Every git call is an argv ARRAY (no shell, no string a path could break out of), runs with
 * GIT_OPTIONAL_LOCKS=0 (a `git diff` otherwise refreshes the index on disk), with --no-ext-diff / --no-textconv (a read must not
 * run a program the repo's config names), and the only commands are diff, ls-files, rev-parse, cat-file, merge-base and show. A
 * page-supplied path is checked lexically (host/repo-guard.js) before it is used, and it only ever follows `<sha>:` in a revision
 * argument, so a name that looks like a flag is a name.
 *
 * Not mutated by Stryker: its tests run the real git on throwaway repositories (a timeout counts as a kill and a hung child outlives it).
 */
const childProcess = require('child_process');
const fsp = require('fs/promises');
const { lexical } = require('./repo-guard');
const {
  parseNameStatusZ, parseNumstatZ, parseNulList, buildChangeset, capFiles, summarize, countLines, resolveScope, MAX_FILES, MAX_COMPARE_BYTES,
} = require('./changes');

const GIT_TIMEOUT_MS = 8000;
const BASE_BRANCHES = Object.freeze(['develop', 'main', 'master']);
const isStr = (v) => typeof v === 'string';

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function defaultRunGit(execFile) {
  return (root, args, { maxBuffer = 16 * 1024 * 1024 } = {}) => new Promise((resolve) => {
    try {
      execFile('git', ['-C', root, '-c', 'core.quotePath=false', ...args],
        { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true, env: { ...process.env, ...GIT_ENV } },
        (err, stdout, stderr) => {
          if (err) {
            const first = String(stderr || '').split(/\r?\n/).find(Boolean) || err.message || 'unknown error';
            resolve({ ok: false, error: first, code: err.code, tooBig: err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
            return;
          }
          resolve({ ok: true, stdout: String(stdout || '') });
        });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
    }
  });
}

const seqOf = (s) => (Number.isSafeInteger(s) || (isStr(s) && s.length <= 64) ? s : undefined);

function createChangesService({ root, execFile = childProcess.execFile, readFile = (p) => fsp.readFile(p, 'utf8'), lstat = (p) => fsp.lstat(p), cap = MAX_FILES } = {}) {
  const git = defaultRunGit(execFile);

  async function baseBranch() {
    for (const name of BASE_BRANCHES) {
      const r = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      if (r.ok && SHA.test(r.stdout.trim())) return { name, sha: r.stdout.trim() };
    }
    return null;
  }

  // The commit the scope compares the worktree to: HEAD, or the merge-base of HEAD and the integration branch.
  async function baseFor(scope) {
    if (scope === 'working') {
      const r = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (!r.ok || !SHA.test(r.stdout.trim())) return { ok: false, error: 'this repository has no commits yet' };
      return { ok: true, sha: r.stdout.trim(), label: 'HEAD' };
    }
    const b = await baseBranch();
    if (!b) return { ok: false, error: 'no develop, main or master branch to compare with' };
    const m = await git(root, ['merge-base', b.sha, 'HEAD']);
    if (!m.ok || !SHA.test(m.stdout.trim())) return { ok: false, error: `no common ancestor with ${b.name}` };
    return { ok: true, sha: m.stdout.trim(), label: b.name };
  }

  async function untrackedFiles() {
    const r = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (!r.ok) return { ok: false, error: r.error };
    const names = parseNulList(r.stdout);
    const out = [];
    for (const rel of names.slice(0, cap + 1)) {            // one past the cap is enough to know there is more
      const lex = lexical(root, rel);
      if (!lex.ok) continue;
      let add = null;
      let binary = false;
      try {
        // lstat, not stat: a link (to a file outside the worktree, say) is not followed, its lines are not counted
        const st = await lstat(lex.abs);
        if (st.isFile() && st.size <= MAX_COMPARE_BYTES) {
          const text = await readFile(lex.abs);
          add = countLines(text);
          binary = add === null;
        }
      } catch { /* unreadable: counts unknown */ }
      out.push({ path: rel, add, binary });
    }
    // the rest are listed without counts, so the total is right even when the list is cut
    for (const rel of names.slice(cap + 1)) out.push({ path: rel, add: null });
    return { ok: true, files: out };
  }

  async function listScope(scope) {
    const base = await baseFor(scope);
    if (!base.ok) return base;
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z'];
    const [ns, num, un] = await Promise.all([
      git(root, [...diffArgs, '--name-status', base.sha, '--']),
      git(root, [...diffArgs, '--numstat', base.sha, '--']),
      untrackedFiles(),
    ]);
    if (!ns.ok) return { ok: false, error: `git diff failed: ${ns.error}` };
    if (!num.ok) return { ok: false, error: `git diff failed: ${num.error}` };
    if (!un.ok) return { ok: false, error: `git ls-files failed: ${un.error}` };
    const files = buildChangeset({ nameStatus: parseNameStatusZ(ns.stdout), numstat: parseNumstatZ(num.stdout), untracked: un.files });
    return { ok: true, base, files };
  }

  async function list(msg) {
    const asked = msg.scope === undefined ? 'auto' : msg.scope;
    let scope;
    let r;
    let knownClean = false;
    if (asked === 'working' || asked === 'branch') {
      scope = asked;
      r = await listScope(scope);
    } else {
      // auto: the working tree if it holds anything, else the branch (and the working tree's emptiness is `dirty: false`)
      r = await listScope('working');
      if (r.ok && r.files.length === 0) {
        const branch = await listScope('branch');
        scope = resolveScope('auto', false);
        knownClean = true;
        // a repo with no integration branch still answers: the empty working tree
        r = branch.ok ? branch : r;
        if (!branch.ok) scope = 'working';
      } else {
        scope = resolveScope('auto', true);
      }
    }
    if (!r.ok) return { ok: false, scope, error: r.error };
    const summary = summarize(r.files);
    const capped = capFiles(r.files, cap);
    // `dirty` is about the working tree whichever scope is shown: the page's default and its "uncommitted work" cue
    let dirty = scope === 'working' ? r.files.length > 0 : (knownClean ? false : null);
    if (dirty === null) {
      const w = await listScope('working');
      dirty = w.ok ? w.files.length > 0 : null;
    }
    // `base` is the integration branch the `vs <base>` scope compares with (the panel names its button after it), whichever scope is shown;
    // `against` is what THIS list was compared with (HEAD, or that branch's merge-base)
    const integration = r.base.label !== 'HEAD' ? r.base.label : ((await baseBranch()) || {}).name || null;
    return { ok: true, scope, base: integration, against: r.base.label, files: capped.files, total: capped.total, more: capped.more, summary, dirty };
  }

  // The file as it was at the scope's base. A new file has no base (`why: 'new'`), a big or binary one is not compared.
  async function baseText(msg) {
    const scope = msg.scope === 'branch' ? 'branch' : 'working';
    const want = isStr(msg.oldPath) && msg.oldPath !== '' ? msg.oldPath : msg.path;
    const lex = lexical(root, want);
    if (!lex.ok) return { ok: false, why: 'bad path', error: lex.why };
    if (isStr(msg.oldPath) && msg.oldPath !== '' && !lexical(root, msg.path).ok) return { ok: false, why: 'bad path' };
    const base = await baseFor(scope);
    if (!base.ok) return { ok: false, why: 'no base', error: base.error };
    const spec = `${base.sha}:${lex.rel}`;
    const size = await git(root, ['cat-file', '-s', spec]);
    if (!size.ok) return { ok: false, why: 'new' };
    const n = Number(size.stdout.trim());
    if (!Number.isFinite(n)) return { ok: false, why: 'unreadable', error: 'git did not give a size' };
    if (n > MAX_COMPARE_BYTES) return { ok: false, why: 'too-large', size: n, limit: MAX_COMPARE_BYTES };
    const r = await git(root, ['show', '--no-textconv', spec], { maxBuffer: MAX_COMPARE_BYTES + 1024 });
    if (!r.ok) return { ok: false, why: r.tooBig ? 'too-large' : 'unreadable', error: r.error };
    if (r.stdout.includes('\0')) return { ok: false, why: 'binary' };
    return { ok: true, text: r.stdout, size: n, base: base.label };
  }

  async function handle(msg) {
    const seq = seqOf(msg && msg.seq);
    const action = msg && isStr(msg.action) ? msg.action : '';
    const tag = (reply) => ({ type: 'changes', action, ...(seq !== undefined ? { seq } : {}), ...reply });
    try {
      if (action === 'list') return tag(await list(msg));
      if (action === 'base') return tag(await baseText(msg));
      return tag({ ok: false, why: 'unknown action' });
    } catch (err) {
      return tag({ ok: false, error: String(err && err.message) });
    }
  }

  return { handle };
}

module.exports = { createChangesService };
