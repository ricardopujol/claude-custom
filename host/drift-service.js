'use strict';
/**
 * "Docs drift" (BACKLOG #39 job 2): after a merge into develop, the local model reads the merge's diff next to the build
 * log's "Now" and the design docs the diff touches, and flags sentences the diff now contradicts. The flags are NOTES for
 * a person to look at; nothing here ever edits a document.
 *
 *   createDriftService({ git, readDocs, ollama, store, slot, now, broadcast, log, limit })
 *     .tick()         -> Promise   one look: has develop moved? is there a merge to read? Never throws, never overlaps itself.
 *     .snapshot()     -> { notes: [note], off: null | { reason, model?, detail? } }
 *     .dismiss(id)    -> { ok: true } | { ok: false, error }
 *   broadcast({ type: 'docs-drift', ...snapshot })    only when what a window would see changed
 *   analyzeMerge({ git, readDocs, ollama }, { sha, subject }) -> { ok: true, flags, shown, reply } | { ok: false, reason }
 *       the one analysis, shared with the evaluation script (verify/eval-docs-drift.js); it writes nothing.
 *
 * SEAMS. git: host/drift-git.js. readDocs() -> { buildLog: text | null, docs: [{ rel, text }] } (host/drift-docs-fs.js, read-only).
 * ollama: host/ask-ollama.js (check, generate, answerModel). store: host/drift-store.js. slot: host/summary-slot.js on the
 * SAME lock file as the "where are we" summaries, so the one GPU does one job at a time across every host and tab.
 *
 * WHEN. The first look at a project only records where develop is: merges from before the app watched are not read. After
 * that, develop moving to a new tip means: the merge commits (first-parent) since the last mark, the newest `limit` of them,
 * oldest first. A move with no merge in it (a direct commit) just moves the mark.
 *
 * THE QUEUE DROPS WHEN BUSY. A tick that finds the last one still running does nothing; a held GPU slot means no job now (the
 * mark stays where it was, so the merge is picked up on a later tick). Nothing is stacked up behind a busy GPU, and an older
 * merge than the newest `limit` is not read after a long gap.
 *
 * SAYING WHAT IS WRONG (never a silent empty state). `off`: ollama-down, model-missing (never pulled from here), failed (it
 * answered, but not usefully: `detail`), no-develop (no develop branch to watch), no-docs (no documentation folder). While
 * Ollama is off the mark does not move, so the merge is read as soon as it is back; it is asked again at most once a minute
 * (RETRY_MS). A reply that is not a list at all is said (`bad-reply`) and that merge is let go, so it is not retried forever.
 */

const { changedFilesOf, buildLogNow, candidateDocs, buildPrompt, parseReply } = require('./drift-text');

const RETRY_MS = 60_000;
const TICK_MS = 60_000;
const DEFAULT_LIMIT = 3;
// Room for three flags with their quoted lines; the default 350 cut a real reply off mid-list (measured on a real merge).
const REPLY_TOKENS = 700;

/** Read one merge and ask the model about it. Writes nothing. */
async function analyzeMerge({ git, readDocs, ollama }, { sha, subject }) {
  const [diff, docs] = await Promise.all([git.diff(sha), readDocs()]);
  if (!docs || (!docs.buildLog && !(Array.isArray(docs.docs) && docs.docs.length))) return { ok: false, reason: 'no-docs' };
  const candidates = candidateDocs({ changedFiles: changedFilesOf(diff), docs: docs.docs || [] });
  const { system, prompt, diff: shownDiff, docs: shown } = buildPrompt({ subject, sha, diff, now: buildLogNow(docs.buildLog), docs: candidates });
  const res = await ollama.generate({ system, prompt, numPredict: REPLY_TOKENS });
  if (!res.ok) return { ok: false, reason: res.reason, ...(res.model ? { model: res.model } : {}) };
  const flags = parseReply(res.text, shown, shownDiff);
  if (flags === null) return { ok: false, reason: 'bad-reply' };
  return { ok: true, flags, shown, reply: res.text };
}

function createDriftService({
  git, readDocs, ollama, store, slot, now = Date.now, broadcast = () => {}, log = () => {}, limit = DEFAULT_LIMIT,
}) {
  let gitOff = null;
  let jobOff = null;
  let retryAt = 0;
  let busy = null;
  let lastSent = null;

  const model = () => ollama.answerModel;
  const message = (err) => (err && err.message) || String(err);

  function snapshot() {
    const off = gitOff || jobOff;
    return { notes: store.open().map(n => ({ ...n })), off: off ? { ...off } : null };
  }

  function publish() {
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (key === lastSent) return;
    lastSent = key;
    broadcast({ type: 'docs-drift', ...snap });
  }

  function failOff(reason, detail) {
    if (reason === 'ollama-down') return { reason: 'ollama-down', model: model() };
    if (reason === 'model-missing') return { reason: 'model-missing', model: model() };
    return { reason: 'failed', model: model(), detail: typeof detail === 'string' ? detail : reason };
  }

  const setJobOff = (off) => { jobOff = off; publish(); };

  async function run() {
    let head;
    try {
      head = await git.head();
    } catch (err) {
      gitOff = { reason: 'failed', detail: message(err) };
      publish();
      return;
    }
    if (head === null) { gitOff = { reason: 'no-develop' }; publish(); return; }
    gitOff = null;

    const st = store.read();
    if (st.processed === null) { store.setProcessed(head); publish(); return; }
    if (st.processed === head) { publish(); return; }
    if (now() < retryAt) return;

    let pending;
    try {
      pending = await git.merges(st.processed, head, { limit });
    } catch (err) {
      gitOff = { reason: 'failed', detail: message(err) };
      publish();
      return;
    }
    if (pending === null) { log('[drift] develop was rewound; following it without reading'); store.setProcessed(head); publish(); return; }
    if (pending.length === 0) { store.setProcessed(head); publish(); return; }

    const health = await ollama.check();
    if (!health.ok) { retryAt = now() + RETRY_MS; setJobOff(failOff(health.reason)); return; }

    let mark = st.processed;
    for (const merge of pending) {
      if (!slot.tryAcquire()) return;                 // the GPU is busy: dropped for now, the mark stays
      try {
        if (store.read().processed !== mark) return;  // another host got to it while this one waited
        const r = await analyzeMerge({ git, readDocs, ollama }, merge);
        if (!r.ok && r.reason === 'no-docs') { retryAt = now() + RETRY_MS; setJobOff({ reason: 'no-docs' }); return; }
        if (!r.ok && r.reason !== 'bad-reply') { retryAt = now() + RETRY_MS; setJobOff(failOff(r.reason)); return; }
        if (r.ok) {
          const put = store.addNotes(merge, r.flags, now());
          if (!put.ok) log('[drift] could not save notes:', put.error);
          jobOff = null;
        } else {
          log('[drift] the model did not answer with a list for', merge.sha.slice(0, 12));
          jobOff = failOff('bad-reply', 'bad-reply');
        }
        const moved = store.setProcessed(merge.sha);
        if (!moved.ok) { log('[drift] could not save the mark:', moved.error); retryAt = now() + RETRY_MS; publish(); return; }
        mark = merge.sha;
        publish();
      } finally {
        slot.release();
      }
    }
    store.setProcessed(head);
    publish();
  }

  async function tick() {
    if (busy) return busy;
    busy = run()
      .catch((err) => {
        log('[drift] tick failed:', message(err));
        retryAt = now() + RETRY_MS;
        setJobOff({ reason: 'failed', model: model(), detail: 'error' });
      })
      .finally(() => { busy = null; });
    return busy;
  }

  function dismiss(id) {
    const r = store.dismiss(id);
    publish();
    return r;
  }

  lastSent = JSON.stringify(snapshot());
  return { tick, snapshot, dismiss };
}

module.exports = { createDriftService, analyzeMerge, RETRY_MS, TICK_MS, DEFAULT_LIMIT, REPLY_TOKENS };
