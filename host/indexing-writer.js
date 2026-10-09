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
 * the file again only when the note was all that was ever in it, then the folder if it is empty, then the block it added.
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
const { isTransient, nextWait, sleepSync, ATTEMPTS: RENAME_ATTEMPTS, FIRST_WAIT_MS } = require('./atomic-write');
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
  return docsDirIn(main) !== null ? main : dev;
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

/** A real project's top folder: a git repo (or linked worktree) that is not a drive root or the home folder. */
function isProjectRoot(home) {
  try {
    if (path.parse(path.resolve(home)).root === path.resolve(home)) return false;
    if (path.resolve(home).toLowerCase() === path.resolve(os.homedir()).toLowerCase()) return false;
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
    if (!isProjectRoot(home)) return { ok: false, reason: 'no-docs' };
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

/**
 * Make sure `<home>\\.gitignore` carries the sync-docs block: created when there is no file (an exclusive create), the
 * block appended (after a blank line, in the file's own line endings) when it lacks the marker, left alone when it has it.
 * -> { ok: true, how: 'present' | 'created' | 'appended', text? } (text: exactly what this call added) | { ok: false }
 */
function addGitignoreBlock(home, opts = {}) {
  const file = path.join(home, '.gitignore');
  for (let i = 0; i < 2; i++) {
    const cur = readDoc(file, opts);
    if (!cur.ok && cur.reason === 'missing') {
      const made = createExclusive(file, gitignoreBlock('\n'));
      if (made.created) return { ok: true, how: 'created', text: gitignoreBlock('\n') };
      continue;                                           // it appeared meanwhile: treat it as the existing file
    }
    if (!cur.ok) return { ok: false };
    if (cur.text.includes(GITIGNORE_MARKER)) return { ok: true, how: 'present' };
    const r = safeRewrite(file, (text) => {
      if (text.includes(GITIGNORE_MARKER)) return { ok: false, reason: 'present' };
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      const sep = text === '' ? '' : (/\n$/.test(text) ? nl : nl + nl);
      const added = sep + gitignoreBlock(nl);
      return { ok: true, text: text + added, added };
    }, opts);
    if (r.ok) return { ok: true, how: 'appended', text: r.added };
    if (r.reason === 'present') return { ok: true, how: 'present' };
    return { ok: false };
  }
  return { ok: false };
}

/** Take back what addGitignoreBlock added, only while the file still ends/holds exactly that. Best effort. */
function removeGitignoreBlock(home, g, opts = {}) {
  const file = path.join(home, '.gitignore');
  try {
    if (g.how === 'created') {
      const cur = readDoc(file, opts);
      if (cur.ok && cur.text === g.text) fs.rmSync(file, { force: true });
    } else if (g.how === 'appended') {
      safeRewrite(file, (text) => (text.endsWith(g.text) ? { ok: true, text: text.slice(0, text.length - g.text.length) } : { ok: false, reason: 'changed' }), opts);
    }
  } catch { /* the block stays; harmless */ }
}

/**
 * Take back what a note made besides the backlog: the documentation folder, only while it is empty, and then, only if
 * the folder went, the .gitignore block this note added. Anything else in the folder keeps both.
 */
function unmake(dir, made, opts = {}) {
  if (!made || made.dir !== true) return;
  try { fs.rmdirSync(dir); } catch { return; }
  if (made.gitignore) removeGitignoreBlock(path.dirname(dir), made.gitignore, opts);
}

/**
 * Create the project's backlog when it isn't there (only for a project that `canCreate`): written to a temp file, then
 * hard-linked into place, which fails with EEXIST rather than replacing a backlog a session or another window made in
 * the meantime; where hard links aren't supported, an exclusive create. The target is never opened for writing otherwise.
 * No `documentation\` folder yet: it is made first, and the sync-docs .gitignore block added; if either fails, whatever
 * this call made is taken back. -> { ok: true, created: boolean, made?: { dir, gitignore? } } | { ok: false, reason: 'no-backlog' | 'write-failed' }
 */
function createBacklog(docs, { beforeCreate = () => {}, link = fs.linkSync } = {}) {
  if (!docs || docs.canCreate !== true) return { ok: false, reason: 'no-backlog' };
  const made = {};
  try {
    if (!fs.existsSync(docs.dir)) {
      try { fs.mkdirSync(docs.dir); made.dir = true; } catch (err) { if (!(err && err.code === 'EEXIST')) throw err; }
      if (made.dir) {
        const g = addGitignoreBlock(path.dirname(docs.dir));
        if (!g.ok) throw new Error('the .gitignore could not be updated');
        if (g.how !== 'present') made.gitignore = { how: g.how, text: g.text };
      }
    }
  } catch {
    unmake(docs.dir, made.dir ? { dir: true, gitignore: made.gitignore } : null);
    return { ok: false, reason: 'write-failed' };
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
  if (!result.ok) { unmake(docs.dir, made.dir ? { dir: true, gitignore: made.gitignore } : null); return result; }
  return result.created && made.dir ? { ...result, made: { dir: true, ...(made.gitignore ? { gitignore: made.gitignore } : {}) } } : result;
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
function deleteIfPristine(file, record, { rename = fs.renameSync, unlink = fs.unlinkSync, beforeDelete = () => {}, readFile, sleep } = {}) {
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
      unmake(path.dirname(file), record.made, { readFile, sleep });     // the folder and the .gitignore block this note made, if nothing else is in them
      return { ok: true };
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

module.exports = { docsOf, fileNote, findNote, undoNote, ensureBacklog, pristineOf };
