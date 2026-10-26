'use strict';
/**
 * The reader's save (#50).
 *
 *   writeRepoFile(abs, { text, eol, bom, expectHash, maxBytes, fsApi }) ->
 *       { ok: true, size, mtimeMs, hash }
 *     | { ok: false, why: 'stale', hash?, size?, gone? }        the file is no longer the one the person started from
 *     | { ok: false, why: 'bad request' | 'too-large' | 'not-a-file' }
 *     | { ok: false, why: 'unwritable', error }                nothing was changed
 *
 * `abs` has ALREADY passed host/repo-guard.js; this module only writes.
 *
 * ATOMIC. The bytes go to a temp file BESIDE the target (same folder, so the rename can't cross a volume), are
 * flushed, and a rename replaces the target. The target is never opened for writing: a failed encode, a full disk
 * or a crash leaves the old file whole, and the temp file is removed on every path out (the lesson of the
 * `app/renderer.js` that was once truncated to zero bytes). The rename is host/atomic-write.js's retry, because
 * Windows fails one while an antivirus scan holds the file for a moment.
 *
 * NEVER BLIND. `expectHash` is the sha256 of the bytes the person read (host/repo-read.js `hash`). The file is
 * hashed before the temp is written and AGAIN just before the rename, and a mismatch writes nothing and answers
 * `stale` with the disk's own hash, so the page can show what changed. Content, not mtime, decides: a `touch`
 * with identical bytes is not a conflict. `expectHash: null` means "the file must not exist" (saving over a file
 * that was deleted while open is a choice the person makes, and it creates the file again); `undefined` or
 * anything else is refused. The rename's retry looks again before every retry (the usual reason for one is that someone
 * else has the file open, often to write it). One window stays open, the instant between the second check and the rename; a
 * writer that lands exactly there wins the race on any filesystem without a compare-and-swap rename.
 *
 * WRITES BACK WHAT THE READ FOUND: UTF-8, the file's line endings (`eol` 'crlf' turns every \n into CR LF), and
 * its BOM if it had one. The text is the editor's, which only ever holds \n, so a CR in it is refused.
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetryAsync } = require('./atomic-write');
const { MAX_BYTES } = require('./repo-read');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bad = () => ({ ok: false, why: 'bad request' });

// The disk's state against what the person started from: null when it still matches.
async function staleness(abs, expectHash, { fsApi, maxBytes }) {
  let st;
  try {
    st = await fsApi.stat(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return expectHash === null ? null : { ok: false, why: 'stale', gone: true };
    return { ok: false, why: 'unwritable', error: (err && err.message) || String(err) };
  }
  if (!st.isFile()) return { ok: false, why: 'not-a-file' };
  if (expectHash === null) return { ok: false, why: 'stale', size: st.size };
  if (st.size > maxBytes) return { ok: false, why: 'stale', size: st.size };       // not the (at most maxBytes) file that was read
  let buf;
  try {
    buf = await fsApi.readFile(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, why: 'stale', gone: true };
    return { ok: false, why: 'unwritable', error: (err && err.message) || String(err) };
  }
  const hash = sha(buf);
  return hash === expectHash ? null : { ok: false, why: 'stale', hash, size: buf.length };
}

async function writeRepoFile(abs, { text, eol = 'lf', bom = false, expectHash, maxBytes = MAX_BYTES, fsApi = fsp } = {}) {
  if (typeof text !== 'string' || text.includes('\r') || !text.isWellFormed()) return bad();
  if (eol !== 'lf' && eol !== 'crlf') return bad();
  if (expectHash !== null && (typeof expectHash !== 'string' || expectHash === '')) return bad();

  const body = Buffer.from(eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  const bytes = bom === true ? Buffer.concat([BOM, body]) : body;
  if (bytes.length > maxBytes) return { ok: false, why: 'too-large', size: bytes.length, limit: maxBytes };

  const first = await staleness(abs, expectHash, { fsApi, maxBytes });
  if (first) return first;

  let mode = null;
  try { mode = (await fsApi.stat(abs)).mode & 0o777; } catch { mode = null; }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fh = await fsApi.open(tmp, 'wx');
    try {
      await fh.writeFile(bytes);
      await fh.sync();
      if (mode !== null && process.platform !== 'win32') await fh.chmod(mode);
    } finally {
      await fh.close();
    }
    // the stamp of the bytes WE wrote: taken from the TEMP path after the handle is closed (closing can still move the
    // time on NTFS), before the rename and before anyone else can reach it; a rename keeps it
    const written = await fsApi.stat(tmp);
    const second = await staleness(abs, expectHash, { fsApi, maxBytes });
    if (second) return second;
    // The retry is for a holder that clears in milliseconds, but a holder is often somebody WRITING the file: look
    // again before every retry, and a change in between is stale, not overwritten.
    let attempt = 0;
    const rename = async (from, to) => {
      if (attempt++ > 0) {
        const again = await staleness(abs, expectHash, { fsApi, maxBytes });
        if (again) throw Object.assign(new Error('changed during the save'), { staleResult: again });
      }
      return fsApi.rename(from, to);
    };
    await renameWithRetryAsync(tmp, abs, { rename });
    return { ok: true, size: written.size, mtimeMs: written.mtimeMs, hash: sha(bytes) };
  } catch (err) {
    if (err && err.staleResult) return err.staleResult;
    return { ok: false, why: 'unwritable', error: (err && err.message) || String(err) };
  } finally {
    // an early `return` above (a stale second check) and a throw both land here: no temp file survives
    try { await fsApi.unlink(tmp); } catch { /* never created, or already renamed */ }
  }
}

module.exports = { writeRepoFile };
