'use strict';
/**
 * Jiandu Home's page (documentation/DESIGN_PROJECT_HUB.md H1, H6-H7; plan documentation/PLAN_PROJECT_HUB.md H-PR2). The page decides
 * nothing: main's app/home-controller.js builds the cards, filters them, and validates every ask. This file draws what it is pushed and
 * says what was clicked.
 *
 *   cardsHtml(payload)     the cards (or the empty-state line), every string escaped: a folder may be named anything
 *   summaryText(summary)   "2 open · 1 needs you"
 *   usedText(t, now)       "used 5 min ago", '' for no time (never "0")
 *   clickTarget(el)        { action, key, lane? } for a card's button or lane, else null
 *   start(document, home)  wires the page to the preload's bridge (window.home: onModel, act)
 *
 * WRAPPED IN AN IIFE, and that is not style: a page loads its scripts as plain <script> tags sharing ONE global scope (CLAUDE.md, the
 * first trap). One name leaves it: `homeDisplay`.
 */

(function (root) {

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0;

const BUTTONS = {
  'open': { label: 'Open' },
  'go-to': { label: 'Go to window' },
  'close-window': { label: 'Close window', title: 'Closes the window. Its sessions keep running in the tray.' },
  'pin': { label: 'Pin', title: 'Pinned projects come first.' },
  'unpin': { label: 'Unpin' },
  'show-in-explorer': { label: 'Show in Explorer' },
  'remove': { label: 'Remove from the list', title: 'The project leaves Home. Its folder is not touched.' },
};

function usedText(t, now) {
  if (!isTime(t) || !isTime(now)) return '';
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return 'used just now';
  if (min < 60) return `used ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `used ${h} h ago`;
  const d = Math.floor(h / 24);
  return `used ${d} day${d === 1 ? '' : 's'} ago`;
}

function stateText(c) {
  if (c.state === 'open') {
    const tabs = isCount(c.tabs) ? ` · ${c.tabs} tab${c.tabs === 1 ? '' : 's'}` : '';
    return `open${tabs}${isCount(c.needs) && c.needs > 0 ? ' · needs you' : ''}`;
  }
  if (c.state === 'windowless') {
    const n = isCount(c.sessions) ? c.sessions : 0;
    return `${n} session${n === 1 ? '' : 's'}, no window`;
  }
  return 'closed';
}

function summaryText(s) {
  if (!s || typeof s !== 'object' || !isCount(s.open)) return '';
  const needs = isCount(s.needs) && s.needs > 0 ? ` · ${s.needs} ${s.needs === 1 ? 'needs' : 'need'} you` : '';
  return `${s.open} open${needs}`;
}

function buttonHtml(action) {
  const b = BUTTONS[action];
  if (!b) return '';
  return `<button data-act="${esc(action)}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.label)}</button>`;
}

function cardHtml(c, now) {
  const needs = isCount(c.needs) && c.needs > 0;
  const cls = `card ${esc(c.state)}${needs ? ' needs' : ''}${c.pinned === true ? ' pinned' : ''}`;
  const lanes = Array.isArray(c.lanes) && c.lanes.length
    ? `<div class="lanes">${c.lanes.map((l) => `<button data-act="lane" data-lane="${esc(l.path)}" class="lane${l.needs === true ? ' needs' : ''}" title="${esc(l.path)}">${esc(l.label)}</button>`).join('')}</div>`
    : '';
  const used = usedText(c.lastUsed, now);
  return `<div class="${cls}" data-key="${esc(c.key)}">`
    + `<div class="head"><span class="pin-mark" aria-hidden="true"></span><span class="label">${esc(c.label)}</span></div>`
    + `<div class="root">${esc(c.root)}</div>`
    + `<div class="status"><span class="state">${esc(stateText(c))}</span>${used ? `<span class="used">${esc(used)}</span>` : ''}</div>`
    + lanes
    + `<div class="actions">${(Array.isArray(c.actions) ? c.actions : []).map(buttonHtml).join('')}</div>`
    + '</div>';
}

function cardsHtml(p) {
  const payload = p && typeof p === 'object' ? p : {};
  if (typeof payload.empty === 'string' && payload.empty) return `<div class="empty">${esc(payload.empty)}</div>`;
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  return cards.map((c) => cardHtml(c, payload.now)).join('');
}

function clickTarget(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const btn = el.closest('[data-act]');
  const card = btn ? btn.closest('[data-key]') : null;
  if (!btn || !card) return null;
  const action = btn.getAttribute('data-act');
  const key = card.getAttribute('data-key');
  if (!action || !key) return null;
  return action === 'lane' ? { action, key, lane: btn.getAttribute('data-lane') } : { action, key };
}

function start(doc, home) {
  let last = null;
  const cards = doc.getElementById('cards');
  const summary = doc.getElementById('summary');
  const notice = doc.getElementById('notice');
  home.onModel((p) => {
    last = p;
    cards.innerHTML = cardsHtml(p);
    summary.textContent = summaryText(p && p.summary);
  });
  cards.addEventListener('click', (e) => {
    const t = clickTarget(e.target);
    if (!t) return;
    if (t.action === 'remove') {
      const c = last && Array.isArray(last.cards) ? last.cards.find((x) => x.key === t.key) : null;
      notice.textContent = `${c ? c.label : 'The project'} removed from the list. Its folder is not touched.`;
    } else {
      notice.textContent = '';
    }
    home.act(t);
  });
  doc.getElementById('filter').addEventListener('input', (e) => home.act({ action: 'filter', text: String(e.target.value) }));
  doc.getElementById('choose').addEventListener('click', () => home.act({ action: 'choose-folder' }));
}

const API = { cardsHtml, summaryText, usedText, stateText, clickTarget, start };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else {
  root.homeDisplay = API;
  // The real page: the script is at the end of <body>, so the document is still loading and the bridge is there.
  if (root.document && root.document.readyState === 'loading' && root.home) {
    root.document.addEventListener('DOMContentLoaded', () => start(root.document, root.home));
  }
}

})(typeof window !== 'undefined' ? window : globalThis);
