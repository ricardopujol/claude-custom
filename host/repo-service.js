'use strict';
/**
 * The host's side of the repo browser (#45 / #32). One control type, `repo`, one action per question:
 *
 *   list    { dir }    the entries of one folder (lazy: the page asks per folder as it opens it)
 *   overlay            fog's read / edited data rolled up into folders (host/repo-overlay.js)
 *   read    { path }   a file's text, or why it can't be shown (too-large / binary / gone / ...)
 *   stat    { path }   size and mtime, for the Reload bar
 *   diff    { path }   what Claude changed in it (host/repo-diff.js)
 *   write   { path, text, eol, bom, expectHash }   the reader's save (#50, host/repo-write.js): atomic, and refused
 *                      as `stale` when the file is no longer the one `expectHash` names. Never under `.git` (real path).
 *
 * Every reply is `{ type: 'repo', action, seq?, ok, ... }`, `seq` echoed so the page can tell which of its
 * asks an answer belongs to. A failure is `{ ok: false, why | error }`, never silence and never an empty
 * success.
 *
 * `repo` MUST be in host/control.js CONTROL_TYPES: a frame of an unlisted type is TYPED into the pty, and a
 * `read` of a path would reach a session that may be running --dangerously-skip-permissions.
 *
 * EVERY PATH IS RE-CHECKED HERE (host/repo-guard.js), whatever the page believes: read and stat use the
 * realpath guard (a junction leading out is refused); diff touches no file, only transcripts and git, so the
 * lexical half is enough. The worktree is `root`, this host's own CWD: a tab is a worktree and cannot name
 * another.
 *
 * The worktree watch starts on the first ask, not at startup: a tab that never opens the Files tab never
 * watches. A change refreshes the listing (`again`, so a change that landed while git was looking is not
 * lost) and tells every client `changed`; the page then re-asks what it is showing.
 */
const { guardPath, guardWrite, lexical } = require('./repo-guard');
const { createIndex } = require('./repo-index');
const { readRepoFile, statRepoFile } = require('./repo-read');
const { writeRepoFile } = require('./repo-write');
const { diffFor, gitModified } = require('./repo-diff');
const { rollUp } = require('./repo-overlay');
const { readFog } = require('./fog');
const { watchRepo } = require('./repo-watch');

const MAX_DIR = 4096;
// One folder's reply is capped here, not only at draw time (PR #95 Miguel M6): a 50k-file folder was serialised
// whole over the socket on every `changed`. Folders sort first, so the cap drops files from the end.
const MAX_LIST_ENTRIES = 3000;
// A tool_result lands about half a second AFTER the file changes (the PostToolUse hooks run first), in a
// transcript outside the watched worktree: no event announces it. So a read that saw a recent edit with no result
// yet re-reads after SETTLE_MS, up to MAX_SETTLES times, and pushes `overlay-ready` when the answer changed.
const SETTLE_MS = 1500;
const MAX_SETTLES = 6;
const validSeq = (s) => (Number.isSafeInteger(s) || (typeof s === 'string' && s.length <= 64) ? s : undefined);

function createRepoService({
  root, projectsDir, readFog: readFogFn = readFog, index = createIndex(root),
  guard = guardPath, guardSave = guardWrite, read = readRepoFile, stat = statRepoFile, write = writeRepoFile, diff = diffFor, modified = gitModified,
  watch = watchRepo, announce = () => {}, listCap = MAX_LIST_ENTRIES,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }, clearTimer = clearTimeout,
} = {}) {
  let watcher = null;
  let loaded = null;
  let overlayInFlight = null;
  let changes = 0;           // worktree changes seen: an overlay read begun before one may not include it
  let settleTimer = null;
  let settles = 0;           // consecutive re-reads for unanswered edits; a worktree change or a clean read resets it
  let lastOverlay = null;    // the last answer, as JSON, to tell whether a re-read changed anything
  let overlayAt = 0;         // the change count the in-flight overlay read began at

  function ensureWatching() {
    if (watcher) return;
    watcher = watch(root, async () => {
      changes += 1;
      settles = 0;
      try {
        await index.refresh({ again: true });
        announce({ type: 'repo', action: 'changed' });
      } catch (err) {
        console.log('[host] repo refresh failed:', err && err.message);
      }
    });
  }

  // The first listing is read once and shared. A FAILED one is not kept (PR #95 Dexter D5): a git timeout under
  // load would otherwise be the answer for the life of the host, and only a file change could clear it, so the
  // next ask runs git again.
  const ensureLoaded = () => {
    if (!loaded) {
      loaded = index.refresh().then((status) => {
        if (!status || status.ok === false) loaded = null;
        return status;
      });
    }
    return loaded;
  };

  // `pending` recent edits had no result yet when this read ran: look again shortly (R2-1).
  function scheduleSettle(pending, out) {
    const now = JSON.stringify([out.files, out.dirs]);
    lastOverlay = now;
    if (!(pending > 0)) {
      settles = 0;
      return;
    }
    if (settleTimer !== null || settles >= MAX_SETTLES) return;
    settles += 1;
    settleTimer = setTimer(async () => {
      settleTimer = null;
      const before = lastOverlay;
      await readOverlay();
      if (lastOverlay !== before) announce({ type: 'repo', action: 'overlay-ready' });
    }, SETTLE_MS);
  }

  function readOverlay() {
    // PR #95 Dexter D4: an ask that comes after a change must not be answered from a read that began before
    // it (a cold read of the transcripts takes seconds): it waits for that read, then reads again.
    if (overlayInFlight && overlayAt !== changes) return overlayInFlight.then(() => readOverlay());
    if (!overlayInFlight) {
      overlayAt = changes;
      overlayInFlight = (async () => {
        try {
          const fog = await readFogFn({ cwd: root, projectsDir });
          const st = fog.status || {};
          // the listing spells the files, so a transcript's other spelling of one is the same row
          await ensureLoaded();
          const out = {
            ok: true, ...rollUp(fog.files, { resolve: index.resolve }),
            status: { transcriptsFound: st.transcriptsFound, transcriptErrors: st.transcriptErrors, transcriptsMissing: st.transcriptsMissing },
          };
          scheduleSettle(st.pendingEdits, out);
          return out;
        } catch (err) {
          return { ok: false, error: `the overlay could not be read: ${(err && err.message) || err}` };
        } finally {
          overlayInFlight = null;
        }
      })();
    }
    return overlayInFlight;
  }

  async function dispatch(msg) {
    switch (msg.action) {
      case 'list': {
        if (typeof msg.dir !== 'string' || msg.dir.length > MAX_DIR) return { ok: false, error: 'not a folder' };
        ensureWatching();
        await ensureLoaded();
        const l = index.list(msg.dir);
        if (!l.ok || !Array.isArray(l.entries)) return { dir: msg.dir, ...l };
        return { dir: msg.dir, ...l, entries: l.entries.slice(0, listCap), omitted: Math.max(0, l.entries.length - listCap) };
      }
      case 'overlay': {
        ensureWatching();
        return readOverlay();
      }
      case 'read': case 'stat': {
        if (typeof msg.path !== 'string') return { ok: false, why: 'bad request', error: 'no path' };
        const g = await guard(root, msg.path);
        if (!g.ok) return { ok: false, why: g.why, path: msg.path.slice(0, 200) };
        ensureWatching();
        if (msg.action === 'stat') return { ...(await stat(g.real || g.abs)), path: g.rel };
        // `modified` (git diff --quiet): a file changed by Bash or by hand gets the Diff toggle too (PR #95 Dexter
        // D2). Asked beside the read, and only attached to one that succeeded.
        const [r, m] = await Promise.all([read(g.real || g.abs), modified(root, g.rel)]);
        if (r.ok) {
          // THE CHECK AND THE USE WERE APART (PR #95 Dexter D10): the guard resolved the path, then awaits passed
          // before the open. Resolve it again now that the bytes are in hand; if it is no longer the same file
          // inside the worktree (a folder swapped for a junction meanwhile), the text is dropped.
          const again = await guard(root, msg.path);
          if (!again.ok || String(again.real || again.abs).toLowerCase() !== String(g.real || g.abs).toLowerCase()) {
            return { ok: false, why: 'changed while reading', path: g.rel };
          }
        }
        return { ...r, ...(r.ok ? { modified: m } : {}), path: g.rel };
      }
      case 'write': {
        if (typeof msg.path !== 'string') return { ok: false, why: 'bad request', error: 'no path' };
        // the SAVE's own guard (host/repo-guard.js guardWrite): a deleted file can be recreated in its folder, and
        // nothing whose REAL path is under any `.git` (a link, a nested repo, a short name) is ever written
        const g = await guardSave(root, msg.path);
        if (!g.ok) return { ok: false, why: g.why, path: msg.path.slice(0, 200) };
        ensureWatching();
        const r = await write(g.real || g.abs, { text: msg.text, eol: msg.eol, bom: msg.bom, expectHash: msg.expectHash });
        return { ...r, path: g.rel };
      }
      case 'diff': {
        if (typeof msg.path !== 'string') return { ok: false, why: 'bad request', error: 'no path' };
        const lex = lexical(root, msg.path);
        if (!lex.ok) return { ok: false, why: lex.why, path: msg.path.slice(0, 200) };
        // The file's own time lets the diff tell that it has changed since Claude's last call (host/repo-diff.js
        // pickDiff). A deleted or unreadable file has none, and the calls stand.
        const g = await guard(root, lex.rel);
        const st = g.ok ? await stat(g.real || g.abs) : null;
        const r = await diff({ root, rel: lex.rel, projectsDir, fileMtimeMs: st && st.ok ? st.mtimeMs : undefined });
        return { ...r, path: lex.rel };
      }
      default:
        return { ok: false, error: 'unknown repo action' };
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'repo', ok: false, error: 'not a request' };
    const head = { type: 'repo', action: typeof msg.action === 'string' ? msg.action.slice(0, 32) : undefined };
    const seq = validSeq(msg.seq);
    if (seq !== undefined) head.seq = seq;
    let body;
    try {
      body = await dispatch(msg);
    } catch (err) {
      body = { ok: false, error: `the repo browser failed: ${(err && err.message) || err}` };
    }
    return { ...head, ...body };
  }

  function close() {
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    if (settleTimer !== null) { clearTimer(settleTimer); settleTimer = null; }
  }

  return { handle, close };
}

module.exports = { createRepoService, MAX_LIST_ENTRIES };
