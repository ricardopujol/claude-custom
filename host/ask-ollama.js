'use strict';
/**
 * The Ollama client for "ask the repo" (BACKLOG #33, DESIGN_ASK_REPO.md). Local only: it talks to `baseUrl` and nothing else,
 * never pulls a model, and settings are per REQUEST (the same rule as host/summary-ollama.js, whose GPU it shares).
 *
 *   check()                 -> { ok: true, answer: true, embed: boolean }
 *                            | { ok: false, reason: 'ollama-down' }
 *                            | { ok: false, reason: 'model-missing', model, embed }   (the ANSWER model)
 *   embed(texts[])          -> { ok: true, vectors } | { ok: false, reason: 'ollama-down'|'timeout'|'model-missing'|'bad-reply'|'http', ... }
 *   generate({system,prompt}) -> { ok: true, text } | { ok: false, reason: same set }
 *   unload()                -> asks Ollama to drop the answer model now (keep_alive 0)
 *
 * A missing EMBED model is not fatal: the index then runs on keywords alone and the panel says so. A missing answer model
 * or a stopped Ollama is said plainly (reason + model name) and never turned into an empty answer. The question and the
 * code excerpts are never logged here.
 *
 * keep_alive: the answer model stays loaded 5 minutes after a question (the 2026-10-09 measurement: a cold load of the 7B
 * coder is ~10 s, and it has to take turns on the 8 GB GPU with the summary model, which holds 5 minutes too); the embedder
 * stays 2 minutes.
 */

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_ANSWER_MODEL = 'qwen2.5-coder:latest';
const DEFAULT_EMBED_MODEL = 'snowflake-arctic-embed2:latest';
const NUM_CTX = 8192;
const NUM_PREDICT = 350;

const usable = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback);
const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const withTag = (m) => (m.includes(':') ? m : m + ':latest');

function createAskOllama({
  baseUrl = DEFAULT_URL, answerModel = DEFAULT_ANSWER_MODEL, embedModel = DEFAULT_EMBED_MODEL, fetchImpl = globalThis.fetch,
  tagsTimeoutMs, embedTimeoutMs, generateTimeoutMs,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const tagsMs = usable(tagsTimeoutMs, 5_000);
  const embedMs = usable(embedTimeoutMs, 60_000);
  const generateMs = usable(generateTimeoutMs, 90_000);

  /** One exchange, bounded in time end to end. A reply is JSON or it is { json: null }. */
  async function call(path, { method = 'GET', json, timeoutMs }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: json === undefined ? undefined : { 'content-type': 'application/json' },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: ctl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { reached: true, status: res.status, body };
    } catch {
      return { reached: false, reason: ctl.signal.aborted ? 'timeout' : 'ollama-down' };
    } finally {
      clearTimeout(timer);
    }
  }

  const failure = (r, model) => {
    if (!r.reached) return { ok: false, reason: r.reason };
    if (r.status === 404) return { ok: false, reason: 'model-missing', model };
    if (r.status < 200 || r.status > 299) return { ok: false, reason: 'http', status: r.status };
    return null;
  };

  async function check() {
    // /api/tags is tried twice: on this machine the first call after a quiet spell has timed out once and then answered.
    let r = await call('/api/tags', { timeoutMs: tagsMs });
    if (!r.reached) r = await call('/api/tags', { timeoutMs: tagsMs });
    if (!r.reached || r.status !== 200) return { ok: false, reason: 'ollama-down' };
    if (!isObject(r.body) || !Array.isArray(r.body.models)) return { ok: false, reason: 'ollama-down' };
    const names = r.body.models.filter(isObject).map(m => (typeof m.name === 'string' ? m.name : m.model)).filter(n => typeof n === 'string');
    const embed = names.includes(withTag(embedModel));
    if (!names.includes(withTag(answerModel))) return { ok: false, reason: 'model-missing', model: answerModel, embed };
    return { ok: true, answer: true, embed };
  }

  async function embed(texts) {
    const r = await call('/api/embed', { method: 'POST', timeoutMs: embedMs, json: { model: embedModel, input: texts, keep_alive: '2m' } });
    const bad = failure(r, embedModel);
    if (bad) return bad;
    const v = isObject(r.body) ? r.body.embeddings : null;
    const good = Array.isArray(v) && v.length === texts.length
      && v.every(e => Array.isArray(e) && e.length > 0 && e.every(x => typeof x === 'number' && Number.isFinite(x)));
    return good ? { ok: true, vectors: v } : { ok: false, reason: 'bad-reply' };
  }

  async function generate({ system, prompt }) {
    const r = await call('/api/generate', {
      method: 'POST',
      timeoutMs: generateMs,
      json: { model: answerModel, system, prompt, stream: false, keep_alive: '5m', options: { num_ctx: NUM_CTX, temperature: 0, num_predict: NUM_PREDICT } },
    });
    const bad = failure(r, answerModel);
    if (bad) return bad;
    const text = isObject(r.body) && typeof r.body.response === 'string' ? r.body.response.trim() : '';
    return text ? { ok: true, text } : { ok: false, reason: 'bad-reply' };
  }

  async function unload() {
    await call('/api/generate', { method: 'POST', timeoutMs: tagsMs, json: { model: answerModel, keep_alive: 0 } });
  }

  return { check, embed, generate, unload, answerModel, embedModel };
}

module.exports = { createAskOllama, DEFAULT_URL, DEFAULT_ANSWER_MODEL, DEFAULT_EMBED_MODEL, NUM_CTX, NUM_PREDICT };
