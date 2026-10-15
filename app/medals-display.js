'use strict';
/**
 * BACKLOG #80: the medals Ricardo gives an agent. Pure rules, shared by the renderer (a plain <script>) and the host
 * (require): the six kinds, the validation of a request, the count chip on the card and the shelf on the agent's log page.
 *
 * The CARD shows only a count chip; the medals with their reasons and dates live on the SHELF (design round 2026-10-09B).
 * A medal is a thing Ricardo gives: nothing here computes one from an agent's work, so no medal ever claims something the
 * transcript did not show.
 *
 * The list is an ARRAY of { agent, medals } entries, not an object keyed by name: an agent can be called `__proto__`.
 *
 * WRAPPED IN AN IIFE, like every display module: plain <script> files share ONE global scope (see
 * app/agent-card-display.js). The one name it publishes is `medalsDisplay`.
 */

(function (root) {

const KINDS = Object.freeze([
  { kind: 'great-work', icon: '🏅', label: 'Great work' },
  { kind: 'bug-hunter', icon: '🐛', label: 'Bug hunter' },
  { kind: 'fast', icon: '⚡', label: 'Fast' },
  { kind: 'sharp-call', icon: '🧠', label: 'Sharp call' },
  { kind: 'saved-the-day', icon: '🛡️', label: 'Saved the day' },
  { kind: 'spot-on', icon: '🎯', label: 'Spot on' },
].map(Object.freeze));

const REASON_MAX = 120;
const AGENT_MAX = 200;
const PER_AGENT_MAX = 200;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const kindOf = (kind) => KINDS.find((k) => k.kind === kind) || null;
const nameOf = (v) => (typeof v === 'string' && v !== '' && v.length <= AGENT_MAX ? v : null);

/** One trimmed line of at most REASON_MAX characters; '' for anything that is not a string. */
function cleanReason(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, REASON_MAX).join('').trim();
}

/** { agent, kind, reason } for a give request, or null when it is not one. */
function validGive(msg) {
  if (!isObject(msg)) return null;
  const agent = nameOf(msg.agent);
  if (agent === null || !kindOf(msg.kind)) return null;
  return { agent, kind: msg.kind, reason: cleanReason(msg.reason) };
}

/** { agent, id } for a remove request, or null. */
function validRemove(msg) {
  if (!isObject(msg)) return null;
  const agent = nameOf(msg.agent);
  if (agent === null || typeof msg.id !== 'string' || msg.id === '' || msg.id.length > 64) return null;
  return { agent, id: msg.id };
}

/** How many medals an agent holds, from the `[{ agent, medals }]` list. Absent is 0, never a guess. */
function countOf(list, agent) {
  if (!Array.isArray(list)) return 0;
  const entry = list.find((e) => isObject(e) && e.agent === agent);
  return entry && Array.isArray(entry.medals) ? entry.medals.length : 0;
}

/** The card's chip: a count and nothing else. '' when the agent has no medals. */
function chipHtml(count) {
  if (!(typeof count === 'number' && Number.isInteger(count) && count > 0)) return '';
  return `<span class="medal-chip" title="${count} medal${count === 1 ? '' : 's'} — open the log to see them">🏅 ${count}</span>`;
}

function dateText(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** The shelf on an agent's log page: every medal with its reason and date, newest first, each removable. */
/**
 * Taking a hand-given medal off takes TWO clicks, in place (no browser confirm()): the first arms the medal's button (it reads
 * "Remove?"), a second click on the same one confirms. `pending` is the armed id or null.
 */
function reduceRemove(pending, id) {
  return pending === id ? { pending: null, send: true } : { pending: id, send: false };
}
const disarm = () => null;

function shelfHtml(agent, medals, pendingId = null, label = agent) {
  // null is UNKNOWN (the host couldn't read the file), which is not the same as none.
  if (medals === null) return `<div class="medal-shelf" data-agent="${escapeHtml(agent)}"><div class="medal-shelf-title">Medals</div><div class="medal-none">Couldn't read the medals just now. Trying again.</div></div>`;
  const rows = (Array.isArray(medals) ? medals : [])
    .filter((m) => isObject(m) && kindOf(m.kind) && typeof m.id === 'string')
    .slice().sort((a, b) => (b.at || 0) - (a.at || 0))
    .map((m) => {
      const k = kindOf(m.kind);
      const reason = typeof m.reason === 'string' && m.reason ? ` <span class="medal-reason">${escapeHtml(m.reason)}</span>` : '';
      return `<div class="medal-row"><span class="medal-icon" title="${escapeHtml(k.label)}">${k.icon}</span>` +
        `<span class="medal-label">${escapeHtml(k.label)}</span>${reason}` +
        `<span class="medal-date">${escapeHtml(dateText(m.at))}</span>` +
        (m.id === pendingId
          ? `<button type="button" class="medal-remove confirm" data-medal-remove="${escapeHtml(m.id)}" title="Click again to take this medal off ${escapeHtml(label)}">Remove?</button>`
          : `<button type="button" class="medal-remove" data-medal-remove="${escapeHtml(m.id)}" title="Take this medal off ${escapeHtml(label)}">&times;</button>`) +
        '</div>';
    });
  const body = rows.length ? rows.join('') : '<div class="medal-none">No medals yet.</div>';
  return `<div class="medal-shelf" data-agent="${escapeHtml(agent)}"><div class="medal-shelf-title">Medals</div>${body}</div>`;
}

/** The 🏅 action on a card (the other way in is a right-click on the card). */
function cardButtonHtml(agent, label = agent) {
  return `<button type="button" class="agent-medal-btn" data-medal-open title="Give ${escapeHtml(label)} a medal">🏅</button>`;
}

/** The give-a-medal menu: six kinds, an optional one-line reason, Give / Cancel. `selected` is a kind or null. `label` is the name shown when it isn't the key. */
function menuHtml(agent, selected, label = agent) {
  const kinds = KINDS.map((k) =>
    `<button type="button" class="medal-kind${k.kind === selected ? ' on' : ''}" data-medal-kind="${k.kind}" ` +
    `aria-pressed="${k.kind === selected}">${k.icon} ${escapeHtml(k.label)}</button>`).join('');
  return `<div class="medal-menu-title">Give ${escapeHtml(label)} a medal</div><div class="medal-kinds">${kinds}</div>` +
    `<input type="text" class="medal-reason-input" maxlength="${REASON_MAX}" placeholder="Why? (optional, one line)" autocomplete="off" spellcheck="false">` +
    `<div class="medal-menu-actions"><button type="button" data-medal-give${selected ? '' : ' disabled'}>Give</button>` +
    `<button type="button" data-medal-cancel>Cancel</button></div>`;
}

const api = { reduceRemove, disarm, cardButtonHtml, menuHtml, KINDS, REASON_MAX, AGENT_MAX, PER_AGENT_MAX, kindOf, cleanReason, validGive, validRemove, countOf, chipHtml, shelfHtml };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.medalsDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
