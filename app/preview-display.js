'use strict';
/**
 * The Preview panel and the Dev servers chip, as pure decisions and HTML strings (BACKLOG #119 A4): the app/canvas-display.js pattern.
 * renderer.js wires the frames, the clicks and the native view.
 *
 * WHAT IS DRAWN HERE, AND WHAT IS NOT. The page of the dev server is not drawn by this app's page at all: it is a native view that main
 * lays over `#preview-slot` (app/preview-views.js). This draws the frame around it: the address field, the port picker, the buttons, the
 * line that says what was blocked, the empty state. A native view paints above the page, so the renderer hides it whenever something
 * else is drawn over the slot (the same hit-test as Claude's panel, window.canvasDisplay.slotObstructed).
 *
 * STATE: `{ url, note, loading, dev }`, changed only through the functions below (each returns a new one, or the same one when the input
 * was not an event). `dev` is main's last answer for this tab (host/dev-servers.js buildState, plus ok/stale). Every string that came
 * from outside (a process name, a page address, a failure text) is escaped.
 *
 * WRAPPED IN AN IIFE: the renderer loads scripts as plain <script> tags sharing one global scope (CLAUDE.md, the first trap). One name
 * leaves it: `previewDisplay`.
 */
(function (root) {

// A COPY of host/port-blocks.js BLOCK (this is a plain script in the page and cannot require it): test/preview-display.test.js pins them equal.
const BLOCK = 100;
const NOTE_MAX = 140;
const URL_MAX = 2048;

const isStr = v => typeof v === 'string';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

const emptyState = () => ({ url: null, note: null, loading: false, dev: null });

/** An event from main (app/preview-views.js onEvent) folded into the state. Anything that is not one changes nothing. */
function withEvent(state, ev) {
  if (ev === null || typeof ev !== 'object') return state;
  switch (ev.kind) {
    case 'url':
      return isStr(ev.url) && ev.url !== '' && ev.url.length <= URL_MAX ? { ...state, url: ev.url, note: null } : state;
    case 'blocked': case 'failed':
      return isStr(ev.text) && ev.text !== '' ? { ...state, note: { text: ev.text.slice(0, NOTE_MAX), bad: true } } : state;
    case 'loading':
      return typeof ev.on === 'boolean' ? { ...state, loading: ev.on } : state;
    default:
      return state;
  }
}

const withDev = (state, dev) => ({ ...state, dev: dev !== null && typeof dev === 'object' ? dev : null });
const withoutUrl = (state) => ({ ...state, url: null, note: null, loading: false });
const wantsView = (state) => isStr(state.url) && state.url !== '';

const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;

/** What the address field shows for a page address: the shorthand the field accepts, so it can be edited and sent back. */
function fieldText(url) {
  if (!isStr(url) || url === '') return '';
  if (!LOOPBACK_ORIGIN.test(url)) return url;
  const bare = url.slice('http://'.length);
  const slash = bare.indexOf('/');
  return slash === bare.length - 1 ? bare.slice(0, slash) : bare;
}

const portOf = (url) => {
  const m = isStr(url) ? /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(?:[/?#]|$)/.exec(url) : null;
  return m ? m[1] : null;
};

const plural = (n, one, many) => (n === 1 ? one : many);
const listOf = (v) => (Array.isArray(v) ? v.filter(r => r !== null && typeof r === 'object' && Number.isInteger(r.port) && isStr(r.name)) : null);
const blockText = (base) => `${base}-${base + BLOCK - 1}`;

/**
 * The chip's icon: Lucide `server` (ISC License, Copyright (c) for Lucide Contributors; the full notice and the Feather MIT notice it derives
 * from are kept in app/rail-icons.js). Constant markup from this file, never built from user data.
 */
const SERVER_ICON = '<svg class="dv-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" />'
  + '<line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></svg>';
const serverIcon = () => SERVER_ICON;

// ---- the chip ---------------------------------------------------------------------------------------------------------------

/** { hidden } | { hidden: false, text, title, state: 'on' | 'idle' | 'unknown' }. Unknown is a dash, never a zero. */
function chipView(dev) {
  if (dev === null || typeof dev !== 'object') return { hidden: true };
  if (dev.ok === false) return { hidden: false, text: '—', state: 'unknown', title: "Dev servers: not known right now. Click for details." };
  if (dev.ok !== true || !Number.isInteger(dev.base)) return { hidden: true };
  const inside = listOf(dev.inBlock);
  if (inside === null) return { hidden: true };
  const n = inside.length;
  const old = dev.stale === true ? ' (the last reading is old)' : '';
  const where = `this worktree's ports (${blockText(dev.base)})`;
  const title = n === 0
    ? `No dev server is listening in ${where}${old}. Click for the list.`
    : `${n} dev ${plural(n, 'server', 'servers')} listening in ${where}${old}. Click for the list.`;
  return { hidden: false, text: String(n), title, state: n > 0 ? 'on' : 'idle' };
}

function menuHtml(dev) {
  if (dev === null || typeof dev !== 'object' || dev.ok !== true) {
    return '<div class="dv-menu" role="menu" aria-label="Dev servers"><div class="dv-none">The listening ports couldn\'t be read right now. They are asked for again every ten seconds.</div></div>';
  }
  const inside = listOf(dev.inBlock) || [];
  const outside = listOf(dev.outside) || [];
  const title = Number.isInteger(dev.base) ? `Dev servers · ports ${blockText(dev.base)}` : 'Dev servers';
  const rowHtml = (r, out) => {
    const label = `${r.port} · ${esc(r.name)}`;
    return `<div class="dv-row${out ? ' dv-outside' : ''}"><span class="dv-label">${label}</span>`
      + (out ? '<span class="dv-note">(outside this worktree\'s block)</span>' : '')
      + `<button type="button" class="dv-btn" data-dev-act="preview" data-dev-port="${r.port}" title="Open in Preview">Preview</button>`
      + `<button type="button" class="dv-btn" data-dev-act="browser" data-dev-port="${r.port}" title="Open in browser">Browser</button></div>`;
  };
  let body;
  if (inside.length === 0 && outside.length === 0) {
    const where = Number.isInteger(dev.base) ? ` in ${blockText(dev.base)}` : '';
    body = `<div class="dv-none">Nothing is listening${where}. Ask Claude to start a dev server on a port from $WORKTREE_PORT_BASE.</div>`;
  } else {
    body = inside.map(r => rowHtml(r, false)).join('') + outside.map(r => rowHtml(r, true)).join('');
  }
  return `<div class="dv-menu" role="menu" aria-label="Dev servers"><div class="dv-title">${esc(title)}</div>${body}</div>`;
}

/** A menu click's data attributes -> { act, port } | null. Strict: the port is plain digits, 1-65535. */
function devActionOf(data) {
  if (data === null || typeof data !== 'object') return null;
  if (data.devAct !== 'preview' && data.devAct !== 'browser') return null;
  if (!isStr(data.devPort) || !/^[1-9]\d{0,4}$/.test(data.devPort)) return null;
  const port = Number(data.devPort);
  return port <= 65535 ? { act: data.devAct, port } : null;
}

// ---- the panel --------------------------------------------------------------------------------------------------------------

function view(state) {
  const dev = state.dev;
  const inside = dev && dev.ok === true ? (listOf(dev.inBlock) || []) : [];
  const outside = dev && dev.ok === true ? (listOf(dev.outside) || []) : [];
  const picker = [
    ...inside.map(r => ({ value: String(r.port), label: `${r.port} · ${r.name}`, outside: false })),
    ...outside.map(r => ({ value: String(r.port), label: `${r.port} · ${r.name} (outside this worktree's block)`, outside: true })),
  ];
  const on = portOf(state.url);
  return {
    empty: !wantsView(state),
    urlText: fieldText(state.url),
    note: state.note ? state.note.text : null,
    noteBad: state.note ? state.note.bad === true : false,
    loading: state.loading === true,
    picker,
    pickerValue: on !== null && picker.some(p => p.value === on) ? on : '',
    pickerKnown: !!dev && dev.ok === true,
  };
}

function html(v) {
  const dis = v.empty ? ' disabled' : '';
  const options = v.picker.length
    ? `<option value=""${v.pickerValue === '' ? ' selected' : ''}>Servers in this worktree…</option>`
      + v.picker.map(p => `<option value="${esc(p.value)}"${p.value === v.pickerValue ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
    : `<option value="" selected>${v.pickerKnown ? 'no servers listening' : 'servers not known yet'}</option>`;
  const head = '<div class="pv-head"><div class="pv-row">'
    + `<input id="preview-url" class="pv-url" type="text" spellcheck="false" autocomplete="off" value="${esc(v.urlText)}" placeholder="localhost:3000" aria-label="Address: this computer only">`
    + '<button type="button" class="pv-btn" data-preview-act="go" title="Open this address (only localhost, 127.0.0.1 and [::1] open here)">Go</button>'
    + `<button type="button" class="pv-btn" data-preview-act="reload" title="Reload"${dis}>↻</button>`
    + `<button type="button" class="pv-btn" data-preview-act="browser" title="Open this page in your browser"${dis}>⧉</button>`
    + `<button type="button" class="pv-btn" data-preview-act="devtools" title="Show or hide the page's DevTools"${dis}>&lt;/&gt;</button>`
    + '</div>'
    + `<div class="pv-row"><select id="preview-port" class="pv-port" aria-label="Servers in this worktree"${v.picker.length ? '' : ' disabled'}>${options}</select></div>`
    + '</div>';
  const note = v.note ? `<div class="pv-note${v.noteBad ? ' pv-note-bad' : ''}" role="status">${esc(v.note)}</div>` : '';
  const body = v.empty
    ? '<div class="pv-empty"><p>Pick a server above, or type an address. Only this computer\'s servers open here (localhost, 127.0.0.1 and [::1]).</p>'
      + '<p>Links to other sites, new windows and downloads are blocked.</p></div>'
    : '<div id="preview-slot" class="pv-slot"></div>';
  return `${head}${note}<div class="pv-body">${body}</div>`;
}

/** A click's data attributes -> { act } | null. */
function actionOf(data) {
  if (data === null || typeof data !== 'object') return null;
  return ['go', 'reload', 'browser', 'devtools'].includes(data.previewAct) ? { act: data.previewAct } : null;
}

const API = { BLOCK, serverIcon, emptyState, withEvent, withDev, withoutUrl, wantsView, fieldText, chipView, menuHtml, devActionOf, view, html, actionOf };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.previewDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
