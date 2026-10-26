'use strict';
/**
 * BACKLOG #80 / #55: the renderer's side of the speech bubbles. A bubble is a short joke line over an agent's card, written by a
 * local model on the host (host/bubbles.js), fading after 8 seconds. It is DECORATION: the card's state and the agent's log
 * stay the truth, and a bubble is drawn as a speech bubble so it can't be read as a status.
 *
 *   createBoard({ now })   show(frame) -> boolean   live(agent) -> { text, remainingMs } | null   nextExpiryIn()   clear()   size()
 *   canShow({ enabled, imagesEnabled, lean })       the switch is on, agent images are not off, the window is not lean
 *   bubbleHtml(text, remainingMs)                   the markup (escaped); the fade is CSS, off under prefers-reduced-motion
 *   attach(root, board, show)                       put each live bubble on its `.agent` card (and take stale ones off)
 *
 * The board is a Map, so an agent called `__proto__` is ordinary, and it is bounded.
 *
 * WRAPPED IN AN IIFE, like every display module: plain <script> files share ONE global scope. The one name it publishes is
 * `bubbleDisplay`.
 */

(function (root) {

const TTL_DEFAULT_MS = 8000;
const TTL_MIN_MS = 1000;
const TTL_MAX_MS = 15000;
const TEXT_MAX = 80;
const AGENT_MAX = 200;
const BOARD_MAX = 200;
const FADE_MS = 600;
// Settled: a bubble this old has already played its fade-in, so a node rebuilt by a roster repaint doesn't blink again.
const SETTLED_MS = 250;

// A duration clock, not the wall clock: a clock that steps back or forward must not stretch or cut an 8 s bubble.
const monotonic = () => performance.now();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cleanText(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, TEXT_MAX).join('').trim();
}

function createBoard({ now = monotonic } = {}) {
  const bubbles = new Map();      // agent -> { text, until, ttl }

  function sweep() {
    const t = now();
    for (const [agent, b] of bubbles) if (b.until <= t) bubbles.delete(agent);
  }

  function show(frame) {
    if (!frame || typeof frame !== 'object') return false;
    const agent = frame.agent;
    const text = cleanText(frame.text);
    if (typeof agent !== 'string' || agent === '' || agent.length > AGENT_MAX || text === '') return false;
    const ttl = typeof frame.ttlMs === 'number' && Number.isFinite(frame.ttlMs)
      ? Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, frame.ttlMs)) : TTL_DEFAULT_MS;
    sweep();
    bubbles.delete(agent);
    bubbles.set(agent, { text, until: now() + ttl, ttl });
    while (bubbles.size > BOARD_MAX) bubbles.delete(bubbles.keys().next().value);
    return true;
  }

  function live(agent) {
    const b = bubbles.get(agent);
    if (!b) return null;
    const remainingMs = b.until - now();
    if (remainingMs <= 0) { bubbles.delete(agent); return null; }
    return { text: b.text, remainingMs, ageMs: Math.max(0, b.ttl - remainingMs) };
  }

  function nextExpiryIn() {
    sweep();
    let soonest = null;
    const t = now();
    for (const b of bubbles.values()) soonest = soonest === null ? b.until - t : Math.min(soonest, b.until - t);
    return soonest;
  }

  return { show, live, nextExpiryIn, clear: () => bubbles.clear(), size: () => bubbles.size };
}

/** The switch is on, agent images are not OFF (unknown counts as not off), and the window is not in lean mode. */
function canShow(s) {
  if (!s || typeof s !== 'object') return false;
  return s.enabled === true && s.imagesEnabled !== false && s.lean !== true;
}

function bubbleHtml(text, remainingMs, ageMs = 0) {
  const life = Math.max(0, Math.round(remainingMs));
  const settled = typeof ageMs === 'number' && ageMs > SETTLED_MS ? ' data-settled' : '';
  const delay = Math.max(0, life - FADE_MS);
  return `<div class="agent-bubble"${settled} role="note" aria-label="a joke from the agent, not a status" ` +
    `style="--bubble-life:${life}ms;--bubble-fade-delay:${delay}ms">${escapeHtml(text)}</div>`;
}

function attach(rootEl, board, show) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
  for (const card of rootEl.querySelectorAll('.agent')) {
    const old = card.querySelector(':scope > .agent-bubble');
    const b = show && card.dataset && card.dataset.state !== 'inactive' ? board.live(card.dataset.agent) : null;   // the Inactive tab has no bubbles
    // The same line already on the card stays: replacing the node would restart its fade-in on every roster repaint (about 1/s).
    if (old && b && old.textContent === b.text) continue;
    if (old) old.remove();
    if (b) card.insertAdjacentHTML('afterbegin', bubbleHtml(b.text, b.remainingMs, b.ageMs));
  }
}

const api = { monotonic, SETTLED_MS, createBoard, canShow, bubbleHtml, attach, TTL_DEFAULT_MS, TTL_MIN_MS, TTL_MAX_MS, TEXT_MAX, BOARD_MAX, FADE_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.bubbleDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
