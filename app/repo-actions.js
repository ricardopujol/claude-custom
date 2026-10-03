'use strict';
/**
 * Show in Explorer and drag-out for the repo browser (#45): the two things only the MAIN process can do.
 *
 *   createRepoActions({ shell, startDrag, icon, guard, fsApi }) ->
 *     reveal(root, rel) -> { ok: true } | { ok: false, why }     shell.showItemInFolder
 *     drag(root, rel, start?) -> { ok: true } | { ok: false, why }   start({ file, icon }) = webContents.startDrag
 *
 * `root` is the worktree of the tab that ASKED (tab.cwd, looked up by main from the sender), never a value
 * the page sent. `rel` is what the page sent; it is run through host/repo-guard.js here, in main, again:
 * the page is not trusted to have kept to the worktree (a stale row, a link planted in the repo, a message
 * it was never meant to send). A path that resolves, after `..`, symlinks and junctions, outside that
 * worktree is refused with the reason, and nothing is touched.
 *
 * NOTHING IS EVER EXECUTED. The shell handed in is only asked to show an item in its folder; this module
 * never launches, opens or runs a file (the #21 / #37 rule: ShellExecute runs .exe .bat .ps1 .js and more,
 * and the repo's files are not the user's to run by a click). test/repo-actions.test.js hands it a shell
 * that throws on every other member, and scans this source for the calls.
 *
 * Drag takes FILES: a folder answers 'not-a-file' (the OS drag takes files, and a folder drag would
 * silently copy a tree). The OS does the copy; this only starts the drag.
 */
const fsp = require('fs/promises');
const { guardPath } = require('../host/repo-guard');

function createRepoActions({ shell, startDrag, icon, guard = guardPath, fsApi = fsp } = {}) {
  async function resolve(root, rel) {
    if (typeof rel !== 'string') return { ok: false, why: 'not a path' };
    const g = await guard(root, rel);
    return g.ok ? { ok: true, at: g.real || g.abs } : { ok: false, why: g.why };
  }

  async function reveal(root, rel) {
    const r = await resolve(root, rel);
    if (!r.ok) return r;
    try {
      shell.showItemInFolder(r.at);
      return { ok: true };
    } catch (err) {
      return { ok: false, why: (err && err.message) || 'could not show it in Explorer' };
    }
  }

  // `start` is the asking page's own webContents.startDrag (main hands it in per call): a drag belongs to
  // the window the pointer is in.
  async function drag(root, rel, start = startDrag) {
    const r = await resolve(root, rel);
    if (!r.ok) return r;
    try {
      const st = await fsApi.stat(r.at);
      if (!st.isFile()) return { ok: false, why: 'not-a-file' };
      start({ file: r.at, icon: icon() });
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, why: 'gone' };
      return { ok: false, why: (err && err.message) || 'could not start the drag' };
    }
  }

  return { reveal, drag };
}

module.exports = { createRepoActions };
