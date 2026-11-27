'use strict';
/**
 * The crash-restore record (single-instance PR 3, step 12): `<UI state dir>\open-windows.json`
 *   = { owner: { pid, start }, at, clean, restoring, windows: [{ root, cwd, hidden }] }
 *
 * It is DERIVED state, written on change, and only by the process the app lock's `app.json` names (owns()): a process that was displaced
 * (hung, then taken over: plan risk 2) writes nothing. A quit writes it clean (will-quit, and a Windows session end), so only a process
 * that ENDED without quitting leaves it not clean.
 *
 *   restoreDecision({ record, proof, bootAt, launchRoot, exists, samePath }) -> { restore: [{ root, cwd, hidden }], skipped, reason }
 *     Pure; never throws on any JSON. Something to restore only when the record is not clean, its owner is proven dead (proof 'dead'), it was
 *     not itself mid-restore (`restoring: true` -> "the last restore did not finish": a restore that crashes never loops; that list stays
 *     in the file), and it is not older than this boot of the machine (§5 Q2 default: after a restart the sessions are gone, so nothing is
 *     restored). The launched root is left out (it opens anyway, first); a folder that is gone is skipped with its reason.
 *
 *   createOpenWindowsWriter({ file, owner, owns, now, write, onWrite }) -> { begin, sync, endRestore, markClean }
 *     begin({ restoring, keep })  the first write: not clean, `restoring` as told, the list it was handed (the old list while restoring)
 *     sync(windows)               the open windows now; writes only on a change; a no-op until endRestore()
 *     endRestore(windows)         the restore is over: restoring false, and the list is the open windows
 *     markClean()                 synchronous (a quit may end the process right after): clean true, the last list
 * No Electron.
 */

const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nothing = (reason) => ({ restore: [], skipped: [], reason });

/** The windows of a record, shape-checked: a root and a cwd as text; hidden only on a real true. */
function cleanWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (!isObj(w) || typeof w.root !== 'string' || !w.root || typeof w.cwd !== 'string' || !w.cwd) continue;
    out.push({ root: w.root, cwd: w.cwd, hidden: w.hidden === true });
  }
  return out;
}

function restoreDecision({ record, proof, bootAt, launchRoot, exists, samePath } = {}) {
  if (!isObj(record) || !Array.isArray(record.windows)) return nothing('no record');
  if (record.clean === true) return nothing('the last quit was clean');
  if (proof !== 'dead') return nothing('its owner is not proven gone');
  if (record.restoring === true) return nothing('the last restore did not finish');
  if (!Number.isFinite(record.at) || !Number.isFinite(bootAt) || record.at < bootAt) return nothing('older than this boot');
  const restore = [];
  const skipped = [];
  for (const w of cleanWindows(record.windows)) {
    let same = false;
    try { same = typeof launchRoot === 'string' && samePath(w.root, launchRoot); } catch { same = false; }
    if (same) continue;
    let there = false;
    try { there = exists(w.cwd) === true; } catch { there = false; }
    if (!there) { skipped.push({ root: w.root, reason: 'the folder is gone' }); continue; }
    restore.push(w);
  }
  return { restore, skipped, reason: 'restore' };
}

/** The record on file, parsed, or null (no file, not JSON). */
function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function createOpenWindowsWriter({ file, owner, owns, now = Date.now, write = writeFileAtomic, onWrite = () => {} }) {
  let restoring = true;            // until begin/endRestore say otherwise, sync waits
  let windows = [];
  let lastText = null;
  let lastClean = false;           // the last write said clean: the next sync writes even an unchanged list (a cancelled quit lives on)

  function put(doc) {
    if (owns() !== true) return false;
    const text = JSON.stringify(doc);
    write(file, text);
    lastText = text;
    lastClean = doc.clean === true;
    onWrite(doc);
    return true;
  }
  const docOf = (clean) => ({ owner: { pid: owner.pid, start: owner.start }, at: now(), clean, restoring, windows });

  function begin({ restoring: r = false, keep = [] } = {}) {
    restoring = r === true;
    windows = cleanWindows(keep);
    try { put(docOf(false)); } catch { /* the next change writes it */ }
  }

  function sync(list) {
    if (restoring) return;
    const next = cleanWindows(list);
    if (JSON.stringify(next) === JSON.stringify(windows) && lastText !== null && !lastClean) return;
    windows = next;
    try { put(docOf(false)); } catch { /* the next change writes it */ }
  }

  function endRestore(list) {
    restoring = false;
    windows = cleanWindows(list);
    try { put(docOf(false)); } catch { /* the next change writes it */ }
  }

  function markClean() {
    try { put(docOf(true)); } catch { /* the next start sees it not clean: at worst a restore of what was open */ }
  }

  return { begin, sync, endRestore, markClean };
}

module.exports = { restoreDecision, createOpenWindowsWriter, readRecord, cleanWindows };
