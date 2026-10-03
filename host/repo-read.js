'use strict';
/**
 * The reader's file read (#32).
 *
 *   readRepoFile(abs, { fsApi, maxBytes }) -> { ok: true, text, size, mtimeMs }
 *                                           | { ok: false, why: 'too-large', size, limit }
 *                                           | { ok: false, why: 'binary', size }
 *                                           | { ok: false, why: 'gone' | 'not-a-file' }
 *                                           | { ok: false, why: 'unreadable', error }
 *   statRepoFile(abs)                      -> { ok: true, size, mtimeMs } | { ok: false, why }
 *
 * `abs` has ALREADY passed host/repo-guard.js; this module only reads.
 *
 * OVER 2 MB, OR A NUL BYTE IN THE FIRST 8 KB: nothing is decoded and the page offers Show in Explorer
 * instead. The same file handle does the stat, the sniff and the read (no stat-then-open gap), and the read
 * asks for one byte more than the cap, so a file that grew in between is "too large" and never silently
 * truncated text. The handle is closed on every path out.
 *
 * Decoding is lenient UTF-8: a Latin-1 file shows replacement characters rather than failing. A leading BOM
 * is dropped (it isn't a character the reader should draw). UTF-16 files carry NUL bytes and so read as
 * binary, which is the honest answer for a reader that only does UTF-8.
 */
const fsp = require('fs/promises');

const MAX_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const CHUNK = 256 * 1024;

function failure(err) {
  if (err && err.code === 'ENOENT') return { ok: false, why: 'gone' };
  return { ok: false, why: 'unreadable', error: (err && err.message) || String(err) };
}

async function readRepoFile(abs, { fsApi = fsp, maxBytes = MAX_BYTES } = {}) {
  let fh;
  try {
    fh = await fsApi.open(abs, 'r');
  } catch (err) {
    return failure(err);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, why: 'not-a-file' };
    if (st.size > maxBytes) return { ok: false, why: 'too-large', size: st.size, limit: maxBytes };

    // Read in chunks, one byte past the cap at most, instead of allocating the cap for every tiny file.
    const chunks = [];
    let got = 0;
    while (got <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(CHUNK, maxBytes + 1 - got));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, got);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      got += bytesRead;
    }
    if (got > maxBytes) return { ok: false, why: 'too-large', size: got, limit: maxBytes };
    const buf = Buffer.concat(chunks, got);
    if (buf.subarray(0, Math.min(got, SNIFF_BYTES)).includes(0)) return { ok: false, why: 'binary', size: got };

    let text = buf.toString('utf8', 0, got);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text, size: got, mtimeMs: st.mtimeMs };
  } catch (err) {
    return failure(err);
  } finally {
    try { await fh.close(); } catch { /* already closed */ }
  }
}

async function statRepoFile(abs, { fsApi = fsp } = {}) {
  try {
    const st = await fsApi.stat(abs);
    if (!st.isFile()) return { ok: false, why: 'not-a-file' };
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    return failure(err);
  }
}

module.exports = { readRepoFile, statRepoFile, MAX_BYTES, SNIFF_BYTES };
