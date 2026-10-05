'use strict';
/**
 * The indexing assistant's doc writer (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Settled earlier" and
 * "Claude's call" 1, 5 and 7). host/indexing-doc.js decides every byte; this reads, writes and checks.
 *
 *   docsOf({ root, dev })  -> { ok: true, dir, name, backlog, history } | { ok: false, reason: 'no-docs' | 'many-build-logs' }
 *   fileNote({ docs, spec: { target, kind, title?, text }, date })
 *                          -> { ok: true, where: { file, target, kind, title, n }, record } | { ok: false, reason }
 *   undoWrite(file, record) -> { ok: true } | { ok: false, reason: 'changed' | 'write-failed' }
 *
 * WHERE: `<dev>\documentation\<NAME>_BACKLOG.md` and `<NAME>_HISTORY.md`, NAME from the one `*_BUILD_LOG.md` (sync-docs'
 * rule, SyncDocs.ps1 Get-DocsName), else the project folder's name upper-cased without separators. The build log itself
 * is never written: it's canonical and owned by /sync-docs.
 *
 * THE BACKLOG is rewritten safely: read, build the new text, write it to a temp file beside it, re-read the backlog just
 * before the rename, and rename only if it's still what was read. A session editing it in between (/sync-docs) makes it
 * start over once from the new text (a new item's number is recomputed), then give up with `conflict`: the note waits.
 * Never truncated: the doc is only ever replaced whole, by rename. What's left unguarded is the moment between that last
 * re-read and the rename itself (no lock is shared with an editor), so an edit landing inside it would be replaced; the
 * window is a single rename, where reading-then-writing without the re-check would be the whole job.
 *
 * THE HISTORY is appended, the way add-history.ps1 does it, in its exact format (host/indexing-doc.js historyText). An
 * append can't lose a session's concurrent add-history.ps1 entry the way a rename could. The record is found by
 * re-reading: our text from where the file ended, or later if a session appended in between.
 *
 * UNDO goes through the same safe rewrite, and only when host/indexing-doc.js undoInsert says the note is still exactly
 * where it was put. Anything else is `changed`, and nothing is removed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry } = require('./atomic-write');
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
  return { ok: true, dir, name, backlog: path.join(dir, `${name}_BACKLOG.md`), history: path.join(dir, `${name}_HISTORY.md`) };
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Replace `file` with compute(text).text, safely (see the header). compute returns { ok: true, text, ...extra } or
 * { ok: false, reason }. -> { ok: true, ...extra } | { ok: false, reason: <compute's> | 'conflict' | 'write-failed' }.
 */
function safeRewrite(file, compute, { beforeRename = () => {}, rename } = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const before = readOrNull(file);
    if (before === null) return { ok: false, reason: 'missing' };
    const next = compute(before);
    if (!next.ok) return next;
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, next.text, 'utf8');
      beforeRename();
      if (readOrNull(file) !== before) { fs.rmSync(tmp, { force: true }); continue; }
      renameWithRetry(tmp, file, rename ? { rename } : {});
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
      return { ok: false, reason: 'write-failed' };
    }
    const { text, ok, ...extra } = next;
    return { ok: true, ...extra };
  }
  return { ok: false, reason: 'conflict' };
}

function fileBacklog(docs, spec, date, opts) {
  const r = safeRewrite(docs.backlog, (text) => {
    const plan = doc.planInsert(text, { ...spec, date });
    if (!plan.ok) return plan;
    return { ok: true, text: doc.applyInsert(text, plan), plan, record: doc.recordOf(text, plan) };
  }, opts);
  if (!r.ok) return { ok: false, reason: r.reason === 'missing' ? 'no-backlog' : r.reason };
  const n = spec.target === 'new' ? r.plan.n : spec.target;
  return {
    ok: true,
    where: { file: docs.backlog, target: spec.target, kind: spec.kind, title: spec.target === 'new' ? spec.title : null, n },
    record: r.record,
  };
}

function fileHistory(docs, spec, date) {
  const before = readOrNull(docs.history);
  if (before === null) return { ok: false, reason: 'no-history' };
  const plan = doc.planInsert(before, { ...spec, date });
  if (!plan.ok) return plan;
  try { fs.appendFileSync(docs.history, plan.inserted, 'utf8'); } catch { return { ok: false, reason: 'write-failed' }; }
  const after = readOrNull(docs.history);
  const at = after === null ? -1 : after.indexOf(plan.inserted, plan.offset);
  // Found where it landed (a session's append in between moves it on): Undo can be exact. Not found, it's still filed,
  // and Undo will say it can't.
  const record = at < 0 ? null : doc.recordOf(after, { offset: at, inserted: plan.inserted });
  return { ok: true, where: { file: docs.history, target: 'history', kind: spec.kind, title: null, n: null }, record };
}

function fileNote({ docs, spec, date, beforeRename, rename }) {
  const s = spec && typeof spec === 'object' ? spec : {};
  if (s.target === 'history') return fileHistory(docs, s, date);
  return fileBacklog(docs, s, date, { beforeRename, rename });
}

function undoWrite(file, record, opts) {
  const r = safeRewrite(file, (text) => {
    const u = doc.undoInsert(text, record);
    return u.ok ? { ok: true, text: u.text } : { ok: false, reason: 'changed' };
  }, opts);
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.reason === 'write-failed' ? 'write-failed' : 'changed' };
}

module.exports = { docsOf, fileNote, undoWrite };
