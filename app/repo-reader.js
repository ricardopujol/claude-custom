'use strict';
/**
 * The code reader (#32): a file opened from the Files tab, in a split BESIDE the terminal (terminal | file,
 * a draggable divider remembered per tab; Esc or the close button gives the terminal its width back).
 * Read-only: CodeMirror 6 with the readOnly state, loaded on the FIRST open (a ~600 KB script, from disk, no
 * network), never at startup. If it can't load, the file is still shown as plain text.
 *
 *   create({ doc, requester, harness, storage, storageKey, typeMention, onClose }) ->
 *     { open(path), openAt(path, line, endLine), selectionInfo(), close(), isOpen(), path(), setOverlay(overlay), onRepoChanged(), probe(action, args) }
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
 * EDIT MODE (#50). The Edit button makes the file editable (CodeMirror's editing keymap and undo history come on
 * with it); a dot shows unsaved text; Ctrl+S or Save writes it through the host (`write`: atomic, host/repo-write.js)
 * and Done goes back to read-only. A file the host says can't be written back faithfully (UTF-16, not UTF-8, mixed
 * line endings, or a host too old to save) shows Edit disabled with the reason.
 *   NEVER A SILENT OVERWRITE. Every save names the hash of the version the person started from; the host refuses
 *   (`stale`) if the file on disk differs. The page then reads the disk's version and shows the banner "Claude
 *   changed this file while you were editing." with three choices, and the watcher raises the same banner as soon
 *   as it sees the change (when there are unsaved edits; with none it is the ordinary Reload bar):
 *     Reload      drops your edits and shows the disk version (still in edit mode);
 *     Keep mine   your text stays and the NEXT save replaces the disk version: it names the disk's hash, so a
 *                 third change in between is caught the same way. The person chose it; nothing else does;
 *     Compare     the two versions line by line (app/repo-linediff.js), with Back to editing.
 *   Leaving with unsaved text asks first: another file (or the same one again), closing the panel or Esc, and
 *   Done. The page also reports the unsaved file to main (`onDirty`) so closing the TAB asks too.
 *
 * MARKDOWN (BACKLOG #119 A9). A .md / .markdown file opens as a rendered PAGE (marked + DOMPurify + Mermaid, one lazily
 * loaded bundle: app/markdown-reader.js, built by build/build-markdown.mjs) with a Rendered | Source segment in the
 * header; the choice is kept per install (`readerMarkdownView`). The code view stays mounted under the page, so Edit
 * (always Source), Diff, selections and Compare keep working on it; anything that fails to render shows the source and
 * says why. A link in the page is classified by app/markdown-links.js: a file link opens in this reader, an http(s)
 * link goes to the browser through `onOpenUrl` (the page's own bridge: this module never names the shell), the rest
 * does nothing.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoReader`.
 */
(function (root) {

const MIN_PANE = 240;
const MIN_TERM = 300;
const WIDTH_STEP = 24;
const SCRIPT = './codemirror-reader.js';
const MD_SCRIPT = './markdown-reader.js';
const MD_KEY = 'readerMarkdownView';
const MD_FILE = /\.(md|markdown)$/i;

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const REFUSALS = {
  'too-large': (r) => `This file is ${fmtSize(r.size || 0)}, over the ${fmtSize(r.limit || 0)} the reader opens.`,
  binary: () => 'This looks like a binary file, so the reader does not open it.',
  gone: () => 'This file is deleted on disk.',
  'not-a-file': () => 'This is a folder, not a file.',
  unreadable: (r) => `This file could not be read${r.error ? `: ${r.error}` : '.'}`,
};
const refusalText = (r) => (REFUSALS[r.why] ? REFUSALS[r.why](r) : `The reader refused this path: ${r.why || r.error || 'unknown reason'}.`);

// Unchanged runs longer than this collapse to their edges in the Compare view
const COMPARE_CONTEXT = 3;
const COMPARE_MAX_ROWS = 4000;

const SAVE_WHY = {
  'too-large': () => 'it would be over the size the reader opens',
  protected: () => "git's own files aren't edited here",
  gone: () => 'the file and its folder are gone from disk (Done or Reload leaves this view)',
  unreadable: () => "the file's place on disk can't be resolved",
  'not-a-file': () => "it isn't a file",
  'bad request': () => 'the host refused the request',
};
const saveFailure = (r) => (r && SAVE_WHY[r.why] ? SAVE_WHY[r.why](r) : (r && (r.error || r.why)) || 'unknown error');

const OLD_HOST = "this session's host is older than this window and can't save; restart the session to edit";

function create({ doc, requester, harness, storage, storageKey = 'repoReaderWidth', typeMention, onClose, termRect, confirmDiscard, onDirty, onAsk, onOpenUrl } = {}) {
  const keyNow = () => (typeof storageKey === 'function' ? storageKey() : storageKey);
  const lang = root.repoLanguage || (typeof require === 'function' ? require('./repo-language') : null);
  const mention = root.repoMention || (typeof require === 'function' ? require('./repo-mention') : null);
  const lineDiff = root.repoLineDiff || (typeof require === 'function' ? require('./repo-linediff') : null);
  const $ = (id) => doc.getElementById(id);
  const el = {
    pane: $('reader'), split: $('reader-split'), path: $('reader-path'), meta: $('reader-meta'),
    diff: $('reader-diff'), mention: $('reader-mention'), ask: $('reader-ask'), reveal: $('reader-reveal'), close: $('reader-close'),
    bar: $('reader-bar'), barText: $('reader-bar-text'), reload: $('reader-reload'),
    body: $('reader-body'), note: $('reader-note'), noteText: $('reader-note-text'), noteReveal: $('reader-note-reveal'),
    termwrap: $('termwrap'),
    dirty: $('reader-dirty'), edit: $('reader-edit'), save: $('reader-save'),
    conflict: $('reader-conflict'), conflictText: $('reader-conflict-text'), conflictReload: $('reader-conflict-reload'),
    conflictKeep: $('reader-conflict-keep'), conflictCompare: $('reader-conflict-compare'),
    compare: $('reader-compare'), compareRows: $('reader-compare-rows'), compareBack: $('reader-compare-back'),
    md: $('reader-md'), view: $('reader-view'), viewRendered: $('reader-view-rendered'), viewSource: $('reader-view-source'),
  };
  // Asked before unsaved text is thrown away. No dialog available means NO: nothing is discarded unasked.
  // The probe (a real window has no one to click a native dialog) answers for the person: { answer, asked[] }.
  let probeAnswer = null;
  const confirmLeave = async (message) => {
    if (probeAnswer) { probeAnswer.asked.push(message); return probeAnswer.answer === true; }
    try { return (await (confirmDiscard || (async (m) => (typeof root.confirm === 'function' ? root.confirm(m) : false)))(message)) === true; } catch { return false; }
  };

  const state = {
    path: null, mode: 'file', stamp: null, modified: false, width: 0, overlayFiles: new Map(), editor: null, cmLoaded: false,
    token: 0, status: '', diffSource: null,
    // edit mode: `base` is the version the person started from (what dirty is measured against, and the hash a save
    // names); `conflict` is the banner's state; `reported` is the last unsaved path told to `onDirty`
    editing: false, base: null, conflict: null, comparing: false, saving: false, reported: null,
    // Markdown (#119): `view` is the person's choice for every .md file, kept per install; `rendered` says the page is on screen
    view: 'rendered', rendered: false, mdSeq: 0, mdPath: null,
  };
  try { if (storage && storage.getItem(MD_KEY) === 'source') state.view = 'source'; } catch { /* storage refused */ }
  let cmPromise = null;
  let mdPromise = null;
  let externalProbe = null;

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

  // ---- Markdown, on first use (BACKLOG #119 A9) ----
  // The page is the same file shown another way: the code view stays mounted underneath (selections, Edit and Diff
  // keep working on it) and #reader-md is laid over it. The bundle (marked + DOMPurify + Mermaid, ~5 MB) is loaded
  // the first time a .md file is shown rendered, never at startup. Anything that goes wrong shows the source.

  function loadMarkdown() {
    if (root.repoMarkdown) return Promise.resolve(root.repoMarkdown);
    if (!mdPromise) {
      mdPromise = new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = MD_SCRIPT;
        s.onload = () => (root.repoMarkdown ? resolve(root.repoMarkdown) : reject(new Error('the Markdown viewer did not start')));
        s.onerror = () => reject(new Error('the Markdown viewer could not be loaded'));
        doc.head.append(s);
      }).catch((err) => { mdPromise = null; throw err; });
    }
    return mdPromise;
  }

  const wantsRendered = () => !!(state.path && MD_FILE.test(state.path) && state.view === 'rendered' && state.mode === 'file' && !state.editing && state.base && state.editor);

  // Back to the code view: the page is released, the code is shown (unless a note or the compare view holds the pane).
  function unrender() {
    state.mdSeq += 1;                              // a render still in flight is dropped
    state.rendered = false;
    el.md.replaceChildren();
    el.md.hidden = true;
    if (el.note.hidden && el.compare.hidden) el.body.hidden = false;
  }

  // Bring the pane in line with what the person wants to see for the file now loaded.
  async function applyView() {
    if (!wantsRendered()) { unrender(); return; }
    const seq = ++state.mdSeq;
    const path = state.path;
    const text = state.base.text;
    const keep = state.mdPath === path ? el.md.scrollTop : 0;
    el.body.hidden = true;                         // no flash of source while the page is made
    let result;
    try {
      const md = await loadMarkdown();
      result = await md.render(text, { fromFile: path, onLink: followLink });
    } catch (err) {
      if (seq !== state.mdSeq) return;
      state.status = `couldn't render: ${(err && err.message) || 'unknown error'}; showing the source`;
      unrender();
      paintHead();
      return;
    }
    if (seq !== state.mdSeq || !wantsRendered() || state.path !== path) return;
    el.md.replaceChildren(result.node);
    el.md.hidden = false;
    el.body.hidden = true;
    el.md.scrollTop = keep;
    state.rendered = true;
    state.mdPath = path;
    paintHead();
  }

  function setView(view) {
    if (view !== 'rendered' && view !== 'source') return;
    state.view = view;
    try { if (storage) storage.setItem(MD_KEY, view); } catch { /* storage refused */ }
    paintHead();
    if (state.path && state.base) applyView();
  }

  function openUrl(url) {
    const failed = () => { state.status = 'could not open the link in your browser'; paintHead(); };
    try {
      if (externalProbe) { externalProbe.push(url); return; }
      if (typeof onOpenUrl !== 'function') throw new Error('no way to open it');
      // (the page's own bridge, wired in renderer.js: this module never names the shell, test/source-contracts.test.js)
      Promise.resolve(onOpenUrl(url)).then((ok) => { if (ok === false) failed(); }, failed);
    } catch {
      failed();
    }
  }

  // A click in the page, already classified by the bundle (app/markdown-links.js). Defence in depth: the kind and
  // the target are checked again here, so a bundle that passed on something odd can't make the reader open it.
  function followLink(link) {
    if (!link || typeof link.target !== 'string' || link.target === '') return;
    if (link.kind === 'file') { open(link.target); return; }
    if (link.kind === 'http' && /^https?:\/\//i.test(link.target)) openUrl(link.target);
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
      state.editor = cm.create(el.body, { onChange: onEditorChange });
      state.cmLoaded = true;
    } catch (err) {
      state.status = `${err.message}; showing plain text`;
      state.editor = plainEditor();
    }
    return state.editor;
  }

  // ---- the pane ----

  // WHERE THE READER SITS. The dock tree (app/dock-tree-display.js) places #termwrap with an inline rectangle on
  // every render, and the terminal bar and the other overlays live inside it. The reader is a pair of absolutely
  // positioned siblings in #dock that take the right part of THAT rectangle: layout() (called by renderer.js
  // after every applyBoxes) shortens #termwrap by the reader's width and puts the reader and its divider in the
  // freed strip. The terminal bar therefore stays over the terminal only, and the terminal's own resize
  // observer refits it. `termRect()` is the plan's full terminal rectangle in #dock's coordinates.
  const SPLIT = 6;
  const fullRect = () => {
    const r = typeof termRect === 'function' ? termRect() : null;
    if (r && Number.isFinite(r.width)) return r;
    return { x: el.termwrap.offsetLeft, y: el.termwrap.offsetTop, width: el.termwrap.offsetWidth + (el.pane.hidden ? 0 : state.width + SPLIT), height: el.termwrap.offsetHeight };
  };
  const roomNow = () => fullRect().width;
  function widthBounds(room = roomNow()) {
    return { min: MIN_PANE, max: Math.max(MIN_PANE, room - SPLIT - MIN_TERM) };
  }
  function layout() {
    if (el.pane.hidden) return;
    if (doc.body.classList && (doc.body.classList.contains('focus-mode') || doc.body.classList.contains('lean'))) return;       // only the terminal shows
    const r = fullRect();
    const { min, max } = widthBounds(r.width);
    const w = Math.round(Math.min(max, Math.max(min, state.width)));
    el.termwrap.style.width = `${Math.max(0, r.width - w - SPLIT)}px`;
    el.split.style.left = `${r.x + r.width - w - SPLIT}px`;
    el.split.style.top = `${r.y}px`;
    el.split.style.width = `${SPLIT}px`;
    el.split.style.height = `${r.height}px`;
    el.pane.style.left = `${r.x + r.width - w}px`;
    el.pane.style.top = `${r.y}px`;
    el.pane.style.width = `${w}px`;
    el.pane.style.height = `${r.height}px`;
  }
  function setWidth(px, { save = true, room } = {}) {
    const { min, max } = widthBounds(room);
    const w = Math.round(Math.min(max, Math.max(min, px)));
    state.width = w;
    layout();
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
    const room = roomNow();
    el.pane.hidden = false;
    el.split.hidden = false;
    restoreWidth(room);
  }

  // Closes the panel. With unsaved edits it ASKS first (`force` skips the question: the caller has asked already).
  // Resolves true when it closed (or was already closed), false when the person kept it open.
  async function close({ force = false } = {}) {
    if (el.pane.hidden) return true;
    if (!force && isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Close the reader and discard them?`))) return false;
    if (el.pane.hidden) return true;               // closed while the question was up
    state.token += 1;
    el.pane.hidden = true;
    el.split.hidden = true;
    // the terminal takes its whole rectangle back (its observer refits it)
    const r = fullRect();
    el.termwrap.style.width = `${r.width}px`;
    stopEditing({ revert: false });
    unrender();                                    // the page's DOM is released with the pane
    state.mdPath = null;
    state.path = null;
    state.stamp = null;
    state.base = null;
    syncDirty();
    if (onClose) onClose();
    return true;
  }

  // ---- showing a file ----

  function clearBar() { el.bar.hidden = true; el.barText.textContent = ''; el.reload.hidden = false; }
  function showBar(text, { reload }) { el.barText.textContent = text; el.reload.hidden = !reload; el.bar.hidden = false; }
  function showNote(text, { reveal }) {
    unrender();
    el.noteText.textContent = text;
    el.noteReveal.hidden = !reveal;
    el.note.hidden = false;
    el.body.hidden = true;
  }
  function hideNote() { el.note.hidden = true; el.body.hidden = state.rendered; }

  function paintHead() {
    el.path.textContent = state.path || '';
    el.path.title = state.path || '';
    const edited = state.path && state.overlayFiles.get(state.path);
    // Diff is offered for a file Claude edited AND for one git calls modified (a Bash or hand change, PR #95 Dexter D2)
    // (not while editing: a diff would replace the text being edited)
    const seg = !!(state.path && MD_FILE.test(state.path) && state.base && state.mode === 'file' && !state.editing);
    el.view.hidden = !seg;
    el.viewRendered.setAttribute('aria-pressed', state.view === 'rendered' ? 'true' : 'false');
    el.viewSource.setAttribute('aria-pressed', state.view === 'source' ? 'true' : 'false');
    el.diff.hidden = state.editing || !((edited && edited.tier === 'edited') || state.modified);
    el.diff.textContent = state.mode === 'diff' ? 'File' : 'Diff';
    el.diff.setAttribute('aria-pressed', state.mode === 'diff' ? 'true' : 'false');
    // Edit: only with an editor that can edit (not the plain-text fallback), on a file view; disabled with the
    // host's reason when the file can't be written back faithfully
    const canEdit = !!(state.base && state.mode === 'file' && state.editor && typeof state.editor.setEditable === 'function');
    el.edit.hidden = !canEdit;
    el.edit.disabled = canEdit && state.base.editable !== true;
    el.edit.title = canEdit ? (state.base.editable === true ? 'Edit this file (Ctrl+S saves)' : state.base.editableWhy || "This file can't be edited here") : '';
    el.edit.textContent = state.editing ? 'Done' : 'Edit';
    el.edit.setAttribute('aria-pressed', state.editing ? 'true' : 'false');
    const dirty = isDirty();
    el.dirty.hidden = !dirty;
    el.save.hidden = !state.editing;
    el.save.disabled = !dirty || state.saving;
    const bits = [];
    if (state.mode === 'diff' && state.diffSource) bits.push(state.diffSource === 'claude' ? "Claude's edits" : 'git diff HEAD');
    else if (state.stamp) bits.push(fmtSize(state.stamp.size));
    if (state.status) bits.push(state.status);
    el.meta.textContent = bits.join(' · ');
  }

  // `discard`: the person already chose to drop unsaved edits (Reload), so nothing is asked.
  // `keepEditing`: come back in edit mode when the file loads (Reload while editing).
  async function open(path, { keepMode = false, discard = false, keepEditing = false } = {}) {
    if (typeof path !== 'string' || path === '') return;
    if (!discard && isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Discard them and open ${path}?`))) return false;
    const same = state.path === path;
    const resume = keepEditing && state.editing;
    stopEditing({ revert: false });
    state.path = path;
    state.base = null;
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
      state.modified = false;
      showNote(refusalText(r), { reveal: r.why === 'too-large' || r.why === 'binary' || r.why === 'unreadable' });
      paintHead();
      return;
    }
    const editor = await ensureEditor();
    if (token !== state.token) return;
    hideNote();
    state.stamp = { size: r.size, mtimeMs: r.mtimeMs };
    state.modified = r.modified === true;
    state.base = baseOf(r);
    editor.show({ text: r.text, name: r.path, mode: 'file', language: lang.languageFor(r.path) });
    if (resume && state.mode === 'file' && state.base.editable && typeof editor.setEditable === 'function') startEditing();
    syncDirty();
    if (state.mode === 'diff') { await showDiff(token); return; }
    applyView();                                   // not awaited: the file is shown (as code) as soon as it is read
  }

  async function showDiff(token) {
    const r = await requester.request('diff', { path: state.path });
    if (token !== state.token) return;
    const editor = await ensureEditor();
    if (token !== state.token) return;
    if (!r.ok) { showNote(`The diff could not be read: ${r.error || r.why || 'unknown error'}`, { reveal: false }); paintHead(); return; }
    if (r.source === null) { showNote('No changes recorded for this file.', { reveal: false }); paintHead(); return; }
    unrender();
    hideNote();
    state.diffSource = r.source;
    editor.show({ text: r.text, name: r.path, mode: 'diff', language: null });
    paintHead();
  }

  async function toggleDiff() {
    if (!state.path || state.editing) return;
    const token = ++state.token;
    if (state.mode === 'diff') { state.mode = 'file'; await open(state.path, { keepMode: true, discard: true }); return; }
    state.mode = 'diff';
    paintHead();
    await showDiff(token);
  }

  // ---- edit mode (#50) ----

  // What the person started from. Anything the host can't write back faithfully (or a host too old to have said
  // so: no hash) is not editable, with the reason.
  function baseOf(r) {
    const hashed = typeof r.hash === 'string';
    return {
      text: r.text, hash: hashed ? r.hash : null, eol: r.eol === 'crlf' ? 'crlf' : 'lf', bom: r.bom === true,
      editable: hashed && r.editable === true, editableWhy: hashed ? r.editableWhy : OLD_HOST,
    };
  }

  // Unsaved: editing, and either the text differs from the version started from or that version is gone from disk
  // (hash null: a save recreates the file).
  function isDirty() {
    return !!(state.editing && state.base && state.editor && (state.base.hash === null || state.editor.text() !== state.base.text));
  }
  // Repaint, and tell the page which file (if any) has unsaved text, so closing the tab can ask.
  function syncDirty() {
    paintHead();
    const now = isDirty() ? state.path : null;
    if (now !== state.reported) {
      state.reported = now;
      if (typeof onDirty === 'function') { try { onDirty(now); } catch (err) { console.error('[repo] onDirty threw', err); } }
    }
  }
  function onEditorChange() {
    if (!state.editing) return;
    if (state.status === 'saved' || state.status.startsWith('not saved')) state.status = '';
    syncDirty();
  }

  function hideCompare() {
    state.comparing = false;
    el.compare.hidden = true;
    if (el.note.hidden) el.body.hidden = false;
  }
  function clearConflict() {
    state.conflict = null;
    el.conflict.hidden = true;
    hideCompare();
  }
  function startEditing() {
    state.editing = true;
    unrender();
    state.editor.setEditable(true);
    if (typeof state.editor.focus === 'function') state.editor.focus();
  }
  // Back to read-only. `revert` puts the version started from back on screen (Done after "discard").
  function stopEditing({ revert }) {
    const was = state.editing;
    state.editing = false;
    clearConflict();
    if (state.editor && typeof state.editor.setEditable === 'function') state.editor.setEditable(false);
    if (was && revert && state.base && state.editor && state.editor.text() !== state.base.text) {
      state.editor.show({ text: state.base.text, name: state.path, mode: 'file', language: lang.languageFor(state.path) });
    }
    syncDirty();
  }

  async function toggleEdit() {
    if (!state.path || !state.base) return;
    if (state.editing) {
      const token = state.token;
      if (isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Discard them and stop editing?`))) return;
      if (token !== state.token) return;
      stopEditing({ revert: true });
      applyView();
      return;
    }
    if (!state.base.editable || state.mode !== 'file' || !state.editor || typeof state.editor.setEditable !== 'function') return;
    startEditing();
    syncDirty();
  }

  async function save() {
    if (!state.editing || !state.base || state.saving || !isDirty()) return;
    const token = state.token;
    const path = state.path;
    const base = state.base;
    const text = state.editor.text();
    state.saving = true;
    state.status = 'saving…';
    paintHead();
    let r;
    try {
      r = await requester.request('write', { path, text, eol: base.eol, bom: base.bom, expectHash: base.hash });
    } finally {
      state.saving = false;
    }
    if (token !== state.token || path !== state.path || !state.editing) return;
    if (r && r.ok === true) {
      state.base = { ...base, text, hash: r.hash, editable: true };
      state.stamp = { size: r.size, mtimeMs: r.mtimeMs };
      clearConflict();
      clearBar();
      state.status = 'saved';
      syncDirty();
      return;
    }
    if (r && r.why === 'stale') {
      state.status = '';
      if (!(await raiseConflict())) { state.status = 'not saved: the file was touched on disk; save again'; syncDirty(); }
      return;
    }
    // no `why`: the host never answered, so the write may still have gone through (a later save checks for that)
    state.status = r && r.why === undefined ? `not saved: ${saveFailure(r)} (it may have gone through; the next save checks)` : `not saved: ${saveFailure(r)}`;
    syncDirty();
  }

  // ---- the conflict banner ----

  // The file on disk is not the one the person started from. Read what is there now and show the three choices.
  // Resolves false when there turned out to be no conflict (the bytes are the same, only the time moved).
  async function raiseConflict() {
    const token = state.token;
    const path = state.path;
    const r = await requester.request('read', { path });
    if (token !== state.token || path !== state.path || !state.editing || !state.base) return true;
    if (!r.ok && r.why === 'gone') { showConflict({ gone: true }); return true; }
    if (!r.ok && r.why === undefined) {                    // the host didn't answer: say so, never guess
      state.status = `the file changed on disk, and reading it failed: ${r.error || 'no answer'}`;
      syncDirty();
      return true;
    }
    if (!r.ok) { showConflict({ blocked: refusalText(r) }); return true; }
    if (r.hash === state.base.hash) {                      // touched, not changed
      state.stamp = { size: r.size, mtimeMs: r.mtimeMs };
      return false;
    }
    if (r.text === state.editor.text() && typeof r.hash === 'string' && r.editable === true) {
      // the disk already holds exactly what is on screen (a save whose answer was lost, or the same edit made
      // elsewhere): nothing to resolve, so no banner and no accusation: it is the new version started from. Only
      // when it can be written back faithfully: a re-encoded file (UTF-16...) is a conflict, never a base we would
      // re-encode on the next save
      state.base = baseOf(r);
      state.stamp = { size: r.size, mtimeMs: r.mtimeMs };
      clearConflict();
      state.status = 'saved';
      syncDirty();
      return true;
    }
    showConflict({ disk: r });
    return true;
  }

  function showConflict(c) {
    state.conflict = c;
    clearBar();
    hideCompare();
    el.conflictText.textContent = c.gone ? 'This file was deleted on disk while you were editing.'
      : c.blocked ? `Claude changed this file while you were editing, and it can't be shown here: ${c.blocked}`
        : 'Claude changed this file while you were editing.';
    el.conflictReload.hidden = !!c.gone;
    el.conflictCompare.hidden = !c.disk;
    el.conflictKeep.hidden = !(c.gone || (c.disk && c.disk.editable === true && typeof c.disk.hash === 'string'));
    el.conflict.hidden = false;
    syncDirty();
  }

  function conflictReload() {
    if (state.path) open(state.path, { keepMode: true, discard: true, keepEditing: true });
  }

  // Your text stays; the NEXT save is checked against the disk version just seen, so replacing it is the person's
  // choice and a further change in between is still caught.
  function conflictKeep() {
    const c = state.conflict;
    if (!c || !state.base) return;
    if (c.gone) {
      state.base = { ...state.base, hash: null };
      state.stamp = null;
    } else if (c.disk) {
      state.base = baseOf(c.disk);
      state.stamp = { size: c.disk.size, mtimeMs: c.disk.mtimeMs };
    } else {
      return;
    }
    clearConflict();
    syncDirty();
  }

  function conflictCompare() {
    const c = state.conflict;
    if (!c || !c.disk || !state.editor) return;
    const rows = lineDiff.diffLines(c.disk.text, state.editor.text());
    const out = [];
    const row = (kind, text, d, m) => {
      const div = doc.createElement('div');
      div.className = `cmp-row ${kind}`;
      div.textContent = text === '' ? ' ' : text;
      div.dataset.d = d === null ? '' : String(d);
      div.dataset.m = m === null ? '' : String(m);
      out.push(div);
    };
    // unchanged runs collapse to their edges, so one changed line in a long file isn't a long scroll
    for (let i = 0; i < rows.length && out.length < COMPARE_MAX_ROWS;) {
      if (rows[i].kind !== 'same') { row(rows[i].kind, rows[i].text, rows[i].diskNo, rows[i].mineNo); i += 1; continue; }
      let j = i;
      while (j < rows.length && rows[j].kind === 'same') j += 1;
      const head = i === 0 ? 0 : COMPARE_CONTEXT;
      const tail = j === rows.length ? 0 : COMPARE_CONTEXT;
      if (j - i <= head + tail + 1) { for (let k = i; k < j; k += 1) row('same', rows[k].text, rows[k].diskNo, rows[k].mineNo); }
      else {
        for (let k = i; k < i + head; k += 1) row('same', rows[k].text, rows[k].diskNo, rows[k].mineNo);
        row('gap', `${j - i - head - tail} unchanged lines`, null, null);
        for (let k = j - tail; k < j; k += 1) row('same', rows[k].text, rows[k].diskNo, rows[k].mineNo);
      }
      i = j;
    }
    if (out.length >= COMPARE_MAX_ROWS) row('gap', 'the rest is not shown', null, null);
    el.compareRows.replaceChildren(...out);
    state.comparing = true;
    el.compare.hidden = false;
    el.body.hidden = true;
  }

  // ---- changed on disk ----

  async function checkStale() {
    if (!state.path || !state.stamp || el.pane.hidden || state.saving || state.conflict) return;
    const path = state.path;
    // The token says which OPEN this answer belongs to (PR #95 Dexter D14): a stat asked before a Reload, and
    // answered while its read is out, describes a file that is about to be replaced and must not raise the bar
    // over the fresh text.
    const token = state.token;
    const r = await requester.request('stat', { path });
    if (path !== state.path || token !== state.token || state.saving) return;
    if (!r.ok && r.why === 'gone') {
      if (isDirty()) { showConflict({ gone: true }); return; }
      showBar('This file was deleted on disk. What you see is the last version read.', { reload: false });
      return;
    }
    if (!r.ok) return;                                  // can't tell: say nothing rather than guess
    if (r.size !== state.stamp.size || r.mtimeMs !== state.stamp.mtimeMs) {
      if (isDirty()) { await raiseConflict(); return; }       // unsaved edits: the three-way banner, never the plain bar
      showBar('This file changed on disk.', { reload: true });
    } else if (!el.bar.hidden) {
      clearBar();
    }
  }

  // ---- @ in prompt ----

  function mentionSelection() {
    if (!state.path) return;
    const sel = state.editor && state.mode === 'file' && !state.rendered ? state.editor.selection() : null;
    const m = mention.mentionText(state.path, sel ? mention.rangeOfLines(sel) : null);
    if (!m.ok) { state.status = `not typed: ${m.reason}`; paintHead(); return; }
    typeMention(m.text, (r) => {
      state.status = r && r.ok ? `typed ${m.text}; press Enter in the terminal to send it` : `not typed: ${(r && r.reason) || 'refused'}`;
      paintHead();
    });
  }

  // ---- "What's this?" and "open at line" (Ask the repo, BACKLOG #33) ----

  /** The selected lines of the file on screen as { file, start, end } (1-based, a bare cursor is none), or null. */
  function selectionInfo() {
    if (!state.path || state.mode !== 'file' || !state.editor || state.rendered) return null;
    const range = mention.rangeOfLines(state.editor.selection());
    return range ? { file: state.path, start: range.from, end: range.to } : null;
  }

  function askSelection() {
    // The host explains the file as it is on DISK; with unsaved edits the buffer's line numbers would name different code (PR #169 Miguel Y3).
    if (isDirty()) { state.status = "save the file first, then click What's this? (it explains the saved file)"; paintHead(); return; }
    const sel = selectionInfo();
    if (!sel) { state.status = state.rendered ? "switch to Source, select some code, then click What's this?" : "select some code first, then click What's this?"; paintHead(); return; }
    state.status = '';
    paintHead();
    if (typeof onAsk === 'function') onAsk(sel);
  }

  /** Open a file with line `line` (to `endLine`) selected and scrolled to: a card or a citation in the Ask panel. */
  async function openAt(path, line, endLine) {
    const r = await open(path);
    if (r === false || state.path !== path || state.mode !== 'file' || !state.editor || typeof state.editor.setSelection !== 'function') return r;
    if (!Number.isInteger(line) || line < 1) return r;
    state.editor.setSelection(line, Number.isInteger(endLine) && endLine >= line ? endLine : line);
    return r;
  }

  // ---- events ----

  el.close.addEventListener('click', () => { close(); });
  el.diff.addEventListener('click', toggleDiff);
  el.mention.addEventListener('click', mentionSelection);
  if (el.ask) { el.ask.hidden = typeof onAsk !== 'function'; el.ask.addEventListener('click', askSelection); }
  // the plain Reload bar only rises over a file with no unsaved edits, so there is nothing to ask about
  // The bar rose over a file with no unsaved edits, but edits can be typed after that: ask again at click time.
  el.reload.addEventListener('click', async () => {
    if (!state.path) return;
    if (isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Discard them and reload it from disk?`))) return;
    open(state.path, { keepMode: true, discard: true, keepEditing: true });
  });
  el.edit.addEventListener('click', () => { toggleEdit(); });
  el.viewRendered.addEventListener('click', () => setView('rendered'));
  el.viewSource.addEventListener('click', () => setView('source'));
  el.save.addEventListener('click', () => { save(); });
  el.conflictReload.addEventListener('click', conflictReload);
  el.conflictKeep.addEventListener('click', conflictKeep);
  el.conflictCompare.addEventListener('click', conflictCompare);
  el.compareBack.addEventListener('click', () => { hideCompare(); if (state.editor && typeof state.editor.focus === 'function') state.editor.focus(); });
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
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); return; }
    // Ctrl+S saves while editing; otherwise the key is left alone
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's' && state.editing) { e.preventDefault(); save(); }
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
    // The reader's right edge is the terminal rectangle's right edge, which doesn't move as it grows: its width is
    // that edge minus the pointer (in #dock's coordinates), less half the divider.
    const r = fullRect();
    const dock = doc.getElementById('dock');
    const dockLeft = dock ? dock.getBoundingClientRect().left : 0;
    setWidth(r.x + r.width - (e.clientX - dockLeft) - SPLIT / 2, { save: false });
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    doc.body.classList.remove('reader-resizing');
    setWidth(state.width);
  };
  el.split.addEventListener('pointerup', endDrag);
  el.split.addEventListener('pointercancel', endDrag);
  el.split.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth(state.width + (e.key === 'ArrowLeft' ? WIDTH_STEP : -WIDTH_STEP));
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
          editing: state.editing, dirty: isDirty(), editShown: !el.edit.hidden, editDisabled: el.edit.disabled, editLabel: el.edit.textContent,
          editTitle: el.edit.title, saveShown: !el.save.hidden, saveDisabled: el.save.disabled, dotShown: !el.dirty.hidden,
          conflictShown: !el.conflict.hidden, conflictText: el.conflictText.textContent, compareShown: !el.compare.hidden,
          compareRows: Array.from(el.compareRows.children || [], (r) => `${r.className}|${r.textContent}`).slice(0, 40),
          mdSegmentShown: !el.view.hidden, mdView: state.view, mdRenderedOn: state.rendered, mdShown: !el.md.hidden, mdLoaded: !!root.repoMarkdown,
          mdPressed: { rendered: el.viewRendered.getAttribute('aria-pressed'), source: el.viewSource.getAttribute('aria-pressed') },
          diffVisible: !el.diff.hidden, diffLabel: el.diff.textContent, meta: el.meta.textContent,
          barShown: !el.bar.hidden, barText: el.barText.textContent, reloadShown: !el.reload.hidden,
          noteShown: !el.note.hidden, noteText: el.noteText.textContent, noteRevealShown: !el.noteReveal.hidden,
          width: r.width, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          selection: selectionInfo(), askShown: !!el.ask && !el.ask.hidden,
          diffClasses: cm ? { add: cm.querySelectorAll('.cm-diff-add').length, del: cm.querySelectorAll('.cm-diff-del').length, hunk: cm.querySelectorAll('.cm-diff-hunk').length } : null,
          heap: root.performance && root.performance.memory ? root.performance.memory.usedJSHeapSize : null,
        };
      }
      case 'open': return open(a.path).then(() => ({ ok: true }));
      case 'openAt': return openAt(a.path, a.line, a.endLine).then(() => ({ ok: true }));
      case 'ask': askSelection(); return { ok: true };
      case 'close': return close(a).then((closed) => ({ ok: true, closed }));
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
      // edit mode (verify/probe-reader-edit.js): the buttons and keys by name, and typing as a change event
      case 'edit': return toggleEdit().then(() => ({ ok: true }));
      case 'save': return save().then(() => ({ ok: true }));
      case 'ctrlS': el.pane.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); return { ok: true };
      case 'type': {
        if (!state.editor || !state.editor.replaceAll) return { ok: false, error: 'no editor' };
        state.editor.replaceAll(String(a.text));
        return { ok: true };
      }
      case 'confirmAnswer': {
        const asked = probeAnswer ? probeAnswer.asked : [];
        probeAnswer = a.answer === null ? null : { answer: a.answer === true, asked: [] };
        return { ok: true, asked };
      }
      case 'confirmAsked': return { ok: true, asked: probeAnswer ? probeAnswer.asked.slice() : [] };
      case 'conflictReload': conflictReload(); return { ok: true };
      case 'conflictKeep': conflictKeep(); return { ok: true };
      case 'conflictCompare': conflictCompare(); return { ok: true };
      case 'compareBack': el.compareBack.click(); return { ok: true };
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
      // Markdown (verify/probe-markdown-reader.js): the segment by name, what the page holds, a click on its nth link,
      // and the browser opens recorded instead of performed
      case 'setView': setView(a.view); return { ok: true };
      case 'mdDom': {
        const page = el.md.querySelector('.md-page');
        if (!page) return { ok: true, page: false };
        const all = Array.from(page.querySelectorAll('*'));
        return {
          ok: true, page: true, textLength: page.textContent.length, rect: (() => { const r = el.md.getBoundingClientRect(); return { width: r.width, height: r.height, scrollHeight: el.md.scrollHeight }; })(),
          headings: Array.from(page.querySelectorAll('h1,h2,h3,h4,h5,h6'), (h) => ({ tag: h.tagName, text: h.textContent, anchor: h.dataset.mdAnchor || null, ruleLeft: getComputedStyle(h).borderLeftWidth })),
          tables: page.querySelectorAll('table').length, tableWrapped: Array.from(page.querySelectorAll('table'), (t) => t.parentElement.className === 'md-table' && getComputedStyle(t.parentElement).overflowX === 'auto'),
          links: Array.from(page.querySelectorAll('a'), (x) => ({ text: x.textContent, kind: x.dataset.mdKind || null, target: x.dataset.mdTarget || null, hasHref: x.hasAttribute('href'), title: x.title })),
          svgs: page.querySelectorAll('svg').length, diagramBoxes: page.querySelectorAll('.md-diagram').length,
          diagramErrors: Array.from(page.querySelectorAll('.md-diagram-error'), (n) => n.textContent),
          fenceBlocks: page.querySelectorAll('pre > code').length,
          checkboxes: Array.from(page.querySelectorAll('input'), (i) => ({ type: i.type, disabled: i.disabled, checked: i.checked })),
          danger: {
            script: page.querySelectorAll('script').length, iframe: page.querySelectorAll('iframe,frame,object,embed').length,
            img: page.querySelectorAll('img').length, style: page.querySelectorAll('style:not(svg style)').length,
            onAttr: all.filter((n) => Array.from(n.attributes).some((at) => /^on/i.test(at.name))).length,
            styleAttr: all.filter((n) => n.hasAttribute('style') && !n.closest('svg')).length,
            ids: all.filter((n) => n.hasAttribute('id') && !n.closest('svg')).length,
            hrefAny: page.querySelectorAll('[href]:not(svg *)').length, jsUrls: all.filter((n) => Array.from(n.attributes).some((at) => /^\s*javascript:/i.test(at.value))).length,
            foreign: page.querySelectorAll('foreignObject').length,
          },
          svgDanger: { script: page.querySelectorAll('svg script').length, on: Array.from(page.querySelectorAll('svg *')).filter((n) => Array.from(n.attributes).some((at) => /^on/i.test(at.name))).length,
            hrefs: Array.from(page.querySelectorAll('svg [href], svg [xlink\\:href]'), (n) => n.getAttribute('href') || n.getAttribute('xlink:href')) },
          globals: { pwned: root.__mdPwned === undefined ? null : root.__mdPwned, readerStillThere: !!doc.getElementById('reader') && doc.getElementById('reader') === el.pane },
          // a diagram's own init must not restyle the app (PR #204 S1), and its links are classified like the page's (B1)
          chrome: { body: root.getComputedStyle(doc.body).display, pane: root.getComputedStyle(el.pane).display, paneWidth: el.pane.getBoundingClientRect().width, href: root.location.href },
          diagramLinks: Array.from(page.querySelectorAll('.md-diagram a'), (x) => ({ text: x.textContent.trim(), kind: x.getAttribute('data-md-kind'), target: x.getAttribute('data-md-target'), attrs: Array.from(x.attributes, (at) => at.name) })),
          mermaidTexts: Array.from(page.querySelectorAll('.md-diagram text'), (t) => t.textContent).slice(0, 20),
        };
      }
      case 'mdLink': {
        const link = Array.from(el.md.querySelectorAll('.md-page a')).filter((x) => (a.text ? x.textContent === a.text : true))[Number(a.index) || 0];
        if (!link) return { ok: false, error: 'no such link' };
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true };
      }
      case 'mdReveal': {                           // scroll the nth diagram to the middle of the page (for a screenshot)
        const box = el.md.querySelectorAll('.md-diagram')[Number(a.index) || 0];
        if (!box) return { ok: false, error: 'no such diagram' };
        box.scrollIntoView({ block: 'center' });
        return { ok: true };
      }
      // a navigation the page itself starts, as a stray link would: main must refuse it (app/nav-guard.js)
      case 'navTry': { try { root.location.assign(String(a.url)); } catch { /* refused is fine */ } return { ok: true, href: root.location.href }; }
      case 'mdScroll': { const top = el.md.scrollTop; return { ok: true, top, height: el.md.clientHeight }; }
      case 'externalProbe': externalProbe = a.on === false ? null : []; return { ok: true };
      case 'externalOpened': return { ok: true, urls: externalProbe ? externalProbe.slice() : null };
      default: return { ok: false, error: `unknown reader action ${action}` };
    }
  }

  return {
    open, openAt, selectionInfo, close, isOpen: () => !el.pane.hidden, path: () => state.path, hasUnsaved: isDirty, save,
    setOverlay, onRepoChanged: checkStale, probe, layout,
    editor: () => state.editor,
  };
}

const API = { create, refusalText, fmtSize };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoReader = API;

})(typeof window !== 'undefined' ? window : globalThis);
