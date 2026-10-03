'use strict';
/**
 * The Files tab (#45): this worktree's files as a lazy tree, with what Claude touched marked on it.
 * DOM and events only; what the rows ARE is app/repo-tree-display.js (pure, tested), and the host's answers
 * come through app/repo-requester.js.
 *
 *   create({ doc, requester, harness, storage, onOpen, onMention, onSaid }) ->
 *     { show(), refresh(), onChanged(), setSelected(path), probe(action, args) }
 *
 * Every name from the repo is drawn with textContent, never as markup: a branch-style hostile file name
 * (`<img onerror=...>.js`) is just text.
 *
 * What a person can do with a row: click a folder to open it (its listing is asked for then, one folder at a
 * time); click a file to read it (onOpen); drag a file out to Explorer, the desktop or another app
 * (harness.repoDrag, which asks main; the OS does the copy); right-click for Open / @ in prompt / Show in
 * Explorer. Arrow keys move, Right / Left open and close a folder, Enter opens. Nothing is ever opened with
 * the OS or run: Show in Explorer only reveals.
 *
 * A failure is shown, never an empty tree that reads as a clean repo: git missing, not a repository, an
 * older host, a host that didn't answer. An empty repository says so too, in other words.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoFilesPanel`.
 */
(function (root) {

const ONLY_KEY = 'repoOnlyTouched';
const OVERLAY_EVERY_MS = 5000;
const SAID_MS = 6000;

function create({ doc, requester, harness, storage, onOpen, onMention, onSaid, now = Date.now } = {}) {
  const display = root.repoTreeDisplay || (typeof require === 'function' ? require('./repo-tree-display') : null);
  const el = {
    note: doc.getElementById('files-note'),
    only: doc.getElementById('files-only'),
    tree: doc.getElementById('files-tree'),
    said: doc.getElementById('files-said'),
  };
  const state = {
    children: new Map(), expanded: new Set(), overlay: null, onlyTouched: false,
    selected: null, error: null, focused: null, loadedRoot: false, menu: null, saidTimer: null,
  };
  // A page main opened with ?probe=1 (verify/probe-repo-browser.js) records a file drag instead of starting it:
  // a real webContents.startDrag opens the OS's modal drag loop, which freezes the window until a mouse button is
  // released, and a probe has no mouse. main's refusals of bad paths are checked directly (harnessDrag).
  const probing = (() => { try { return new URLSearchParams(root.location.search).get('probe') === '1'; } catch { return false; } })();
  const dragRequests = [];
  let lastOverlayAt = -Infinity;
  let overlayTimer = null;
  let overlayBusy = false;
  let renders = 0;

  try { state.onlyTouched = !!storage && storage.getItem(ONLY_KEY) === '1'; } catch { /* storage refused */ }
  el.only.checked = state.onlyTouched;

  const say = (text) => {
    if (!el.said) return;
    el.said.textContent = text || '';
    clearTimeout(state.saidTimer);
    if (text) state.saidTimer = setTimeout(() => { el.said.textContent = ''; }, SAID_MS);
  };

  // ---- asking the host ----

  async function loadDir(dir) {
    const r = await requester.request('list', { dir });
    if (!r.ok) {
      // git can't answer, so NO listing is current: drop what was drawn (the host drops its last good tree for
      // the same reason) rather than show a stale tree under a warning. Open folders stay open, and are listed
      // again when git answers.
      state.error = r.error || 'the file list could not be read';
      state.children.clear();
      state.loadedRoot = false;
      render();
      return false;
    }
    state.error = null;
    state.loadedRoot = state.loadedRoot || dir === '';
    state.children.set(dir, r.entries || []);
    if (r.missing) state.expanded.delete(dir);
    render();
    return true;
  }

  async function loadOverlay() {
    if (overlayBusy) return;
    overlayBusy = true;
    lastOverlayAt = now();
    try {
      const r = await requester.request('overlay');
      state.overlay = r;
    } finally {
      overlayBusy = false;
    }
    if (onOverlay) onOverlay(state.overlay);
    render();
  }
  let onOverlay = null;

  function show() {
    if (!state.loadedRoot || state.error) loadDir('');
    loadOverlay();
  }

  // The host's `changed` push: re-list the root and every open folder; the overlay at most every 5s (it
  // re-reads transcripts, and the active one grows with every turn).
  function onChanged() {
    loadDir('');
    for (const dir of state.expanded) loadDir(dir);
    const wait = OVERLAY_EVERY_MS - (now() - lastOverlayAt);
    if (wait <= 0) loadOverlay();
    else if (overlayTimer === null) overlayTimer = setTimeout(() => { overlayTimer = null; loadOverlay(); }, wait);
  }

  // ---- drawing ----

  function rowsNow() {
    return display.rows({ children: state.children, expanded: state.expanded, overlay: state.overlay && state.overlay.ok === false ? null : state.overlay, onlyTouched: state.onlyTouched });
  }

  function paintNote() {
    if (state.error) { el.note.textContent = state.error; el.note.classList.add('fog-warn'); return; }
    const n = display.overlayNote(state.overlay, state.overlay && state.overlay.status);
    el.note.textContent = n.text;
    el.note.classList.toggle('fog-warn', n.warn);
  }

  function rowEl(r, focusPath) {
    const row = doc.createElement('div');
    row.className = `fr ${r.kind} ${r.state}${r.path === state.selected ? ' sel' : ''}`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(r.depth + 1));
    row.style.paddingLeft = `${6 + r.depth * 12}px`;
    if (r.kind === 'loading') { row.textContent = 'reading…'; row.classList.add('loading'); return row; }
    if (r.kind === 'more') { row.textContent = `+${r.count} more not shown`; row.classList.add('more'); return row; }
    row.dataset.path = r.path;
    row.dataset.kind = r.kind;
    row.tabIndex = r.path === focusPath ? 0 : -1;
    if (r.title) row.title = r.title;
    if (r.kind === 'dir') row.setAttribute('aria-expanded', r.expanded ? 'true' : 'false');
    const chev = doc.createElement('span');
    chev.className = 'chev';
    chev.textContent = r.kind === 'dir' ? (r.expanded ? '▾' : '▸') : '';
    const name = doc.createElement('span');
    name.className = 'nm';
    name.textContent = r.name;
    row.append(chev, name);
    if (r.badge) {
      const b = doc.createElement('span');
      b.className = 'bd';
      b.textContent = r.badge;
      row.append(b);
    }
    if (r.kind === 'file') row.draggable = true;
    return row;
  }

  function render() {
    renders += 1;
    paintNote();
    const rows = rowsNow();
    const keepScroll = el.tree.scrollTop;
    const focusPath = rows.some(r => r.path === state.focused) ? state.focused : (rows.find(r => r.path) || {}).path;
    const hadFocus = el.tree.contains(doc.activeElement);
    el.tree.replaceChildren(...rows.map(r => rowEl(r, focusPath)));
    el.tree.scrollTop = keepScroll;
    if (hadFocus && focusPath) { const f = rowByPath(focusPath); if (f) f.focus({ preventScroll: true }); }
    if (!rows.length && !state.error) {
      const empty = doc.createElement('div');
      empty.className = 'files-empty';
      empty.textContent = state.onlyTouched
        ? 'Nothing to show: Claude has not touched a file here yet.'
        : (state.loadedRoot ? 'This worktree has no files yet.' : 'reading the files…');
      el.tree.append(empty);
    }
  }

  const rowByPath = (p) => [...el.tree.querySelectorAll('.fr[data-path]')].find(r => r.dataset.path === p) || null;
  const rowsList = () => [...el.tree.querySelectorAll('.fr[data-path]')];

  // ---- acting on rows ----

  function toggle(path) {
    if (state.onlyTouched) return;                       // under the filter every folder is open
    if (state.expanded.has(path)) state.expanded.delete(path);
    else { state.expanded.add(path); if (!state.children.has(path)) loadDir(path); }
    state.focused = path;
    render();
  }

  function activate(path, kind) {
    state.focused = path;
    if (kind === 'dir') { toggle(path); return; }
    state.selected = path;
    render();
    if (onOpen) onOpen(path);
  }

  async function reveal(path) {
    const r = harness && harness.repoReveal ? await harness.repoReveal(path) : { ok: false, why: 'unavailable' };
    if (!r || r.ok !== true) say(`Could not show it in Explorer: ${(r && r.why) || 'refused'}`);
  }

  function closeMenu() {
    if (state.menu) { state.menu.remove(); state.menu = null; }
  }

  function openMenu(ev, path, kind) {
    closeMenu();
    const m = doc.createElement('div');
    m.className = 'files-menu';
    m.setAttribute('role', 'menu');
    const item = (label, fn) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); fn(); });
      m.append(b);
    };
    if (kind === 'file') {
      item('Open', () => activate(path, 'file'));
      item('@ in prompt', () => { if (onMention) onMention(path); });
    }
    item('Show in Explorer', () => reveal(path));
    doc.body.append(m);
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    m.style.left = `${Math.max(4, Math.min(ev.clientX, root.innerWidth - w - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(ev.clientY, root.innerHeight - h - 4))}px`;
    state.menu = m;
    m.querySelector('button').focus();
  }

  // ---- events (delegated: rows are rebuilt on every render) ----

  el.tree.addEventListener('click', (e) => {
    const row = e.target.closest('.fr[data-path]');
    if (row) activate(row.dataset.path, row.dataset.kind);
  });

  el.tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.fr[data-path]');
    if (!row) return;
    e.preventDefault();
    openMenu(e, row.dataset.path, row.dataset.kind);
  });

  // The OS drag starts in main: Electron's webContents.startDrag, after main re-runs the path guard.
  el.tree.addEventListener('dragstart', async (e) => {
    const row = e.target.closest && e.target.closest('.fr[data-path]');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.kind !== 'file') return;
    if (probing) { dragRequests.push(row.dataset.path); return; }
    const r = harness && harness.repoDrag ? await harness.repoDrag(row.dataset.path) : { ok: false, why: 'unavailable' };
    if (!r || r.ok !== true) say(`Could not drag it out: ${(r && r.why) || 'refused'}`);
  });

  el.tree.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.fr[data-path]');
    if (!row) return;
    const list = rowsList();
    const i = list.indexOf(row);
    const go = (r) => { if (r) { state.focused = r.dataset.path; list.forEach(x => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); } e.preventDefault(); };
    const isDir = row.dataset.kind === 'dir';
    const open = row.getAttribute('aria-expanded') === 'true';
    if (e.key === 'ArrowDown') go(list[i + 1]);
    else if (e.key === 'ArrowUp') go(list[i - 1]);
    else if (e.key === 'Home') go(list[0]);
    else if (e.key === 'End') go(list[list.length - 1]);
    else if (e.key === 'ArrowRight' && isDir && !open) { toggle(row.dataset.path); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && isDir && open) go(list[i + 1]);
    else if (e.key === 'ArrowLeft' && isDir && open) { toggle(row.dataset.path); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') {
      const parent = row.dataset.path.includes('/') ? row.dataset.path.slice(0, row.dataset.path.lastIndexOf('/')) : null;
      go(parent === null ? null : rowByPath(parent));
    } else if (e.key === 'Enter' || e.key === ' ') { activate(row.dataset.path, row.dataset.kind); e.preventDefault(); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = row.getBoundingClientRect();
      openMenu({ clientX: r.left + 20, clientY: r.bottom }, row.dataset.path, row.dataset.kind);
      e.preventDefault();
    }
  });

  el.only.addEventListener('change', () => {
    state.onlyTouched = el.only.checked;
    try { if (storage) storage.setItem(ONLY_KEY, state.onlyTouched ? '1' : '0'); } catch { /* storage refused */ }
    render();
  });

  doc.addEventListener('mousedown', (e) => { if (state.menu && !state.menu.contains(e.target)) closeMenu(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.menu) { closeMenu(); e.stopPropagation(); } }, true);
  root.addEventListener('blur', closeMenu);

  // ---- for the reader and the probe ----

  function setSelected(path) {
    state.selected = path;
    if (path) {
      // Reveal the open file: its folders open (and are listed) so the row exists to highlight.
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!state.expanded.has(d)) { state.expanded.add(d); if (!state.children.has(d)) loadDir(d); }
      }
    }
    render();
  }

  function probe(action, a = {}) {
    switch (action) {
      case 'state':
        return {
          ok: true, renders, error: state.error, note: el.note.textContent, noteWarn: el.note.classList.contains('fog-warn'),
          onlyTouched: state.onlyTouched, selected: state.selected, said: el.said ? el.said.textContent : '', dragRequests: [...dragRequests],
          rows: [...el.tree.querySelectorAll('.fr')].map(r => ({
            path: r.dataset.path || null, kind: r.dataset.kind || (r.classList.contains('loading') ? 'loading' : 'more'),
            cls: r.className, text: r.textContent, title: r.title, depth: Number(r.getAttribute('aria-level')) - 1,
            expanded: r.getAttribute('aria-expanded'), draggable: r.draggable, badge: (r.querySelector('.bd') || {}).textContent || '',
            tabIndex: r.tabIndex,
          })),
          empty: (el.tree.querySelector('.files-empty') || {}).textContent || '',
          tree: (() => { const b = el.tree.getBoundingClientRect(); return { width: b.width, height: b.height }; })(),
          menu: state.menu ? [...state.menu.querySelectorAll('button')].map(b => b.textContent) : null,
        };
      case 'click': { const r = rowByPath(a.path); if (!r) return { ok: false, error: `no row ${a.path}` }; r.click(); return { ok: true }; }
      case 'key': {
        const r = rowByPath(a.path) || doc.activeElement;
        r.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true, cancelable: true, shiftKey: !!a.shift }));
        return { ok: true, focused: (doc.activeElement && doc.activeElement.dataset && doc.activeElement.dataset.path) || null };
      }
      case 'only': el.only.checked = a.on === true; el.only.dispatchEvent(new Event('change')); return { ok: true };
      case 'contextMenu': {
        const r = rowByPath(a.path);
        if (!r) return { ok: false, error: `no row ${a.path}` };
        const b = r.getBoundingClientRect();
        r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 5 }));
        return { ok: true, items: state.menu ? [...state.menu.querySelectorAll('button')].map(x => x.textContent) : [] };
      }
      case 'menuClick': {
        const b = state.menu && [...state.menu.querySelectorAll('button')].find(x => x.textContent === a.item);
        if (!b) return { ok: false, error: `no menu item ${a.item}` };
        b.click();
        return { ok: true };
      }
      // main's two guarded actions, asked directly with a path (the probe sends only refused ones: a real reveal
      // would open an Explorer window on the machine running it)
      case 'harnessReveal': return harness.repoReveal(a.path);
      case 'harnessDrag': return harness.repoDrag(a.path);
      case 'dragStart': {
        const r = rowByPath(a.path);
        if (!r) return { ok: false, error: `no row ${a.path}` };
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true });
        r.dispatchEvent(ev);
        return { ok: true, defaultPrevented: ev.defaultPrevented };
      }
      default: return { ok: false, error: `unknown files action ${action}` };
    }
  }

  return {
    show, onChanged, setSelected, probe, say,
    refresh: () => { loadDir(''); loadOverlay(); },
    onOverlay: (fn) => { onOverlay = fn; },
    overlay: () => state.overlay,
  };
}

const API = { create };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoFilesPanel = API;

})(typeof window !== 'undefined' ? window : globalThis);
