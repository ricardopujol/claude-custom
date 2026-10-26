'use strict';
/**
 * The indexing assistant's doc writer (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": a verbatim inbox). host/indexing-doc.js decides every byte; this reads, writes and checks.
 *
 *   docsOf({ root, dev })              -> { ok: true, dir, name, title, backlog, canCreate }
 *                                        | { ok: false, reason: 'no-docs' | 'many-build-logs' | 'no-backlog-ambiguous' }
 *   fileNote({ docs, stamp, text })    -> { ok: true, where: { file }, record, result? } | { ok: false, reason }
 *   ensureBacklog(docs)                -> { ok: true, created } | { ok: false, reason }
 *   undoNote(file, record)             -> { ok: true } | { ok: false, reason: 'changed' | 'write-failed' }
 *
 * WHERE: the project's `documentation\` folder, found the way sync-docs finds it (SyncDocs.ps1 Resolve-ProjectRoot: a
 * linked worktree's docs are the main checkout's, unless the worktree has a build log of its own). docsOf never makes
 * it; a project with no `documentation\` is `no-docs` unless its home is a git root (then the first note makes the
 * folder, see CREATING). The backlog is the one that is there: a single `*_BACKLOG.md` or
 * `BACKLOG.md` (whatever its stem), or the one named `<NAME>_BACKLOG.md` among several; several with none of that name
 * are `no-backlog-ambiguous`. NAME is sync-docs' Get-DocsName: the one `*_BUILD_LOG.md`'s stem, else the folder name
 * (a `dev` folder is named after its parent) upper-cased without separators, character by character like .NET's
 * ToUpperInvariant. Besides what CREATING makes, only the backlog is ever written.
 *
 * CREATING (#79): a project with no backlog at all gets one, but only when its home is a git root that is not a
 * drive root or the home folder (`canCreate`), never a launch-directory fallback: `# <folder> — Feature & Bug
 * Backlog` and an empty `## Inbox`, made via temp file + hard link (or an exclusive create where hard links aren't
 * supported) so a backlog that appears meanwhile is never replaced. A project with no `documentation\` folder gets that
 * made first, and the sync-docs `.gitignore` block added to the repo's `.gitignore` (created if missing; idempotent by
 * its marker line), so the docs stay out of GitHub (Ricardo, 2026-10-09). fileNote says `result: 'created-backlog'`
 * and its record carries the `pristine` text (and `made`, what this note made besides the file), so undoNote removes
 * the file again only when the note was all that was ever in it, then the folder if it is empty, then the block it added
 * (only while git shows the .gitignore uncommitted; else it is left and Undo says `kept: ['gitignore']`). In a linked
 * worktree with no docs anywhere the folder is made in the MAIN checkout. The .gitignore is edited as bytes and never
 * if it is a symlink or not valid UTF-8 (the note still files; the record says `ignoreSkipped`). A read-only
 * .gitignore, or a file named documentation, is the permanent `gitignore-blocked` / `docs-blocked` (held, not retried).
 *
 * SAFELY: read, build the new text (the inbox created after the status block if it's missing, the entry appended),
 * write it to a temp file beside the backlog, re-read the backlog just before the rename, and rename only if it's still
 * what was read (re-checked before every retry of a refused rename). A session editing it in between (/sync-docs)
 * makes it start over once from the new text, then give up with `conflict`. Never truncated: the backlog is only ever
 * replaced whole, by rename. A temp file is removed on every path that doesn't rename it. What's left unguarded is the
 * moment between a re-check and the rename call itself (no lock is shared with an editor).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { isTransient, nextWait, sleepSync, renameWithRetry, ATTEMPTS: RENAME_ATTEMPTS, FIRST_WAIT_MS } = require('./atomic-write');
const doc = require('./indexing-doc');

const ATTEMPTS = 2;

const DOCS_DIR = /^documentation$/i;

/** The folder's `documentation` directory (any case, like Get-DocsDir), or null. */
function docsDirIn(home) {
  try {
    const hit = fs.readdirSync(home, { withFileTypes: true }).find(e => e.isDirectory() && DOCS_DIR.test(e.name));
    return hit ? path.join(home, hit.name) : null;
  } catch { return null; }
}

const hasBuildLog = (dir) => { try { return fs.readdirSync(dir).some(n => /_BUILD_LOG\.md$/i.test(n)); } catch { return false; } };

/** The main checkout of a linked worktree (its `.git` is a file naming `<main>\.git\worktrees\<name>`), else null. */
function mainCheckoutOf(dev) {
  try {
    const gitFile = path.join(dev, '.git');
    if (!fs.statSync(gitFile).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(dev, m[1]);
    return /[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) ? path.resolve(gitDir, '..', '..', '..') : null;
  } catch { return null; }
}

/** Where this folder's docs live (sync-docs' Resolve-ProjectRoot, for the cases that matter here). */
function homeOf(dev) {
  const main = mainCheckoutOf(dev);
  if (main === null) return dev;
  const own = docsDirIn(dev);
  if (own !== null && hasBuildLog(own)) return dev;
  if (docsDirIn(main) !== null) return main;
  // Neither has docs: a folder made now goes in the MAIN checkout, where sync-docs will look, never in the worktree
  // (flat sibling or nested `.claude\worktrees\*`); the worktree's own folder is used only when it already has one.
  return own !== null ? dev : main;
}

/** sync-docs' Get-ProjectLeaf: in the worktree layout (`<project>\dev`) the project is named after the container. */
function leafOf(home) {
  const trimmed = home.replace(/[\\/]+$/, '');
  const leaf = path.basename(trimmed);
  if (leaf.toLowerCase() === 'dev') {
    const parent = path.dirname(trimmed);
    if (parent !== trimmed && path.basename(parent) !== '') return path.basename(parent);
  }
  return leaf;
}

/** .NET's ToUpperInvariant: one character at a time, a character whose upper case is several stays (ß is not SS). */
const upperInvariant = (s) => Array.from(s, (ch) => { const u = ch.toUpperCase(); return Array.from(u).length === 1 ? u : ch; }).join('');

// Windows-only today: paths compare case-insensitively.
const isHomeFolder = (home) => { try { return path.resolve(home).toLowerCase() === path.resolve(os.homedir()).toLowerCase(); } catch { return false; } };

/** A git repo (or linked worktree) top folder that is not a drive root: where a backlog may be created in an existing documentation\. */
function isProjectRoot(home) {
  try {
    if (path.parse(path.resolve(home)).root === path.resolve(home)) return false;
    const g = fs.statSync(path.join(home, '.git'));
    return g.isFile() || (g.isDirectory() && fs.statSync(path.join(home, '.git', 'HEAD')).isFile());
  } catch { return false; }
}

function docsOf(project) {
  if (!project || typeof project.dev !== 'string') return { ok: false, reason: 'no-docs' };
  const home = homeOf(project.dev);
  let dir = docsDirIn(home);
  let names = [];
  if (dir === null) {
    // No documentation folder: the first note makes it, but only in a real project's top folder (#79).
    if (!isProjectRoot(home) || isHomeFolder(home)) return { ok: false, reason: 'no-docs' };     // never a folder made in the home folder
    dir = path.join(home, 'documentation');
  } else {
    try { names = fs.readdirSync(dir); } catch { return { ok: false, reason: 'no-docs' }; }
  }
  const logs = names.filter(n => /_BUILD_LOG\.md$/i.test(n));
  if (logs.length > 1) return { ok: false, reason: 'many-build-logs' };
  const leaf = leafOf(home);
  const name = logs.length === 1 ? logs[0].replace(/_BUILD_LOG\.md$/i, '') : upperInvariant(leaf.replace(/[-_\s]/g, ''));
  // Never a second backlog: whatever one is already there is the one.
  const there = names.filter(n => /(^|_)BACKLOG\.md$/i.test(n));
  let file = `${name}_BACKLOG.md`;
  if (there.length === 1) file = there[0];
  else if (there.length > 1) {
    const own = there.find(n => n.toLowerCase() === file.toLowerCase());
    if (!own) return { ok: false, reason: 'no-backlog-ambiguous' };
    file = own;
  }
  return { ok: true, dir, name, title: leaf, backlog: path.join(dir, file), canCreate: isProjectRoot(home) };
}

const READ_ATTEMPTS = 4;

/**
 * The file's text, or why not: `missing` (ENOENT: there is no such file) or `busy` (a handle held it through every
 * retry). A read refused for a moment (EBUSY/EPERM/EACCES: a scanner, a session's editor) is retried with
 * atomic-write's backoff, never taken for "missing" or "changed" (Dexter F8, PR #121).
 */
function readDoc(file, { readFile = fs.readFileSync, sleep = sleepSync } = {}) {
  let wait = FIRST_WAIT_MS;
  for (let i = 1; ; i++) {
    try {
      return { ok: true, text: readFile(file, 'utf8') };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
      // Only ENOENT is "missing". Any other failure (EMFILE, EIO) is a read that didn't happen, not an absent file
      // (Dexter F4, PR #121): 'busy', which the tick retries; waiting out the backoff only helps the transient codes.
      if (!isTransient(err) || i >= READ_ATTEMPTS) return { ok: false, reason: 'busy' };
      sleep(wait);
      wait = nextWait(wait);
    }
  }
}

/**
 * Rename `tmp` over `file` only while `file` still holds `before`, re-checked before EVERY attempt: a rename refused
 * (EPERM/EBUSY: a scanner, or a session's own writer holding the file) is retried with atomic-write's backoff, and the
 * edit that may land during that backoff must never be replaced (Dexter F5, PR #121). -> true (renamed) | false
 * (the file changed, or couldn't be read to check: start over). Throws what the rename threw when it isn't transient
 * or the attempts ran out.
 */
function renameIfUnchanged(tmp, file, before, { rename = fs.renameSync, sleep = sleepSync, readFile } = {}) {
  let wait = FIRST_WAIT_MS;
  for (let i = 1; ; i++) {
    const now = readDoc(file, { readFile, sleep });
    if (!now.ok || now.text !== before) return false;
    try {
      rename(tmp, file);
      return true;
    } catch (err) {
      if (!isTransient(err) || i >= RENAME_ATTEMPTS) throw err;
      sleep(wait);
      wait = nextWait(wait);
    }
  }
}

/**
 * Replace `file` with compute(text).text, safely (see the header). compute returns { ok: true, text, ...extra } or
 * { ok: false, reason }. -> { ok: true, ...extra }
 *                         | { ok: false, reason: <compute's> | 'missing' | 'busy' | 'conflict' | 'write-failed' }.
 */
function safeRewrite(file, compute, { beforeRename = () => {}, rename, sleep, readFile } = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const read = readDoc(file, { readFile, sleep });
    if (!read.ok) return read;
    const before = read.text;
    const next = compute(before);
    if (!next.ok) return next;
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, next.text, 'utf8');
      beforeRename();
      if (!renameIfUnchanged(tmp, file, before, { rename, sleep, readFile })) { fs.rmSync(tmp, { force: true }); continue; }
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
      return { ok: false, reason: 'write-failed' };
    }
    const { text, ok, ...extra } = next;
    return { ok: true, ...extra };
  }
  return { ok: false, reason: 'conflict' };
}

/** What a backlog this writer creates holds before any note: a title and an empty inbox. Undo recognises it again. */
const pristineOf = (docs) => `# ${docs.title || docs.name} — Feature & Bug Backlog\n\n## Inbox\n`;

// The codes that mean "this filesystem has no hard links" (FAT/exFAT, some SMB and cloud-filter folders). Anything else
// (a locked folder, a full disk) is a failure, not a reason to try another way of writing.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL']);

/** Create the file with `text` only if it isn't there: an exclusive open, so an existing backlog is never replaced. */
function createExclusive(file, text) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: true, created: false };
    throw err;
  }
  try {
    fs.writeSync(fd, text, null, 'utf8');
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* nothing to do */ }
    try { fs.rmSync(file, { force: true }); } catch { /* nothing left to clean */ }
    throw err;
  }
  fs.closeSync(fd);
  return { ok: true, created: true };
}

// The block /sync-docs puts in a project's .gitignore (skills/sync-docs/templates.md): documentation/ stays out of
// GitHub, only its README is tracked. Idempotent by the marker line.
const GITIGNORE_MARKER = '# --- sync-docs (gitignore) ---';
const GITIGNORE_LINES = [
  GITIGNORE_MARKER,
  '# documentation/ is mirrored to the Obsidian vault and kept OUT of GitHub by',
  '# default. Only the index README is tracked. Delete this block to push the docs.',
  'documentation/*',
  '!documentation/README.md',
  '# --- end sync-docs (gitignore) ---',
];
const gitignoreBlock = (nl) => GITIGNORE_LINES.join(nl) + nl;

// A .gitignore is a tracked file this writer doesn't own, so it is handled as BYTES: read, appended to, written back
// without ever decoding what it doesn't understand (PR #146, Dexter D3).
const isUtf8 = (buf) => {
  if (buf.includes(0)) return false;                       // UTF-16 without a BOM, or binary
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
};
const PERMANENT = new Set(['EPERM', 'EACCES', 'EROFS', 'EISDIR', 'ENOTDIR']);
const blockedOr = (err) => (err && PERMANENT.has(err.code) ? 'gitignore-blocked' : 'write-failed');

/** Replace `file` with compute(bytes) (a Buffer, or null to give up), only while it still holds what was read. */
function rewriteBytes(file, compute) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const before = fs.readFileSync(file);
    const next = compute(before);
    if (next === null) return { ok: false, reason: 'changed' };
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, next);
      if (!fs.readFileSync(file).equals(before)) { fs.rmSync(tmp, { force: true }); continue; }
      renameWithRetry(tmp, file);
      return { ok: true };
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
      return { ok: false, reason: blockedOr(err) };
    }
  }
  return { ok: false, reason: 'conflict' };
}

/**
 * Make sure `<home>\.gitignore` carries the sync-docs block: created when there is no file (an exclusive create), the
 * block appended at the byte level (after a blank line, in the file's own line endings) when it lacks the marker, left
 * alone when it has it. A symlink, or a file that isn't valid UTF-8 (cp1252, UTF-16), is never touched.
 * -> { ok: true, how: 'present' | 'created' | 'appended', text? } (text: exactly what this call added)
 *  | { ok: true, how: 'skipped', why: 'symlink' | 'encoding' }
 *  | { ok: false, reason: 'gitignore-blocked' (read-only, not a file: permanent) | 'write-failed' }
 */
function addGitignoreBlock(home) {
  const file = path.join(home, '.gitignore');
  for (let i = 0; i < 2; i++) {
    let st = null;
    try { st = fs.lstatSync(file); } catch (err) { if (!(err && err.code === 'ENOENT')) return { ok: false, reason: blockedOr(err) }; }
    if (st === null) {
      try {
        if (createExclusive(file, gitignoreBlock('\n')).created) return { ok: true, how: 'created', text: gitignoreBlock('\n') };
      } catch (err) { return { ok: false, reason: blockedOr(err) }; }
      continue;                                             // it appeared meanwhile: treat it as the existing file
    }
    if (st.isSymbolicLink()) return { ok: true, how: 'skipped', why: 'symlink' };
    if (!st.isFile()) return { ok: false, reason: 'gitignore-blocked' };
    try { fs.accessSync(file, fs.constants.W_OK); } catch { return { ok: false, reason: 'gitignore-blocked' }; }
    let buf;
    try { buf = fs.readFileSync(file); } catch (err) { return { ok: false, reason: blockedOr(err) }; }
    if (!isUtf8(buf)) return { ok: true, how: 'skipped', why: 'encoding' };
    if (buf.toString('utf8').includes(GITIGNORE_MARKER)) return { ok: true, how: 'present' };
    let added = '';
    const r = rewriteBytes(file, (bytes) => {
      if (!isUtf8(bytes)) return null;
      const text = bytes.toString('utf8');
      if (text.includes(GITIGNORE_MARKER)) return null;
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      added = (text === '' ? '' : (/\n$/.test(text) ? nl : nl + nl)) + gitignoreBlock(nl);
      return Buffer.concat([bytes, Buffer.from(added, 'utf8')]);
    });
    if (r.ok) return { ok: true, how: 'appended', text: added };
    if (r.reason === 'changed') continue;
    return { ok: false, reason: r.reason };
  }
  return { ok: false, reason: 'write-failed' };
}

const defaultGitStatus = (home) => {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', '.gitignore'], {
      cwd: home, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch { return null; }
};

/**
 * Is the .gitignore still what this note made, in git's eyes too? A block that has been committed since is history, not
 * ours to cut out (Dexter D6). The file just made reads `??` (or staged `A`); an appended block reads as a modification.
 */
function stillOurs(home, g, gitStatus) {
  const out = gitStatus(home);
  if (typeof out !== 'string') return false;                // git couldn't say: leave it
  return out.trim() !== '';                              // clean = committed since (or never differed): history, not ours to cut
}

/**
 * Take back what addGitignoreBlock added, only while the file still ends/holds exactly that (and, unless `force`, git
 * shows it uncommitted). Bytes, never decoded. -> true (taken back) | false (left alone)
 */
function removeGitignoreBlock(home, g, { force = false, gitStatus = defaultGitStatus } = {}) {
  const file = path.join(home, '.gitignore');
  try {
    if (!force && !stillOurs(home, g, gitStatus)) return false;
    const want = Buffer.from(g.text, 'utf8');
    if (g.how === 'created') {
      if (!fs.readFileSync(file).equals(want)) return false;
      // Moved aside first, and the moved copy is what is checked and deleted (the shape Undo of the backlog uses).
      const aside = path.join(home, `.gitignore.${process.pid}-${crypto.randomBytes(4).toString('hex')}.undo`);
      fs.renameSync(file, aside);
      if (fs.readFileSync(aside).equals(want)) { fs.unlinkSync(aside); return true; }
      try { fs.linkSync(aside, file); } catch { /* something new is at the old name: keep that */ }
      fs.rmSync(aside, { force: true });
      return false;
    }
    if (g.how === 'appended') {
      return rewriteBytes(file, (b) => (b.length >= want.length && b.subarray(b.length - want.length).equals(want)
        ? b.subarray(0, b.length - want.length) : null)).ok;
    }
  } catch { /* the block stays; harmless */ }
  return false;
}

/**
 * Take back what a note made besides the backlog: the documentation folder, only while it is empty, and then, only if
 * the folder went, the .gitignore block this note added (a block added to an existing empty folder: only while it is
 * still empty). Anything else in the folder keeps both. -> the list of things it left alone ('gitignore'), usually [].
 */
function unmake(dir, made, opts = {}) {
  const kept = [];
  if (!made) return kept;
  if (made.dir === true) {
    try { fs.rmdirSync(dir); } catch { return kept; }
  } else if (made.gitignore) {
    try { if (fs.readdirSync(dir).length > 0) return kept; } catch { return kept; }
  }
  if (made.gitignore && !removeGitignoreBlock(path.dirname(dir), made.gitignore, opts)) kept.push('gitignore');
  return kept;
}

/**
 * A backlog this call created, taken back with the folder and block it made, when the note could not be written into it
 * (Dexter D2): only while the file still holds exactly what it was created with.
 */
function takeBack(docs, made) {
  try {
    const cur = readDoc(docs.backlog);
    if (cur.ok && cur.text === pristineOf(docs)) fs.rmSync(docs.backlog, { force: true });
  } catch { /* the file stays; the retry finds it */ }
  unmake(docs.dir, made, { force: true });
}

/**
 * Create the project's backlog when it isn't there (only for a project that `canCreate`): written to a temp file, then
 * hard-linked into place, which fails with EEXIST rather than replacing a backlog a session or another window made in
 * the meantime; where hard links aren't supported, an exclusive create. The target is never opened for writing otherwise.
 * No `documentation\` folder yet (or an empty one with no .gitignore block): the sync-docs block goes in FIRST, then the
 * folder, so an interruption leaves a block with no folder, never a folder git doesn't ignore (Dexter D5); if anything
 * fails, whatever this call made is taken back.
 * -> { ok: true, created: boolean, made?: { dir?, gitignore?, ignoreSkipped? } }
 *  | { ok: false, reason: 'no-backlog' | 'write-failed' | 'docs-blocked' | 'gitignore-blocked' }  (the last two are permanent)
 */
function createBacklog(docs, { beforeCreate = () => {}, link = fs.linkSync } = {}) {
  if (!docs || docs.canCreate !== true) return { ok: false, reason: 'no-backlog' };
  const home = path.dirname(docs.dir);
  let dirStat = null;
  try { dirStat = fs.statSync(docs.dir); } catch { dirStat = null; }
  if (dirStat !== null && !dirStat.isDirectory()) return { ok: false, reason: 'docs-blocked' };     // a FILE named documentation
  const made = {};
  const hasBlock = () => { try { return fs.readFileSync(path.join(home, '.gitignore'), 'utf8').includes(GITIGNORE_MARKER); } catch { return false; } };
  let emptyUnignored = false;
  try { emptyUnignored = dirStat !== null && fs.readdirSync(docs.dir).length === 0 && !hasBlock(); } catch { emptyUnignored = false; }
  if (dirStat === null || emptyUnignored) {
    const g = addGitignoreBlock(home);
    if (!g.ok) return { ok: false, reason: g.reason };
    if (g.how === 'skipped') made.ignoreSkipped = g.why;
    else if (g.how !== 'present') made.gitignore = { how: g.how, text: g.text };
    if (dirStat === null) {
      try { fs.mkdirSync(docs.dir); made.dir = true; } catch (err) {
        if (!(err && err.code === 'EEXIST')) { unmake(docs.dir, made, { force: true }); return { ok: false, reason: blockedOr(err) === 'gitignore-blocked' ? 'docs-blocked' : 'write-failed' }; }
      }
    }
  }
  const tmp = path.join(docs.dir, `.${path.basename(docs.backlog)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  let result;
  try {
    fs.writeFileSync(tmp, pristineOf(docs), 'utf8');
    beforeCreate(docs.backlog);
    try {
      link(tmp, docs.backlog);
      result = { ok: true, created: true };
    } catch (err) {
      if (err && err.code === 'EEXIST') result = { ok: true, created: false };
      else if (!(err && NO_HARD_LINKS.has(err.code))) throw err;
      else result = createExclusive(docs.backlog, pristineOf(docs));
    }
  } catch {
    result = { ok: false, reason: 'write-failed' };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
  }
  if (!result.ok) { unmake(docs.dir, made, { force: true }); return result; }
  return result.created && Object.keys(made).length > 0 ? { ...result, made } : result;
}

/** The backlog exists after this, or why not. -> { ok: true, created: boolean } | { ok: false, reason } */
function ensureBacklog(docs, opts) {
  if (docs && fs.existsSync(docs.backlog)) return { ok: true, created: false };
  return createBacklog(docs, opts);
}

/**
 * -> { ok: true, where, record, result?: 'created-backlog' } | { ok: false, reason }. A project with no backlog file
 * gets one made first (#79); `result: 'created-backlog'` says this call made it, and the record then remembers the
 * pristine text so Undo can take the file out again when the note was all that was in it.
 */
function fileNote({ docs, stamp, text, beforeRename, beforeCreate, link, rename, sleep, readFile }) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
  const rewrite = () => safeRewrite(docs.backlog, (current) => {
    const base = doc.ensureInbox(current).text;
    const entry = doc.entryText(stamp, text, doc.newlineOf(base));
    const plan = doc.planAppend(base, entry);
    if (!plan.ok) return plan;
    return { ok: true, text: doc.applyInsert(base, plan), record: doc.recordOf(plan, entry) };
  }, { beforeRename, rename, sleep, readFile });
  let r = rewrite();
  let created = false;
  let made = null;
  if (!r.ok && r.reason === 'missing') {
    const c = createBacklog(docs, { beforeCreate, link });
    if (!c.ok) return c;
    created = c.created;
    made = c.made || null;
    r = rewrite();
    if (!r.ok && created) takeBack(docs, made);       // the note didn't go in: nothing this call made is left behind (Dexter D2)
  }
  if (!r.ok) return { ok: false, reason: r.reason === 'missing' ? 'no-backlog' : r.reason };
  if (!created) return { ok: true, where: { file: docs.backlog }, record: r.record };
  return { ok: true, result: 'created-backlog', where: { file: docs.backlog },
    record: { ...r.record, pristine: pristineOf(docs), ...(made ? { made } : {}) } };
}

/**
 * Is this note's entry already in the inbox? -> { ok: true, record | null } | { ok: false, reason: 'no-backlog' | 'busy' }.
 * For a retry after a write the journal never heard about (Dexter F3, PR #121): the record found is the one Undo uses.
 */
function findNote({ docs, stamp, text, others = [], readFile, sleep }) {
  const read = readDoc(docs.backlog, { readFile, sleep });
  if (!read.ok) return { ok: false, reason: read.reason === 'missing' ? 'no-backlog' : read.reason };
  const entry = doc.entryText(stamp, text, doc.newlineOf(read.text));
  // Identical entries are interchangeable bytes: one belongs to each other filed note that has the same one, and this
  // note adopts only a copy beyond those (Dexter F3, PR #121). `others`: the records of the other filed notes.
  const owned = others.filter(r => r && r.entry === entry).length;
  const found = doc.findEntries(read.text, entry);
  if (found.length <= owned) return { ok: true, record: null };
  return { ok: true, record: { entry, offset: found[found.length - 1], lead: '', sep: '' } };
}

const leavesPristine = (text, record) => { const u = doc.removeEntry(text, record); return u.ok && u.text === record.pristine; };

/**
 * Undo of a note that created its backlog: when taking the entry out leaves exactly the text the file was created with,
 * the file goes too. The file is moved aside first and the moved copy is what gets checked and deleted, so an edit that
 * lands after the check is either in the copy (then it isn't pristine and the file is put back) or in a new file at the
 * old name; it is never deleted unseen. -> null (not applicable or not pristine: do the ordinary Undo) | { ok, reason? }
 */
function deleteIfPristine(file, record, opts = {}) {
  const { rename = fs.renameSync, unlink = fs.unlinkSync, beforeDelete = () => {}, readFile, sleep } = opts;
  const read = readDoc(file, { readFile, sleep });
  if (!read.ok || !leavesPristine(read.text, record)) return null;
  beforeDelete();
  const aside = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.undo`);
  try { rename(file, aside); } catch { return null; }
  const moved = readDoc(aside, { readFile, sleep });
  let failure = null;
  if (moved.ok && leavesPristine(moved.text, record)) {
    try {
      unlink(aside);
      // the folder and the .gitignore block this note made, if nothing else is in them and git hasn't seen them committed
      const kept = unmake(path.dirname(file), record.made, { gitStatus: opts.gitStatus });
      return kept.length > 0 ? { ok: true, kept } : { ok: true };
    } catch { failure = { ok: false, reason: 'write-failed' }; }
  }
  // Not what it was (or couldn't be deleted): put it back, unless something new is at the old name already.
  try {
    try { fs.linkSync(aside, file); } catch (err) { if (!err || err.code === 'EEXIST') throw err; rename(aside, file); }
    fs.rmSync(aside, { force: true });
  } catch {
    return { ok: false, reason: 'changed' };
  }
  return failure;
}

/** -> { ok: true } | { ok: false, reason: 'changed' | 'busy' | 'write-failed' }  ('changed' also for a file that's gone) */
function undoNote(file, record, opts) {
  if (record && typeof record.pristine === 'string') {
    const gone = deleteIfPristine(file, record, opts || {});
    if (gone !== null) return gone;
  }
  const r = safeRewrite(file, (text) => {
    const u = doc.removeEntry(text, record);
    return u.ok ? { ok: true, text: u.text } : { ok: false, reason: 'changed' };
  }, opts);
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.reason === 'write-failed' || r.reason === 'busy' ? r.reason : 'changed' };
}

module.exports = { docsOf, fileNote, findNote, undoNote, ensureBacklog, takeBack, pristineOf };
