'use strict';
/**
 * Drop claude-custom's own Ollama models when the LAST claude-custom host exits (BACKLOG #91, the 2026-10-14 GPU
 * investigation). Every model is held for its keep_alive (5m / 2m) after the last call, so a quit used to leave up to 5.8 GB
 * on the GPU for minutes. Each tab is its own host process, and Ollama is one machine-wide server: only the last host out
 * may unload, or one tab closing would cold-start the models under every other tab.
 *
 *   unloadOnLastExit({ models, anotherHostRunning, baseUrl?, fetchImpl?, timeoutMs?, log? })
 *     -> { unloaded: boolean, reason?: 'other-host'|'unknown'|'no-models'|'ollama-down', models? }
 *
 * `models` are only the names claude-custom itself loads (summaries, Ask answer, Ask embedder): never "whatever is loaded".
 * `anotherHostRunning()` -> Promise<boolean|null>: true another host lives, false none, null/throws "couldn't tell". Anything
 * but a clean false skips the unload: a model left for its timer is the old behaviour, a model dropped under a live tab is a
 * cold load. It NEVER throws and is bounded by `timeoutMs` end to end (listing the hosts included), so it can't hold up a quit.
 * Ollama being down is not an error: the fetch fails, the result says so.
 *
 * keep_alive 0 on /api/generate with no prompt is Ollama's documented unload (the same call as host/ask-ollama.js unload()).
 */

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 3_000;

async function unloadOnLastExit({
  models, anotherHostRunning, baseUrl = DEFAULT_URL, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {},
} = {}) {
  const names = [...new Set((Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m.trim()))];
  if (names.length === 0) return { unloaded: false, reason: 'no-models' };
  const base = String(baseUrl).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // The deadline covers the host listing too: an `await` that never settles must not outlast it.
  const deadline = new Promise((res) => { ctl.signal.addEventListener('abort', () => res('deadline')); });
  try {
    let others;
    try { others = await Promise.race([Promise.resolve().then(anotherHostRunning), deadline]); } catch { others = null; }
    if (others === true) return { unloaded: false, reason: 'other-host' };
    if (others !== false) return { unloaded: false, reason: 'unknown' };
    const results = await Promise.race([
      Promise.all(names.map(async (model) => {
        try {
          const res = await fetchImpl(base + '/api/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: 0 }),
            signal: ctl.signal,
          });
          try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
          return res.status >= 200 && res.status < 300;
        } catch { return false; }
      })),
      deadline.then(() => names.map(() => false)),
    ]);
    const done = names.filter((_, i) => results[i]);
    log(`[host] ollama unload on last exit: ${done.length}/${names.length}`);
    return done.length > 0 ? { unloaded: true, models: done } : { unloaded: false, reason: 'ollama-down' };
  } catch {
    return { unloaded: false, reason: 'unknown' };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

module.exports = { unloadOnLastExit, DEFAULT_TIMEOUT_MS };
