'use strict';
/**
 * Where a tab's "where are we" summary is kept (backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md decision 5):
 * in memory, and in `<dir>/<session-id>.json` (`<harness>/state/summaries`), so a restart still shows the last one.
 *
 *   createSummaryStore({ dir, rename }) -> { get(sessionId), put(sessionId, rec, at) }
 *   get -> { text, model, at, turnsSeen, newestKey, stale } | null
 *   put -> { ok: true, record } | { ok: false, error, record? }
 *
 * `stale` is true for a summary read back from disk that nothing in THIS run has refreshed: the page dims it. A
 * summary put in this run is never stale.
 *
 * TRUTH RULES
 *   - Nothing known is null: never an empty summary. A file that isn't a summary (not JSON, the wrong shape, absurdly
 *     large) reads as nothing, and a refused put writes nothing.
 *   - The session id comes off a hook payload: somebody else's string. Only `[A-Za-z0-9_-]` ids (not starting with a
 *     dash, at most 128) become a file name, so it can never name a path outside the folder.
 *   - The write is a temp file renamed over the target, never the target opened with 'w' (a failed write leaves the old
 *     file whole, and the temp is removed). A failed write is REPORTED, and the summary is still held in memory: it is
 *     still true, only not persisted.
 *   - A missing time is not time zero (Number(null) is 0): `at` must be a finite number.
 * It writes only inside `dir`. It never reads or writes a project's files.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry } = require('./atomic-write');

const ID_OK = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const SUMMARY_FILE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\.json$/;
const TMP_FILE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\.json\.\d+\.[0-9a-f]+\.tmp$/;
const MAX_AGE_MS = 30 * 86_400_000;       // these files hold a digest of private conversations: a sane privacy bound too
const MAX_FILES = 500;
const TMP_MAX_AGE_MS = 3_600_000;
const TEXT_MAX = 2000;
const FILE_MAX = 64 * 1024;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isCount = (n) => Number.isInteger(n) && n >= 0;

/** The persisted shape, or null when `o` is not a usable summary. `at` is checked by the caller. */
function shape(o) {
  if (!isObject(o)) return null;
  if (typeof o.text !== 'string' || o.text.trim() === '' || o.text.length > TEXT_MAX) return null;
  if (typeof o.model !== 'string' || o.model === '') return null;
  if (!isCount(o.turnsSeen)) return null;
  if (o.newestKey !== null && typeof o.newestKey !== 'string') return null;
  return { text: o.text, model: o.model, turnsSeen: o.turnsSeen, newestKey: o.newestKey };
}

function createSummaryStore({ dir, rename = renameWithRetry } = {}) {
  const memory = new Map();

  const fileOf = (id) => path.join(dir, id + '.json');

  function readDisk(id) {
    try {
      const file = fileOf(id);
      if (fs.statSync(file).size > FILE_MAX) return null;
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rec = shape(o);
      return rec && isNum(o.at) ? { ...rec, at: o.at, stale: true } : null;
    } catch {
      return null;
    }
  }

  function get(id) {
    if (typeof id !== 'string' || !ID_OK.test(id)) return null;
    if (memory.has(id)) return { ...memory.get(id) };
    const rec = readDisk(id);
    if (rec) memory.set(id, rec);
    return rec ? { ...rec } : null;
  }

  function put(id, rec, at) {
    if (typeof id !== 'string' || !ID_OK.test(id)) return { ok: false, error: 'not a usable session id' };
    const kept = shape(rec);
    if (!kept) return { ok: false, error: 'not a usable summary' };
    if (!isNum(at)) return { ok: false, error: 'no usable time' };
    const record = { ...kept, at, stale: false };
    memory.set(id, record);
    const tmp = fileOf(id) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ ...kept, at }) + '\n');
      rename(tmp, fileOf(id));
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* it was never written */ }
      return { ok: false, error: String((err && err.message) || err), record: { ...record } };
    }
    return { ok: true, record: { ...record } };
  }

  /**
   * One sweep (the host runs it once at start, Miguel I4, PR #105): summaries older than MAX_AGE_MS go, at most the newest
   * MAX_FILES stay, and orphan temp files (a host killed between the write and the rename) older than an hour go. It touches
   * only names that are summary or temp files of this store (never the GPU slot's dotfiles, never a directory), tolerates
   * every file vanishing under it (hosts sweep at the same time), and never leaves `dir`. -> { removed: [name] }
   */
  async function sweep({ now = Date.now(), maxAgeMs = MAX_AGE_MS, maxFiles = MAX_FILES, tmpMaxAgeMs = TMP_MAX_AGE_MS } = {}) {
    const removed = [];
    let names;
    try { names = await fsp.readdir(dir); } catch { return { removed }; }
    const keep = [];
    for (const name of names) {
      const isSummary = SUMMARY_FILE.test(name);
      if (!isSummary && !TMP_FILE.test(name)) continue;
      let st;
      try { st = await fsp.lstat(path.join(dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      const age = now - st.mtimeMs;
      if (age > (isSummary ? maxAgeMs : tmpMaxAgeMs)) {
        try { await fsp.unlink(path.join(dir, name)); removed.push(name); } catch { /* another host got it first */ }
      } else if (isSummary) {
        keep.push({ name, mtimeMs: st.mtimeMs });
      }
    }
    keep.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
    for (const { name } of keep.slice(maxFiles)) {
      try { await fsp.unlink(path.join(dir, name)); removed.push(name); } catch { /* another host got it first */ }
    }
    return { removed };
  }

  return { get, put, sweep };
}

module.exports = { createSummaryStore, TEXT_MAX, MAX_AGE_MS, MAX_FILES };
