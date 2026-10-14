'use strict';
/**
 * "Ask the repo" (BACKLOG #33, DESIGN_ASK_REPO.md): a question about one worktree, answered by a LOCAL model from the
 * top chunks of that worktree's index, with citations that are checked to exist.
 *
 *   createAskRepo({ index, ollama, k, staleWaitMs, buildProbeMs }).ask(worktree, question)
 *     -> { ok: true, text, citations, dropped, sources, model, label: 'local model', keywordOnly, stale, refreshError?, ms }
 *      | { ok: false, reason: 'empty-question' | 'index-building' | 'index-failed' | 'no-matches' | 'ollama-down'
 *                            | 'model-missing' | 'timeout' | 'http' | 'bad-reply', model?, progress?, partial?, error?, hits? }
 *   .status(worktree) -> { state: 'none' | 'building' | 'partial' | 'failed' | 'ready', files, chunks, builtAt, keywordOnly, model, progress, error? }
 *
 * HONESTY (BACKLOG #33): every failure names its reason; there is no silent empty answer. When the model can't answer but
 * the index can still search (Ollama down, model missing, a timeout), the top file:line `hits` come back with the failure,
 * so the person still gets somewhere to look. The answer is labelled 'local model' so it's never taken for Claude's.
 * A build that FAILED is `index-failed` with the reason (git missing, not a repository...), never `index-building` forever; a
 * refresh that failed over a saved index answers from it marked `stale` with `refreshError`; an index only partly built
 * (an interrupted first build) is `index-building` with `partial: true` while the build resumes, never answered from.
 *
 * k=8 (2026-10-03 measurement: hybrid at k=8 found the right chunk for 10/10 questions with tests left out; k=5 for 9/10).
 * A refresh runs before each question so a file edited a minute ago is searchable; if it outlasts `staleWaitMs` the
 * question is answered from the saved index and marked `stale`, so a big re-embed never holds a question hostage.
 *
 * THE PROMPT IS BOUNDED (PR #136 Dexter D5): every excerpt is cut to a line cap and a chunk cap, and excerpts stop when the
 * total budget is spent, so one 200 KB line can't push the question and instructions out of the 8192-token window. The range
 * in each excerpt's header is what was actually SENT, and citations are checked against exactly those ranges (D4).
 */

const { tokenize, hybridRank } = require('./ask-retrieve');
const { extractCitations } = require('./ask-citations');

const SYSTEM = 'You answer questions about a code repository using ONLY the numbered excerpts provided. Cite every claim as file:line, '
  + 'using the full path from the excerpt header and the line numbers printed in the excerpt (written like path/to/file.ext:123). '
  + 'If the excerpts do not contain the answer, say so. Be brief: at most 6 sentences or bullets.';
const MAX_QUESTION_CHARS = 500;
const DEFAULT_K = 8;
const STALE_WAIT_MS = 15_000;
const BUILD_PROBE_MS = 1_500;
const RETRY_AFTER_MS = 30_000; // a build that failed is named, not restarted, for this long
const LINE_CAP = 300;
const CHUNK_CAP = 2_000;
const EXCERPT_BUDGET = 12_000;
// excerpts + system prompt + question + the fixed words around them. 12,000 chars is well inside 8192 tokens even at 2 chars/token.
const PROMPT_MAX_CHARS = EXCERPT_BUDGET + 1_500;

/** The excerpt text for one chunk, within the caps, and the last line that made it in. */
function renderChunk(rel, c) {
  const out = [];
  let used = 0;
  let last = c.start - 1;
  const lines = c.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const shown = lines[i].length > LINE_CAP ? lines[i].slice(0, LINE_CAP) + ' ...[line cut]' : lines[i];
    const row = `${c.start + i}: ${shown}`;
    if (out.length && used + row.length + 1 > CHUNK_CAP) break;
    out.push(row);
    used += row.length + 1;
    last = c.start + i;
  }
  return { last, body: `### ${rel}:${c.start}-${last}\n${out.join('\n')}` };
}

/** The excerpt text for the top chunks (best first), within the budget, and the ranges it really contains. */
function buildExcerpts(top) {
  const parts = [];
  const sent = [];
  let used = 0;
  for (const { rel, chunk } of top) {
    const r = renderChunk(rel, chunk);
    if (sent.length && used + r.body.length + 2 > EXCERPT_BUDGET) break;
    parts.push(r.body);
    sent.push({ file: rel, start: chunk.start, end: r.last });
    used += r.body.length + 2;
  }
  return { body: parts.join('\n\n'), sent };
}

/** The prompt for a question and its top chunks (best first), and the ranges it really contains. */
function buildPrompt(question, top) {
  const { body, sent } = buildExcerpts(top);
  return { prompt: body + `\n\nQuestion: ${question}\nAnswer with file:line citations.`, sent };
}

function createAskRepo({
  index, ollama, k = DEFAULT_K, staleWaitMs = STALE_WAIT_MS, buildProbeMs = BUILD_PROBE_MS, retryAfterMs = RETRY_AFTER_MS, now = Date.now,
} = {}) {
  // Tokens per chunk are worked out once per index object (a refresh makes a new one), not per question.
  const prepared = new WeakMap();
  function prepare(data) {
    let p = prepared.get(data);
    if (p) return p;
    const entries = [];
    const refs = [];
    for (const f of data.files) {
      for (const c of f.chunks) {
        entries.push({ id: refs.length, tokens: tokenize(`${f.rel} ${c.text}`), vec: c.vec });
        refs.push({ rel: f.rel, chunk: c });
      }
    }
    p = { entries, refs };
    prepared.set(data, p);
    return p;
  }

  const message = (err) => (err && err.message) || String(err);
  const toHits = (sent) => sent.map(({ file, start, end }) => ({ file, line: start, endLine: end }));

  /** Start a refresh and say how it went: 'failed' (with the error), 'done', or 'late' (still running after `ms`). */
  async function startAndWatch(worktree, ms) {
    const run = index.refresh(worktree).then(() => ({ outcome: 'done' }), (err) => ({ outcome: 'failed', error: message(err) }));
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r({ outcome: 'late' }), ms); });
    const result = await Promise.race([run, late]);
    clearTimeout(timer);
    return result;
  }

  /**
   * Is there an index to answer from? { ok: true, data, stale, refreshError? } or { ok: false, failure } where `failure` is the
   * reply ask() gives: 'index-failed' (named, retried only after a backoff) or 'index-building' (with its progress).
   */
  async function ready(worktree) {
    let data = await index.load(worktree);
    const progress = () => index.progress(worktree);
    if (!data || progress().partial) {
      const partial = Boolean(data);
      if (!index.isRunning(worktree)) {
        // A build that already failed (even long after the watch below ended) is named, and only retried after a backoff.
        const p = progress();
        if (p.error && typeof p.failedAt === 'number' && now() - p.failedAt < retryAfterMs) {
          return { ok: false, failure: { ok: false, reason: 'index-failed', error: p.error, partial } };
        }
        const w = await startAndWatch(worktree, buildProbeMs);
        if (w.outcome === 'failed') return { ok: false, failure: { ok: false, reason: 'index-failed', error: w.error, partial } };
        if (w.outcome === 'done') data = index.get(worktree) || null;
        if (data && progress().partial) data = null; // still partial: not answerable
      }
      if (!data || progress().partial) return { ok: false, failure: { ok: false, reason: 'index-building', progress: progress(), partial } };
    }

    // The newest state of the files, unless that takes too long or fails.
    let stale = false;
    let refreshError;
    if (!index.isRunning(worktree)) {
      const w = await startAndWatch(worktree, staleWaitMs);
      if (w.outcome === 'failed') { stale = true; refreshError = w.error; } else if (w.outcome === 'late') stale = true;
    } else {
      stale = true;
    }
    data = index.get(worktree) || data;
    return { ok: true, data, stale, ...(refreshError ? { refreshError } : {}) };
  }

  /** The top chunks for `q` over `data`: keyword + vector when the embedder answers. Also the model status, asked once. */
  async function search(data, q, want) {
    const status = await ollama.check();
    const embedUp = status.ok ? status.embed !== false : status.reason === 'model-missing' && status.embed === true;
    // Vectors of one model are meaningless against another's (PR #136 D7): a mismatch is keywords only, said so.
    const sameModel = !ollama.embedModel || !data.embedModel || ollama.embedModel === data.embedModel;

    let queryVec = null;
    if (embedUp && sameModel) {
      const e = await ollama.embed([q]);
      if (e.ok) queryVec = e.vectors[0];
    }
    const { entries, refs } = prepare(data);
    const top = hybridRank({ question: q, queryVec, entries, k: want }).map(id => refs[id]);
    const keywordOnly = queryVec === null || entries.some(e => e.vec === null);
    return { status, top, keywordOnly };
  }

  async function ask(worktree, question) {
    const q = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    if (!q) return { ok: false, reason: 'empty-question' };
    const started = now();

    const rdy = await ready(worktree);
    if (!rdy.ok) return rdy.failure;
    const { data, stale, refreshError } = rdy;

    const { status, top, keywordOnly } = await search(data, q, k);
    const extra = { keywordOnly, stale, ...(refreshError ? { refreshError } : {}) };

    if (!top.length) return { ok: false, reason: 'no-matches', ...extra };
    const { prompt, sent } = buildPrompt(q, top);
    if (!status.ok) return { ok: false, reason: status.reason, ...(status.model ? { model: status.model } : {}), hits: toHits(sent), ...extra };

    const g = await ollama.generate({ system: SYSTEM, prompt });
    if (!g.ok) {
      return { ok: false, reason: g.reason, ...(g.model ? { model: g.model } : {}), ...(g.status ? { status: g.status } : {}), ...(g.detail ? { detail: g.detail } : {}), hits: toHits(sent), ...extra };
    }
    // Citations are checked against what the model was SHOWN: only files and line ranges that were in the prompt.
    const ranges = new Map();
    const lineCounts = new Map();
    for (const s of sent) {
      if (!ranges.has(s.file)) ranges.set(s.file, []);
      ranges.get(s.file).push([s.start, s.end]);
      lineCounts.set(s.file, data.files.find(f => f.rel === s.file).lines);
    }
    const { citations, dropped } = extractCitations(g.text, lineCounts, { ranges });
    return {
      ok: true, text: g.text, citations, dropped,
      sources: toHits(sent), model: ollama.answerModel, label: 'local model', ...extra, ms: Math.max(0, now() - started),
    };
  }

  /**
   * The excerpts to explain a SELECTION or to preview a question's places (BACKLOG #33): the best chunks for `query`, the selection's own
   * lines left out (`exclude` = { file, start, end }), as the numbered text a prompt carries.
   *   -> { ok: true, body, sent, lineCounts, keywordOnly, stale, refreshError?, ollamaStatus }   (no match is ok, with an empty body)
   *    | the same failure ask() gives while the index isn't ready ('index-building' with progress, 'index-failed')
   * `wantK` is how many chunks to offer (default k). Pure retrieval: no model is asked to write anything.
   */
  async function excerptsFor(worktree, query, { exclude, k: wantK } = {}) {
    const q = typeof query === 'string' ? query.trim().slice(0, MAX_QUESTION_CHARS) : '';
    if (!q) return { ok: false, reason: 'empty-question' };
    const rdy = await ready(worktree);
    if (!rdy.ok) return rdy.failure;
    const { data, stale, refreshError } = rdy;
    const want = Number.isInteger(wantK) && wantK > 0 ? wantK : k;
    const { status, top, keywordOnly } = await search(data, q, want + 4);
    const overlaps = (r) => !!exclude && r.rel === exclude.file && r.chunk.start <= exclude.end && r.chunk.end >= exclude.start;
    const { body, sent } = buildExcerpts(top.filter(r => !overlaps(r)).slice(0, want));
    const lineCounts = new Map();
    for (const s of sent) lineCounts.set(s.file, data.files.find(f => f.rel === s.file).lines);
    return { ok: true, body, sent, lineCounts, keywordOnly, stale, ...(refreshError ? { refreshError } : {}), ollamaStatus: status };
  }

  async function status(worktree) {
    const data = await index.load(worktree);
    const progress = index.progress(worktree);
    const error = progress.error ? { error: progress.error } : {};
    const state = progress.state === 'building' && !data ? 'building' : (progress.state === 'building' ? (progress.partial ? 'partial' : 'ready') : progress.state);
    if (!data) return { state: state === 'ready' ? 'none' : state, files: 0, chunks: 0, builtAt: null, keywordOnly: false, model: ollama.answerModel, progress, ...error };
    const chunks = data.files.reduce((n, f) => n + f.chunks.length, 0);
    return {
      state, files: data.files.length, chunks, builtAt: data.builtAt,
      keywordOnly: data.files.some(f => f.chunks.some(c => c.vec === null)), model: ollama.answerModel, progress, ...error,
    };
  }

  return { ask, status, excerptsFor };
}

module.exports = { createAskRepo, buildPrompt, buildExcerpts, SYSTEM, DEFAULT_K, PROMPT_MAX_CHARS };
