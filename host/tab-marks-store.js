'use strict';
/**
 * Where the tab marks (#40) live and how they're read and written:
 * <stateRoot>\.claude-custom\tab-marks.json, beside the look and the branch
 * ledger, behind the same `*` .gitignore. app/tab-marks.js is the pure half.
 *
 * Load states (app/tab-marks.js markMenuModel reads them):
 *   'missing'     no file yet: an empty store, safe to write.
 *   'ok'          read and understood.
 *   'unreadable'  there, but unread or not understood: shown as no marks and
 *                 NEVER written over -- it's the person's data.
 *   'unavailable' .claude-custom is a link or junction to somewhere else:
 *                 style.js refuses to write through one (its Dexter F7), and so
 *                 does the ledger (PR #84 Miguel B3), and so does this.
 *
 * The write is a temp file renamed over the target, never the target opened
 * with 'w': a failed write must leave the old file whole.
 */

const fs = require('fs');
const path = require('path');
const { lookDir, lookDirState, ensureLookDir } = require('./style');
const { renameWithRetry } = require('./atomic-write');
const { parseMarks, serializeMarks, emptyMarks } = require('../app/tab-marks');

const MARKS_FILE = 'tab-marks.json';

/** The file's path, or null when .claude-custom is foreign. Creates nothing. */
function marksFileFor(stateRoot, fsImpl = fs) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') return null;
  return path.join(lookDir(stateRoot), MARKS_FILE);
}

/** `{ state, store }`; `store` is null unless the state may be written over. */
function loadMarks(file, { fsImpl = fs } = {}) {
  if (file === null) return { state: 'unavailable', store: null };
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', store: emptyMarks() };
    return { state: 'unreadable', store: null };
  }
  const r = parseMarks(text);
  return r.ok ? { state: 'ok', store: r.store } : { state: 'unreadable', store: null };
}

function saveMarks(stateRoot, store, { fsImpl = fs } = {}) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') {
    throw new Error(`tab-marks: ${lookDir(stateRoot)} is a link to somewhere else; not writing through it`);
  }
  const file = path.join(ensureLookDir(stateRoot, fsImpl), MARKS_FILE);
  const temp = `${file}.tmp${process.pid}`;
  try {
    fsImpl.writeFileSync(temp, serializeMarks(store));
    renameWithRetry(temp, file, { rename: fsImpl.renameSync });
  } catch (err) {
    try { fsImpl.unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = { marksFileFor, loadMarks, saveMarks, MARKS_FILE };
