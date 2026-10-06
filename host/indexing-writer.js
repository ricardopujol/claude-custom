'use strict';
/**
 * The indexing assistant's doc writer (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": a verbatim inbox). host/indexing-doc.js decides every byte; this reads, writes and checks.
 *
 *   docsOf({ root, dev })              -> { ok: true, dir, name, backlog } | { ok: false, reason: 'no-docs' | 'many-build-logs' }
 *   fileNote({ docs, stamp, text })    -> { ok: true, where: { file }, record } | { ok: false, reason }
 *   undoNote(file, record)             -> { ok: true } | { ok: false, reason: 'changed' | 'write-failed' }
 *
 * WHERE: `<dev>\documentation\<NAME>_BACKLOG.md`, NAME from the one `*_BUILD_LOG.md` (sync-docs' rule, SyncDocs.ps1
 * Get-DocsName), else the project folder's name upper-cased without separators. Only the backlog is ever written, and
 * only when it exists: a project with no backlog file gets none (`no-backlog`).
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
const crypto = require('crypto');
const { isTransient, nextWait, sleepSync, ATTEMPTS: RENAME_ATTEMPTS, FIRST_WAIT_MS } = require('./atomic-write');
const doc = require('./indexing-doc');

const ATTEMPTS = 2;

function docsOf(project) {
  if (!project || typeof project.dev !== 'string') return { ok: false, reason: 'no-docs' };
  const dir = path.join(project.dev, 'documentation');
  let names;
  try { names = fs.readdirSync(dir); } catch { return { ok: false, reason: 'no-docs' }; }
  const logs = names.filter(n => /_BUILD_LOG\.md$/i.test(n));
  if (logs.length > 1) return { ok: false, reason: 'many-build-logs' };
  const leaf = path.basename(typeof project.root === 'string' ? project.root : project.dev);
  const name = logs.length === 1 ? logs[0].replace(/_BUILD_LOG\.md$/i, '') : leaf.replace(/[-_\s]/g, '').toUpperCase();
  return { ok: true, dir, name, backlog: path.join(dir, `${name}_BACKLOG.md`) };
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Replace `file` with compute(text).text, safely (see the header). compute returns { ok: true, text, ...extra } or
 * { ok: false, reason }. -> { ok: true, ...extra } | { ok: false, reason: <compute's> | 'missing' | 'conflict' | 'write-failed' }.
 */
/**
 * Rename `tmp` over `file` only while `file` still holds `before`, re-checked before EVERY attempt: a rename refused
 * (EPERM/EBUSY: a scanner, or a session's own writer holding the file) is retried with atomic-write's backoff, and the
 * edit that may land during that backoff must never be replaced (Dexter F5, PR #121). -> true (renamed) | false
 * (the file changed: start over). Throws what the rename threw when it isn't transient or the attempts ran out.
 */
function renameIfUnchanged(tmp, file, before, { rename = fs.renameSync, sleep = sleepSync } = {}) {
  let wait = FIRST_WAIT_MS;
  for (let i = 1; ; i++) {
    if (readOrNull(file) !== before) return false;
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

function safeRewrite(file, compute, { beforeRename = () => {}, rename, sleep } = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const before = readOrNull(file);
    if (before === null) return { ok: false, reason: 'missing' };
    const next = compute(before);
    if (!next.ok) return next;
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, next.text, 'utf8');
      beforeRename();
      if (!renameIfUnchanged(tmp, file, before, { rename, sleep })) { fs.rmSync(tmp, { force: true }); continue; }
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
      return { ok: false, reason: 'write-failed' };
    }
    const { text, ok, ...extra } = next;
    return { ok: true, ...extra };
  }
  return { ok: false, reason: 'conflict' };
}

function fileNote({ docs, stamp, text, beforeRename, rename, sleep }) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
  const r = safeRewrite(docs.backlog, (current) => {
    const base = doc.ensureInbox(current).text;
    const entry = doc.entryText(stamp, text, doc.newlineOf(base));
    const plan = doc.planAppend(base, entry);
    if (!plan.ok) return plan;
    return { ok: true, text: doc.applyInsert(base, plan), record: doc.recordOf(plan, entry) };
  }, { beforeRename, rename, sleep });
  if (!r.ok) return { ok: false, reason: r.reason === 'missing' ? 'no-backlog' : r.reason };
  return { ok: true, where: { file: docs.backlog }, record: r.record };
}

/**
 * Is this note's entry already in the inbox? -> { ok: true, record | null } | { ok: false, reason: 'no-backlog' }.
 * For a retry after a write the journal never heard about (Dexter F3, PR #121): the record found is the one Undo uses.
 */
function findNote({ docs, stamp, text }) {
  const current = readOrNull(docs.backlog);
  if (current === null) return { ok: false, reason: 'no-backlog' };
  const entry = doc.entryText(stamp, text, doc.newlineOf(current));
  const at = doc.findEntry(current, entry);
  return { ok: true, record: at < 0 ? null : { entry, offset: at, lead: '', sep: '' } };
}

function undoNote(file, record, opts) {
  const r = safeRewrite(file, (text) => {
    const u = doc.removeEntry(text, record);
    return u.ok ? { ok: true, text: u.text } : { ok: false, reason: 'changed' };
  }, opts);
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.reason === 'write-failed' ? 'write-failed' : 'changed' };
}

module.exports = { docsOf, fileNote, findNote, undoNote };
