'use strict';
/**
 * The Changes panel's host side (BACKLOG #119 A3): the worktree's changeset, read from git and never written to it.
 *
 *   PURE
 *   parseNameStatusZ(text)   -> [{ status: 'M'|'A'|'D'|'R'|'U', path, oldPath? }]     `git diff --name-status -z -M`
 *   parseNumstatZ(text)      -> [{ path, oldPath?, add, del, binary }]                 `git diff --numstat -z -M`; a binary file's
 *                                                                                       counts are null, never 0
 *   parseNulList(text)       -> string[]                                                `git ls-files -z`
 *   buildChangeset({ nameStatus, numstat, untracked }) -> files (sorted by path)
 *   capFiles(files, cap)     -> { files, total, more }
 *   summarize(files)         -> { files, add, del, unknown }     `unknown`: files whose counts git could not give
 *   summaryLine(summary)     -> '12 files · +340 −58'
 *   countLines(text)         -> number | null                    null for a text with a NUL (binary)
 *   resolveScope(asked, dirty) -> 'working' | 'branch'           `auto` is the working tree when it is dirty, else the branch
 *
 *   SERVICE   createChangesService({ root, execFile, readFile, ... }).handle(msg) -> Promise<reply>   (host/host.js, control type `changes`)
 *     list { scope }                  scope: 'auto' | 'working' | 'branch'
 *         -> { ok, scope, base, files, total, more, summary, dirty }
 *     base { scope, path, oldPath? }  the file as it was at the scope's base: HEAD (working) or the merge-base with the integration branch (branch)
 *         -> { ok, text } | { ok: false, why: 'new' | 'too-large' | 'binary' | ... }
 *
 * READ-ONLY, BY CONSTRUCTION. Every git call is an argv ARRAY (no shell, no string a path could break out of), runs with
 * GIT_OPTIONAL_LOCKS=0 (a `git diff` otherwise refreshes the index on disk), with --no-ext-diff / --no-textconv (a read must not
 * run a program the repo's config names), and the only commands are diff, ls-files, rev-parse, merge-base and show. A page-supplied
 * path is checked lexically (host/repo-guard.js) before it is used, and git's own `:(literal)` pathspec keeps `app/[id]/x` a name,
 * not a glob.
 *
 * The WORKING TREE scope is the tree against HEAD: staged and unstaged edits together, plus untracked files (as adds). The BRANCH
 * scope is the tree against the merge-base with `develop` (else `main`, else `master`): everything this lane did, committed or not.
 */
const childProcess = require('child_process');
const fsp = require('fs/promises');
const { lexical } = require('./repo-guard');

const MAX_FILES = 500;
// A file over this is not compared (the reader would draw a wall); the page says "too large to compare".
const MAX_COMPARE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 8000;
const SCOPES = Object.freeze(['working', 'branch']);
const BASE_BRANCHES = Object.freeze(['develop', 'main', 'master']);

const isStr = (v) => typeof v === 'string';

function parseNulList(text) {
  if (!isStr(text) || text === '') return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const STATUS_OF = { M: 'M', T: 'M', A: 'A', C: 'A', D: 'D', R: 'R', U: 'U' };

function parseNameStatusZ(text) {
  const t = parseNulList(text);
  const out = [];
  for (let i = 0; i < t.length;) {
    const code = t[i];
    const m = /^([A-Z])\d*$/.exec(code);
    if (!m) { i += 1; continue; }              // not a status token: resynchronise on the next
    const letter = m[1];
    const twoPaths = letter === 'R' || letter === 'C';
    const need = twoPaths ? 2 : 1;
    if (i + need > t.length - 1) break;                  // a truncated record
    const status = STATUS_OF[letter];
    if (twoPaths) {
      const oldPath = t[i + 1];
      const path = t[i + 2];
      if (status) out.push(letter === 'R' ? { status, path, oldPath } : { status, path });
      i += 3;
    } else {
      if (status) out.push({ status, path: t[i + 1] });
      i += 2;
    }
  }
  return out;
}

const COUNT = /^(\d+|-)$/;
const countOf = (s) => (s === '-' ? null : Number(s));

function parseNumstatZ(text) {
  const t = parseNulList(text);
  const out = [];
  for (let i = 0; i < t.length;) {
    const rec = t[i];
    const a = rec.indexOf('\t');
    const b = a === -1 ? -1 : rec.indexOf('\t', a + 1);
    if (b === -1) { i += 1; continue; }
    const addS = rec.slice(0, a);
    const delS = rec.slice(a + 1, b);
    const rest = rec.slice(b + 1);
    if (!COUNT.test(addS) || !COUNT.test(delS)) { i += 1; continue; }
    const add = countOf(addS);
    const del = countOf(delS);
    const binary = add === null || del === null;
    if (rest === '') {                                  // a rename or copy: the old and the new path are the next two fields
      if (i + 2 >= t.length) break;
      out.push({ path: t[i + 2], oldPath: t[i + 1], add, del, binary });
      i += 3;
    } else {
      out.push({ path: rest, add, del, binary });
      i += 1;
    }
  }
  return out;
}

const byPath = (a, b) => {
  const x = a.path.toLowerCase();
  const y = b.path.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

function buildChangeset({ nameStatus = [], numstat = [], untracked = [] } = {}) {
  const counts = new Map(numstat.map(n => [n.path, n]));
  const files = [];
  const seen = new Set();
  for (const s of nameStatus) {
    const n = counts.get(s.path);
    const f = { path: s.path, ...(s.oldPath ? { oldPath: s.oldPath } : {}), status: s.status, add: n ? n.add : null, del: n ? n.del : null, binary: n ? n.binary === true : false };
    files.push(f);
    seen.add(s.path);
  }
  for (const u of untracked) {
    if (seen.has(u.path)) continue;
    seen.add(u.path);
    const add = typeof u.add === 'number' ? u.add : null;
    files.push({ path: u.path, status: 'A', add, del: add === null ? null : 0, binary: u.binary === true, untracked: true });
  }
  return files.sort(byPath);
}

function capFiles(files, cap = MAX_FILES) {
  const list = Array.isArray(files) ? files : [];
  const n = Math.max(0, Math.floor(cap));
  return { files: list.slice(0, n), total: list.length, more: Math.max(0, list.length - n) };
}

function summarize(files) {
  const s = { files: 0, add: 0, del: 0, unknown: 0 };
  for (const f of Array.isArray(files) ? files : []) {
    s.files += 1;
    if (typeof f.add === 'number') s.add += f.add; else s.unknown += 1;
    if (typeof f.del === 'number') s.del += f.del;
  }
  return s;
}

function summaryLine(s) {
  if (!s || s.files === 0) return 'no changes';
  return `${s.files} file${s.files === 1 ? '' : 's'} · +${s.add} −${s.del}${s.unknown > 0 ? ' (+ binary or unread)' : ''}`;
}

function countLines(text) {
  if (!isStr(text)) return null;
  if (text.includes('\0')) return null;
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function resolveScope(asked, dirty) {
  if (asked === 'working' || asked === 'branch') return asked;
  if (asked === 'auto' || asked === undefined) return dirty ? 'working' : 'branch';
  return dirty ? 'working' : 'branch';
}

// ---- the service ----

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

function createChangesService({ root, execFile = childProcess.execFile, readFile = (p) => fsp.readFile(p, 'utf8'), stat = (p) => fsp.stat(p), cap = MAX_FILES } = {}) {
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
        const st = await stat(lex.abs);
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
    if (asked === 'working' || asked === 'branch') {
      scope = asked;
      r = await listScope(scope);
    } else {
      // auto: the working tree if it holds anything, else the branch (and the working tree's emptiness is `dirty: false`)
      r = await listScope('working');
      if (r.ok && r.files.length === 0) {
        const branch = await listScope('branch');
        scope = resolveScope('auto', false);
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
    let dirty = scope === 'working' ? r.files.length > 0 : null;
    if (dirty === null) {
      const w = await listScope('working');
      dirty = w.ok ? w.files.length > 0 : null;
    }
    return { ok: true, scope, base: r.base.label, files: capped.files, total: capped.total, more: capped.more, summary, dirty };
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

module.exports = {
  parseNameStatusZ, parseNumstatZ, parseNulList, buildChangeset, capFiles, summarize, summaryLine, countLines, resolveScope,
  createChangesService, MAX_FILES, MAX_COMPARE_BYTES, SCOPES,
};
