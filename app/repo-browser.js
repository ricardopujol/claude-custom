'use strict';
/**
 * The repo browser and code reader (#45 + #32), composed: the Files tab, the reader beside the terminal, and
 * the one `repo` conversation with the host that feeds both. renderer.js only wires it in (a hello, a control
 * message, the tab being shown, the socket dropping, and how to type into the terminal).
 *
 *   create({ doc, send, harness, storage, typeMention, typeComment, focusTerminal, storageKey, isShown, termRect, confirmDiscard, onDirty }) ->
 *     { setControls(list), onMessage(msg), show(), failAll(reason), probe(action, args), openChange(info), changes, refreshTouched(), isTouched(path) }
 *
 * The Changes panel (BACKLOG #119 A3) shares this: its `changes` conversation (the same requester as `repo`, another control type, gated on
 * the host's own hello), the reader that shows a change side by side, and the set of files Claude edited (the Files tab's overlay), asked for
 * once per refresh so the Changes list marks them even when the Files tab was never opened.
 *
 * `typeMention(text, done)` is the page's typeAndCheck path (PR #93): it clears a one-line draft, refuses a
 * dialog or a multi-line draft, reads the box back, and NEVER presses Enter. "@ in prompt" is that and
 * nothing else.
 *
 * Which tab's worktree? Always this page's own: the host that answers is this tab's host, and main's reveal
 * and drag use this tab's folder. The page never names a worktree.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `repoBrowser`.
 */
(function (root) {

function create({ doc, send, harness, storage, typeMention, typeComment, focusTerminal, storageKey, isShown, termRect, confirmDiscard, onDirty, onAsk } = {}) {
  const R = root.repoRequester || (typeof require === 'function' ? require('./repo-requester') : null);
  const Panel = root.repoFilesPanel || (typeof require === 'function' ? require('./repo-files-panel') : null);
  const Reader = root.repoReader || (typeof require === 'function' ? require('./repo-reader') : null);
  const Mention = root.repoMention || (typeof require === 'function' ? require('./repo-mention') : null);

  const requester = R.createRequester({ send });
  const changes = R.createRequester({
    send, type: 'changes',
    older: "This session's host is older than this window and can't list changes. Restart the session (close this tab and open it again) to see them.",
  });
  let said = () => {};
  // the files Claude edited, lower-cased (Windows paths): the Files tab's overlay, read on demand for the Changes list's dot
  let touched = new Set();

  const reader = Reader.create({
    doc, requester, changes, harness, storage, storageKey, typeMention, typeComment, termRect, confirmDiscard, onDirty, onAsk,
    onClose: () => { panel.setSelected(null); if (focusTerminal) focusTerminal(); },
  });

  // "@ in prompt" from a tree row: the whole file (a line range needs the reader open and a selection).
  const mentionFile = (path) => {
    const m = Mention.mentionText(path);
    if (!m.ok) { said(`Not typed: ${m.reason}`); return; }
    typeMention(m.text, (r) => said(r && r.ok ? `Typed ${m.text}. Press Enter in the terminal to send it.` : `Not typed: ${(r && r.reason) || 'refused'}`));
  };

  const panel = Panel.create({
    doc, requester, harness, storage,
    // the person may answer "keep editing" to the unsaved-text question: the row they clicked is then not what the
    // reader shows, so the highlight goes back to the file that is (or to none)
    onOpen: async (path) => { if ((await reader.open(path)) === false) panel.setSelected(reader.path()); },
    onMention: mentionFile,
    isShown,
  });
  said = panel.say;
  panel.onOverlay((overlay) => reader.setOverlay(overlay && overlay.ok ? overlay : null));

  requester.onChanged(() => { panel.onChanged(); reader.onRepoChanged(); });
  requester.onOverlayReady(() => panel.onOverlayReady());

  return {
    // The socket opens BEFORE the host says hello, so a tab that was showing Files at load asked once with no
    // controls to go on and was told to wait: when the hello arrives it asks again.
    setControls: (list) => { requester.setControls(list); changes.setControls(list); if (isShown && isShown()) panel.show(); },
    onMessage: (msg) => requester.onMessage(msg) || changes.onMessage(msg),
    show: () => panel.show(),
    // after the dock tree places #termwrap (renderer.js renderLayout): the reader takes its strip of it
    layout: () => reader.layout(),
    failAll: (reason) => { requester.failAll(reason); changes.failAll(reason); },
    // verify/probe-repo-browser.js: named actions only, JSON answers
    probe: (action, a) => (typeof action === 'string' && action.startsWith('reader.') ? reader.probe(action.slice(7), a)
      : action === 'refresh' ? (panel.refresh(), { ok: true })
        : panel.probe(action, a)),
    // "Ask the repo" (#33): a card or a citation opens the file at its line; the Files tab's highlight follows
    openAt: async (path, line, endLine) => { const r = await reader.openAt(path, line, endLine); panel.setSelected(reader.path()); return r; },
    // The Changes panel (#119 A3): a file from its list opens as a side-by-side change; the Files tab's highlight follows
    openChange: async (info) => { const r = await reader.openChange(info); panel.setSelected(reader.path()); return r; },
    changes,
    // ask the host which files Claude edited; true when the answer replaced the set
    refreshTouched: async () => {
      const r = await requester.request('overlay');
      if (!r || r.ok !== true || !Array.isArray(r.files)) return false;
      touched = new Set(r.files.filter(f => f && f.tier === 'edited' && typeof f.path === 'string').map(f => f.path.toLowerCase()));
      return true;
    },
    isTouched: (path) => typeof path === 'string' && touched.has(path.toLowerCase()),
    reader, panel,
  };
}

const API = { create };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.repoBrowser = API;

})(typeof window !== 'undefined' ? window : globalThis);
