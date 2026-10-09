'use strict';
/**
 * "Ask the repo" (BACKLOG #33, DESIGN_ASK_REPO.md): a question about one worktree, answered by a LOCAL model from the
 * top chunks of that worktree's index, with citations that are checked to exist.
 *
 *   createAskRepo({ index, ollama, k, staleWaitMs }).ask(worktree, question)
 *     -> { ok: true, text, citations, dropped, sources, model, label: 'local model', keywordOnly, stale, ms }
 *      | { ok: false, reason: 'empty-question' | 'index-building' | 'no-matches' | 'ollama-down' | 'model-missing'
 *                            | 'timeout' | 'http' | 'bad-reply', model?, progress?, hits? }
 *   .status(worktree) -> { state, files, chunks, builtAt, keywordOnly, model, progress }
 *
 * HONESTY (BACKLOG #33): every failure names its reason; there is no silent empty answer. When the model can't answer but
 * the index can still search (Ollama down, model missing, a timeout), the top file:line `hits` come back with the failure,
 * so the person still gets somewhere to look. The answer is labelled 'local model' so it's never taken for Claude's.
 *
 * k=8 (2026-10-03 measurement: hybrid at k=8 found the right chunk for 10/10 questions with tests left out; k=5 for 9/10).
 * A refresh runs before each question so a file edited a minute ago is searchable; if it outlasts `staleWaitMs` the
 * question is answered from the saved index and marked `stale`, so a big re-embed never holds a question hostage.
 */

const { tokenize, hybridRank } = require('./ask-retrieve');
const { extractCitations } = require('./ask-citations');

const SYSTEM = 'You answer questions about a code repository using ONLY the numbered excerpts provided. Cite every claim as file:line '
  + '(use the line numbers printed in the excerpts, e.g. host/session-lock.js:217). If the excerpts do not contain the answer, say so. '
  + 'Be brief: at most 6 sentences or bullets.';
const MAX_QUESTION_CHARS = 500;
const DEFAULT_K = 8;
const STALE_WAIT_MS = 15_000;

const render = (rel, c) => `### ${rel}:${c.start}-${c.end}\n${c.text.split('\n').map((l, i) => `${c.start + i}: ${l}`).join('\n')}`;

function createAskRepo({ index, ollama, k = DEFAULT_K, staleWaitMs = STALE_WAIT_MS, now = Date.now } = {}) {
  // Tokens per chunk are worked out once per index object (a refresh makes a new one), not per question.
  const prepared = new WeakMap();
  function prepare(data) {
    let p = prepared.get(data);
    if (p) return p;
    const entries = [];
    const refs = [];
    const lineCounts = new Map();
    for (const f of data.files) {
      lineCounts.set(f.rel, f.lines);
      for (const c of f.chunks) {
        entries.push({ id: refs.length, tokens: tokenize(`${f.rel} ${c.text}`), vec: c.vec });
        refs.push({ rel: f.rel, chunk: c });
      }
    }
    p = { entries, refs, lineCounts };
    prepared.set(data, p);
    return p;
  }

  const hitsOf = (top) => top.map(({ rel, chunk }) => ({ file: rel, line: chunk.start, endLine: chunk.end }));

  async function ask(worktree, question) {
    const q = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    if (!q) return { ok: false, reason: 'empty-question' };
    const started = now();

    let data = await index.load(worktree);
    if (!data) {
      if (!index.isRunning(worktree)) index.refresh(worktree).catch((err) => console.warn('[ask-repo] build failed:', err && err.message));
      return { ok: false, reason: 'index-building', progress: index.progress(worktree) };
    }

    // The newest state of the files, unless that takes too long.
    let stale = false;
    if (!index.isRunning(worktree)) {
      const run = index.refresh(worktree).catch((err) => { console.warn('[ask-repo] refresh failed:', err && err.message); });
      let timer;
      const outcome = await Promise.race([run.then(() => 'done'), new Promise((r) => { timer = setTimeout(() => r('late'), staleWaitMs); })]);
      clearTimeout(timer);
      stale = outcome === 'late';
    } else {
      stale = true;
    }
    data = index.get(worktree) || data;

    const status = await ollama.check();
    const embedUp = status.ok ? status.embed !== false : status.reason === 'model-missing' && status.embed === true;

    let queryVec = null;
    if (embedUp) {
      const e = await ollama.embed([q]);
      if (e.ok) queryVec = e.vectors[0];
    }
    const { entries, refs, lineCounts } = prepare(data);
    const ids = hybridRank({ question: q, queryVec, entries, k });
    const top = ids.map(id => refs[id]);
    const keywordOnly = queryVec === null || entries.some(e => e.vec === null);

    if (!status.ok) {
      return { ok: false, reason: status.reason, ...(status.model ? { model: status.model } : {}), hits: hitsOf(top), keywordOnly, stale };
    }
    if (!top.length) return { ok: false, reason: 'no-matches', keywordOnly, stale };

    const prompt = top.map(({ rel, chunk }) => render(rel, chunk)).join('\n\n') + `\n\nQuestion: ${q}\nAnswer with file:line citations.`;
    const g = await ollama.generate({ system: SYSTEM, prompt });
    if (!g.ok) {
      return { ok: false, reason: g.reason, ...(g.model ? { model: g.model } : {}), ...(g.status ? { status: g.status } : {}), hits: hitsOf(top), keywordOnly, stale };
    }
    const { citations, dropped } = extractCitations(g.text, lineCounts);
    return {
      ok: true, text: g.text, citations, dropped,
      sources: hitsOf(top), model: ollama.answerModel, label: 'local model', keywordOnly, stale, ms: Math.max(0, now() - started),
    };
  }

  async function status(worktree) {
    const data = await index.load(worktree);
    const progress = index.progress(worktree);
    if (!data) return { state: progress.state === 'building' ? 'building' : 'none', files: 0, chunks: 0, builtAt: null, keywordOnly: false, model: ollama.answerModel, progress };
    const chunks = data.files.reduce((n, f) => n + f.chunks.length, 0);
    return {
      state: progress.state === 'building' ? 'building' : 'ready', files: data.files.length, chunks, builtAt: data.builtAt,
      keywordOnly: data.files.some(f => f.chunks.some(c => c.vec === null)), model: ollama.answerModel, progress,
    };
  }

  return { ask, status };
}

module.exports = { createAskRepo, SYSTEM, DEFAULT_K };
