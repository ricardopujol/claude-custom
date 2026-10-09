'use strict';
/**
 * The speech bubbles (BACKLOG #80, rules from #55): on an agent's state change, one short joke line over its card, written by a
 * LOCAL model through the existing Ollama client.
 *
 *   createBubbles({ gate, ollama, slot, voiceOf, contextOf, settings, broadcast, log, now })
 *     .onMood({ agent, state }) -> Promise<{ shown: true } | { shown: false, reason }>      never throws
 *     .setVisible(boolean)      -> the window says whether it can show a bubble at all (agent images off, lean mode)
 *   createBubbleSettings({ store }) -> { enabled(), set(boolean) }                           on by default, persisted
 *
 * THE ORDER OF THE DROPS, cheapest first, none of which touches the model: off, hidden by the window, cooling off after a
 * failure, the rate gate (one per agent per 3 minutes, one request at a time: host/bubble-gate.js), then the GPU slot
 * the "where are we" summaries hold (host/summary-slot.js, the same lock file): a bubble waits for nothing, it is dropped.
 *
 * OLLAMA MISSING OR SLOW IS NOT AN ERROR: no bubble, a quiet log line, and the service leaves Ollama alone for
 * FAILURE_COOLDOWN_MS so a flapping agent cannot hammer a dead port or stack 20 s timeouts. The card never waits on a joke:
 * onMood is fire-and-forget from the mood listener.
 *
 * DECORATION, NEVER INFORMATION: the frame carries a line and nothing about the work. What reaches the model is trimmed by
 * host/bubble-prompt.js (names, state, tool, file names, the task line; never contents or secrets).
 */

const { buildPrompt, cleanLine, STATES } = require('./bubble-prompt');

const TTL_MS = 8000;
const FAILURE_COOLDOWN_MS = 60_000;
const NUM_PREDICT = 60;
const TEMPERATURE = 0.9;
const STORE_KEY = 'bubbles';

function createBubbles({ gate, ollama, slot, voiceOf, contextOf, settings, broadcast, log = () => {}, now = Date.now } = {}) {
  for (const [name, dep] of Object.entries({ gate, ollama, slot, voiceOf, contextOf, settings, broadcast })) {
    if (!dep) throw new Error(`createBubbles: ${name} is required`);
  }
  let visible = true;
  let coolUntil = 0;

  const drop = (reason) => ({ shown: false, reason });

  async function onMood(change) {
    try {
      if (!change || typeof change.agent !== 'string' || !change.agent || !STATES.has(change.state)) return drop('ignored');
      if (!settings.enabled()) return drop('off');
      if (!visible) return drop('hidden');
      if (now() < coolUntil) return drop('cooling-off');
      const turn = gate.offer(change.agent);
      if (!turn.ok) return drop(turn.reason);
      let held = false;
      try {
        if (!slot.tryAcquire()) return drop('gpu-busy');
        held = true;
        let voice = null;
        try { voice = await voiceOf(change.agent); } catch { voice = null; }   // no file: a neutral voice
        const built = buildPrompt({ agent: change.agent, state: change.state, voice, ...contextOf(change.agent) });
        if (!built) return drop('ignored');
        let res;
        try {
          res = await ollama.generate({ ...built, numPredict: NUM_PREDICT, temperature: TEMPERATURE });
        } catch (err) {
          res = { ok: false, reason: 'threw', message: err && err.message };
        }
        if (!res || !res.ok) {
          coolUntil = now() + FAILURE_COOLDOWN_MS;
          log(`[bubbles] no bubble for ${change.agent}: ${res && res.reason}`);
          return drop('ollama');
        }
        const text = cleanLine(res.text);
        if (text === null) return drop('unusable');
        broadcast({ type: 'bubble', agent: change.agent, state: change.state, text, ttlMs: TTL_MS });
        return { shown: true };
      } finally {
        if (held) { try { slot.release(); } catch { /* the slot goes stale on its own */ } }
        gate.done();
      }
    } catch (err) {
      log(`[bubbles] failed: ${err && err.message}`);
      return drop('error');
    }
  }

  return { onMood, setVisible: (v) => { visible = v === true; } };
}

/** The on/off choice, install-wide in `.harness/state/bubbles.json`. On until Ricardo turns it off. A corrupt file reads as on. */
function createBubbleSettings({ store } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') throw new Error('createBubbleSettings: store is required');
  const saved = store.read(STORE_KEY, null);
  let on = !(saved && typeof saved === 'object' && saved.enabled === false);
  return {
    enabled: () => on,
    set(value) {
      if (typeof value !== 'boolean') return { ok: false, reason: 'invalid' };
      try { store.write(STORE_KEY, { enabled: value }); } catch { return { ok: false, reason: 'write-failed' }; }
      on = value;
      return { ok: true };
    },
  };
}

module.exports = { createBubbles, createBubbleSettings, TTL_MS, FAILURE_COOLDOWN_MS, NUM_PREDICT, TEMPERATURE, STORE_KEY };
