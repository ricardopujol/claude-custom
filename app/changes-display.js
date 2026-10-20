'use strict';
/**
 * The Changes dock panel (BACKLOG #119 A3): the worktree's changeset, one row per file, and a click opens that file in the reader's
 * side-by-side Compare (app/repo-reader.js openChange).
 *
 *   PURE   emptyState() / withReply(state, reply) / setAsked / select / move   the state a host answer makes
 *          view(state, { touched }) -> { scopes, summary, note, rows, more }      what is drawn
 *          html(view) -> string                                                    the markup (every path escaped)
 *          keyAction(e) / actionOf(dataset)                                        what a key or a click means
 *   MOUNT  mount({ doc, root, request, isTouched, openChange, usage }) -> { show, hide, onChanged, refresh, state, probe }
 *
 * THE TWO SCOPES. `Working tree` is the tree against HEAD (staged, unstaged and untracked together). `vs <base>` is the tree against
 * the merge-base with the integration branch (develop, else main): everything the lane did, committed or not. The page asks for
 * `auto` until the person clicks one: the host picks Working tree when it holds changes, else the branch, and says which it used,
 * so the button that is lit is always the list that is shown.
 *
 * NOTHING IS ASKED WHILE THE PANEL IS HIDDEN. The host pushes `changed` two seconds after a tool that can change a file; a hidden
 * panel only remembers it, and asks when it is shown again. A push that lands during a refresh makes exactly one more.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `changesDisplay`.
 */
(function (root) {

const SCOPES = ['working', 'branch'];
const MINUS = '−';
const DOT = '·';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

function emptyState() {
  return { asked: 'auto', scope: null, base: null, files: [], total: 0, more: 0, summary: null, dirty: null, loaded: false, error: null, selected: null };
}

function withReply(state, reply) {
  if (!isObj(reply)) return { ...state, error: 'no answer from the session' };
  if (reply.ok !== true) return { ...state, error: isStr(reply.error) && reply.error ? reply.error : isStr(reply.why) && reply.why ? reply.why : 'the session could not list the changes' };
  const files = Array.isArray(reply.files) ? reply.files.filter(f => isObj(f) && isStr(f.path) && f.path !== '') : [];
  return {
    ...state,
    scope: SCOPES.includes(reply.scope) ? reply.scope : state.scope,
    base: isStr(reply.base) ? reply.base : state.base,
    files,
    total: Number.isInteger(reply.total) ? reply.total : files.length,
    more: Number.isInteger(reply.more) && reply.more > 0 ? reply.more : 0,
    summary: isObj(reply.summary) ? reply.summary : null,
    dirty: typeof reply.dirty === 'boolean' ? reply.dirty : null,
    loaded: true,
    error: null,
    selected: files.some(f => f.path === state.selected) ? state.selected : null,
  };
}

function setAsked(state, scope) {
  return scope === 'auto' || SCOPES.includes(scope) ? { ...state, asked: scope } : state;
}

function select(state, path) {
  return state.files.some(f => f.path === path) ? { ...state, selected: path } : state;
}

function move(state, delta) {
  const n = state.files.length;
  if (n === 0) return state;
  const at = state.files.findIndex(f => f.path === state.selected);
  let next;
  if (at === -1) next = delta > 0 ? 0 : n - 1;
  else next = Math.min(n - 1, Math.max(0, at + (delta > 0 ? 1 : -1)));
  return { ...state, selected: state.files[next].path };
}

function countText(f) {
  if (typeof f.add === 'number') return { add: `+${f.add}`, del: typeof f.del === 'number' ? `${MINUS}${f.del}` : '' };
  return { add: f.binary === true ? 'bin' : '?', del: '' };
}

function summaryText(s) {
  if (!isObj(s) || !Number.isInteger(s.files) || s.files === 0) return 'no changes';
  const unknown = Number.isInteger(s.unknown) && s.unknown > 0 ? ' (+ binary or unread)' : '';
  return `${s.files} file${s.files === 1 ? '' : 's'} ${DOT} +${s.add} ${MINUS}${s.del}${unknown}`;
}

function view(state, { touched } = {}) {
  const isTouched = typeof touched === 'function' ? touched : () => false;
  const shown = state.scope;
  const baseName = state.base || 'develop';
  const scopes = [
    { id: 'working', label: 'Working tree', on: shown === 'working' },
    { id: 'branch', label: `vs ${baseName}`, on: shown === 'branch' },
  ];
  const rows = state.files.map((f) => {
    const slash = f.path.lastIndexOf('/');
    const c = countText(f);
    return {
      path: f.path, dir: slash === -1 ? '' : f.path.slice(0, slash + 1), name: slash === -1 ? f.path : f.path.slice(slash + 1),
      status: isStr(f.status) ? f.status : 'M', add: c.add, del: c.del,
      touched: isTouched(f.path) === true, selected: f.path === state.selected, untracked: f.untracked === true,
      title: isStr(f.oldPath) && f.oldPath ? `${f.path} (was ${f.oldPath})` : f.path,
    };
  });
  let note = '';
  if (state.error) note = state.loaded ? `Could not refresh: ${state.error}` : state.error;
  else if (!state.loaded) note = 'Looking at the worktree…';
  else if (rows.length === 0) note = shown === 'branch' ? `This branch has no changes against ${baseName}.` : 'The working tree matches HEAD: nothing to review.';
  const more = state.more > 0 ? { n: state.more, text: `+${state.more} more file${state.more === 1 ? '' : 's'} not listed` } : null;
  return { scopes, summary: state.loaded ? summaryText(state.summary) : '', note, rows, more };
}

function html(v) {
  const scopes = v.scopes.map(s => `<button type="button" class="chg-scope-btn${s.on ? ' on' : ''}" data-act="scope" data-scope="${esc(s.id)}" aria-pressed="${s.on ? 'true' : 'false'}">${esc(s.label)}</button>`).join('');
  const head = `<div class="chg-head"><div class="chg-scope" role="group" aria-label="What to compare">${scopes}</div><button type="button" class="chg-refresh" data-act="refresh" title="Look at the worktree again" aria-label="Refresh">↻</button></div>`;
  const summary = v.summary ? `<div class="chg-summary">${esc(v.summary)}</div>` : '';
  const note = v.note ? `<div class="chg-note" role="status">${esc(v.note)}</div>` : '';
  const rows = v.rows.map(r => `<div class="chg-row${r.selected ? ' sel' : ''}" role="option" aria-selected="${r.selected ? 'true' : 'false'}" data-act="open" data-path="${esc(r.path)}" title="${esc(r.title)}">`
    + `<span class="chg-st st-${esc(r.status)}">${esc(r.status)}</span>`
    + `<span class="chg-path"><bdi>${esc(r.dir)}<b>${esc(r.name)}</b></bdi></span>`
    + (r.touched ? '<span class="chg-dot" title="Claude touched this file" aria-label="Claude touched this file"></span>' : '')
    + `<span class="chg-n"><span class="chg-add">${esc(r.add)}</span>${r.del ? ` <span class="chg-del">${esc(r.del)}</span>` : ''}</span>`
    + '</div>').join('');
  const more = v.more ? `<div class="chg-more">${esc(v.more.text)}</div>` : '';
  return `${head}${summary}${note}<div class="chg-list" role="listbox" tabindex="0" aria-label="Changed files">${rows}${more}</div>`;
}

function keyAction(e) {
  if (!isObj(e) || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === 'ArrowDown') return { type: 'move', delta: 1 };
  if (e.key === 'ArrowUp') return { type: 'move', delta: -1 };
  if (e.key === 'Enter') return { type: 'open' };
  return null;
}

function actionOf(ds) {
  if (!isObj(ds)) return null;
  if (ds.act === 'scope') return SCOPES.includes(ds.scope) ? { type: 'scope', scope: ds.scope } : null;
  if (ds.act === 'refresh') return { type: 'refresh' };
  if (ds.act === 'open') return isStr(ds.path) && ds.path !== '' ? { type: 'open', path: ds.path } : null;
  return null;
}

// ---- mounted ----

function mount({ doc, root: host, request, isTouched, openChange, usage } = {}) {
  let state = emptyState();
  let shown = false;
  let inFlight = false;
  let again = false;

  function render() {
    const list = host.querySelector('.chg-list');
    const top = list ? list.scrollTop : 0;
    const hadFocus = !!(list && doc && doc.activeElement && typeof host.contains === 'function' && host.contains(doc.activeElement));
    host.innerHTML = html(view(state, { touched: isTouched }));
    const next = host.querySelector('.chg-list');
    if (next) {
      next.scrollTop = top;
      if (hadFocus && typeof next.focus === 'function') next.focus();
      const sel = host.querySelector('.chg-row.sel');
      if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function refresh() {
    if (inFlight) { again = true; return; }
    inFlight = true;
    let p;
    try { p = Promise.resolve(request('list', { scope: state.asked })); } catch (err) { p = Promise.reject(err); }
    p.then((r) => r, (err) => ({ ok: false, error: (err && err.message) || 'the request failed' })).then((r) => {
      state = withReply(state, r);
      inFlight = false;
      render();
      if (again) { again = false; if (shown) refresh(); }
    });
  }

  function openRow(path) {
    state = select(state, path);
    const f = state.files.find(x => x.path === path);
    if (!f) return false;
    render();
    if (typeof usage === 'function') usage('changes:file-opened');
    if (typeof openChange === 'function') {
      openChange({ path: f.path, ...(isStr(f.oldPath) && f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, scope: state.scope, base: state.base });
    }
    return true;
  }

  host.addEventListener('click', (e) => {
    const el = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act]') : null;
    const a = actionOf(el && el.dataset);
    if (!a) return;
    if (a.type === 'scope') { state = setAsked(state, a.scope); if (typeof usage === 'function') usage('changes:scope'); refresh(); }
    else if (a.type === 'refresh') refresh();
    else if (a.type === 'open') openRow(a.path);
  });

  host.addEventListener('keydown', (e) => {
    const a = keyAction(e);
    if (!a) return;
    if (a.type === 'move') {
      if (state.files.length === 0) return;
      state = move(state, a.delta);
      render();
      e.preventDefault();
    } else if (a.type === 'open') {
      if (state.selected === null) return;
      openRow(state.selected);
      e.preventDefault();
    }
  });

  render();

  return {
    show() { shown = true; refresh(); },
    hide() { shown = false; },
    // the host's `changed` push (two seconds after a tool that can change a file): act on it only while the panel is on screen
    onChanged() { if (shown) refresh(); },
    refresh,
    state: () => state,
    probe: () => ({ ok: true, shown, asked: state.asked, scope: state.scope, base: state.base, selected: state.selected, error: state.error, rows: view(state, { touched: isTouched }).rows.map(r => ({ path: r.path, status: r.status, add: r.add, del: r.del, touched: r.touched })), summary: view(state, {}).summary }),
  };
}

const API = { emptyState, withReply, setAsked, select, move, view, html, keyAction, actionOf, summaryText, mount };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.changesDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
