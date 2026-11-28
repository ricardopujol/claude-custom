'use strict';
/**
 * Jiandu Home's page (documentation/DESIGN_PROJECT_HUB.md H1, H6-H7; plan documentation/PLAN_PROJECT_HUB.md H-PR2). The page decides
 * nothing: main's app/home-controller.js builds the cards, filters them, and validates every ask. This file draws what it is pushed and
 * says what was clicked.
 *
 *   cardsHtml(payload, ui) the cards (or the empty-state line), every string escaped: a folder may be named anything. `ui` is the
 *                          page's own state (H-PR3): the card asking "Stop 2 sessions in viral? Stop / Cancel" (H8, no popup), the
 *                          open New lane form (a type prefix and a name), and each card's last note ("Stopped 2 sessions.")
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
  'stop-sessions': { label: 'Stop its sessions', title: 'Stops the sessions that run with no window. It asks first.' },
  'new-lane': { label: 'New lane', title: 'A new worktree branch for this project, opened in its window.' },
};
// The New lane form's type prefixes (the worktree scripts accept these: new-worktree.ps1). The first is the default.
const PREFIXES = ['feat/', 'fix/', 'spike/', 'chore/', 'docs/', 'refactor/', 'test/'];
const HAS_PREFIX = /^(feat|fix|spike|chore|docs|refactor|test)\//;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

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

// The card's own question (H8: no popup) and its New lane form take the place of its buttons while they are open.
function confirmHtml(c) {
  const n = isCount(c.sessions) ? c.sessions : 0;
  return `<div class="confirm"><span class="question">${esc(`Stop ${plural(n, 'session')} in ${c.label}?`)}</span>`
    + '<button data-act="stop-confirm" class="danger">Stop</button><button data-act="stop-cancel">Cancel</button></div>';
}

function laneFormHtml(form) {
  const opts = PREFIXES.map((p) => `<option value="${esc(p)}"${p === form.prefix ? ' selected' : ''}>${esc(p)}</option>`).join('');
  return `<div class="lane-form"><select data-field="prefix" aria-label="Branch type">${opts}</select>`
    + `<input data-field="name" type="text" maxlength="120" spellcheck="false" placeholder="my-change" aria-label="Branch name" value="${esc(form.name)}">`
    + '<button data-act="lane-create">Create</button><button data-act="lane-cancel">Cancel</button></div>';
}

function cardHtml(c, now, ui) {
  const u = ui && typeof ui === 'object' ? ui : {};
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
    + below(c, u)
    + (u.notes && typeof u.notes[c.key] === 'string' ? `<div class="card-note" role="status">${esc(u.notes[c.key])}</div>` : '')
    + '</div>';
}

function below(c, u) {
  const acts = Array.isArray(c.actions) ? c.actions : [];
  if (u.confirm === c.key && acts.includes('stop-sessions')) return confirmHtml(c);
  if (u.laneForm && u.laneForm.key === c.key && acts.includes('new-lane')) return laneFormHtml(u.laneForm);
  return `<div class="actions">${acts.map(buttonHtml).join('')}</div>`;
}

/** The cards; `ui` is the page's own state: { confirm: key, laneForm: { key, prefix, name }, notes: { key: text } }. */
function cardsHtml(p, ui) {
  const payload = p && typeof p === 'object' ? p : {};
  if (typeof payload.empty === 'string' && payload.empty) return `<div class="empty">${esc(payload.empty)}</div>`;
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  return cards.map((c) => cardHtml(c, payload.now, ui)).join('');
}

/** What the card says once main answered a stop (H8). */
function stopNote(r, asked) {
  if (r && r.ok === true && isCount(r.stopped)) return `Stopped ${plural(r.stopped, 'session')}.`;
  const why = r && typeof r.error === 'string' && r.error ? r.error.replace(/\.+$/, '') : 'no answer';
  if (r && isCount(r.stopped) && r.stopped > 0) return `Stopped ${r.stopped} of ${plural(Math.max(asked, r.stopped + (isCount(r.kept) ? r.kept : 0)), 'session')}. ${why}.`;
  return `The sessions were not stopped: ${why}.`;
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

// What a record edit says when main refused it (PR #263 Miguel Y3): "<name> was not removed: <main's reason>."
const NOT_DONE = { 'remove': 'removed', 'pin': 'pinned', 'unpin': 'unpinned' };

function start(doc, home) {
  let last = null;
  let first = true;
  const cards = doc.getElementById('cards');
  const summary = doc.getElementById('summary');
  const notice = doc.getElementById('notice');
  const box = doc.getElementById('filter');
  // The page's own state, drawn into every render so a push never drops it: the card asking to stop (H8), the open New lane form
  // with what was typed, and each card's last note.
  const ui = { confirm: null, laneForm: null, notes: {} };
  function render() {
    const typing = doc.activeElement && doc.activeElement.getAttribute && doc.activeElement.getAttribute('data-field') === 'name';
    cards.innerHTML = cardsHtml(last, ui);
    if (ui.laneForm && typing) {
      const input = cards.querySelector('input[data-field="name"]');
      if (input) { input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n); } catch { /* not a text input */ } }
    }
  }
  const focusName = () => { const input = cards.querySelector('input[data-field="name"]'); if (input) input.focus(); };
  home.onModel((p) => {
    last = p;
    render();
    summary.textContent = summaryText(p && p.summary);
    // the first payload sets the box to main's filter, so the two agree (PR #263 Dexter 1); a later one never fights the typing
    if (first) { first = false; if (p && typeof p.filter === 'string') box.value = p.filter; }
  });

  function stopConfirmed(key, c) {
    const asked = c && isCount(c.sessions) ? c.sessions : 0;
    ui.confirm = null;
    ui.notes[key] = `Stopping ${plural(asked, 'session')}…`;
    render();
    // the second click (H8): main refuses a stop that does not carry it
    Promise.resolve(home.act({ action: 'stop-sessions', key, confirmed: true }))
      .then((r) => stopNote(r, asked), () => stopNote(null, asked))
      .then((text) => { ui.notes[key] = text; render(); });
  }

  function createLane(key) {
    const f = ui.laneForm;
    if (!f || f.key !== key) return;
    const typed = f.name.trim();
    const branch = HAS_PREFIX.test(typed) ? typed : `${f.prefix}${typed}`;
    ui.laneForm = null;
    ui.notes[key] = `Creating ${branch}… Its window shows the progress.`;
    render();
    Promise.resolve(home.act({ action: 'new-lane', key, branch })).then((r) => r, () => null).then((r) => {
      if (r && r.ok === true) {
        ui.notes[key] = `${typeof r.branch === 'string' && r.branch ? r.branch : branch} opened in its window.`;
      } else {
        ui.notes[key] = `The lane was not made: ${r && typeof r.error === 'string' && r.error ? r.error : 'no answer'}`;
        ui.laneForm = { key, prefix: f.prefix, name: f.name };     // back, with what was typed, so it can be fixed
      }
      render();
    });
  }

  // the card's own controls: they change the page's state and ask main nothing until Stop or Create
  function pageAct(t, c) {
    switch (t.action) {
      case 'stop-sessions': ui.confirm = t.key; ui.laneForm = null; delete ui.notes[t.key]; render(); return true;
      case 'stop-cancel': ui.confirm = null; render(); return true;
      case 'stop-confirm': stopConfirmed(t.key, c); return true;
      case 'new-lane': ui.laneForm = { key: t.key, prefix: PREFIXES[0], name: '' }; ui.confirm = null; delete ui.notes[t.key]; render(); focusName(); return true;
      case 'lane-cancel': ui.laneForm = null; render(); return true;
      case 'lane-create': createLane(t.key); return true;
      default: return false;
    }
  }

  const fieldEvent = (e) => {
    const field = e.target && e.target.getAttribute ? e.target.getAttribute('data-field') : null;
    if (!ui.laneForm || (field !== 'prefix' && field !== 'name')) return;
    ui.laneForm[field] = String(e.target.value);
  };
  cards.addEventListener('input', fieldEvent);
  cards.addEventListener('change', fieldEvent);
  cards.addEventListener('keydown', (e) => {
    if (!ui.laneForm || !e.target || !e.target.getAttribute || e.target.getAttribute('data-field') !== 'name') return;
    if (e.key === 'Enter') { e.preventDefault(); ui.laneForm.name = String(e.target.value); createLane(ui.laneForm.key); }
    else if (e.key === 'Escape') { e.preventDefault(); ui.laneForm = null; render(); }
  });

  cards.addEventListener('click', (e) => {
    const t = clickTarget(e.target);
    if (!t) return;
    const c = last && Array.isArray(last.cards) ? last.cards.find((x) => x.key === t.key) : null;
    if (pageAct(t, c)) return;
    const name = c ? c.label : 'The project';
    notice.textContent = '';
    // said from main's answer, never before it (PR #263 Miguel Y3): act is an invoke
    Promise.resolve(home.act(t)).then((r) => {
      if (r && r.ok === true) {
        if (t.action === 'remove') notice.textContent = `${name} removed from the list. Its folder is not touched.`;
      } else if (NOT_DONE[t.action]) {
        notice.textContent = `${name} was not ${NOT_DONE[t.action]}: ${r && typeof r.error === 'string' ? r.error : 'no answer'}.`;
      }
    }, () => { if (NOT_DONE[t.action]) notice.textContent = `${name} was not ${NOT_DONE[t.action]}: no answer.`; });
  });
  box.addEventListener('input', (e) => home.act({ action: 'filter', text: String(e.target.value) }));
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
