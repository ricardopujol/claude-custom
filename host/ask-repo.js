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

/** The prompt for a question and its top chunks (best first), and the ranges it really contains. */
function buildPrompt(question, top) {
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
  return { prompt: parts.join('\n\n') + `\n\nQuestion: ${question}\nAnswer with file:line citations.`, sent };
}

function createAskRepo({
  index, ollama, k = DEFAULT_K, staleWaitMs = STALE_WAIT_MS, buildProbeMs = BUILD_PROBE_MS, now = Date.now,
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

  async function ask(worktree, question) {
    const q = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    if (!q) return { ok: false, reason: 'empty-question' };
    const started = now();

    let data = await index.load(worktree);
    const progress = () => index.progress(worktree);
    if (!data || progress().partial) {
      const partial = Boolean(data);
      if (!index.isRunning(worktree)) {
        const w = await startAndWatch(worktree, buildProbeMs);
        if (w.outcome === 'failed') return { ok: false, reason: 'index-failed', error: w.error, partial };
        if (w.outcome === 'done') data = index.get(worktree) || null;
        if (data && progress().partial) data = null; // still partial: not answerable
      }
      if (!data || progress().partial) return { ok: false, reason: 'index-building', progress: progress(), partial };
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
    const top = hybridRank({ question: q, queryVec, entries, k }).map(id => refs[id]);
    const keywordOnly = queryVec === null || entries.some(e => e.vec === null);
    const extra = { keywordOnly, stale, ...(refreshError ? { refreshError } : {}) };

    if (!top.length) return { ok: false, reason: 'no-matches', ...extra };
    const { prompt, sent } = buildPrompt(q, top);
    if (!status.ok) return { ok: false, reason: status.reason, ...(status.model ? { model: status.model } : {}), hits: toHits(sent), ...extra };

    const g = await ollama.generate({ system: SYSTEM, prompt });
    if (!g.ok) {
      return { ok: false, reason: g.reason, ...(g.model ? { model: g.model } : {}), ...(g.status ? { status: g.status } : {}), hits: toHits(sent), ...extra };
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

  return { ask, status };
}

module.exports = { createAskRepo, buildPrompt, SYSTEM, DEFAULT_K, PROMPT_MAX_CHARS };
