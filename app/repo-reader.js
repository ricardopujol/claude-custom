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
 *   Changes view   openChange(info): a file picked in the Changes panel (BACKLOG #119 A3), its base version (HEAD, or the merge-base
 *                  with develop) beside what is on disk now, side by side. A "+" on a line opens a one-line field; Enter types
 *                  `In <path>:<line> - <comment>` into the prompt and NEVER submits it. See "the Changes Compare" below.
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

// `changes` is the `changes` conversation (request(action, body)) and `typeComment(text, done)` the page's typing path for a review comment
// (planTyping kind `comment`); both come from app/repo-browser.js and are absent in an older wiring.
function create({ doc, requester, changes, harness, storage, storageKey = 'repoReaderWidth', typeMention, typeComment, onClose, termRect, confirmDiscard, onDirty, onAsk } = {}) {
  const keyNow = () => (typeof storageKey === 'function' ? storageKey() : storageKey);
  const lang = root.repoLanguage || (typeof require === 'function' ? require('./repo-language') : null);
  const mention = root.repoMention || (typeof require === 'function' ? require('./repo-mention') : null);
  const lineDiff = root.repoLineDiff || (typeof require === 'function' ? require('./repo-linediff') : null);
  const changesCompare = root.changesCompare || (typeof require === 'function' ? require('./changes-compare') : null);
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
    compare: $('reader-compare'), compareRows: $('reader-compare-rows'), compareBack: $('reader-compare-back'), compareTitle: $('reader-compare-title'),
    queue: $('reader-compare-queue'), queueText: $('reader-compare-queue-text'), queueItems: $('reader-compare-queue-items'), send: $('reader-compare-send'), clear: $('reader-compare-clear'),
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
    // the Changes Compare: what is being compared, and the comments queued to be typed into the prompt
    change: null, pending: [], sending: false,
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
    state.path = null;
    state.stamp = null;
    state.base = null;
    state.change = null;
    closeComposer();
    syncDirty();
    if (onClose) onClose();
    return true;
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
    // Diff is offered for a file Claude edited AND for one git calls modified (a Bash or hand change, PR #95 Dexter D2)
    // (not while editing: a diff would replace the text being edited)
    // in the Changes Compare the same button goes back to the plain file
    const inChanges = state.mode === 'changes';
    el.diff.hidden = inChanges ? false : state.editing || !((edited && edited.tier === 'edited') || state.modified);
    el.diff.textContent = inChanges || state.mode === 'diff' ? 'File' : 'Diff';
    el.diff.setAttribute('aria-pressed', inChanges || state.mode === 'diff' ? 'true' : 'false');
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
    if (inChanges && state.change) bits.push(`${changeBaseLabel()} vs now`);
    else if (state.mode === 'diff' && state.diffSource) bits.push(state.diffSource === 'claude' ? "Claude's edits" : 'git diff HEAD');
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
    if (!state.path || state.editing) return;
    const token = ++state.token;
    if (state.mode === 'changes') { state.mode = 'file'; await open(state.path, { keepMode: true, discard: true }); return; }
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
    el.compareTitle.textContent = 'On disk now, against yours';
    el.compareBack.hidden = false;
    state.comparing = true;
    el.compare.hidden = false;
    el.body.hidden = true;
  }

  // ---- the Changes Compare (BACKLOG #119 A3) ----
  // A file picked in the Changes panel: its BASE version (HEAD, or the merge-base with the integration branch) beside what is on
  // disk now, aligned by the same line diff as the conflict Compare. Read-only. A line has a "+" that opens a one-line field:
  // Enter types `In <path>:<line> - <comment>` into the prompt, Shift+Enter queues it, and a queue is typed as ONE line. Nothing is
  // ever submitted: the person presses Enter in the terminal.

  const COMPARE_MAX_BYTES = 1024 * 1024;
  const changeBaseLabel = () => { const c = state.change; return c && c.scope === 'branch' ? (c.base || 'the base') : 'HEAD'; };
  const plural = (n, one, many) => (n === 1 ? one : many);

  async function openChange(info) {
    const i = info && typeof info === 'object' ? info : {};
    if (typeof i.path !== 'string' || i.path === '') return;
    if (isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Discard them and open the changes of ${i.path}?`))) return false;
    stopEditing({ revert: false });
    closeComposer();
    state.path = i.path;
    state.base = null;
    state.mode = 'changes';
    state.status = '';
    state.diffSource = null;
    state.change = {
      path: i.path, oldPath: typeof i.oldPath === 'string' && i.oldPath !== '' ? i.oldPath : null, status: i.status,
      scope: i.scope === 'branch' ? 'branch' : 'working', base: typeof i.base === 'string' ? i.base : null, rows: [], hunks: [], cur: null,
    };
    const token = ++state.token;
    showPane();
    clearBar();
    paintHead();
    showNote('reading...', { reveal: false });
    await renderChange(token);
  }

  function refuseChange(text) {
    hideCompare();
    showNote(text, { reveal: false });
    paintHead();
  }

  async function renderChange(token) {
    const c = state.change;
    if (!c) return;
    if (!changes || typeof changes.request !== 'function') { refuseChange('The Changes compare is not available in this window.'); return; }
    const deleted = c.status === 'D';
    const fresh = c.status === 'A';
    const baseBody = { scope: c.scope, path: c.path, ...(c.oldPath ? { oldPath: c.oldPath } : {}) };
    let [now, base] = await Promise.all([
      deleted ? Promise.resolve({ ok: true, text: '', size: 0 }) : requester.request('read', { path: c.path }),
      fresh ? Promise.resolve({ ok: true, text: '' }) : changes.request('base', baseBody),
    ]);
    if (token !== state.token || state.change !== c) return;
    if (!now.ok && now.why === 'gone') now = { ok: true, text: '', size: 0 };
    if (!now.ok) { refuseChange(now.why === 'too-large' ? 'This file is too large to compare (over 1 MB).' : refusalText(now)); return; }
    if (now.size > COMPARE_MAX_BYTES) { refuseChange(`This file is ${fmtSize(now.size)}, too large to compare (over 1 MB).`); return; }
    if (!base.ok && base.why === 'new') base = { ok: true, text: '' };
    if (!base.ok) {
      refuseChange(base.why === 'too-large' ? 'The base version is too large to compare (over 1 MB).'
        : base.why === 'binary' ? 'This file was a binary file at the base, so there is nothing to compare.'
          : base.why === 'encoding' ? 'This file was UTF-16 at the base, an encoding the compare does not decode.'
          : `The base version could not be read: ${base.error || base.why || 'unknown error'}`);
      return;
    }
    closeComposer();
    // both sides are made the same way (a BOM dropped, CRLF folded), so a line is marked changed only when it is (PR #199 Dexter 4)
    c.rows = changesCompare.fold(changesCompare.sideBySide(lineDiff.diffLines(changesCompare.normalizeText(base.text), changesCompare.normalizeText(now.text))));
    c.hunks = changesCompare.hunkStarts(c.rows);
    c.cur = null;
    state.stamp = deleted ? null : { size: now.size, mtimeMs: now.mtimeMs };
    el.compareRows.replaceChildren(...changesCompare.buildRows(doc, c.rows));
    el.compareTitle.textContent = `${changeBaseLabel()} against now`;
    el.compareBack.hidden = true;
    hideNote();
    state.comparing = true;
    el.compare.hidden = false;
    el.body.hidden = true;
    paintHead();
    renderQueue();
  }

  // -- the current row, and the hunks --

  function setCur(i) {
    const c = state.change;
    const rows = el.compareRows.children;
    if (!c || !rows[i]) return;
    if (Number.isInteger(c.cur) && rows[c.cur]) rows[c.cur].className = rows[c.cur].className.replace(/ cur\b/g, '');
    c.cur = i;
    rows[i].className += ' cur';
    if (typeof rows[i].scrollIntoView === 'function') rows[i].scrollIntoView({ block: 'center' });
  }

  function jumpHunk(dir) {
    const c = state.change;
    if (!c) return;
    const at = dir > 0 ? changesCompare.nextHunk(c.hunks, c.cur) : changesCompare.prevHunk(c.hunks, c.cur);
    if (at !== null) setCur(at);
  }

  // -- the comment field --

  let composer = null;
  function closeComposer() {
    if (composer) { composer.field.remove(); composer = null; }
  }

  function openComposer(row) {
    if (!row || !row.dataset || !row.dataset.line) return;
    closeComposer();
    const line = Number(row.dataset.line);
    const field = doc.createElement('div');
    field.className = 'sbs-compose';
    const input = doc.createElement('input');
    input.className = 'sbs-input';
    input.type = 'text';
    input.maxLength = 400;
    input.placeholder = `Comment on line ${line}`;
    input.setAttribute('aria-label', `Comment on line ${line}`);
    const hint = doc.createElement('span');
    hint.className = 'sbs-hint';
    hint.textContent = 'Enter types it into the prompt. Shift+Enter adds it to the stack. Esc cancels.';
    field.append(input, hint);
    row.append(field);
    composer = { field, input, line };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        closeComposer();
        if (typeof el.compareRows.focus === 'function') el.compareRows.focus();
        return;
      }
      if (e.key !== 'Enter') return;
      // Enter that ends an IME composition is the IME's, not a comment (PR #199 Miguel S3)
      if (e.isComposing) return;
      e.preventDefault();
      addComment(line, input.value, { send: !e.shiftKey });
    });
    if (typeof input.focus === 'function') input.focus();
  }

  function composeAtCurrent() {
    const c = state.change;
    if (!c) return;
    const rows = el.compareRows.children;
    const from = Number.isInteger(c.cur) ? c.cur : (c.hunks.length ? c.hunks[0] : 0);
    for (let i = from; i < rows.length; i += 1) {
      if (rows[i].dataset && rows[i].dataset.line) { setCur(i); openComposer(rows[i]); return; }
    }
  }

  function addComment(line, text, { send }) {
    const r = changesCompare.commentText(state.path, line, text);
    if (!r.ok) { state.status = `not added: ${r.reason}`; paintHead(); return; }
    addPending(r.text);
    closeComposer();
    state.status = '';
    renderQueue();
    paintHead();
    if (send) sendPending();
  }

  // The queue: each comment has its own Type and Remove, so a stack too long to type in one go (or one comment that is wrong) is never a
  // choice between "type nothing" and "lose everything" (PR #199 Dexter 6). Entries carry an id: a comment added while a send is typing
  // stays queued, and only what was sent leaves (Dexter 11).
  let nextPendingId = 1;

  function addPending(text) {
    state.pending.push({ id: nextPendingId, text });
    nextPendingId += 1;
  }

  function renderQueue() {
    const n = state.pending.length;
    el.queue.hidden = n === 0;
    el.queueText.textContent = n === 0 ? '' : `${n} ${plural(n, 'comment', 'comments')} queued`;
    const items = state.pending.map((p) => {
      const row = doc.createElement('div');
      row.className = 'q-item';
      const t = doc.createElement('span');
      t.className = 'q-text';
      t.textContent = p.text;
      t.title = p.text;
      const send = doc.createElement('button');
      send.type = 'button';
      send.className = 'q-send';
      send.textContent = 'Type';
      send.title = 'Type just this comment into the prompt';
      send.dataset.q = 'send';
      send.dataset.id = String(p.id);
      const rm = doc.createElement('button');
      rm.type = 'button';
      rm.className = 'q-remove';
      rm.textContent = 'Remove';
      rm.dataset.q = 'remove';
      rm.dataset.id = String(p.id);
      row.append(t, send, rm);
      return row;
    });
    el.queueItems.replaceChildren(...items);
  }

  // `ids`: only these queued comments (the per-item Type); none: all of them
  function sendPending(ids) {
    if (state.sending) { state.status = 'not typed: the last comments are still being typed'; paintHead(); return; }
    const chosen = Array.isArray(ids) ? state.pending.filter(p => ids.includes(p.id)) : state.pending.slice();
    const s = changesCompare.stackText(chosen.map(p => p.text));
    if (!s.ok) { state.status = `not typed: ${s.reason}`; paintHead(); return; }
    if (typeof typeComment !== 'function') { state.status = 'not typed: this window cannot type into the prompt'; paintHead(); return; }
    const n = s.count;
    const sentIds = new Set(chosen.map(p => p.id));
    state.sending = true;
    typeComment(s.text, (r) => {
      state.sending = false;
      if (r && r.ok) {
        // only what was typed leaves the queue: a comment added while this was typing stays
        state.pending = state.pending.filter(p => !sentIds.has(p.id));
        const how = r.appended ? `added ${n} ${plural(n, 'comment', 'comments')} to what was typed` : `typed ${n} ${plural(n, 'comment', 'comments')}`;
        // a box that was not empty and not ours was replaced (a draft, or the CLI's placeholder: the text cannot tell)
        const lost = r.cleared ? " Its input box wasn't empty: if that was a draft, Ctrl+Y in that tab brings it back." : '';
        state.status = `${how}; press Enter in the terminal to send ${plural(n, 'it', 'them')}.${lost}`;
      } else {
        state.status = `not typed: ${(r && r.reason) || 'refused'}`;
      }
      renderQueue();
      paintHead();
    });
  }

  function removePending(id) {
    state.pending = state.pending.filter(p => p.id !== id);
    renderQueue();
  }

  function clearPending() {
    state.pending = [];
    renderQueue();
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
      if (state.mode === 'changes') {
        // a comment being typed is never redrawn from under the person: the bar offers Reload instead
        if (composer) { showBar('This file changed on disk.', { reload: true }); return; }
        clearBar();
        await renderChange(token);
        return;
      }
      if (isDirty()) { await raiseConflict(); return; }       // unsaved edits: the three-way banner, never the plain bar
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

  // ---- "What's this?" and "open at line" (Ask the repo, BACKLOG #33) ----

  /** The selected lines of the file on screen as { file, start, end } (1-based, a bare cursor is none), or null. */
  function selectionInfo() {
    if (!state.path || state.mode !== 'file' || !state.editor) return null;
    const range = mention.rangeOfLines(state.editor.selection());
    return range ? { file: state.path, start: range.from, end: range.to } : null;
  }

  function askSelection() {
    // The host explains the file as it is on DISK; with unsaved edits the buffer's line numbers would name different code (PR #169 Miguel Y3).
    if (isDirty()) { state.status = "save the file first, then click What's this? (it explains the saved file)"; paintHead(); return; }
    const sel = selectionInfo();
    if (!sel) { state.status = "select some code first, then click What's this?"; paintHead(); return; }
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
    if (state.mode === 'changes') { clearBar(); renderChange(state.token); return; }
    if (isDirty() && !(await confirmLeave(`You have unsaved changes to ${state.path}. Discard them and reload it from disk?`))) return;
    open(state.path, { keepMode: true, discard: true, keepEditing: true });
  });
  el.edit.addEventListener('click', () => { toggleEdit(); });
  el.save.addEventListener('click', () => { save(); });
  el.conflictReload.addEventListener('click', conflictReload);
  el.conflictKeep.addEventListener('click', conflictKeep);
  el.conflictCompare.addEventListener('click', conflictCompare);
  el.compareBack.addEventListener('click', () => { hideCompare(); if (state.editor && typeof state.editor.focus === 'function') state.editor.focus(); });
  el.send.addEventListener('click', () => sendPending());
  el.queueItems.addEventListener('click', (e) => {
    const t = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-q]') : null;
    if (!t) return;
    const id = Number(t.dataset.id);
    if (t.dataset.q === 'send') sendPending([id]);
    else if (t.dataset.q === 'remove') removePending(id);
  });
  el.clear.addEventListener('click', clearPending);
  // the Changes Compare: a "+" opens the comment field, a click on a row makes it the current one, j / k walk the hunks, Ctrl+/ comments on the current line
  el.compareRows.addEventListener('click', (e) => {
    if (state.mode !== 'changes') return;
    const t = e && e.target;
    const btn = t && typeof t.closest === 'function' ? t.closest('[data-act="comment"]') : null;
    const row = t && typeof t.closest === 'function' ? t.closest('.sbs-row') : null;
    if (btn) {
      const rows = Array.from(el.compareRows.children);
      const at = rows.findIndex(r => r.dataset && r.dataset.line === btn.dataset.line);
      if (at >= 0) { setCur(at); openComposer(rows[at]); }
      return;
    }
    if (row) { const i = Array.from(el.compareRows.children).indexOf(row); if (i >= 0) setCur(i); }
  });
  el.compareRows.addEventListener('keydown', (e) => {
    const t = e && e.target;
    if (t && t.tagName === 'INPUT') return;
    if (state.mode !== 'changes' || !state.change) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '/') { e.preventDefault(); composeAtCurrent(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); jumpHunk(e.key === 'j' ? 1 : -1); }
  });
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
          change: state.change ? { scope: state.change.scope, base: state.change.base, status: state.change.status, hunks: state.change.hunks.length, cur: state.change.cur } : null,
          pending: state.pending.map(p => p.text), queueShown: !el.queue.hidden, compareTitle: el.compareTitle.textContent,
          conflictShown: !el.conflict.hidden, conflictText: el.conflictText.textContent, compareShown: !el.compare.hidden,
          compareRows: Array.from(el.compareRows.children || [], (r) => `${r.className}|${r.textContent}`).slice(0, 40),
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
      // the Changes Compare (verify/probe-changes-panel.js): open a change, comment on a line the way a click and Enter would, walk the hunks
      case 'openChange': return openChange(a).then(() => ({ ok: true }));
      case 'comment': {
        const btn = el.compareRows.querySelector(`.sbs-row[data-line="${Number(a.line)}"] .sbs-btn`);
        if (!btn) return { ok: false, error: `no commentable line ${a.line}` };
        btn.click();
        const input = el.compareRows.querySelector('.sbs-input');
        if (!input) return { ok: false, error: 'the comment field did not open' };
        input.value = String(a.text);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: a.send === false, bubbles: true, cancelable: true }));
        return { ok: true };
      }
      case 'hunk': jumpHunk(a.dir === 'prev' ? -1 : 1); return { ok: true, cur: state.change ? state.change.cur : null };
      case 'sendQueued': sendPending(); return { ok: true };
      case 'sendQueuedItem': sendPending([Number(a.id)]); return { ok: true };
      case 'removeQueued': removePending(Number(a.id)); return { ok: true };
      case 'clearQueued': clearPending(); return { ok: true };
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
      default: return { ok: false, error: `unknown reader action ${action}` };
    }
  }

  return {
    open, openAt, openChange, selectionInfo, close, isOpen: () => !el.pane.hidden, path: () => state.path, hasUnsaved: isDirty, save,
    setOverlay, onRepoChanged: checkStale, probe, layout,
    editor: () => state.editor,
  };
}

const API = { create, refusalText, fmtSize };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoReader = API;

})(typeof window !== 'undefined' ? window : globalThis);
