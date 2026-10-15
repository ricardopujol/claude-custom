'use strict';
/**
 * The Ask explainer's live state (BACKLOG #33 gamification, DESIGN_ASK_REPO.md "Gamification, rounds G1-G2"): the agents' four states,
 * so its roster card, its sort and its panel portrait can use the agents' own display (app/agent-state-display.js).
 *
 *   createExplainer({ now, idleMs, flashMs, queuedMs }) -> EventEmitter with
 *     begin()                    a question or selection started its search            -> token; working / reading
 *     stage(token, 'queued')     the places are back, the words are still to be asked   -> working / writing (dropped after queuedMs)
 *     stage(token, 'writing')    the answer is being written                           -> working / writing
 *     end(token, { ok, reason }) the answer landed (ok) or failed
 *     placeOpened()              the person opened a place it found                    -> happy for flashMs
 *     setPanel(viewer, open) / dropViewer(viewer)   which windows have an Ask panel open, one count per window
 *     tick()                     time passing (the host's 1 s clock)
 *     snapshot() -> { state, detail, panels }       'change' is emitted with it whenever what is shown changes
 *
 * THE MOOD MACHINE'S TIMINGS, NOT ITS EVENT FEED. host/mood-machine.js is driven by a CLI session's hook events (a spawn, a tool call,
 * a stop) and knows nothing of an answer that is searched and then written; feeding it synthetic hooks would borrow its bookkeeping
 * (invocation trees, teammates, a stall reaper) for none of its decisions. What carries over is what the person sees: the same four
 * states and finer names (`reading`, `writing`), the idle clock (IDLE_MS) and the flash (FLASH_MS), imported from it, not restated.
 *
 *   working   any ask is in flight: `writing` once its words are asked for (or about to be), `reading` while it only searches
 *   happy     FLASH_MS after a place was opened (a good answer alone is calm: it goes straight back to sleeping)
 *   stressed  a failed answer (not signed in, Claude didn't answer, Ollama down, model missing ...), until the next good answer or
 *             IDLE_MS of silence; a refusal of bad input (empty question, a bad selection ...) is not a failed answer
 *   sleeping  otherwise
 * Working outranks happy, which outranks stressed (opening a place on a failed answer is happy for FLASH_MS, then stressed again).
 */

const { EventEmitter } = require('node:events');
const { IDLE_MS, FLASH_MS, SLEEPING, WORKING, HAPPY, STRESSED, READING, WRITING } = require('./mood-machine');

// How long a finished search waits for the answer request that follows it (the host's own retrieval TTL is 60 s).
const QUEUED_MS = 30_000;

// A reply that says "that input can't be answered" or "not ready yet", not "the explainer failed".
const NOT_A_FAILURE = new Set(['empty-question', 'bad-selection', 'explainer-off', 'bad-message', 'unknown-op', 'index-building']);

function createExplainer({ now = Date.now, idleMs = IDLE_MS, flashMs = FLASH_MS, queuedMs = QUEUED_MS } = {}) {
  const ex = new EventEmitter();
  const runs = new Map();            // token -> { stage: 'searching' | 'queued' | 'writing', at }
  const viewers = new Set();
  let serial = 0;
  let stressed = false;
  let lastActivity = now();
  let happyUntil = 0;
  let shown = null;                  // the signature of what was last emitted

  // Stress is a judgement about silence: once it has lapsed it stays gone, even if the next thing to happen is an activity that
  // would restart the clock.
  function settle() {
    const t = now();
    for (const [token, r] of runs) if (r.stage === 'queued' && t - r.at > queuedMs) runs.delete(token);
    if (stressed && runs.size === 0 && t - lastActivity > idleMs) stressed = false;
  }

  function look() {
    const t = now();
    let writing = false;
    for (const r of runs.values()) if (r.stage !== 'searching') writing = true;
    let state = SLEEPING;
    let detail = SLEEPING;
    if (runs.size) { state = WORKING; detail = writing ? WRITING : READING; }
    else if (t <= happyUntil) { state = HAPPY; detail = HAPPY; }
    else if (stressed) { state = STRESSED; detail = STRESSED; }
    return { state, detail, panels: viewers.size };
  }

  function announce() {
    const s = look();
    const sig = `${s.state}|${s.detail}|${s.panels}`;
    if (sig === shown) return;
    shown = sig;
    ex.emit('change', s);
  }

  const touch = () => { lastActivity = now(); };

  ex.begin = () => {
    settle();
    const token = ++serial;
    runs.set(token, { stage: 'searching', at: now() });
    touch();
    announce();
    return token;
  };

  ex.stage = (token, stage) => {
    settle();
    const r = runs.get(token);
    if (!r || !['searching', 'queued', 'writing'].includes(stage)) return;
    r.stage = stage;
    r.at = now();
    touch();
    announce();
  };

  ex.end = (token, { ok, reason } = {}) => {
    settle();
    if (!runs.delete(token)) return;
    touch();
    if (ok === true) stressed = false;
    else if (!NOT_A_FAILURE.has(reason)) stressed = true;
    announce();
  };

  ex.placeOpened = () => {
    settle();
    touch();
    happyUntil = now() + flashMs;
    announce();
  };

  ex.setPanel = (viewer, open) => {
    if (open === true) viewers.add(viewer); else viewers.delete(viewer);
    announce();
  };
  ex.dropViewer = (viewer) => { viewers.delete(viewer); announce(); };

  ex.tick = () => { settle(); announce(); };
  ex.snapshot = () => { settle(); return look(); };

  return ex;
}

module.exports = { createExplainer, NOT_A_FAILURE, QUEUED_MS };
