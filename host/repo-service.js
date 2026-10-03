'use strict';
/**
 * The host's side of the repo browser (#45 / #32). One control type, `repo`, one action per question:
 *
 *   list    { dir }    the entries of one folder (lazy: the page asks per folder as it opens it)
 *   overlay            fog's read / edited data rolled up into folders (host/repo-overlay.js)
 *   read    { path }   a file's text, or why it can't be shown (too-large / binary / gone / ...)
 *   stat    { path }   size and mtime, for the Reload bar
 *   diff    { path }   what Claude changed in it (host/repo-diff.js)
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
const { guardPath, lexical } = require('./repo-guard');
const { createIndex } = require('./repo-index');
const { readRepoFile, statRepoFile } = require('./repo-read');
const { diffFor } = require('./repo-diff');
const { rollUp } = require('./repo-overlay');
const { readFog } = require('./fog');
const { watchRepo } = require('./repo-watch');

const MAX_DIR = 4096;
const validSeq = (s) => (Number.isSafeInteger(s) || (typeof s === 'string' && s.length <= 64) ? s : undefined);

function createRepoService({
  root, projectsDir, readFog: readFogFn = readFog, index = createIndex(root),
  guard = guardPath, read = readRepoFile, stat = statRepoFile, diff = diffFor,
  watch = watchRepo, announce = () => {},
} = {}) {
  let watcher = null;
  let loaded = null;
  let overlayInFlight = null;
  let changes = 0;           // worktree changes seen: an overlay read begun before one may not include it
  let overlayAt = 0;         // the change count the in-flight overlay read began at

  function ensureWatching() {
    if (watcher) return;
    watcher = watch(root, async () => {
      changes += 1;
      try {
        await index.refresh({ again: true });
        announce({ type: 'repo', action: 'changed' });
      } catch (err) {
        console.log('[host] repo refresh failed:', err && err.message);
      }
    });
  }

  const ensureLoaded = () => {
    if (!loaded) loaded = index.refresh();
    return loaded;
  };

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
          return {
            ok: true, ...rollUp(fog.files, { resolve: index.resolve }),
            status: { transcriptsFound: st.transcriptsFound, transcriptErrors: st.transcriptErrors, transcriptsMissing: st.transcriptsMissing },
          };
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
        return { dir: msg.dir, ...index.list(msg.dir) };
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
        const r = msg.action === 'read' ? await read(g.real || g.abs) : await stat(g.real || g.abs);
        return { ...r, path: g.rel };
      }
      case 'diff': {
        if (typeof msg.path !== 'string') return { ok: false, why: 'bad request', error: 'no path' };
        const lex = lexical(root, msg.path);
        if (!lex.ok) return { ok: false, why: lex.why, path: msg.path.slice(0, 200) };
        const r = await diff({ root, rel: lex.rel, projectsDir });
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
  }

  return { handle, close };
}

module.exports = { createRepoService };
