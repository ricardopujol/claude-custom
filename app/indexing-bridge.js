'use strict';
/**
 * Main's half of the indexing field (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)": a field in the strip, Enter appends the note verbatim to the selected project's backlog `## Inbox`, Undo in a
 * 10 s toast and in the "N filed" list; the chip switches project). Electron is injected, so this is tested without a
 * window (test/indexing-bridge.test.js).
 *
 *   createIndexingBridge({ ipcMain, Menu, shell, copyText, makeView, overlayFile, getWin, isStrip, service, project,
 *                          docsFor, projects, viewTop, focusSelected, setFieldFocused, journalStamp, now })
 *     -> { push(force), raise(), focusField(), setAccent(hex), relayout(), start(ms), stop() }
 *
 * THE OVERLAY. The tab views cover everything under the 34 px strip, so the toast (bottom right) and the "N filed" list
 * (top right, under the strip) are two small WebContentsViews of app/indexing-overlay.html, stacked over the tab views
 * and sized to what they show: each page reports its height and main sets the bounds (overlayBounds). A view that has
 * nothing to show is hidden, so it never covers the terminal for nothing. raise() puts them back on top after main adds
 * a tab view.
 *
 * CHANNELS, each answered only from its own page (a handler that answers anyone is not a boundary):
 *   strip  -> main  strip:indexSubmit (invoke), strip:indexFocus, strip:indexLeave, strip:indexChip, strip:indexList
 *   main -> strip   strip-index { label, counts, listOpen }, strip-index-focus
 *   overlay -> main indexing:undo (invoke), indexing:copy, indexing:open, indexing:dismiss, indexing:size,
 *                   indexing:closeList, indexing:ready
 *   main -> overlay indexing-state { part, snapshot, toast: { id, seq, result } | null, listOpen, accent, label }
 *
 * THE TOAST follows the note typed last in this window (or the one acted on last from the list), and shows what that
 * note's state says (app/indexing-display.js toastModel); `result` is an Undo that didn't work, said once. A "not filed
 * yet" toast hides after its 10 s but comes back (a new seq) when that note is filed; a dismissed "added" toast stays
 * gone. Undo is always for the selected project (the service re-derives the file from it). Copy puts a note's own words
 * on the clipboard, for a note in this project's list only. Open is allowed only for the project's own backlog.
 */

const { samePath } = require('../host/project-layout');

const NOTE_MAX = 10_000;
const ID_MAX = 64;
const TOAST_W = 420;
const LIST_W = 380;
const BLUR_REOPEN_MS = 400;

const isId = (s) => typeof s === 'string' && s !== '' && s.length <= ID_MAX;

/** Where an overlay goes in a window of { width, height } whose views start at `top`; null for no usable height. */
function overlayBounds(part, { width, height, top }, reported) {
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) return null;
  if (part === 'toast') {
    const w = Math.max(0, Math.min(TOAST_W, width - 24));
    const h = Math.max(0, Math.min(Math.ceil(reported), height - top - 24));
    return { x: width - w - 12, y: height - h - 12, width: w, height: h };
  }
  const w = Math.max(0, Math.min(LIST_W, width - 20));
  const y = top + 6;
  const h = Math.max(0, Math.min(Math.ceil(reported), height - y - 20));
  return { x: width - w - 10, y, width: w, height: h };
}

function createIndexingBridge({
  ipcMain, Menu, shell, copyText = () => {}, makeView, overlayFile, getWin, isStrip, service, project: initialProject, docsFor, projects,
  viewTop, focusSelected = () => {}, setFieldFocused = () => {}, journalStamp = () => null, now = Date.now,
}) {
  let project = { ...initialProject };
  let toast = null;              // { id, seq, result }
  let seq = 0;
  let listOpen = false;
  let listClosedByBlurAt = -Infinity;
  let listFocused = false;
  let accent = null;
  const views = { toast: null, list: null };
  const shown = { toast: false, list: false };      // tracked here: a View has no visibility property to read back
  const sizes = { toast: 0, list: 0 };
  let lastStrip = null;
  const lastOverlay = { toast: null, list: null };
  let lastStamp = null;
  let timer = null;

  const win = () => { const w = getWin(); return w && !w.isDestroyed() ? w : null; };
  const fromStrip = (e) => !!e && isStrip(e.sender) === true;
  const partOf = (e) => {
    if (!e) return null;
    for (const p of ['toast', 'list']) if (views[p] && views[p].webContents === e.sender) return p;
    return null;
  };
  const active = (part) => (part === 'toast' ? toast !== null && !toast.hiddenWhileUnfiled : listOpen);

  function viewFor(part) {
    if (views[part]) return views[part];
    const w = win();
    if (!w) return null;
    const v = makeView(part);
    try { v.setBackgroundColor('#00000000'); } catch { /* transparent is a nicety */ }
    v.setVisible(false);
    w.contentView.addChildView(v);
    v.webContents.loadFile(overlayFile, { query: { part } });
    if (part === 'list') {
      // Click outside closes it, but only once it was clicked into: opening it leaves the keyboard where it was, and
      // a blur that no focus came before is the strip keeping it, not the person leaving (measured in the probe).
      v.webContents.on('focus', () => { listFocused = true; });
      v.webContents.on('blur', () => {
        const wasFocused = listFocused;
        listFocused = false;
        if (!listOpen || !wasFocused) return;
        listOpen = false;
        listClosedByBlurAt = now();
        push(true);
      });
    }
    views[part] = v;
    return v;
  }

  function layout() {
    const w = win();
    if (!w) return;
    const [width, height] = w.getContentSize();
    for (const part of ['toast', 'list']) {
      const v = views[part];
      if (!v || v.webContents.isDestroyed()) continue;
      const b = active(part) ? overlayBounds(part, { width, height, top: viewTop() }, sizes[part]) : null;
      if (!b || b.width === 0 || b.height === 0) { v.setVisible(false); shown[part] = false; continue; }
      v.setBounds(b);
      if (!shown[part]) w.contentView.addChildView(v);   // shown again: on top of any tab view added meanwhile
      v.setVisible(true);
      shown[part] = true;
    }
  }

  function push(force = false) {
    const w = win();
    if (!w) return;
    let snapshot;
    try { snapshot = service.snapshot(project.root); } catch { return; }
    // A "not filed yet" toast that timed out comes back once its note is filed: that's news.
    if (toast && toast.hiddenWhileUnfiled) {
      const row = (snapshot.list || []).find(n => n.id === toast.id);
      if (!row) toast = null;
      else if (row.state !== 'unfiled') showToast(toast.id);
    }
    const shownToast = toast && !toast.hiddenWhileUnfiled ? toast : null;
    const strip = { label: project.label, counts: snapshot.counts, listOpen };
    const sKey = JSON.stringify(strip);
    if (force || sKey !== lastStrip) {
      lastStrip = sKey;
      try { w.webContents.send('strip-index', strip); } catch { /* the window is going away */ }
    }
    for (const part of ['toast', 'list']) {
      if (!active(part) && !views[part]) continue;
      const v = viewFor(part);
      if (!v) continue;
      const state = { part, snapshot, toast: shownToast, listOpen, accent, label: project.label };
      const key = JSON.stringify(state);
      if (!force && key === lastOverlay[part]) continue;
      lastOverlay[part] = key;
      try { v.webContents.send('indexing-state', state); } catch { /* reloading */ }
    }
    layout();
  }

  function showToast(id, result) {
    seq += 1;
    toast = { id, seq, result: result || null };
  }

  function kick() {
    Promise.resolve(service.tick()).then(() => push(), () => push());
  }

  // --- the strip -----------------------------------------------------------------------------------------------------

  ipcMain.handle('strip:indexSubmit', (e, text) => {
    if (!fromStrip(e)) return null;
    if (typeof text !== 'string') return { ok: false, reason: 'bad-note' };
    if (text.length > NOTE_MAX) return { ok: false, reason: 'too-long' };
    const r = service.submit(project.root, text);
    if (r && r.ok) { showToast(r.id); push(true); kick(); }
    return r;
  });

  ipcMain.on('strip:indexFocus', (e, on) => {
    if (!fromStrip(e) || typeof on !== 'boolean') return;
    setFieldFocused(on);
  });

  ipcMain.on('strip:indexLeave', (e) => {
    if (!fromStrip(e)) return;
    focusSelected();
  });

  ipcMain.on('strip:indexList', (e) => {
    if (!fromStrip(e)) return;
    // A click on the counter while the list is open first blurs the list (closing it); that click must not reopen it.
    if (!listOpen && now() - listClosedByBlurAt < BLUR_REOPEN_MS) return;
    listOpen = !listOpen;
    push(true);
  });

  ipcMain.on('strip:indexChip', async (e) => {
    if (!fromStrip(e)) return;
    let list;
    try { list = await projects(project.root); } catch { list = null; }
    const choices = Array.isArray(list) && list.length ? list : [{ ...project, current: true }];
    const w = win();
    if (!w) return;
    Menu.buildFromTemplate(choices.map(c => ({
      label: c.label,
      type: 'radio',
      checked: samePath(c.root, project.root),
      click: () => { project = { root: c.root, label: c.label }; toast = null; push(true); },
    }))).popup({ window: w });
  });

  // --- the overlay ---------------------------------------------------------------------------------------------------

  const act = (e, id, run) => {
    if (partOf(e) === null) return null;
    if (!isId(id)) return { ok: false, reason: 'bad-id' };
    const r = run();
    showToast(id, r && r.ok ? null : r);
    push(true);
    return r;
  };

  // Always for the selected project: the service re-derives the backlog from it (Miguel I4, PR #121).
  ipcMain.handle('indexing:undo', (e, id) => act(e, id, () => service.undo(id, project.root)));

  // A note's own words onto the clipboard (a note that wasn't filed lives only in the journal), for a note of this
  // project's list only.
  ipcMain.on('indexing:copy', (e, id) => {
    if (partOf(e) === null || !isId(id)) return;
    let row = null;
    try { row = (service.snapshot(project.root).list || []).find(n => n.id === id) || null; } catch { row = null; }
    if (row && typeof row.text === 'string') { try { copyText(row.text); } catch { /* the clipboard is busy */ } }
  });

  ipcMain.on('indexing:open', (e, file) => {
    if (partOf(e) === null || typeof file !== 'string') return;
    const docs = docsFor(project.root);
    if (!docs || docs.ok !== true || !samePath(file, docs.backlog)) return;
    Promise.resolve(shell.openPath(file)).catch(() => {});
  });

  ipcMain.on('indexing:dismiss', (e, shownSeq) => {
    if (partOf(e) !== 'toast' || !toast || toast.seq !== shownSeq) return;
    let row = null;
    try { row = (service.snapshot(project.root).list || []).find(n => n.id === toast.id) || null; } catch { row = null; }
    if (!toast.result && row && row.state === 'unfiled') toast.hiddenWhileUnfiled = true;
    else toast = null;
    push(true);
  });

  ipcMain.on('indexing:size', (e, part, h) => {
    if (partOf(e) !== part || typeof h !== 'number' || !Number.isFinite(h) || h < 0) return;
    sizes[part] = h;
    layout();
  });

  ipcMain.on('indexing:closeList', (e) => {
    if (partOf(e) !== 'list' || !listOpen) return;
    listOpen = false;
    push(true);
    focusSelected();
  });

  ipcMain.on('indexing:ready', (e) => {
    const part = partOf(e);
    if (part === null) return;
    lastOverlay[part] = null;
    push(true);
  });

  return {
    push,
    raise() {
      const w = win();
      if (!w) return;
      for (const part of ['toast', 'list']) {
        const v = views[part];
        if (v && shown[part] && !v.webContents.isDestroyed()) w.contentView.addChildView(v);
      }
    },
    focusField() {
      const w = win();
      if (!w) return;
      try { w.webContents.focus(); w.webContents.send('strip-index-focus'); } catch { /* going away */ }
    },
    setAccent(hex) { accent = typeof hex === 'string' ? hex : null; push(); },
    relayout: layout,
    start(ms = 3000) {
      if (timer) return;
      timer = setInterval(() => {
        Promise.resolve(service.tick()).catch(() => {}).then(() => {
          // A snapshot reads the journal and the backlog: only when something may have changed.
          const stamp = journalStamp();
          if (stamp === null || stamp !== lastStamp || toast !== null || listOpen) { lastStamp = stamp; push(); }
        });
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createIndexingBridge, overlayBounds, NOTE_MAX };
