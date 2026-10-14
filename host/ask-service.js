'use strict';
/**
 * The host's side of the `ask` protocol for the "Ask the repo" panel (BACKLOG #33, DESIGN_ASK_REPO.md rounds 1-8). One service per host,
 * which is one worktree: the page never names a worktree (the same rule as the Files tab), and never reads a file itself.
 *
 *   createAskService({ cwd, index, ollama, claude, models, repoFor, readSelection, spawnOllama }).handle(msg) -> Promise<reply>
 *
 * A message is { type: 'ask', op, seq, ...body }; the reply echoes `op` and `seq`. `handle` never rejects: every failure is
 * { ok: false, reason, ... } with the reason in words the page turns into a note (app/ask-panel-state.js noticeOf).
 *
 *   status        -> { ok, index, ollama, models: [{ id, kind, name, model, where, explainer }], examples }   `warm` starts a first index
 *   places        -> { ok, places }     the search alone: the best few ranges as cards, so they show while the words are written
 *   ask           -> { ok, text, places, model, ... }      a typed question: the 9/10 path (short answer + "Where to look")
 *   explain       -> the same, for a SELECTION and a level (the explainer; refused for a model with no passed record)
 *   start-ollama  -> { ok } | { ok, already }
 *
 * THE MODEL IS CHOSEN PER REQUEST, from a fixed list: Local (Ollama), Haiku, Sonnet (the real claude CLI, host/ask-claude.js). An unknown
 * name from the page is the local model, never a command. THE EXPLAINER IS REFUSED, in the host and not only in the page, for any model
 * without a passed-the-bar record (host/ask-models.js). A SELECTION is read here, through the Files tab's guard (host/repo-guard.js,
 * host/repo-read.js): the page's file name is untrusted and its line numbers are checked against the file.
 *
 * Failures keep the places the search found (they arrive as `hits`), so "Ollama isn't running" still shows somewhere to look.
 */

const childProcess = require('child_process');
const { guardPath } = require('./repo-guard');
const { readRepoFile } = require('./repo-read');
const { extractCitations } = require('./ask-citations');
const { buildExplain, clipSelection } = require('./ask-explain');
const { createAskRepo } = require('./ask-repo');

const CARD_MAX = 6;
const PREVIEW_MAX = 5;
const CARD_LINES = 4;
const WHY_MAX = 160;
const WHY_MIN = 8;
const SELECTION_SPAN_MAX = 400;
const QUERY_CHARS = 500;
const EXPLAIN_NUM_PREDICT = 450;
const EXAMPLE_TEMPLATES = Object.freeze([
  (f) => `What does ${f} do?`,
  (f) => `Where is ${f} defined, and what calls it?`,
  (f) => `How does ${f} work?`,
]);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- places ---------------------------------------------------------------------------------------------------------------------

/** The real lines [from..to] of `file` from the index's own chunks: [{ n, text }]; [] when the index does not hold them. */
function linesOf(data, file, from, to) {
  const f = isObj(data) && Array.isArray(data.files) ? data.files.find(x => x.rel === file) : null;
  if (!f) return [];
  const out = [];
  for (const c of f.chunks || []) {
    if (!isStr(c.text) || !Number.isInteger(c.start)) continue;
    const rows = c.text.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const n = c.start + i;
      if (n >= from && n <= to && !out.some(o => o.n === n)) out.push({ n, text: rows[i].slice(0, 200) });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The sentence of the answer around a citation, without the citation itself or its bullet; '' when nothing useful is left. */
function whyFor(text, cit) {
  if (!isStr(text) || !cit) return '';
  const token = `${cit.file}:${cit.line}`;
  const row = text.split(/\r?\n/).find(l => l.includes(token));
  if (!row) return '';
  const cite = new RegExp(escapeRe(cit.file) + ':\\d+(?:\\s?[-–]\\s?\\d+)?', 'g');
  let s = row.replace(cite, ' ').replace(/[`*]/g, '').replace(/^\s*(?:[-•]|\d+[.)])\s*/, '');
  s = s.replace(/\s+/g, ' ').replace(/^[\s:–—,;.()-]+/, '').replace(/[\s:–—,;.()-]+$/, '');
  if (s.length < WHY_MIN) return '';
  return s.length > WHY_MAX ? s.slice(0, WHY_MAX - 1) + '…' : s;
}

/** Cards from the checked citations of an answer: deduped, capped, each with its real lines and the answer's own words for it. */
function placesFromCitations(text, citations, data) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(citations) ? citations : []) {
    if (!isObj(c) || !isStr(c.file) || !Number.isInteger(c.line)) continue;
    const key = `${c.file}:${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const endLine = Number.isInteger(c.endLine) && c.endLine >= c.line ? c.endLine : c.line;
    out.push({ file: c.file, line: c.line, endLine, why: whyFor(text, c), lines: linesOf(data, c.file, c.line, Math.min(endLine, c.line + CARD_LINES - 1)) });
    if (out.length >= CARD_MAX) break;
  }
  return out;
}

/** Cards from the chunks the search offered ([{ file, line|start, endLine|end }]): the first few, no "why" (they are not claims). */
function placesFromRanges(ranges, data, max = PREVIEW_MAX) {
  const out = [];
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const line = Number.isInteger(r.line) ? r.line : r.start;
    const endLine = Number.isInteger(r.endLine) ? r.endLine : r.end;
    if (!isStr(r.file) || !Number.isInteger(line)) continue;
    out.push({ file: r.file, line, endLine: Number.isInteger(endLine) && endLine >= line ? endLine : line, why: '', lines: linesOf(data, r.file, line, line + CARD_LINES - 1) });
    if (out.length >= max) break;
  }
  return out;
}

/** Three example questions about real functions of three different files (the biggest files first), the same every time. */
function examplesFrom(data) {
  if (!isObj(data) || !Array.isArray(data.files)) return [];
  const files = [...data.files].sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const names = new Set();
  const out = [];
  for (const f of files) {
    if (out.length >= EXAMPLE_TEMPLATES.length) break;
    const text = (f.chunks || []).map(c => (isStr(c.text) ? c.text : '')).join('\n');
    const m = /(?:^|\n)[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]{3,})\s*\(/.exec(text);
    if (!m || names.has(m[1])) continue;
    names.add(m[1]);
    out.push(EXAMPLE_TEMPLATES[out.length](m[1]));
  }
  return out;
}

// ---- the selection --------------------------------------------------------------------------------------------------------------

async function defaultReadSelection(cwd, file) {
  const g = await guardPath(cwd, file);
  if (!g.ok) return { ok: false, why: g.why };
  const r = await readRepoFile(g.abs);
  return r.ok ? { ok: true, text: r.text } : { ok: false, why: r.why };
}

function defaultSpawnOllama() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const child = childProcess.spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => fin({ ok: false, reason: e && e.code === 'ENOENT' ? 'ollama-not-installed' : 'spawn-failed' }));
      child.unref();
      setTimeout(() => fin({ ok: true }), 400);
    } catch { fin({ ok: false, reason: 'spawn-failed' }); }
  });
}

/** For a Claude model, the engine sees the local Ollama only for its embedder; the ANSWER comes from the claude CLI. */
function claudeAsOllama({ ollama, claude, modelId }) {
  return {
    answerModel: modelId,
    embedModel: ollama.embedModel,
    check: async () => {
      const s = await ollama.check();
      const embed = s.ok ? s.embed !== false : s.reason === 'model-missing' && s.embed === true;
      return { ok: true, answer: true, embed };
    },
    embed: (t) => ollama.embed(t),
    generate: ({ system, prompt }) => claude.generate({ model: modelId, system, prompt }),
  };
}

/** The production `repoFor`: one engine per model, over the same index. */
function createRepoFactory({ index, ollama, claude }) {
  const byModel = new Map();
  return (modelId) => {
    if (!byModel.has(modelId)) {
      byModel.set(modelId, createAskRepo({ index, ollama: modelId === 'local' ? ollama : claudeAsOllama({ ollama, claude, modelId }) }));
    }
    return byModel.get(modelId);
  };
}

// ---- the service ----------------------------------------------------------------------------------------------------------------

function createAskService({
  cwd, index, ollama, claude, models, repoFor, readSelection = defaultReadSelection, spawnOllama = defaultSpawnOllama,
} = {}) {
  const dataNow = () => (index && typeof index.get === 'function' ? index.get(cwd) : null);
  const modelOf = (msg) => models.choose(msg && msg.model);

  function failure(reply, data, extra = {}) {
    const hits = Array.isArray(reply.hits) ? reply.hits : [];
    const { hits: _drop, ...rest } = reply;
    void _drop;
    return { ...rest, ok: false, ...extra, ...(hits.length ? { places: placesFromRanges(hits, data) } : {}) };
  }

  function success(base, data, text, citations, sources, extra) {
    let places = placesFromCitations(text, citations, data);
    if (!places.length) places = placesFromRanges(sources, data, 3);
    return { ...extra, ok: true, text, places, ...base };
  }

  async function status(msg) {
    const [idx, ol] = await Promise.all([repoFor('local').status(cwd), ollama.check()]);
    if (msg.warm === true && idx && idx.state === 'none' && !(index.isRunning && index.isRunning(cwd))) {
      Promise.resolve(index.refresh(cwd)).catch(() => {});
    }
    return {
      ok: true,
      index: idx,
      ollama: ol.ok ? { ok: true } : { ok: false, reason: ol.reason, ...(ol.model ? { model: ol.model } : {}) },
      models: models.list(),
      examples: examplesFrom(dataNow()).slice(0, 3),
    };
  }

  /** The selection a message names: { ok, sel (clipped), query } or { ok: false, reason: 'bad-selection', detail }. */
  async function selectionOf(msg) {
    const bad = (detail) => ({ ok: false, reason: 'bad-selection', detail });
    const { file, start, end } = msg;
    if (!isStr(file) || !file || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return bad('that is not a range of lines');
    if (end - start + 1 > SELECTION_SPAN_MAX) return bad('that is too many lines at once');
    const r = await readSelection(cwd, file);
    if (!r || r.ok !== true) return bad((r && r.why) || 'the file could not be read');
    const all = String(r.text).split(/\r?\n/);
    if (end > all.length) return bad(`the file has only ${all.length} lines`);
    const sel = clipSelection({ file, start, end, lines: all.slice(start - 1, end) });
    const term = isStr(msg.term) ? msg.term.trim() : '';
    const query = (term || sel.lines.join('\n')).slice(0, QUERY_CHARS);
    return { ok: true, sel, query, total: all.length };
  }

  async function places(msg) {
    const modelId = modelOf(msg);
    const repo = repoFor(modelId);
    let query;
    let exclude;
    if (isStr(msg.file)) {
      const s = await selectionOf(msg);
      if (!s.ok) return s;
      query = s.query;
      exclude = { file: msg.file, start: msg.start, end: msg.end };
    } else {
      if (!isStr(msg.question) || !msg.question.trim()) return { ok: false, reason: 'empty-question' };
      query = msg.question;
    }
    const ex = await repo.excerptsFor(cwd, query, { exclude });
    if (!ex.ok) return ex;
    return { ok: true, places: placesFromRanges(ex.sent, dataNow()), keywordOnly: ex.keywordOnly, stale: ex.stale };
  }

  async function ask(msg) {
    if (!isStr(msg.question) || !msg.question.trim()) return { ok: false, reason: 'empty-question' };
    const modelId = modelOf(msg);
    const r = await repoFor(modelId).ask(cwd, msg.question);
    const data = dataNow();
    if (!r.ok) return failure(r, data, { model: modelId });
    return success(
      { model: modelId, keywordOnly: r.keywordOnly === true, stale: r.stale === true, dropped: r.dropped || [], ms: r.ms },
      data, r.text, r.citations, r.sources, { kind: 'question' },
    );
  }

  async function explain(msg) {
    const modelId = modelOf(msg);
    if (!models.explainerOn(modelId)) return { ok: false, reason: 'explainer-off', model: modelId };
    const s = await selectionOf(msg);
    if (!s.ok) return s;
    const repo = repoFor(modelId);
    const ex = await repo.excerptsFor(cwd, s.query, { exclude: { file: msg.file, start: msg.start, end: msg.end } });
    if (!ex.ok) return { ...ex, model: modelId };
    const data = dataNow();
    const previews = () => placesFromRanges(ex.sent, data);
    const st = ex.ollamaStatus;
    if (modelId === 'local' && st && st.ok === false) {
      return { ok: false, reason: st.reason, ...(st.model ? { model: st.model } : { model: modelId }), places: previews(), keywordOnly: ex.keywordOnly, stale: ex.stale };
    }
    const { system, prompt } = buildExplain({
      file: msg.file, start: s.sel.start, end: s.sel.end, lines: s.sel.lines, excerpts: ex.body,
      level: msg.level, aboutMe: msg.aboutMe, direction: msg.direction, term: msg.term, answer: msg.answer,
    });
    const g = modelId === 'local'
      ? await ollama.generate({ system, prompt, numPredict: EXPLAIN_NUM_PREDICT })
      : await claude.generate({ model: modelId, system, prompt });
    if (!g.ok) {
      return { ok: false, reason: g.reason, model: modelId, ...(g.detail ? { detail: g.detail } : {}), ...(g.status ? { status: g.status } : {}), places: previews(), keywordOnly: ex.keywordOnly, stale: ex.stale };
    }
    // Citations are checked against what the model was SHOWN: the excerpts and the selection itself.
    const ranges = new Map();
    const counts = new Map(ex.lineCounts);
    for (const r of [...ex.sent, { file: msg.file, start: s.sel.start, end: s.sel.end }]) {
      if (!ranges.has(r.file)) ranges.set(r.file, []);
      ranges.get(r.file).push([r.start, r.end]);
    }
    if (!counts.has(msg.file)) counts.set(msg.file, s.total);
    const { citations, dropped } = extractCitations(g.text, counts, { ranges });
    return success(
      { model: modelId, keywordOnly: ex.keywordOnly, stale: ex.stale, dropped, ms: 0 },
      data, g.text, citations, ex.sent, { kind: 'explain', clipped: s.sel.clipped === true },
    );
  }

  async function startOllama() {
    const s = await ollama.check();
    if (s.ok || s.reason === 'model-missing') return { ok: true, already: true };
    const r = await spawnOllama();
    return r && r.ok === true ? { ok: true } : { ok: false, reason: (r && r.reason) || 'spawn-failed' };
  }

  const OPS = { status, places, ask, explain, 'start-ollama': startOllama };

  async function handle(msg) {
    if (!isObj(msg)) return { type: 'ask', ok: false, reason: 'bad-message' };
    const head = { type: 'ask', op: msg.op, seq: msg.seq };
    if (!isStr(msg.op) || !Object.prototype.hasOwnProperty.call(OPS, msg.op)) return { ...head, ok: false, reason: 'unknown-op' };
    try {
      return { ...head, ...(await OPS[msg.op](msg)) };
    } catch (err) {
      return { ...head, ok: false, reason: 'host-error', error: (err && err.message) || String(err) };
    }
  }

  return { handle };
}

module.exports = { createAskService, createRepoFactory, claudeAsOllama, whyFor, placesFromCitations, placesFromRanges, examplesFrom, linesOf };
