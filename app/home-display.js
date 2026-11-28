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
// ONE length rule with main (app/home-controller.js MAX_BRANCH): the whole branch is at most 120, so the name box takes 120 less the
// longest type, and a name typed with its own type is checked whole (PR #265 Dexter 9, Miguel G3).
const MAX_BRANCH = 120;
const NAME_MAX = MAX_BRANCH - Math.max(...PREFIXES.map((p) => p.length));
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
// The number is main's answer to the ask (the sessions it read and bound to the token), never the card's older count.
function confirmHtml(c, ask) {
  const n = ask && isCount(ask.count) ? ask.count : 0;
  return `<div class="confirm"><span class="question">${esc(`Stop ${plural(n, 'session')} in ${c.label}?`)}</span>`
    + '<button data-act="stop-confirm" class="danger">Stop</button><button data-act="stop-cancel">Cancel</button></div>';
}

function laneFormHtml(form) {
  const opts = PREFIXES.map((p) => `<option value="${esc(p)}"${p === form.prefix ? ' selected' : ''}>${esc(p)}</option>`).join('');
  return `<div class="lane-form"><select data-field="prefix" aria-label="Branch type">${opts}</select>`
    + `<input data-field="name" type="text" maxlength="${NAME_MAX}" spellcheck="false" placeholder="my-change" aria-label="Branch name" value="${esc(form.name)}">`
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
  if (u.confirm && u.confirm.key === c.key && acts.includes('stop-sessions')) return confirmHtml(c, u.confirm);
  const form = u.forms && Object.prototype.hasOwnProperty.call(u.forms, c.key) ? u.forms[c.key] : null;
  if (form && acts.includes('new-lane')) return laneFormHtml(form);
  return `<div class="actions">${acts.map(buttonHtml).join('')}</div>`;
}

/** The cards; `ui` is the page's own state: { confirm: { key, token, count }, forms: { key: { prefix, name } }, notes: { key: text } }. */
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
  const ui = { confirm: null, forms: {}, notes: {} };
  const shownCards = () => (last && Array.isArray(last.cards) && !(typeof last.empty === 'string' && last.empty) ? last.cards : []);
  const cardOf = (key) => shownCards().find((x) => x.key === key) || null;
  const offers = (key, action) => { const c = cardOf(key); return !!c && Array.isArray(c.actions) && c.actions.includes(action); };
  const nodeOf = (key) => [...cards.children].find((n) => n.getAttribute && n.getAttribute('data-key') === key) || null;

  // A question or a form whose card lost the action is dropped, so it never comes back by itself (PR #265 Dexter 7, Miguel G4).
  function prune() {
    if (ui.confirm && !offers(ui.confirm.key, 'stop-sessions')) ui.confirm = null;
    for (const key of Object.keys(ui.forms)) if (!offers(key, 'new-lane')) delete ui.forms[key];
  }

  // Each card is drawn on its own. A card whose New lane form is open keeps its element (the form, its focus, its caret, an IME
  // composition: Miguel Y2); only its status line and its note follow the push. The other cards are drawn fresh.
  function render() {
    prune();
    const list = shownCards();
    if (list.length === 0) { cards.innerHTML = cardsHtml(last, ui); return; }
    const tpl = doc.createElement('template');
    const wanted = list.map((c) => {
      const old = nodeOf(c.key);
      tpl.innerHTML = cardHtml(c, last.now, ui);
      const fresh = tpl.content.firstElementChild;
      if (old && ui.forms[c.key] && old.querySelector('.lane-form')) {
        const swap = (sel) => {
          const a = old.querySelector(sel);
          const b = fresh.querySelector(sel);
          if (a && b) a.replaceWith(b); else if (a) a.remove(); else if (b) old.appendChild(b);
        };
        swap('.status');
        swap('.card-note');
        old.className = fresh.className;
        return old;
      }
      return fresh;
    });
    wanted.forEach((node, i) => { if (cards.children[i] !== node) cards.insertBefore(node, cards.children[i] || null); });
    while (cards.children.length > wanted.length) cards.lastElementChild.remove();
  }
  const focusName = (key) => { const n = nodeOf(key); const input = n && n.querySelector('input[data-field="name"]'); if (input) input.focus(); };
  home.onModel((p) => {
    last = p;
    render();
    summary.textContent = summaryText(p && p.summary);
    // the first payload sets the box to main's filter, so the two agree (PR #263 Dexter 1); a later one never fights the typing
    if (first) { first = false; if (p && typeof p.filter === 'string') box.value = p.filter; }
  });

  // H8, the first click: main reads the card's sessions now and answers how many, with the token the second click must carry
  function askStop(key) {
    ui.confirm = null;
    delete ui.forms[key];
    delete ui.notes[key];
    render();
    Promise.resolve(home.act({ action: 'stop-ask', key })).then((r) => r, () => null).then((r) => {
      if (r && r.ok === true && typeof r.token === 'string' && isCount(r.count)) ui.confirm = { key, token: r.token, count: r.count };
      else ui.notes[key] = stopNote(r, 0);
      render();
    });
  }

  function stopConfirmed(key) {
    const ask = ui.confirm && ui.confirm.key === key ? ui.confirm : null;
    if (!ask) return;
    ui.confirm = null;
    ui.notes[key] = `Stopping ${plural(ask.count, 'session')}…`;
    render();
    // the second click: it carries the question's token, and main stops only the sessions that question named
    Promise.resolve(home.act({ action: 'stop-sessions', key, token: ask.token }))
      .then((r) => stopNote(r, ask.count), () => stopNote(null, ask.count))
      .then((text) => { ui.notes[key] = text; render(); });
  }

  function createLane(key) {
    const f = ui.forms[key];
    if (!f) return;
    const typed = f.name.trim();
    const branch = HAS_PREFIX.test(typed) ? typed : `${f.prefix}${typed}`;
    // refused here, before anything opens, with the reason main would give (PR #265 Dexter 4, 9, Miguel G3)
    const refused = !typed || /\/$/.test(branch) ? 'Type a name after the branch type.'
      : branch.length > MAX_BRANCH ? `A branch name is at most ${MAX_BRANCH} characters.` : null;
    if (refused) { ui.notes[key] = refused; render(); focusName(key); return; }
    delete ui.forms[key];
    ui.notes[key] = `Creating ${branch}… Its window shows the progress.`;
    render();
    Promise.resolve(home.act({ action: 'new-lane', key, branch })).then((r) => r, () => null).then((r) => {
      const made = typeof (r && r.branch) === 'string' && r.branch ? r.branch : branch;
      const why = r && typeof r.error === 'string' && r.error ? r.error : 'no answer';
      if (r && r.ok === true) {
        ui.notes[key] = `${made} opened in its window.`;
      } else if (r && r.made === true) {
        ui.notes[key] = `${made} opened in its window, but ${why.replace(/\.+$/, '')}.`;   // made: no form to fix (Miguel G6)
      } else {
        ui.notes[key] = `The lane was not made: ${why}`;
        // back on THIS card only, with what was typed, so it can be fixed (Dexter 8); a form opened again meanwhile wins
        if (!ui.forms[key]) ui.forms[key] = { prefix: f.prefix, name: f.name };
      }
      render();
    });
  }

  // the card's own controls: they change the page's state and ask main nothing until Stop or Create
  function pageAct(t, c) {
    switch (t.action) {
      case 'stop-sessions': askStop(t.key); return true;
      case 'stop-cancel': ui.confirm = null; render(); return true;
      case 'stop-confirm': stopConfirmed(t.key); return true;
      case 'new-lane':
        ui.forms[t.key] = { prefix: PREFIXES[0], name: '' };
        if (ui.confirm && ui.confirm.key === t.key) ui.confirm = null;
        delete ui.notes[t.key];
        render();
        focusName(t.key);
        return true;
      case 'lane-cancel': delete ui.forms[t.key]; render(); return true;
      case 'lane-create': createLane(t.key); return true;
      default: return false;
    }
  }

  // the form a field belongs to: its card's (Dexter 8)
  const formFor = (el) => {
    const card = el && typeof el.closest === 'function' ? el.closest('[data-key]') : null;
    const key = card ? card.getAttribute('data-key') : null;
    return key && ui.forms[key] ? { key, form: ui.forms[key] } : null;
  };
  const fieldEvent = (e) => {
    const field = e.target && e.target.getAttribute ? e.target.getAttribute('data-field') : null;
    const f = formFor(e.target);
    if (!f || (field !== 'prefix' && field !== 'name')) return;
    f.form[field] = String(e.target.value);
  };
  cards.addEventListener('input', fieldEvent);
  cards.addEventListener('change', fieldEvent);
  cards.addEventListener('keydown', (e) => {
    if (!e.target || !e.target.getAttribute || e.target.getAttribute('data-field') !== 'name') return;
    const f = formFor(e.target);
    if (!f) return;
    if (e.key === 'Enter') { e.preventDefault(); f.form.name = String(e.target.value); createLane(f.key); }
    else if (e.key === 'Escape') { e.preventDefault(); delete ui.forms[f.key]; render(); }
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
