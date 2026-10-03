'use strict';
/**
 * The code reader (#32): a file opened from the Files tab, in a split BESIDE the terminal (terminal | file,
 * a draggable divider remembered per tab; Esc or the close button gives the terminal its width back).
 * Read-only: CodeMirror 6 with the readOnly state, loaded on the FIRST open (a ~600 KB script, from disk, no
 * network), never at startup. If it can't load, the file is still shown as plain text.
 *
 *   create({ doc, requester, harness, storage, storageKey, typeMention, onClose }) ->
 *     { open(path), close(), isOpen(), path(), setOverlay(overlay), onRepoChanged(), probe(action, args) }
 *
 *   Diff toggle    only on a file the overlay says Claude edited. Claude's own Edit / Write calls first, git
 *                  diff HEAD as the fallback (host/repo-diff.js); "no changes recorded" when neither.
 *   @ in prompt    types `@path` or `@path#L40-60` (the selected lines) into the CLI's input box through the
 *                  page's shared typeAndCheck, and NEVER presses Enter: the person does.
 *   Reload bar     a file that changed on disk while open is NOT swapped under the reader: a bar says so and
 *                  offers Reload. Deleted: "deleted on disk", the old text stays.
 *   Too large /    over 2 MB, or binary: nothing is decoded; the reason is shown with Show in Explorer.
 *   binary
 *   Show in        harness.repoReveal: main re-runs the path guard and only REVEALS. Nothing is opened or run.
 *
 * A late answer for a file the person has already moved off is dropped (`token`), so a slow read can't paint
 * over the file now showing.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoReader`.
 */
(function (root) {

const MIN_PANE = 240;
const MIN_TERM = 300;
const WIDTH_STEP = 24;
const SCRIPT = './codemirror-reader.js';

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const REFUSALS = {
  'too-large': (r) => `This file is ${fmtSize(r.size || 0)}, over the ${fmtSize(r.limit || 0)} the reader opens.`,
  binary: () => 'This looks like a binary file, so the reader does not open it.',
  gone: () => 'This file is deleted on disk.',
  'not-a-file': () => 'This is a folder, not a file.',
  unreadable: (r) => `This file could not be read${r.error ? `: ${r.error}` : '.'}`,
};
const refusalText = (r) => (REFUSALS[r.why] ? REFUSALS[r.why](r) : `The reader refused this path: ${r.why || r.error || 'unknown reason'}.`);

function create({ doc, requester, harness, storage, storageKey = 'repoReaderWidth', typeMention, onClose } = {}) {
  const keyNow = () => (typeof storageKey === 'function' ? storageKey() : storageKey);
  const lang = root.repoLanguage || (typeof require === 'function' ? require('./repo-language') : null);
  const mention = root.repoMention || (typeof require === 'function' ? require('./repo-mention') : null);
  const $ = (id) => doc.getElementById(id);
  const el = {
    pane: $('reader'), split: $('reader-split'), path: $('reader-path'), meta: $('reader-meta'),
    diff: $('reader-diff'), mention: $('reader-mention'), reveal: $('reader-reveal'), close: $('reader-close'),
    bar: $('reader-bar'), barText: $('reader-bar-text'), reload: $('reader-reload'),
    body: $('reader-body'), note: $('reader-note'), noteText: $('reader-note-text'), noteReveal: $('reader-note-reveal'),
    termwrap: $('termwrap'),
  };

  const state = {
    path: null, mode: 'file', stamp: null, overlayFiles: new Map(), editor: null, cmLoaded: false,
    token: 0, status: '', diffSource: null,
  };
  let cmPromise = null;

  // ---- CodeMirror, on first use ----

  function loadCodeMirror() {
    if (root.repoCodeMirror) return Promise.resolve(root.repoCodeMirror);
    if (!cmPromise) {
      cmPromise = new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = SCRIPT;
        s.onload = () => (root.repoCodeMirror ? resolve(root.repoCodeMirror) : reject(new Error('the code viewer did not start')));
        s.onerror = () => reject(new Error('the code viewer could not be loaded'));
        doc.head.append(s);
      }).catch((err) => { cmPromise = null; throw err; });
    }
    return cmPromise;
  }

  // The plain-text fallback has the same small surface as the CodeMirror handle.
  function plainEditor() {
    const pre = doc.createElement('pre');
    pre.className = 'reader-plain';
    el.body.replaceChildren(pre);
    return {
      show({ text, mode }) { pre.textContent = text; pre.dataset.mode = mode; },
      selection: () => ({ fromLine: 1, toLine: 1, empty: true, toCol0: false }),
      lines: () => pre.textContent.split('\n').length,
      text: () => pre.textContent,
      focus: () => pre.focus(),
    };
  }

  async function ensureEditor() {
    if (state.editor) return state.editor;
    try {
      const cm = await loadCodeMirror();
      el.body.replaceChildren();
      state.editor = cm.create(el.body, {});
      state.cmLoaded = true;
    } catch (err) {
      state.status = `${err.message}; showing plain text`;
      state.editor = plainEditor();
    }
    return state.editor;
  }

  // ---- the pane ----

  // The room the terminal and the reader SHARE (the dock zones beside them are not theirs to take): what the
  // terminal has now, plus what the reader already holds. The terminal always keeps MIN_TERM of it.
  function sharedRoom() {
    const term = el.termwrap ? el.termwrap.getBoundingClientRect().width : 0;
    return term + (el.pane.hidden ? 0 : el.pane.getBoundingClientRect().width);
  }
  function widthBounds(room = sharedRoom()) {
    return { min: MIN_PANE, max: Math.max(MIN_PANE, room - MIN_TERM) };
  }
  function setWidth(px, { save = true, room } = {}) {
    const { min, max } = widthBounds(room);
    const w = Math.round(Math.min(max, Math.max(min, px)));
    el.pane.style.width = `${w}px`;
    if (save) { try { if (storage) storage.setItem(keyNow(), String(w)); } catch { /* storage refused */ } }
    return w;
  }
  function restoreWidth(room) {
    let saved = NaN;
    try { const raw = storage ? storage.getItem(keyNow()) : null; saved = raw === null ? NaN : Number(raw); } catch { /* storage refused */ }
    setWidth(Number.isFinite(saved) && saved > 0 ? saved : room * 0.45, { save: false, room });
  }

  function showPane() {
    if (!el.pane.hidden) return;
    const room = sharedRoom();          // measured while the reader is hidden: the terminal has it all
    el.pane.hidden = false;
    el.split.hidden = false;
    restoreWidth(room);
  }

  function close() {
    if (el.pane.hidden) return;
    state.token += 1;
    el.pane.hidden = true;
    el.split.hidden = true;
    state.path = null;
    state.stamp = null;
    if (onClose) onClose();
  }

  // ---- showing a file ----

  function clearBar() { el.bar.hidden = true; el.barText.textContent = ''; el.reload.hidden = false; }
  function showBar(text, { reload }) { el.barText.textContent = text; el.reload.hidden = !reload; el.bar.hidden = false; }
  function showNote(text, { reveal }) {
    el.noteText.textContent = text;
    el.noteReveal.hidden = !reveal;
    el.note.hidden = false;
    el.body.hidden = true;
  }
  function hideNote() { el.note.hidden = true; el.body.hidden = false; }

  function paintHead() {
    el.path.textContent = state.path || '';
    el.path.title = state.path || '';
    const edited = state.path && state.overlayFiles.get(state.path);
    el.diff.hidden = !(edited && edited.tier === 'edited');
    el.diff.textContent = state.mode === 'diff' ? 'File' : 'Diff';
    el.diff.setAttribute('aria-pressed', state.mode === 'diff' ? 'true' : 'false');
    const bits = [];
    if (state.mode === 'diff' && state.diffSource) bits.push(state.diffSource === 'claude' ? "Claude's edits" : 'git diff HEAD');
    else if (state.stamp) bits.push(fmtSize(state.stamp.size));
    if (state.status) bits.push(state.status);
    el.meta.textContent = bits.join(' · ');
  }

  async function open(path, { keepMode = false } = {}) {
    if (typeof path !== 'string' || path === '') return;
    const same = state.path === path;
    state.path = path;
    if (!keepMode || !same) state.mode = 'file';
    state.status = '';
    state.diffSource = null;
    const token = ++state.token;
    showPane();
    clearBar();
    paintHead();
    if (!el.note.hidden) showNote('reading\u2026', { reveal: false });
    const r = await requester.request('read', { path });
    if (token !== state.token) return;
    if (!r.ok) {
      state.stamp = null;
      showNote(refusalText(r), { reveal: r.why === 'too-large' || r.why === 'binary' || r.why === 'unreadable' });
      paintHead();
      return;
    }
    const editor = await ensureEditor();
    if (token !== state.token) return;
    hideNote();
    state.stamp = { size: r.size, mtimeMs: r.mtimeMs };
    editor.show({ text: r.text, name: r.path, mode: 'file', language: lang.languageFor(r.path) });
    paintHead();
    if (state.mode === 'diff') await showDiff(token);
  }

  async function showDiff(token) {
    const r = await requester.request('diff', { path: state.path });
    if (token !== state.token) return;
    const editor = await ensureEditor();
    if (token !== state.token) return;
    if (!r.ok) { showNote(`The diff could not be read: ${r.error || r.why || 'unknown error'}`, { reveal: false }); paintHead(); return; }
    if (r.source === null) { showNote('No changes recorded for this file.', { reveal: false }); paintHead(); return; }
    hideNote();
    state.diffSource = r.source;
    editor.show({ text: r.text, name: r.path, mode: 'diff', language: null });
    paintHead();
  }

  async function toggleDiff() {
    if (!state.path) return;
    const token = ++state.token;
    if (state.mode === 'diff') { state.mode = 'file'; await open(state.path, { keepMode: true }); return; }
    state.mode = 'diff';
    paintHead();
    await showDiff(token);
  }

  // ---- changed on disk ----

  async function checkStale() {
    if (!state.path || !state.stamp || el.pane.hidden) return;
    const path = state.path;
    const r = await requester.request('stat', { path });
    if (path !== state.path) return;
    if (!r.ok && r.why === 'gone') { showBar('This file was deleted on disk. What you see is the last version read.', { reload: false }); return; }
    if (!r.ok) return;                                  // can't tell: say nothing rather than guess
    if (r.size !== state.stamp.size || r.mtimeMs !== state.stamp.mtimeMs) {
      showBar('This file changed on disk.', { reload: true });
    } else if (!el.bar.hidden) {
      clearBar();
    }
  }

  // ---- @ in prompt ----

  function mentionSelection() {
    if (!state.path) return;
    const sel = state.editor && state.mode === 'file' ? state.editor.selection() : null;
    const m = mention.mentionText(state.path, sel ? mention.rangeOfLines(sel) : null);
    if (!m.ok) { state.status = `not typed: ${m.reason}`; paintHead(); return; }
    typeMention(m.text, (r) => {
      state.status = r && r.ok ? `typed ${m.text}; press Enter in the terminal to send it` : `not typed: ${(r && r.reason) || 'refused'}`;
      paintHead();
    });
  }

  // ---- events ----

  el.close.addEventListener('click', close);
  el.diff.addEventListener('click', toggleDiff);
  el.mention.addEventListener('click', mentionSelection);
  el.reload.addEventListener('click', () => { if (state.path) open(state.path, { keepMode: true }); });
  const reveal = async () => {
    if (!state.path) return;
    const r = harness && harness.repoReveal ? await harness.repoReveal(state.path) : { ok: false, why: 'unavailable' };
    state.status = r && r.ok === true ? '' : `could not show it in Explorer: ${(r && r.why) || 'refused'}`;
    paintHead();
  };
  el.reveal.addEventListener('click', reveal);
  el.noteReveal.addEventListener('click', reveal);

  // Esc closes it, unless CodeMirror used the key (its search box closes on Esc and says so with
  // preventDefault).
  el.pane.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); }
  });
  root.addEventListener('focus', () => { checkStale(); });

  // ---- the divider ----

  let dragging = false;
  el.split.addEventListener('pointerdown', (e) => {
    dragging = true;
    // A real pointer is captured so the drag keeps tracking over the terminal; a synthetic one (the probe's) has no
    // active pointer to capture and must not throw.
    try { el.split.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
    doc.body.classList.add('reader-resizing');
    e.preventDefault();
  });
  el.split.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // The pane's right edge doesn't move as it grows (the terminal takes up the slack), so its width is
    // that edge minus the pointer.
    setWidth(el.pane.getBoundingClientRect().right - e.clientX, { save: false });
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    doc.body.classList.remove('reader-resizing');
    setWidth(el.pane.getBoundingClientRect().width);
  };
  el.split.addEventListener('pointerup', endDrag);
  el.split.addEventListener('pointercancel', endDrag);
  el.split.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth(el.pane.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? WIDTH_STEP : -WIDTH_STEP));
  });

  // ---- for the browser and the probe ----

  function setOverlay(overlay) {
    state.overlayFiles = new Map();
    if (overlay && Array.isArray(overlay.files)) for (const f of overlay.files) state.overlayFiles.set(f.path, f);
    if (!el.pane.hidden) paintHead();
  }

  function probe(action, a = {}) {
    switch (action) {
      case 'state': {
        const r = el.pane.getBoundingClientRect();
        const cm = el.body.querySelector('.cm-editor');
        const text = state.editor ? state.editor.text().slice(0, 400) : '';
        return {
          ok: true, open: !el.pane.hidden, splitShown: !el.split.hidden, path: state.path, mode: state.mode,
          cmLoaded: !!root.repoCodeMirror, cmMounted: !!cm, plain: !!el.body.querySelector('.reader-plain'),
          lines: state.editor ? state.editor.lines() : 0, text, bodyHidden: el.body.hidden,
          diffVisible: !el.diff.hidden, diffLabel: el.diff.textContent, meta: el.meta.textContent,
          barShown: !el.bar.hidden, barText: el.barText.textContent, reloadShown: !el.reload.hidden,
          noteShown: !el.note.hidden, noteText: el.noteText.textContent, noteRevealShown: !el.noteReveal.hidden,
          width: r.width, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          diffClasses: cm ? { add: cm.querySelectorAll('.cm-diff-add').length, del: cm.querySelectorAll('.cm-diff-del').length, hunk: cm.querySelectorAll('.cm-diff-hunk').length } : null,
          heap: root.performance && root.performance.memory ? root.performance.memory.usedJSHeapSize : null,
        };
      }
      case 'open': return open(a.path).then(() => ({ ok: true }));
      case 'close': close(); return { ok: true };
      case 'toggleDiff': return toggleDiff().then(() => ({ ok: true }));
      case 'checkStale': return checkStale().then(() => ({ ok: true }));
      case 'reload': el.reload.click(); return { ok: true };
      case 'escape': el.pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return { ok: true };
      case 'select': {
        // select whole lines a..b (1-based) in the editor, as the mouse would
        if (!state.editor || !state.editor.setSelection) return { ok: false, error: 'no editor' };
        state.editor.setSelection(a.from, a.to);
        return { ok: true };
      }
      case 'mention': mentionSelection(); return { ok: true };
      case 'setWidth': return { ok: true, width: setWidth(Number(a.px)) };
      // a drag of the divider by dx pixels, as the pointer would send it; and what was remembered for this tab
      case 'dragSplit': {
        const x0 = el.split.getBoundingClientRect().left + 3;
        const at = (type, x) => el.split.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, bubbles: true, cancelable: true }));
        at('pointerdown', x0); at('pointermove', x0 + Number(a.dx)); at('pointerup', x0 + Number(a.dx));
        return { ok: true, width: el.pane.getBoundingClientRect().width };
      }
      case 'storedWidth': { let v = null; try { v = storage ? storage.getItem(keyNow()) : null; } catch { v = null; } return { ok: true, value: v, key: keyNow() }; }
      case 'reveal': return reveal().then(() => ({ ok: true }));
      default: return { ok: false, error: `unknown reader action ${action}` };
    }
  }

  return {
    open, close, isOpen: () => !el.pane.hidden, path: () => state.path,
    setOverlay, onRepoChanged: checkStale, probe,
    editor: () => state.editor,
  };
}

const API = { create, refusalText, fmtSize };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoReader = API;

})(typeof window !== 'undefined' ? window : globalThis);
