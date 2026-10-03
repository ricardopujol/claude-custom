'use strict';
/**
 * The "where are we" summary for ONE session (backlog #39 job 1, documentation/DESIGN_SLAVE_MODE_SUMMARY.md): it
 * watches the session's transcript, and when new turns have settled it asks the local model for a short summary and
 * keeps it. One host runs per tab, so there is one of these per tab.
 *
 *   createSummaryService({ now, sessionId, transcriptFile, stat, readTail, ollama, store, scheduler, slot, onBattery,
 *                          broadcast, log, model }) -> { tick() -> Promise, snapshot() }
 *   snapshot() -> { summary: { text, model, at, turnsSeen, stale } | null, off: null | { reason, model, detail? } }
 *   broadcast({ type: 'summary', ...snapshot() })   only when what a window would see changed
 *
 * `tick()` is called every few seconds by the host. A tick is cheap: ONE stat of the transcript. A job (a read of the
 * tail, a model call) only starts for a tab with new turns, after the scheduler's quiet period, one at a time per
 * host and, through the slot, one at a time across hosts; a job that finds the newest message is the one the stored
 * summary was built from (a transcript that grew only by tool calls) costs no GPU and gives the cap back.
 *
 * SAYING WHAT IS WRONG (never a silent empty state). `off` is why there's no fresh summary:
 *   ollama-down    Ollama isn't answering         model-missing   the model isn't installed (never pulled from here)
 *   failed         it answered, but not with a summary (`detail` says how)
 * The last good summary stays in the snapshot beside it. Ollama is asked whether it's there once at the start, then
 * only before a job; while it is off it's asked again once a minute (RETRY_MS), so recovery is noticed without any
 * new typing and a dead Ollama is never hammered.
 *
 * READ-ONLY (test/summary-readonly.test.js reads this file's source): it only opens a transcript for reading, writes
 * only through the injected store and slot, never types into a session. The conversation is never logged.
 *
 * A tick never throws: a failed read or job is logged, held off for a minute, and shown as `failed`.
 */

const fs = require('fs');
const { flattenTranscript, buildPrompt } = require('./summary-text');
const { DEFAULT_MODEL } = require('./summary-ollama');

const RETRY_MS = 60_000;
const SLOT_RETRY_MS = 5_000;
const TICK_MS = 5_000;
const TAIL_SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const ENOUGH_CHARS = 4_000;
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

/** The last `bytes` of a file as text, starting on a line boundary; null when it can't be read. Read-only. */
function readTailFile(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return null;              // a directory opens on Windows and reads as empty: that is not "no text"
    const size = info.size;
    if (size <= bytes) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8', 0, n);
    }
    const want = bytes + 1;                       // one byte before the window says whether the cut falls on a line start
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, size - want);
    const text = buf.toString('utf8', 0, n);
    if (text.charCodeAt(0) === 10) return text.slice(1);
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/**
 * What was appended to a file at and after `offset` (at most the last `maxBytes` of it), as text starting on a line
 * boundary; null when it can't be read. Read-only. A change a tick sees is usually a line or two.
 */
function readFromFile(file, offset, maxBytes = 1024 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return null;
    const size = info.size;
    if (size <= offset) return '';
    const start = Math.max(offset, size - maxBytes);
    const from = Math.max(0, start - 1);              // one byte before says whether the cut falls on a line start
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8', 0, n);
    if (from === start) return text;                  // from the very start of the file
    if (text.charCodeAt(0) === 10) return text.slice(1);
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function createSummaryService({
  now = Date.now, sessionId, transcriptFile, stat = statFile, readTail = readTailFile, readFrom = readFromFile,
  ollama, store, scheduler, slot, onBattery = async () => null, broadcast = () => {}, log = () => {}, model = DEFAULT_MODEL,
}) {
  let current = null;        // the session being watched
  let seen = null;           // the transcript's last size:mtime
  let seenSize = null;       // ...and its size, so a change can be read from where the last look ended
  let off = null;
  let lastCheckAt = null;
  let busy = null;
  let lastSent = null;
  let lastSlotError = '';

  const sidNow = () => {
    const sid = sessionId();
    return typeof sid === 'string' && SAFE_ID.test(sid) ? sid : null;
  };

  function snapshot() {
    const sid = sidNow();
    const rec = sid ? store.get(sid) : null;
    return {
      summary: rec ? { text: rec.text, model: rec.model, at: rec.at, turnsSeen: rec.turnsSeen, stale: rec.stale === true } : null,
      off: off ? { ...off } : null,
    };
  }

  lastSent = JSON.stringify(snapshot());

  function publish() {
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (key === lastSent) return;
    lastSent = key;
    broadcast({ type: 'summary', ...snap });
  }

  function setOff(next) {
    off = next;
    publish();
  }

  function offFor(reason, detail) {
    if (reason === 'model-missing') return { reason: 'model-missing', model };
    if (reason === 'unreachable') return { reason: 'ollama-down', model };
    return { reason: 'failed', model, detail: typeof detail === 'string' ? detail : reason };
  }

  /** Watch the transcript: a stat, and the session changing under us. */
  function observe() {
    const sid = sidNow();
    if (sid !== current) {
      if (current !== null) scheduler.forget(current);
      current = sid;
      seen = null;
      seenSize = null;
      publish();
    }
    if (sid === null) return;
    const st = stat(transcriptFile(sid));
    if (!st) return;
    const sig = st.size + ':' + st.mtimeMs;
    if (sig === seen) return;
    seen = sig;
    const prev = seenSize;
    seenSize = st.size;
    // The quiet clock follows main-session TURNS, not bytes (Dexter F1, PR #105): a tool call or result is not one. The
    // first look, and a transcript that shrank (rewritten), can't say what is new, so they count as a turn.
    if (prev === null || st.size < prev) { scheduler.activity(sid, now()); return; }
    const added = readFrom(transcriptFile(sid), prev);
    if (typeof added !== 'string' || flattenTranscript(added).messages.length > 0) scheduler.activity(sid, now());
  }

  async function healthCheck() {
    const c = await ollama.check();
    lastCheckAt = now();
    if (c.ok) {
      if (off && off.reason !== 'failed') setOff(null);
      return true;
    }
    setOff(offFor(c.reason));
    return false;
  }

  function readFlattened(sid) {
    const file = transcriptFile(sid);
    const st = stat(file);
    if (!st) throw new Error('transcript is gone');
    let flat = null;
    for (const bytes of TAIL_SIZES) {
      const text = readTail(file, bytes);
      if (typeof text !== 'string') throw new Error('transcript unreadable');
      flat = flattenTranscript(text);
      if (flat.transcript.length >= ENOUGH_CHARS || st.size <= bytes) break;
    }
    return flat;
  }

  async function job(sid) {
    if (!scheduler.start(sid, now())) return;
    let held = false;
    try {
      if (!(await healthCheck())) { scheduler.fail(sid, now(), RETRY_MS); return; }
      const flat = readFlattened(sid);
      if (flat.newestKey === null) { scheduler.clean(sid, now()); return; }
      const existing = store.get(sid);
      if (existing && existing.newestKey === flat.newestKey) {
        // Nothing new was said since this summary was written: it's still true, so a stale one is confirmed (its age
        // stays the time it was written).
        if (existing.stale) {
          const put = store.put(sid, existing, existing.at);
          if (!put.ok) log('[summary] could not save:', put.error);
        }
        scheduler.clean(sid, now());
        publish();
        return;
      }
      if (!slot.tryAcquire()) {
        // Another host holding it is the ordinary case and says nothing; a slot that can't be made at all is said once.
        const why = slot.lastError();
        if (why && why !== lastSlotError) { lastSlotError = why; log('[summary] GPU slot unavailable:', why); }
        scheduler.fail(sid, now(), SLOT_RETRY_MS);
        return;
      }
      held = true;
      const r = await ollama.summarize(buildPrompt(flat.transcript));
      if (!r.ok) {
        setOff(offFor(r.reason));
        scheduler.fail(sid, now(), RETRY_MS);
        return;
      }
      const put = store.put(sid, { text: r.text, model, turnsSeen: flat.messages.length, newestKey: flat.newestKey }, now());
      if (!put.ok) log('[summary] could not save:', put.error);
      off = null;
      scheduler.finish(sid, now());
      publish();
    } catch (err) {
      log('[summary] job failed:', (err && err.message) || String(err));
      scheduler.fail(sid, now(), RETRY_MS);
      setOff({ reason: 'failed', model, detail: 'error' });
    } finally {
      if (held) slot.release();
    }
  }

  async function run() {
    // Is Ollama there at all? Once at the start, then once a minute only while it is off.
    if (lastCheckAt === null || (off !== null && off.reason !== 'failed' && now() - lastCheckAt >= RETRY_MS)) await healthCheck();
    if (scheduler.ready(now(), {}) === null) return;
    const onBatt = await onBattery();
    const sid = scheduler.ready(now(), { onBattery: onBatt });
    if (sid !== null) await job(sid);
  }

  async function tick() {
    try { observe(); } catch (err) { log('[summary] watch failed:', (err && err.message) || String(err)); }
    if (busy) return busy;
    busy = run()
      .catch((err) => { log('[summary] tick failed:', (err && err.message) || String(err)); })
      .finally(() => { busy = null; });
    return busy;
  }

  return { tick, snapshot };
}

module.exports = { createSummaryService, readTailFile, readFromFile, statFile, RETRY_MS, SLOT_RETRY_MS, TICK_MS, TAIL_SIZES };
