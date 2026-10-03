'use strict';
/**
 * The Ollama client for the "where are we" summary (backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md decisions 1
 * and 6; settings from the 2026-10-03 serving measurement).
 *
 *   createOllamaClient({ baseUrl, model, fetchImpl, healthTimeoutMs, tagsTimeoutMs, generateTimeoutMs, now })
 *     .health()          -> { ok: true } | { ok: false, reason: 'unreachable' }
 *     .hasModel()        -> { ok: true } | { ok: false, reason: 'unreachable' | 'model-missing' | 'bad-reply' }
 *     .check()           -> health, then the model: the first failure, with `model` named
 *     .summarize(prompt) -> { ok: true, text, ms } | { ok: false, reason: 'timeout' | 'unreachable' | 'model-missing'
 *                                                                  | 'bad-reply' | 'http', status? }
 *
 * WHY THE RETRIES. On the real machine the first /api/tags call timed out at 5 s and the next answered in under a
 * second: one miss is not "Ollama is off". A health check is GET / (3 s) and a model check GET /api/tags (5 s), each
 * tried TWICE before they say so; a generate is tried twice too (a cold model load can run past one timeout while
 * Ollama keeps loading, and the retry then lands on a warm model). Anything Ollama actually ANSWERED is not retried:
 * a 404 is a model that isn't there, a 500 is a 500, a reply that isn't a summary is a bad reply.
 *
 * TWO TRIES MUST FIT inside host/summary-slot.js's STALE_MS, or another host could take the GPU slot over mid-job
 * (test/summary-ollama.test.js pins it).
 *
 * It never pulls a model and never talks to anything but `baseUrl`. The settings are per REQUEST (num_ctx,
 * keep_alive), never Ollama's global config. The prompt (the person's words) is never logged here.
 */

const { cleanReply } = require('./summary-text');

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2:3b';
const NUM_CTX = 8192;
const KEEP_ALIVE = '5m';
const HEALTH_TIMEOUT_MS = 3_000;
const TAGS_TIMEOUT_MS = 5_000;
const GENERATE_TIMEOUT_MS = 40_000;

const usable = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback);
const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

function createOllamaClient({
  baseUrl = DEFAULT_URL, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch,
  healthTimeoutMs, tagsTimeoutMs, generateTimeoutMs, now = Date.now,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const healthMs = usable(healthTimeoutMs, HEALTH_TIMEOUT_MS);
  const tagsMs = usable(tagsTimeoutMs, TAGS_TIMEOUT_MS);
  const generateMs = usable(generateTimeoutMs, GENERATE_TIMEOUT_MS);

  /** One HTTP exchange, bounded in time end to end (the body read included). */
  async function request(path, { method = 'GET', json, timeoutMs }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: json === undefined ? undefined : { 'content-type': 'application/json' },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: ctl.signal,
      });
      const text = await res.text();
      return { ok: true, status: res.status, text };
    } catch {
      return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The exchange, once more if it never got an answer. */
  async function twice(path, opts) {
    const first = await request(path, opts);
    return first.ok ? first : request(path, opts);
  }

  async function health() {
    const r = await twice('/', { timeoutMs: healthMs });
    return r.ok && r.status === 200 ? { ok: true } : { ok: false, reason: 'unreachable' };
  }

  async function hasModel() {
    const r = await twice('/api/tags', { timeoutMs: tagsMs });
    if (!r.ok || r.status !== 200) return { ok: false, reason: 'unreachable' };
    let parsed;
    try { parsed = JSON.parse(r.text); } catch { return { ok: false, reason: 'bad-reply' }; }
    if (!isObject(parsed) || !Array.isArray(parsed.models)) return { ok: false, reason: 'bad-reply' };
    const names = parsed.models.filter(isObject).map(m => (typeof m.name === 'string' ? m.name : m.model)).filter(n => typeof n === 'string');
    const want = model.includes(':') ? model : model + ':latest';
    return names.includes(want) ? { ok: true } : { ok: false, reason: 'model-missing' };
  }

  async function check() {
    const h = await health();
    if (!h.ok) return { ...h, model };
    const m = await hasModel();
    return m.ok ? m : { ...m, model };
  }

  async function summarize(prompt) {
    const started = now();
    const r = await twice('/api/generate', {
      method: 'POST',
      timeoutMs: generateMs,
      json: { model, prompt, stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX, temperature: 0.2, num_predict: 200 } },
    });
    if (!r.ok) return { ok: false, reason: r.reason === 'timeout' ? 'timeout' : 'unreachable' };
    if (r.status === 404) return { ok: false, reason: 'model-missing' };
    if (r.status < 200 || r.status > 299) return { ok: false, reason: 'http', status: r.status };
    let parsed;
    try { parsed = JSON.parse(r.text); } catch { return { ok: false, reason: 'bad-reply' }; }
    const text = isObject(parsed) && typeof parsed.response === 'string' ? cleanReply(parsed.response) : null;
    if (text === null) return { ok: false, reason: 'bad-reply' };
    return { ok: true, text, ms: Math.max(0, now() - started) };
  }

  return { health, hasModel, check, summarize };
}

module.exports = { createOllamaClient, DEFAULT_URL, DEFAULT_MODEL, NUM_CTX, KEEP_ALIVE, GENERATE_TIMEOUT_MS };
