'use strict';
/**
 * The "Ask the repo" panel (BACKLOG #33, DESIGN_ASK_REPO.md "The design, in full" + Round 8): a dock tab, 360 px, that explains and
 * finds code with a local model (or Haiku / Sonnet through the real claude CLI), named and pictured by its owner.
 *
 *   mount({ doc, root, request, openAt, storage, setTimer, clearTimer, getSelection, shrinkImage }) ->
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
 * The pure half (what to show) is app/ask-panel-state.js; this file draws it and runs the asks. Everything from the host or the model
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
const POLL_MS = 2500;
const WRITING_AFTER_MS = { local: 4000, claude: 2500 };
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

function portraitHtml(profile) {
  const p = profile.portrait;
  if (p && p.kind === 'image') return `<img class="ask-portrait" alt="" src="${esc(p.dataUrl)}">`;
  return `<span class="ask-portrait ask-portrait-emoji" aria-hidden="true">${esc(p && p.value ? p.value : P.PORTRAITS[0])}</span>`;
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
  return `<div class="ask-head">${portraitHtml(profile)}<div class="ask-head-text"><span class="ask-label">${esc(labelOf(profile, host))}</span>`
    + (explains ? `<span class="ask-for">explaining for: ${esc(lvl.label)} · <button type="button" class="ask-link" data-act="settings">change</button></span>` : '')
    + '</div><button type="button" class="ask-gear" data-act="settings" title="Name, level, About me and model" aria-label="Settings" aria-expanded="'
    + (m.ui.settings ? 'true' : 'false') + '">⚙</button></div>';
}

function namingHtml(m) {
  const d = m.ui.naming;
  const chips = P.NAME_SUGGESTIONS.map(n => `<button type="button" class="ask-chip${d.name === n ? ' on' : ''}" data-act="chip" data-name="${esc(n)}">${esc(n)}</button>`).join('');
  const faces = P.PORTRAITS.map((e, i) => `<button type="button" class="ask-face${d.portrait.kind === 'emoji' && d.portrait.value === e ? ' on' : ''}" data-act="face" data-i="${i}" aria-label="Portrait ${i + 1}">${esc(e)}</button>`).join('');
  const up = d.portrait.kind === 'image' ? `<img class="ask-face on" alt="Your upload" src="${esc(d.portrait.dataUrl)}">` : '';
  return '<section class="ask-naming"><h3 class="ask-h3">Name your explainer</h3>'
    + '<p class="ask-note">It explains code for you. Pick a name and a face; you can change both later in ⚙.</p>'
    + `<input class="ask-input" id="ask-name" type="text" maxlength="${P.NAME_MAX}" value="${esc(d.name)}" aria-label="Name" autocomplete="off">`
    + `<div class="ask-chips">${chips}</div><div class="ask-faces">${faces}${up}<button type="button" class="ask-face ask-upload" data-act="upload" title="Upload a picture">＋</button></div>`
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
  doc, root: host, request, openAt, storage = null, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout,
  getSelection = null, shrinkImage = null,
} = {}) {
  let profile = P.load(storage);
  let st = S.create();
  let hostStatus = null;
  let hostError = null;
  let shown = false;
  let warmed = false;
  let pollTimer = null;
  let pendingExplain = null;
  const ui = { settings: false, naming: { name: P.DEFAULT_NAME, portrait: { kind: 'emoji', value: P.PORTRAITS[0] }, error: '' }, startMsg: '' };
  const timers = new Set();

  host.innerHTML = '<div class="ask-root"><div class="ask-top"></div><div class="ask-body" tabindex="-1"></div><div class="ask-foot"></div>'
    + '<form class="ask-form" autocomplete="off"><input class="ask-q" type="text" maxlength="500" placeholder="Ask about this repo..." aria-label="Ask about this repo">'
    + '<button type="submit" class="ask-go">Ask</button></form></div>';
  const $ = (sel) => host.querySelector(sel);
  const top = $('.ask-top');
  const body = $('.ask-body');
  const foot = $('.ask-foot');
  const form = $('.ask-form');
  const input = $('.ask-q');

  const model = () => {
    const entry = S.current(st);
    return {
      profile, host: hostStatus, hostError, ui, entry, trail: S.trail(st), history: S.history(st), view: S.viewOf(st, profile),
    };
  };

  function paint() {
    const m = model();
    top.innerHTML = headerHtml(m);
    body.innerHTML = bodyHtml(m);
    foot.innerHTML = footHtml(m);
    form.hidden = !profile.named;
    wireHighlight();
  }

  // ---- host status and the first index -----------------------------------------------------------------------------------
  async function refreshStatus(warm) {
    const r = await request('status', warm ? { warm: true } : {});
    if (r && r.ok === true) { hostStatus = r; hostError = null; } else { hostError = (r && r.error) || 'The session did not answer.'; }
    paint();
    schedulePoll();
  }
  function schedulePoll() {
    if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
    const idx = hostStatus && hostStatus.index;
    if (shown && idx && (idx.state === 'building' || idx.state === 'partial')) {
      pollTimer = setTimer(() => { pollTimer = null; refreshStatus(false); }, POLL_MS);
    }
  }

  // ---- asking -------------------------------------------------------------------------------------------------------------
  const later = (fn, ms) => { const t = setTimer(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  async function run(entryId, kind, body0, modelId) {
    const claude = modelId !== 'local';
    const placesBody = { ...body0, model: modelId };
    const q1 = request('places', placesBody).then((r) => {
      st = S.setPlaces(st, entryId, r);
      const e = S.current(st);
      if (e && e.id === entryId) paint();
      if (r && r.ok === true) later(() => { st = S.setStage(st, entryId, 'writing'); paint(); }, claude ? WRITING_AFTER_MS.claude : WRITING_AFTER_MS.local);
    });
    const r = await request(kind === 'explain' ? 'explain' : 'ask', placesBody);
    await q1;
    st = S.finish(st, entryId, r);
    paint();
    if (r && r.ok === false && r.reason === 'index-building') { refreshStatus(false); }
  }

  function startQuestion(question, { parent, modelId, direction } = {}) {
    const q = String(question || '').trim();
    if (!q) return;
    if (!profile.named) return;
    const mid = modelId || profile.model;
    st = S.begin(st, { kind: 'question', label: q, request: { question: q, direction }, parent, model: mid });
    paint();
    return run(S.current(st).id, 'question', { question: q }, mid);
  }

  function startExplain({ file, start, end, term, answer, parent, direction, modelId, label }) {
    if (!profile.named) { pendingExplain = { file, start, end }; paint(); return; }
    const mid = modelId || profile.model;
    const lab = label || (term ? term : `${file}:${start}${end > start ? '-' + end : ''}`);
    if (!S.canExplain(hostStatus, mid)) {
      st = S.begin(st, { kind: 'explain', label: lab, request: { file, start, end }, parent, model: mid });
      st = S.finish(st, S.current(st).id, { ok: false, reason: 'explainer-off' });
      paint();
      return;
    }
    const reqBody = { file, start, end, level: profile.level, aboutMe: profile.aboutMe, ...(term ? { term, answer } : {}), ...(direction ? { direction } : {}) };
    st = S.begin(st, { kind: 'explain', label: lab, request: reqBody, parent, model: mid });
    paint();
    return run(S.current(st).id, 'explain', reqBody, mid);
  }

  // "Ask Claude instead": the same thing, once, of a Claude model (plan quota only on this click).
  function askClaudeInstead() {
    const e = S.current(st);
    if (!e) return;
    const claudeId = profile.model !== 'local' ? profile.model : 'haiku';
    if (e.kind === 'explain') {
      const r = e.request || {};
      if (S.canExplain(hostStatus, claudeId)) return startExplain({ ...r, parent: e.parent, modelId: claudeId, label: e.label });
      return startQuestion(`What is the code in ${r.file} lines ${r.start}-${r.end} doing?`, { parent: e.parent, modelId: claudeId });
    }
    return startQuestion((e.request && e.request.question) || e.label, { parent: e.parent, modelId: claudeId });
  }

  // ---- highlight inside an answer -> "What's this?" again -------------------------------------------------------------------
  let highlighted = '';
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
    const answer = body.querySelector('.ask-answer');
    if (!answer) { highlighted = ''; return; }
    answer.addEventListener('mouseup', () => later(showHighlight, 0));
    answer.addEventListener('keyup', () => later(showHighlight, 0));
  }

  // ---- clicks ---------------------------------------------------------------------------------------------------------------
  function actOf(target) {
    const el = target && target.closest ? target.closest('[data-act]') : null;
    return el ? { el, act: el.getAttribute('data-act') } : null;
  }
  const dataOf = (el, k) => el.getAttribute('data-' + k);

  function saveProfile(next) { profile = next; P.save(storage, profile); }

  function readNaming() {
    const n = body.querySelector('#ask-name');
    if (n) ui.naming.name = n.value;
  }

  async function onClick(e) {
    const hit = actOf(e.target);
    if (!hit) return;
    const { el, act } = hit;
    if (act === 'open') { if (typeof openAt === 'function') openAt(dataOf(el, 'file'), Number(dataOf(el, 'line'))); return; }
    if (act === 'example') { startQuestion(dataOf(el, 'q')); return; }
    if (act === 'goto') { st = S.select(st, Number(dataOf(el, 'id'))); paint(); return; }
    if (act === 'settings') { ui.settings = !ui.settings; paint(); return; }
    if (act === 'chip') { ui.naming.name = dataOf(el, 'name'); paint(); return; }
    if (act === 'face') { readNaming(); ui.naming.portrait = { kind: 'emoji', value: P.PORTRAITS[Number(dataOf(el, 'i'))] }; paint(); return; }
    if (act === 'upload') { await pickImage(); return; }
    if (act === 'name-save') {
      readNaming();
      const r = P.name(profile, ui.naming.name, ui.naming.portrait);
      if (!r.ok) { ui.naming.error = 'Give it a name first.'; paint(); return; }
      ui.naming.error = '';
      saveProfile(r.profile);
      const pend = pendingExplain; pendingExplain = null;
      paint();
      if (pend) startExplain(pend);
      return;
    }
    if (act === 'rename') { ui.naming = { name: profile.name || P.DEFAULT_NAME, portrait: profile.portrait, error: '' }; saveProfile({ ...profile, named: false }); ui.settings = false; paint(); return; }
    if (act === 'settings-save') {
      const v = (sel) => { const n = body.querySelector(sel); return n ? n.value : null; };
      let next = profile;
      const nm = P.name(next, v('#ask-set-name') || next.name, next.portrait);
      if (nm.ok) next = nm.profile;
      next = P.setLevel(next, v('#ask-set-level'));
      next = P.setAboutMe(next, v('#ask-set-about') === null ? next.aboutMe : v('#ask-set-about'));
      next = P.setModel(next, v('#ask-set-model') || next.model);
      saveProfile(next);
      ui.settings = false;
      paint();
      return;
    }
    if (act === 'reask') {
      const cur = S.current(st);
      if (cur && cur.kind === 'explain') startExplain({ ...cur.request, direction: dataOf(el, 'dir'), parent: cur.parent, modelId: cur.model, label: cur.label });
      return;
    }
    if (act === 'drill') {
      const cur = S.current(st);
      if (cur && highlighted) {
        const base = cur.kind === 'explain' ? cur.request : null;
        if (base) startExplain({ file: base.file, start: base.start, end: base.end, term: highlighted, answer: cur.reply && cur.reply.text, parent: cur.id, modelId: cur.model });
        else startQuestion(`What is ${highlighted}?`, { parent: cur.id, modelId: cur.model });
      }
      return;
    }
    if (act === 'ask-claude') { askClaudeInstead(); return; }
    if (act === 'start-ollama') {
      ui.startMsg = 'Starting Ollama…';
      paint();
      const r = await request('start-ollama', {});
      ui.startMsg = r && r.ok === true ? 'Ollama is starting. Ask again in a few seconds.' : `Couldn't start Ollama${r && (r.reason || r.error) ? ': ' + (r.reason || r.error) : ''}.`;
      paint();
      refreshStatus(false);
    }
  }
  host.addEventListener('click', onClick);

  form.addEventListener('submit', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const q = input.value;
    input.value = '';
    startQuestion(q);
  });
  host.addEventListener('input', (e) => {
    if (e && e.target && e.target.id === 'ask-name') ui.naming.name = e.target.value;
  });

  async function pickImage() {
    readNaming();
    if (typeof shrinkImage !== 'function') return;
    const url = await shrinkImage();
    if (isStr(url)) {
      const probe = P.name(profile, 'x', { kind: 'image', dataUrl: url });
      if (probe.ok && probe.profile.portrait.kind === 'image') { ui.naming.portrait = probe.profile.portrait; ui.naming.error = ''; } else ui.naming.error = 'That picture is too big or not a PNG, JPEG, WebP or GIF.';
      paint();
    }
  }

  paint();

  return {
    show() {
      shown = true;
      if (!warmed) { warmed = true; refreshStatus(true); } else { refreshStatus(false); }
    },
    hide() { shown = false; if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; } },
    ask: (q) => startQuestion(q),
    explainSelection: (sel) => startExplain({ file: sel.file, start: sel.start, end: sel.end }),
    onHostLost(reason) { hostError = reason || 'The session connection dropped.'; paint(); },
    profile: () => profile,
    state: () => ({ view: S.viewOf(st, profile), entry: S.current(st), trail: S.trail(st), history: S.history(st), host: hostStatus, hostError, profile, ui: { ...ui, naming: { ...ui.naming } } }),
    // verify/probe-ask-panel.js: named actions, JSON answers
    probe(action, a) {
      if (action === 'refresh') return refreshStatus(false).then(() => ({ ok: true }));
      if (action === 'ask') return startQuestion(a.question, { modelId: a.model }).then(() => ({ ok: true }));
      if (action === 'explain') return startExplain({ file: a.file, start: a.start, end: a.end, modelId: a.model }).then(() => ({ ok: true }));
      return { ok: false, error: 'unknown action ' + action };
    },
  };
}

const API = { mount, formatText, cardHtml, cardsHtml, bodyHtml, headerHtml, namingHtml, emptyHtml, waitingHtml, answerHtml, noteHtml, esc, LEVELS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
