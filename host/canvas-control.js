'use strict';
/**
 * The host's side of Claude's panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md), the same shape as
 * host/wand-control.js.
 *
 *   hello         carries `canvas: payload()`   { sessionId, status, bytes, signature, hosts, limitBytes }
 *   canvas-get    (no fields)   the window opened the panel and wants the page
 *   canvas-hosts  { action: 'allow'|'deny'|'remove', origin }   the person's answer about a host, kept for THIS panel
 *   canvas        the answer, BROADCAST to every window: the payload, plus `html` when the page is readable and the window
 *                 asked for it, plus `changed: true` when the page on disk changed (the first such frame is what docks the
 *                 panel: it only ever happens because Claude was asked to render into it).
 *
 * The panel is keyed by the CLI's session id (host/canvas-store.js), learned from the SessionStart hook, so a new session
 * (`/clear`, a fresh start) is an empty panel and `--resume` brings the old one back. The page itself never rides in the
 * hello or in a change frame: a window that has the panel open asks for it (`canvas-get`), so up to 1 MB is not pushed to
 * windows that never look at it.
 *
 * The session folder is watched with host/wand-watch.js's watchDir (the directory, not the file: the MCP tool writes by
 * rename). A page that was already there when the session resumed is not a "change"; only a write after that is.
 */
const fs = require('fs');
const { panelDir, validSessionId, readPage, readHosts, setHostDecision, MAX_HTML_BYTES } = require('./canvas-store');
const { isShelfEvent, artifactFromPayload, readShelf, addToShelf } = require('./canvas-shelf');

// Every message type this control answers. host/control.js CONTROL_TYPES must list each, or the frame is typed into the
// pty as literal JSON (test/canvas-wiring.test.js checks both lists against each other).
const CANVAS_TYPES = Object.freeze(['canvas-get', 'canvas-hosts']);
const WATCHED = new Set(['index.html', 'shelf.json']);

function createCanvasControl({ stateDir, getSessionId, emit, watch, log = () => {} } = {}) {
  if (!stateDir) throw new Error('createCanvasControl: stateDir is required');
  if (typeof getSessionId !== 'function') throw new Error('createCanvasControl: getSessionId is required');
  if (typeof emit !== 'function') throw new Error('createCanvasControl: emit is required');
  if (typeof watch !== 'function') throw new Error('createCanvasControl: watch is required');

  let armedId = null;       // the session whose folder is watched
  let watcher = null;
  let lastSig = 'empty';    // the signature the windows were last told about

  const currentId = () => { const id = getSessionId(); return validSessionId(id) ? id : null; };
  const dirOf = (id) => (id ? panelDir(stateDir, id) : null);

  function meta(page, id) {
    const dir = dirOf(id);
    return { sessionId: id, status: page.status, bytes: page.bytes, signature: page.signature,
      hosts: dir ? readHosts(dir) : { approved: [], denied: [] }, shelf: dir ? readShelf(dir) : [], limitBytes: MAX_HTML_BYTES };
  }
  const pageOf = (id) => (id ? readPage(dirOf(id)) : { status: 'empty', bytes: 0, signature: 'empty' });

  const payload = () => { const id = currentId(); return meta(pageOf(id), id); };

  function pruneEmpty(id) {
    const dir = dirOf(id);
    if (!dir) return;
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone: a page is never deleted */ }
  }

  function onChange() {
    const id = armedId;
    if (!id) return;
    const page = pageOf(id);
    if (page.signature === lastSig) return;
    lastSig = page.signature;
    emit({ type: 'canvas', ok: true, ...meta(page, id), changed: true });
  }

  function sessionChanged(raw) {
    const id = validSessionId(raw) ? raw : null;
    if (id === armedId) return;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    pruneEmpty(armedId);
    armedId = id;
    if (id) {
      try {
        watcher = watch({ dir: dirOf(id), create: true, match: (f) => WATCHED.has(f), onChange });
      } catch (err) { log(`[canvas] could not watch the panel folder: ${err && err.message}`); }
    }
    const page = pageOf(id);
    lastSig = page.signature;       // what is already there (a resumed session's page) is not a change
    emit({ type: 'canvas', ok: true, ...meta(page, id), changed: false });
  }

  const handles = (type) => CANVAS_TYPES.includes(type);

  function handle(msg) {
    const id = currentId();
    if (msg.type === 'canvas-get') {
      const page = pageOf(id);
      const frame = { type: 'canvas', ok: true, ...meta(page, id), changed: false };
      if (page.status === 'ok') frame.html = page.html;
      emit(frame);
      return;
    }
    if (msg.type === 'canvas-hosts') {
      const dir = dirOf(id);
      if (!dir) { emit({ type: 'canvas', ok: false, reason: 'no session yet, so there is no panel to answer for', ...meta(pageOf(null), null), changed: false }); return; }
      let next = null;
      try { next = setHostDecision(dir, msg.origin, msg.action); } catch (err) { log(`[canvas] could not save the host list: ${err && err.message}`); }
      if (!next) { emit({ type: 'canvas', ok: false, reason: 'that host answer was not accepted', ...meta(pageOf(id), id), changed: false }); return; }
      emit({ type: 'canvas', ok: true, ...meta(pageOf(id), id), changed: false });
    }
  }

  const handlesShelfEvent = isShelfEvent;

  // A publish the CLI's own PostToolUse hook reported: onto THIS session's shelf, and every window is told. Never a page change, so
  // it never docks the panel. A failure, or a payload with no https address, adds nothing and says nothing.
  function shelfEvent(ev) {
    const id = currentId();
    const dir = dirOf(id);
    if (!dir || !isShelfEvent(ev)) return;
    const item = artifactFromPayload(ev.payload);
    if (!item) return;
    try { addToShelf(dir, item); } catch (err) { log(`[canvas] could not save the shelf: ${err && err.message}`); return; }
    emit({ type: 'canvas', ok: true, ...meta(pageOf(id), id), changed: false });
  }

  function close() {
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    pruneEmpty(armedId);
    armedId = null;
  }

  return { payload, handles, handle, handlesShelfEvent, shelfEvent, sessionChanged, close };
}

module.exports = { createCanvasControl, CANVAS_TYPES };
