'use strict';
/**
 * Claude's panel as a dock module (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md): pure decisions and HTML strings,
 * the app/resources-display.js pattern. renderer.js wires the frames, the clicks and the native view.
 *
 * WHAT IS DRAWN HERE, AND WHAT IS NOT. The page Claude wrote is not drawn by this app's page at all: it is a sealed native
 * view that main lays over `#canvas-slot` (app/canvas-views.js). This draws the frame around it: the header and its host
 * badge, the empty state, the too-big note, the question "this panel wants to reach <host>", and the host list. A native
 * view paints above the page, so while a question or the list is up there is NO slot: `covered` tells main to hide the view
 * and the overlay is drawn in its place.
 *
 * STATE: `{ payload, html, htmlSig, asks, hostsOpen, note }`, changed only through the functions below (each returns a new
 * one). `payload` is the host's last `canvas` frame (never the page); `html` arrives only when asked for, and is used only
 * while its signature is the payload's (a stale page is never shown as if it were current).
 *
 * Every host string is somebody else's: the page chose it. All of them are escaped.
 *
 * WRAPPED IN AN IIFE: the renderer loads scripts as plain <script> tags sharing one global scope (CLAUDE.md, the first
 * trap). One name leaves it: `canvasDisplay`.
 */
(function (root) {

// The words come from app/submit-gate.js (loaded before this file in the renderer): one copy of "typed, press Enter" and of the
// cleared-draft note, shared with the wand and the Git drawer.
const gate = typeof module !== 'undefined' && module.exports ? require('./submit-gate') : root.submitGate;

const MB = 1024 * 1024;
const MESSAGE_MAX = 2000;
// Control characters, the C1 range and the two Unicode line separators: none may be in a button's one line of text.
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + '-' + String.fromCharCode(159)
  + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']');
const STATUSES = ['empty', 'ok', 'toobig', 'unreadable'];
const EXAMPLES = ['a list of every artifact you publish', 'a clock with Santiago and UTC', 'a button that checks my Claude quota'];

const isStr = v => typeof v === 'string';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);
const plural = (n, one, many) => (n === 1 ? one : many);
const mb = (bytes) => { const n = bytes / MB; return Number.isInteger(n) ? String(n) : n.toFixed(1); };

const emptyState = () => ({ payload: null, html: null, htmlSig: null, asks: [], hostsOpen: false, note: null, status: null });

const isPayload = f => f !== null && typeof f === 'object' && (f.sessionId === null || isStr(f.sessionId)) && STATUSES.includes(f.status)
  && typeof f.signature === 'string';

function cleanShelf(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (it === null || typeof it !== 'object' || !isStr(it.title) || it.title === '' || !isStr(it.time) || !isStr(it.url)) continue;
    let u;
    try { u = new URL(it.url); } catch { continue; }
    if (u.protocol === 'https:' && !u.username && !u.password) out.push({ title: it.title, url: it.url, time: it.time });
  }
  return out;
}

/**
 * A `canvas` frame (or the hello's payload). A refusal (`ok:false`) carries the true state and a reason. A new session is an
 * empty panel. A frame carrying html that is not the signature we already know is a stale answer and changes nothing.
 */
function withFrame(state, frame) {
  if (!isPayload(frame)) return state;
  const known = state.payload;
  const sameSession = known !== null && known.sessionId === frame.sessionId;
  if (isStr(frame.html) && sameSession && known.signature !== frame.signature) return state;
  const base = known === null || sameSession ? state : { ...emptyState() };
  const payload = {
    sessionId: frame.sessionId, status: frame.status, bytes: typeof frame.bytes === 'number' ? frame.bytes : 0, signature: frame.signature,
    hosts: { approved: Array.isArray(frame.hosts && frame.hosts.approved) ? frame.hosts.approved.filter(isStr) : [],
      denied: Array.isArray(frame.hosts && frame.hosts.denied) ? frame.hosts.denied.filter(isStr) : [] },
    limitBytes: typeof frame.limitBytes === 'number' ? frame.limitBytes : MB,
    shelf: cleanShelf(frame.shelf),
  };
  let { html, htmlSig } = base;
  if (frame.status !== 'ok') { html = null; htmlSig = null; }
  else if (isStr(frame.html)) { html = frame.html; htmlSig = frame.signature; }
  return { ...base, payload, html, htmlSig, note: frame.ok === false && isStr(frame.reason) ? frame.reason : null };
}

/** Has Claude just written a page into this panel? That, and only that, docks the panel (a resumed page does not). */
const shouldDock = frame => isPayload(frame) && frame.changed === true && (frame.status === 'ok' || frame.status === 'toobig');

const needsFetch = s => !!s.payload && s.payload.status === 'ok' && s.htmlSig !== s.payload.signature;
const canShow = s => !!s.payload && s.payload.status === 'ok' && isStr(s.html) && s.htmlSig === s.payload.signature;
const showRequest = s => (canShow(s) ? { html: s.html, hosts: s.payload.hosts, shelf: s.payload.shelf } : null);
const shelfOf = s => (s.payload ? s.payload.shelf : []);
const shelfKey = s => JSON.stringify(shelfOf(s));
const covered = s => s.asks.length > 0 || s.hostsOpen;

function withAsk(state, ask) {
  if (!ask || !Number.isInteger(ask.id) || ask.id < 0 || !isStr(ask.origin) || ask.origin === '') return state;
  if (state.asks.some(a => a.id === ask.id)) return state;
  return { ...state, asks: [...state.asks, { id: ask.id, origin: ask.origin }] };
}
/**
 * What came of a button's message (typeCommand's / submitTyped's answer): the gate's own words for a message that was typed, and
 * why nothing was typed otherwise. Said on screen, so a click is never unseen.
 */
function typed(state, result) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    const base = isStr(result.flash) && result.flash !== '' ? result.flash : gate.FLASH.typed;
    const cleared = isStr(result.box) && result.box !== '';
    return { ...state, status: { text: base + (cleared ? gate.DRAFT_CLEARED : ''), bad: false } };
  }
  const reason = result !== null && typeof result === 'object' && isStr(result.reason) && result.reason ? result.reason : 'the terminal did not take it';
  return { ...state, status: { text: `didn't type your message from Claude's panel: ${reason}`, bad: true } };
}
const clearStatus = state => ({ ...state, status: null });

/** The one line a button's message becomes in the prompt, or null if it is not a plain one-line message. */
function sessionLine(text) {
  if (!isStr(text)) return null;
  const t = text.trim();
  if (!t || t.length > MESSAGE_MAX || CONTROL.test(t)) return null;
  return `(from Claude's panel) ${t}`;
}

const answered = (state, id) => ({ ...state, asks: state.asks.filter(a => a.id !== id) });
const toggleHosts = (state, open) => ({ ...state, hostsOpen: open === undefined ? !state.hostsOpen : open === true });

// ---- the view -----------------------------------------------------------------------------------------

function view(state) {
  const p = state.payload;
  const hosts = p ? p.hosts : { approved: [], denied: [] };
  let badge = null;
  if (hosts.approved.length) badge = { text: `${hosts.approved.length} ${plural(hosts.approved.length, 'host', 'hosts')} allowed` };
  else if (hosts.denied.length) badge = { text: `${hosts.denied.length} ${plural(hosts.denied.length, 'host', 'hosts')} denied` };
  if (badge) badge.title = 'The websites this panel may reach. Click to see them or take one away.';
  const status = p ? p.status : 'empty';
  const kind = status === 'ok' ? 'page' : status;
  const first = state.asks[0] || null;
  return {
    kind, badge, hosts, hostsOpen: state.hostsOpen, note: state.note,
    status: state.status ? state.status.text : null, statusIsError: state.status ? state.status.bad === true : false,
    ask: first ? { id: first.id, origin: first.origin, more: state.asks.length - 1 } : null,
    loading: kind === 'page' && !canShow(state),
    text: kind === 'toobig' ? `Claude's page is too big (${mb(p.bytes)} MB, the limit is ${mb(p.limitBytes)} MB)` : null,
  };
}

function head(v) {
  const badge = v.badge
    ? `<button type="button" class="cv-badge" data-canvas-act="hosts" aria-expanded="${v.hostsOpen ? 'true' : 'false'}" title="${esc(v.badge.title)}">${esc(v.badge.text)}</button>`
    : '';
  return `<div class="cv-head"><span class="cv-title">Claude's panel</span>${badge}</div>`;
}

function askHtml(a) {
  const more = a.more > 0 ? `<div class="cv-more">${a.more} more waiting</div>` : '';
  return `<div class="cv-ask" role="alertdialog" aria-live="assertive"><p>This panel wants to reach <code>${esc(a.origin)}</code>.</p>`
    + `<div class="cv-ask-btns"><button type="button" class="cv-allow" data-canvas-act="allow" data-canvas-id="${a.id}">Allow for this panel</button>`
    + `<button type="button" class="cv-deny" data-canvas-act="deny" data-canvas-id="${a.id}">Deny</button></div>${more}</div>`;
}

function hostsHtml(hosts) {
  const rows = [...hosts.approved.map(o => ['Allowed', o]), ...hosts.denied.map(o => ['Denied', o])]
    .map(([what, o]) => `<li class="cv-host"><span class="cv-host-name">${esc(o)}</span><span class="cv-host-state">${what}</span>`
      + `<button type="button" class="cv-remove" data-canvas-act="remove" data-canvas-origin="${esc(o)}" aria-label="Remove ${esc(o)}">Remove</button></li>`);
  const body = rows.length ? `<ul class="cv-hosts">${rows.join('')}</ul>` : '<p class="cv-none">No hosts yet. This panel can\'t reach any website until you allow one.</p>';
  return `<div class="cv-list"><h4>Hosts for this panel</h4>${body}<button type="button" class="cv-close" data-canvas-act="close-hosts">Close</button></div>`;
}

function emptyHtml() {
  return '<div class="cv-empty"><p>Nothing here yet. Ask Claude to build something in this panel, for example:</p>'
    + `<ul>${EXAMPLES.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
    + '<p class="cv-sandbox">This panel is sandboxed: it can\'t touch your files, your other tabs or your clipboard, and it only reaches websites you allow.</p></div>';
}

function html(v) {
  let body;
  if (v.ask) body = askHtml(v.ask);
  else if (v.hostsOpen) body = hostsHtml(v.hosts);
  else if (v.kind === 'toobig') body = `<div class="cv-note">${esc(v.text)}</div>`;
  else if (v.kind === 'unreadable') body = '<div class="cv-note">Claude\'s page can\'t be read.</div>';
  else if (v.kind === 'page') body = v.loading ? '<div class="cv-note">Loading…</div>' : '<div id="canvas-slot" class="cv-slot"></div>';
  else body = emptyHtml();
  const note = v.note ? `<div class="cv-error">${esc(v.note)}</div>` : '';
  const status = v.status ? `<div class="cv-status${v.statusIsError ? ' cv-status-bad' : ''}" role="status">${esc(v.status)}</div>` : '';
  return head(v) + status + note + `<div class="cv-body">${body}</div>`;
}

/** A click's data attributes -> an action, or null. Strict: an id is a non-negative integer, an origin a non-empty string. */
function actionOf(data) {
  if (!data || typeof data !== 'object') return null;
  switch (data.canvasAct) {
    case 'allow': case 'deny': {
      if (!/^\d+$/.test(String(data.canvasId))) return null;
      return { act: data.canvasAct, id: Number(data.canvasId) };
    }
    case 'remove': return isStr(data.canvasOrigin) && data.canvasOrigin !== '' ? { act: 'remove', origin: data.canvasOrigin } : null;
    case 'hosts': return { act: 'hosts' };
    case 'close-hosts': return { act: 'close-hosts' };
    default: return null;
  }
}

const API = { emptyState, withFrame, shouldDock, needsFetch, canShow, showRequest, shelfOf, shelfKey, covered, withAsk, answered, toggleHosts, typed, clearStatus, sessionLine, view, html, actionOf };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.canvasDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
