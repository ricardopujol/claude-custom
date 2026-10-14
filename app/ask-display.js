'use strict';
/**
 * The "Ask the repo" panel (BACKLOG #33, DESIGN_ASK_REPO.md "The design, in full" + Round 8): a dock tab, 360 px, that explains and
 * finds code with a local model (or Haiku / Sonnet through the real claude CLI), named and pictured by its owner.
 *
 *   mount({ doc, root, request, openAt, storage, setTimer, clearTimer, getSelection, pickPortrait, imagesEnabled }) ->
 *     { show(), hide(), ask(question), explainSelection({ file, start, end }), state(), profile(), probe(action, args) }
 *
 *   request(op, body) -> Promise<reply>   app/ask-requester.js, over the tab's own host socket; the page never names a worktree
 *   openAt(file, line)                     opens the code reader (#32) at that line
 *
 * WHAT THE PERSON SEES, in the order the design gives it: the naming card on first use (a pre-filled name with chips, a portrait);
 * the empty panel (two steps, a box, three real example questions, the model / index line); a waiting view that shows the "Where to
 * look" cards the moment the search returns, with three named steps and a placeholder where the words go; an answer (the idea at the
 * person's level, then the cards; Simpler / Deeper; Ask Claude instead; highlight words and "What's this?" again, with a breadcrumb);
 * and honest notes: Ollama down or the model missing (the places still show, with Start Ollama and Ask Claude instead), the first
 * index with its progress, and "explaining is off on this model" until that model has passed the quality bar (host/ask-models.js).
 *
 * The pure half (what to show) is app/ask-panel-state.js and what the panel DOES is app/ask-controller.js; this file draws it. Everything from the host or the model
 * is escaped; every control is a <button> (data-act), and the body is rebuilt from state, so the page holds nothing it cannot rebuild.
 * The question box and the About-me / name boxes are NOT rebuilt while the person types in them.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askDisplay`.
 */
(function (root) {

const S = typeof module !== 'undefined' && module.exports ? require('./ask-panel-state') : root.askPanelState;
const P = typeof module !== 'undefined' && module.exports ? require('./ask-profile') : root.askProfile;

const LEVELS = Object.freeze([
  { id: 'new', label: 'New to coding' },
  { id: 'learning', label: 'Learning this language' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'expert', label: 'Expert' },
]);
const CARD_LINES = 4;
const MIN_HIGHLIGHT = 2;
const MAX_HIGHLIGHT = 120;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';

// ---- the words of an answer ---------------------------------------------------------------------------------------------------

const CITE = /([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9]+):(\d{1,7})(?:[-–](\d{1,7}))?/g;

/** An answer's text as safe HTML: paragraphs and bullets, `code`, **bold**, and file:line made clickable ONLY for a place we know. */
function formatText(text, files) {
  const known = files instanceof Set ? files : new Set();
  const inline = (raw) => {
    let h = esc(raw);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return h.replace(/([A-Za-z0-9_@./\\-]+\.[A-Za-z0-9]+):(\d{1,7})(?:[-–](\d{1,7}))?/g, (all, f, a) => {
      const file = f.replace(/&#39;|&amp;/g, '');
      return known.has(file) ? `<button type="button" class="ask-cite" data-act="open" data-file="${esc(file)}" data-line="${esc(a)}">${all}</button>` : all;
    });
  };
  const out = [];
  let list = null;
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (b) {
      if (!list) { list = []; out.push(list); }
      list.push(b[1]);
    } else if (line.trim() === '') {
      list = null;
    } else {
      list = null;
      out.push(line.replace(/^\s*#{1,6}\s*/, ''));
    }
  }
  return out.map((p) => (Array.isArray(p) ? `<ul>${p.map(li => `<li>${inline(li)}</li>`).join('')}</ul>` : `<p>${inline(p)}</p>`)).join('');
}

function cardHtml(p) {
  const lines = Array.isArray(p.lines) ? p.lines.slice(0, CARD_LINES) : [];
  const code = lines.map(l => `<span class="ask-ln">${esc(l.n)}</span>${esc(l.text)}`).join('\n');
  const end = Number.isInteger(p.endLine) && p.endLine > p.line ? `-${p.endLine}` : '';
  return `<button type="button" class="ask-card" data-act="open" data-file="${esc(p.file)}" data-line="${esc(p.line)}">`
    + `<span class="ask-card-where">${esc(p.file)}:${esc(p.line)}${esc(end)}</span>`
    + (isStr(p.why) && p.why ? `<span class="ask-card-why">${esc(p.why)}</span>` : '')
    + (code ? `<pre class="ask-card-code">${code}</pre>` : '')
    + '</button>';
}

function cardsHtml(places, title) {
  if (!Array.isArray(places) || !places.length) return '';
  return `<section class="ask-places" aria-label="${esc(title)}"><h4 class="ask-h">${esc(title)}</h4>${places.map(cardHtml).join('')}</section>`;
}

// The explainer's face is an AGENT's picture, drawn by the same code as the roster's faces (app/portrait-media-display.js), so the tier
// wording, the "agent images off" switch and the placeholder behave exactly as they do there. The host sends the results (status.portraits).
const PM = typeof module !== 'undefined' && module.exports ? require('./portrait-media-display') : root.portraitMedia;

/** The portrait result the profile points at: a chosen agent's picture, else the explainer's own; null until the host has said. */
function portraitResult(portrait, host) {
  const ps = isObj(host) && isObj(host.portraits) ? host.portraits : null;
  if (!ps) return null;
  if (portrait && portrait.kind === 'agent' && Array.isArray(ps.suggestions)) {
    const s = ps.suggestions.find(x => isObj(x) && x.agent === portrait.agent);
    if (s && isObj(s.portrait)) return s.portrait;
  }
  return isObj(ps.own) ? ps.own : null;
}

function faceHtml(result, images) {
  return result ? PM.faceMediaHtml(result, { imagesEnabled: images !== false }) : '';
}

function portraitHtml(profile, host, images) {
  return `<span class="ask-portrait" aria-hidden="true">${faceHtml(portraitResult(profile.portrait, host), images) || '·'}</span>`;
}

const whereOf = (host, id) => {
  const m = isObj(host) && Array.isArray(host.models) ? host.models.find(x => isObj(x) && x.id === id) : null;
  return m && isStr(m.where) ? m.where : (id === 'local' ? 'local' : id);
};
const modelNameOf = (host, id) => {
  const m = isObj(host) && Array.isArray(host.models) ? host.models.find(x => isObj(x) && x.id === id) : null;
  return m && isStr(m.model) ? m.model : id;
};
const labelOf = (profile, host) => `${profile.name ? profile.name + ' · ' : ''}${whereOf(host, profile.model)}`;

// ---- the views ----------------------------------------------------------------------------------------------------------------

function headerHtml(m) {
  const { profile, host } = m;
  if (!profile.named) return '<div class="ask-head"><span class="ask-title">Ask the repo</span></div>';
  const lvl = LEVELS.find(l => l.id === profile.level) || LEVELS[2];
  const explains = S.canExplain(host, profile.model);
  return `<div class="ask-head">${portraitHtml(profile, host, m.images)}<div class="ask-head-text"><span class="ask-label">${esc(labelOf(profile, host))}</span>`
    + (explains ? `<span class="ask-for">explaining for: ${esc(lvl.label)} · <button type="button" class="ask-link" data-act="settings">change</button></span>` : '')
    + '</div><button type="button" class="ask-gear" data-act="settings" title="Name, level, About me and model" aria-label="Settings" aria-expanded="'
    + (m.ui.settings ? 'true' : 'false') + '">⚙</button></div>';
}

function namingHtml(m) {
  const d = m.ui.naming;
  const chips = P.NAME_SUGGESTIONS.map(n => `<button type="button" class="ask-chip${d.name === n ? ' on' : ''}" data-act="chip" data-name="${esc(n)}">${esc(n)}</button>`).join('');
  // The agents' picker: the explainer's own picture first (an upload, or what the agents fall back to; a click opens the OS file picker),
  // then the agents' generated pictures to choose from.
  const ps = isObj(m.host) && isObj(m.host.portraits) ? m.host.portraits : { own: null, suggestions: [] };
  const own = `<button type="button" class="ask-face ask-upload${d.portrait.kind === 'upload' ? ' on' : ''}" data-act="upload" title="Choose your own picture, GIF or video">${faceHtml(isObj(ps.own) ? ps.own : null, m.images) || '＋'}</button>`;
  const faces = (Array.isArray(ps.suggestions) ? ps.suggestions : []).map(s => `<button type="button" class="ask-face${d.portrait.kind === 'agent' && d.portrait.agent === s.agent ? ' on' : ''}" data-act="face" data-agent="${esc(s.agent)}" title="${esc(s.agent)}" aria-label="Picture of ${esc(s.agent)}">${faceHtml(s.portrait, m.images)}</button>`).join('');
  return '<section class="ask-naming"><h3 class="ask-h3">Name your explainer</h3>'
    + '<p class="ask-note">It explains code for you. Pick a name and a face (one of the agents\' pictures, or your own); you can change both later in ⚙.</p>'
    + `<input class="ask-input" id="ask-name" type="text" maxlength="${P.NAME_MAX}" value="${esc(d.name)}" aria-label="Name" autocomplete="off">`
    + `<div class="ask-chips">${chips}</div><div class="ask-faces">${own}${faces}</div>`
    + (d.error ? `<p class="ask-bad">${esc(d.error)}</p>` : '')
    + '<button type="button" class="ask-primary" data-act="name-save">Save</button></section>';
}

function settingsHtml(m) {
  const { profile, host } = m;
  const lv = LEVELS.map(l => `<option value="${l.id}"${l.id === profile.level ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
  const models = (isObj(host) && Array.isArray(host.models) && host.models.length ? host.models : [{ id: 'local', model: 'local' }, { id: 'haiku', model: 'Haiku' }, { id: 'sonnet', model: 'Sonnet' }])
    .map(x => `<option value="${esc(x.id)}"${x.id === profile.model ? ' selected' : ''}>${esc(x.id === 'local' ? `Local (${x.model})` : `${x.model} (Claude, uses your plan)`)}${x.explainer ? '' : ' - explaining off'}</option>`).join('');
  return '<section class="ask-settings"><h4 class="ask-h">Settings</h4>'
    + `<label class="ask-field">Name<input class="ask-input" id="ask-set-name" type="text" maxlength="${P.NAME_MAX}" value="${esc(profile.name)}" autocomplete="off"></label>`
    + `<label class="ask-field">Explain for<select class="ask-input" id="ask-set-level">${lv}</select></label>`
    + `<label class="ask-field">About me (optional)<textarea class="ask-input" id="ask-set-about" rows="3" maxlength="${P.ABOUT_ME_MAX}" placeholder="e.g. learning Python, background in C# audio: comparisons come from there">${esc(profile.aboutMe)}</textarea></label>`
    + `<label class="ask-field">Model<select class="ask-input" id="ask-set-model">${models}</select></label>`
    + '<p class="ask-note">A Claude model answers through your own claude sign-in and uses your plan. Nothing is sent to anything else.</p>'
    + '<div class="ask-row"><button type="button" class="ask-primary" data-act="settings-save">Save</button><button type="button" class="ask-link" data-act="rename">Change portrait</button></div></section>';
}

function emptyHtml(m) {
  const ex = S.examplesOf(m.host).map(q => `<li><button type="button" class="ask-example" data-act="example" data-q="${esc(q)}">${esc(q)}</button></li>`).join('');
  return '<section class="ask-empty"><ol class="ask-steps"><li>Select code in a file (Files tab).</li><li>Click <b>What\'s this?</b> beside it.</li></ol>'
    + '<p class="ask-note">Or type a question below. For example:</p>'
    + `<ul class="ask-examples">${ex}</ul></section>`;
}

function stagesHtml(entry, modelId) {
  return `<ol class="ask-stages" aria-live="polite">${S.stagesOf(entry, modelId).map(s => `<li class="ask-stage ${s.state}">${esc(s.text)}</li>`).join('')}</ol>`;
}

function trailHtml(trail) {
  if (trail.length < 2) return '';
  return `<nav class="ask-trail" aria-label="Where you've drilled to">${trail.map((t, i) => (i === trail.length - 1
    ? `<span class="ask-trail-now">${esc(t.label)}</span>`
    : `<button type="button" class="ask-link" data-act="goto" data-id="${t.id}">${esc(t.label)}</button><span class="ask-sep">›</span>`)).join('')}</nav>`;
}

function waitingHtml(m) {
  const e = m.entry;
  return `<section class="ask-wait">${trailHtml(m.trail)}<h4 class="ask-h">${esc(e.label)}</h4>${stagesHtml(e, e.model)}`
    + cardsHtml(e.places, 'Where to look')
    + '<div class="ask-placeholder" aria-hidden="true"><i></i><i></i><i></i></div></section>';
}

function answerHtml(m) {
  const e = m.entry;
  const r = e.reply;
  const files = new Set((e.places || []).map(p => p.file));
  const canDrill = e.kind === 'explain' || S.canExplain(m.host, e.model);
  const note = [];
  if (r.keywordOnly === true) note.push('answered from keyword search only (no embedding model)');
  if (r.stale === true) note.push('the index may be a little behind your latest edits');
  if (r.dropped && r.dropped.length) note.push(`${r.dropped.length} cited place${r.dropped.length === 1 ? '' : 's'} could not be checked and ${r.dropped.length === 1 ? 'was' : 'were'} left out`);
  const reasked = isStr(e.request && e.request.direction);
  const actions = (e.kind === 'explain' && S.canExplain(m.host, e.model)
    ? `<button type="button" class="ask-chip" data-act="reask" data-dir="simpler"${reasked ? ' disabled' : ''}>Simpler</button><button type="button" class="ask-chip" data-act="reask" data-dir="deeper"${reasked ? ' disabled' : ''}>Deeper</button>` : '')
    + (m.profile.model === 'local' ? '<button type="button" class="ask-chip" data-act="ask-claude" title="Ask the same thing of Claude (uses your plan, only on this click)">Ask Claude instead</button>' : '');
  return `<section class="ask-answer-wrap">${trailHtml(m.trail)}<h4 class="ask-h">${esc(e.label)}</h4>`
    + `<div class="ask-answer" data-answer="${e.id}">${formatText(r.text, files)}</div>`
    + (canDrill ? `<div class="ask-highlight" hidden><button type="button" class="ask-chip" data-act="drill">What's this? <span class="ask-hl-text"></span></button></div>` : '')
    + `<div class="ask-actions">${actions}</div>`
    + (note.length ? `<p class="ask-note">${esc(note.join('; '))}.</p>` : '')
    + `<p class="ask-from">${esc(labelOf({ ...m.profile, model: e.model }, m.host))}</p>`
    + cardsHtml(e.places, 'Where to look') + '</section>';
}

function noteHtml(m) {
  const e = m.entry;
  const n = S.noticeOf(e.reply, { name: m.profile.name, kind: e.kind, modelId: e.model, modelName: modelNameOf(m.host, e.model), hasPlaces: Array.isArray(e.places) && e.places.length > 0 });
  const prog = e.reply && e.reply.reason === 'index-building' ? S.indexLine({ state: 'building', progress: e.reply.progress }) : null;
  const text = prog ? prog.text.charAt(0).toUpperCase() + prog.text.slice(1) + '.' : n.text;
  const acts = prog ? [] : n.actions;
  return `<section class="ask-note-wrap">${trailHtml(m.trail)}<h4 class="ask-h">${esc(e.label)}</h4>`
    + `<p class="ask-notice" role="status">${esc(text)}</p>`
    + (acts.length ? `<div class="ask-actions">${acts.map(a => `<button type="button" class="ask-chip" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>` : '')
    + (m.ui.startMsg ? `<p class="ask-note">${esc(m.ui.startMsg)}</p>` : '')
    + cardsHtml(e.places, 'Where to look') + '</section>';
}

function historyHtml(m) {
  const h = m.history;
  if (h.length < 2 && m.view !== 'empty') return '';
  if (!h.length) return '';
  return `<details class="ask-history"><summary>Earlier this session (${h.length})</summary><ul>${h.map(e => `<li><button type="button" class="ask-link" data-act="goto" data-id="${e.id}">${esc(e.label)}</button></li>`).join('')}</ul></details>`;
}

function bodyHtml(m) {
  let main;
  if (m.view === 'naming') main = namingHtml(m);
  else if (m.view === 'empty') main = emptyHtml(m);
  else if (m.view === 'waiting') main = waitingHtml(m);
  else if (m.view === 'answer') main = answerHtml(m);
  else main = noteHtml(m);
  const hostNote = m.hostError ? `<p class="ask-bad" role="status">${esc(m.hostError)}</p>` : '';
  return hostNote + (m.ui.settings && m.profile.named ? settingsHtml(m) : '') + main + (m.view === 'naming' ? '' : historyHtml(m));
}

function footHtml(m) {
  if (!m.profile.named) return '';
  const idx = S.statusLine(m.host, m.profile.model);
  return `<div class="ask-status">${esc(idx)}</div>`;
}

// ---- mounting -----------------------------------------------------------------------------------------------------------------

function mount({
  doc, root: host, request, openAt, storage = null, setTimer, clearTimer, getSelection = null, pickPortrait = null, imagesEnabled = () => true,
} = {}) {
  const Controller = typeof module !== 'undefined' && module.exports ? require('./ask-controller') : root.askController;
  const timers = setTimer ? { setTimer, clearTimer } : {};

  host.innerHTML = '<div class="ask-root"><div class="ask-top"></div><div class="ask-body" tabindex="-1"></div><div class="ask-foot"></div>'
    + '<form class="ask-form" autocomplete="off"><input class="ask-q" type="text" maxlength="500" placeholder="Ask about this repo..." aria-label="Ask about this repo">'
    + '<button type="submit" class="ask-go">Ask</button></form></div>';
  const $ = (sel) => host.querySelector(sel);
  const top = $('.ask-top');
  const body = $('.ask-body');
  const foot = $('.ask-foot');
  const form = $('.ask-form');
  const input = $('.ask-q');

  let highlighted = '';

  const ctl = Controller.create({ request, storage, pickPortrait, onChange: () => paint(), ...timers });

  function paint() {
    const m = { ...ctl.state(), images: imagesEnabled() === true };
    top.innerHTML = headerHtml(m);
    body.innerHTML = bodyHtml(m);
    foot.innerHTML = footHtml(m);
    form.hidden = !m.profile.named;
    wireHighlight();
  }

  // ---- highlight inside an answer -> "What's this?" again -------------------------------------------------------------------
  function readHighlight() {
    if (typeof getSelection !== 'function') return '';
    const sel = getSelection();
    if (!sel || sel.isCollapsed || typeof sel.toString !== 'function') return '';
    const answer = body.querySelector('.ask-answer');
    const anchor = sel.anchorNode;
    if (!answer || !anchor || !answer.contains(anchor)) return '';
    const t = sel.toString().replace(/\s+/g, ' ').trim();
    return t.length >= MIN_HIGHLIGHT && t.length <= MAX_HIGHLIGHT ? t : '';
  }
  function showHighlight() {
    highlighted = readHighlight();
    const bar = body.querySelector('.ask-highlight');
    if (!bar) return;
    bar.hidden = highlighted === '';
    const span = bar.querySelector('.ask-hl-text');
    if (span) span.textContent = highlighted ? `"${highlighted.length > 28 ? highlighted.slice(0, 27) + '…' : highlighted}"` : '';
  }
  function wireHighlight() {
    highlighted = '';
    const answer = body.querySelector('.ask-answer');
    if (!answer) return;
    const soon = () => { Promise.resolve().then(showHighlight); };
    answer.addEventListener('mouseup', soon);
    answer.addEventListener('keyup', soon);
  }

  // ---- clicks ---------------------------------------------------------------------------------------------------------------
  const actOf = (target) => {
    const el = target && target.closest ? target.closest('[data-act]') : null;
    return el ? { el, act: el.getAttribute('data-act') } : null;
  };
  const dataOf = (el, k) => el.getAttribute('data-' + k);
  const valueOf = (sel) => { const n = body.querySelector(sel); return n ? n.value : undefined; };

  function onClick(e) {
    const hit = actOf(e.target);
    if (!hit) return;
    const { el, act } = hit;
    switch (act) {
      case 'open': if (typeof openAt === 'function') openAt(dataOf(el, 'file'), Number(dataOf(el, 'line'))); break;
      case 'example': ctl.ask(dataOf(el, 'q')); break;
      case 'goto': ctl.select(Number(dataOf(el, 'id'))); break;
      case 'settings': ctl.toggleSettings(); break;
      case 'chip': ctl.setNamingName(dataOf(el, 'name')); paint(); break;
      case 'face': ctl.setNamingName(valueOf('#ask-name')); ctl.setNamingPortrait({ kind: 'agent', agent: dataOf(el, 'agent') }); break;
      case 'upload': ctl.setNamingName(valueOf('#ask-name')); ctl.choosePicture(); break;
      case 'name-save': ctl.setNamingName(valueOf('#ask-name')); ctl.saveNaming(); break;
      case 'rename': ctl.rename(); break;
      case 'settings-save':
        ctl.saveSettings({ name: valueOf('#ask-set-name'), level: valueOf('#ask-set-level'), aboutMe: valueOf('#ask-set-about'), model: valueOf('#ask-set-model') });
        break;
      case 'reask': ctl.reask(dataOf(el, 'dir')); break;
      case 'drill': if (highlighted) ctl.drill(highlighted); break;
      case 'ask-claude': ctl.askClaude(); break;
      case 'start-ollama': ctl.startOllama(); break;
      default: break;
    }
  }
  host.addEventListener('click', onClick);

  form.addEventListener('submit', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const q = input.value;
    input.value = '';
    ctl.ask(q);
  });
  host.addEventListener('input', (e) => {
    if (e && e.target && e.target.id === 'ask-name') ctl.setNamingName(e.target.value);
  });

  paint();

  return {
    show: () => ctl.show(),
    hide: () => ctl.hide(),
    ask: (q) => ctl.ask(q),
    explainSelection: (sel) => ctl.explain(sel),
    profile: () => ctl.state().profile,
    refresh: () => ctl.refreshStatus(),
    repaint: () => paint(),
    state: () => ctl.state(),
    // verify/probe-ask-panel.js: named actions, JSON answers
    probe(action, a) {
      if (action === 'refresh') return ctl.refreshStatus().then(() => ({ ok: true }));
      if (action === 'ask') return Promise.resolve(ctl.ask(a.question, { modelId: a.model })).then(() => ({ ok: true }));
      return { ok: false, error: 'unknown action ' + action };
    },
  };
}

const API = { mount, portraitHtml, portraitResult, formatText, cardHtml, cardsHtml, bodyHtml, headerHtml, namingHtml, emptyHtml, waitingHtml, answerHtml, noteHtml, footHtml, esc, LEVELS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
