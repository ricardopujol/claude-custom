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
 * (RETRY_MS). A reply that is not a list at all is retried like a git failure and, after MAX_ATTEMPTS, the merge is let go, so it is not retried forever. A merge that
 * fails for its OWN reasons (its diff can't be produced, the model times out on it, a 500) is tried MAX_ATTEMPTS times and then let go and
 * said, so it can't hold the shared GPU slot every minute for good. The off line is cleared on every path that finds nothing left to do,
 * including when another host read the merge. A project with no documents is said once and costs no diff, no model and no slot. A notes
 * file that exists but can't be read is not a first look: nothing is marked until it can be read.
 */

const { isInfraError } = require('./drift-git');
const { KEEP_ALIVE_BACKGROUND } = require('./ask-ollama');
const { changedFilesOf, buildLogNow, candidateDocs, buildPrompt, parseReply } = require('./drift-text');

const RETRY_MS = 60_000;
const TICK_MS = 60_000;
const DEFAULT_LIMIT = 3;
// Room for three flags with their quoted lines; the default 350 cut a real reply off mid-list (measured on a real merge).
const REPLY_TOKENS = 700;
// How long the model gets per merge. One job (a 20 s diff at worst plus this) must fit inside the GPU slot's stale time
// (host/summary-slot.js, test/drift-service.test.js), and the evaluation script uses the same number so it measures what ships.
const GENERATE_TIMEOUT_MS = 60_000;
// A merge that fails for ITS OWN reasons (git answers with an exit status for its diff) is let go after this many tries, so it can
// never hold the shared GPU slot every minute for good (PR #153 Dexter 1). Nothing infrastructural ever counts (R2-1): a git that was
// killed or timed out, a missing git, Ollama down or slow or answering 5xx, a busy GPU. Those wait, however long they last.
// A merge that is let go is recorded as a NOTE (LET_GO_DOC), so it is shown on every window until dismissed (R2-2).
const MAX_ATTEMPTS = 3;
const LET_GO_DOC = '(merge not checked)';

/** Read one merge and ask the model about it. Writes nothing. `docs` may be handed in when the caller has just read them. */
async function analyzeMerge({ git, readDocs, ollama, docs: given }, { sha, subject }) {
  const [diff, docs] = await Promise.all([git.diff(sha), given || readDocs()]);
  if (!docs || (!docs.buildLog && !(Array.isArray(docs.docs) && docs.docs.length))) return { ok: false, reason: 'no-docs' };
  const candidates = candidateDocs({ changedFiles: changedFilesOf(diff), docs: docs.docs || [] });
  const { system, prompt, diff: shownDiff, docs: shown } = buildPrompt({
    subject, sha, diff, now: buildLogNow(docs.buildLog), nowRel: docs.buildLogName || undefined, docs: candidates,
  });
  const res = await ollama.generate({ system, prompt, numPredict: REPLY_TOKENS, keepAlive: KEEP_ALIVE_BACKGROUND, neverShorten: true });
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
  const attempts = new Map();     // merge sha -> failed tries in this host
  let lastNotes = [];             // the last list the notes file really gave, kept on screen while it can't be read (R2-7)

  const model = () => ollama.answerModel;
  const message = (err) => (err && err.message) || String(err);

  function snapshot() {
    const st = store.read();
    if (!st.unreadable) lastNotes = st.notes.filter(n => !n.dismissed).sort((a, b) => b.at - a.at);
    // An unreadable file is not an empty one: the last good list stays, and the line says why it may be out of date.
    const off = gitOff || jobOff || (st.unreadable ? { reason: 'failed', detail: 'the notes file is unreadable right now' } : null);
    return { notes: lastNotes.map(n => ({ ...n })), off: off ? { ...off } : null };
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
  /** Nothing is waiting to be read, so whatever this host last complained about (Ollama, a model, a file) no longer matters. */
  const settled = () => { jobOff = null; publish(); };
  const holdOff = (off) => { retryAt = now() + RETRY_MS; setJobOff(off); };

  /** A merge that was given up on, kept as a note so it is not lost with the next tick. */
  function letGo(merge, why) {
    log('[drift] letting go of', merge.sha.slice(0, 12), ':', why);
    const put = store.addNotes(merge, [{ doc: LET_GO_DOC, sentence: `This merge was not checked: ${merge.subject || merge.sha.slice(0, 12)}`, why }], now());
    if (!put.ok) log('[drift] could not save the let-go note:', put.error);
    jobOff = null;
  }

  /** One merge, under the GPU slot. -> 'next' | 'stop' */
  async function processMerge(merge, mark, docs) {
    if (!slot.tryAcquire()) return 'stop';                       // the GPU is busy: dropped for now, the mark stays
    try {
      if (store.read().processed !== mark) return 'stop';        // another host got to it while this one waited
      let r;
      let thrown = null;
      try {
        r = await analyzeMerge({ git, readDocs, ollama, docs }, merge);
      } catch (err) {
        thrown = message(err);
        log('[drift] could not read merge', merge.sha.slice(0, 12), ':', thrown);
        // a git that was killed, timed out, is missing or ran out of buffer says nothing about THIS merge: wait, never count
        if (isInfraError(err)) { holdOff(failOff('error')); return 'stop'; }
        r = { ok: false, reason: 'error' };
      }
      if (!r.ok && r.reason === 'no-docs') { holdOff({ reason: 'no-docs' }); return 'stop'; }
      // The project's own condition, not this merge's: it waits, and is never held against the merge.
      if (!r.ok && (r.reason === 'ollama-down' || r.reason === 'model-missing')) { holdOff(failOff(r.reason)); return 'stop'; }
      // The model timing out or answering 5xx, or any other reason Ollama gives, is the machine's condition, not this merge's: it waits.
      if (!r.ok && r.reason !== 'bad-reply' && r.reason !== 'error') { holdOff(failOff(r.reason)); return 'stop'; }
      // The merge's OWN failures count: git refusing its diff, or the model answering with something that is not a list.
      if (!r.ok) {
        const n = (attempts.get(merge.sha) || 0) + 1;
        if (n < MAX_ATTEMPTS) { attempts.set(merge.sha, n); holdOff(failOff(r.reason === 'bad-reply' ? 'bad-reply' : 'error')); return 'stop'; }
        attempts.delete(merge.sha);
        letGo(merge, r.reason === 'bad-reply' ? `the model did not answer with a list ${n} times` : `git refused its diff ${n} times (${thrown})`);
      } else if (r.ok) {
        const put = store.addNotes(merge, r.flags, now());
        if (!put.ok) log('[drift] could not save notes:', put.error);
        jobOff = null;
      }
      const moved = store.setProcessed(merge.sha);
      if (!moved.ok) { log('[drift] could not save the mark:', moved.error); holdOff(jobOff); return 'stop'; }
      attempts.delete(merge.sha);
      publish();
      return 'next';
    } finally {
      slot.release();
    }
  }

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
    // A file that EXISTS but can't be read is not a first look and not an empty store: leave everything as it is.
    if (st.unreadable) { setJobOff({ reason: 'failed', detail: 'the notes file is unreadable right now' }); return; }
    if (st.processed === null) { store.setProcessed(head); settled(); return; }
    if (st.processed === head) { settled(); return; }
    if (now() < retryAt) return;

    let pending;
    try {
      pending = await git.merges(st.processed, head, { limit });
    } catch (err) {
      gitOff = { reason: 'failed', detail: message(err) };     // a timeout or a missing git: the mark stays, it is tried again
      publish();
      return;
    }
    if (pending === null) { log('[drift] develop was rewound; following it without reading'); store.setProcessed(head); settled(); return; }
    if (pending.length === 0) { store.setProcessed(head); settled(); return; }

    // The documents are a fact about the project, not about a merge: with none there is no diff to read, no model to ask and no GPU slot to hold.
    const docs = await readDocs();
    if (!docs || (!docs.buildLog && !(Array.isArray(docs.docs) && docs.docs.length))) { setJobOff({ reason: 'no-docs' }); return; }

    const health = await ollama.check();
    if (!health.ok) { holdOff(failOff(health.reason)); return; }

    let mark = st.processed;
    for (const merge of pending) {
      if (await processMerge(merge, mark, docs) === 'stop') return;
      mark = merge.sha;
    }
    store.setProcessed(head);
    publish();
  }

  async function tick() {
    if (busy) return busy;
    busy = run()
      .catch((err) => {
        log('[drift] tick failed:', message(err));
        holdOff({ reason: 'failed', model: model(), detail: 'error' });
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

module.exports = { createDriftService, analyzeMerge, RETRY_MS, TICK_MS, DEFAULT_LIMIT, REPLY_TOKENS, GENERATE_TIMEOUT_MS, MAX_ATTEMPTS };
