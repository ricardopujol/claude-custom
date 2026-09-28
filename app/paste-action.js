'use strict';
/**
 * What Ctrl+V does (BACKLOG #12 text, #8 image). Pure, so it can be tested;
 * renderer.js only wires it to the key handler and the clipboard bridge.
 *
 * MEASURED, not assumed -- verify/probe-paste.js, 2026-09-27, real window,
 * real `claude`:
 *
 *   - Before this, Ctrl+V put the single byte \x16 on the pty. xterm consumes
 *     the keydown, so the default Edit menu's Ctrl+V accelerator never ran and
 *     nothing was pasted. (The menu's own paste path, webContents.paste(),
 *     does work: xterm brackets it into ONE frame.)
 *   - With an image on the clipboard, `claude` attaches it itself on ESC+v --
 *     Alt+V, the binding Claude Code documents for Windows -- and shows
 *     "[Image #1]". The raw \x16 does not. So an image paste is ESC+v, and no
 *     temp file is written: the CLI reads the clipboard through its own
 *     mechanism, which is the founding bet of this project.
 *
 * Loaded as a plain <script> in renderer.html, so it is wrapped: every file
 * there shares ONE global scope (CLAUDE.md).
 */

(function (root) {

const IMAGE_PASTE_BYTES = '\x1bv';

// { text, hasImage } from the clipboard bridge -> what to do with it.
// Text wins over an image: a copy from a browser or Word often carries a
// bitmap alongside the words, and words are what the user copied.
function pasteAction(clip) {
  const text = clip && typeof clip.text === 'string' ? clip.text : '';
  // Trimmed for the CHECK only (Miguel, PR #55, S1): Office can leave a lone
  // space as text/plain beside a copied bitmap, and that must not hide the
  // image. Real text is pasted with its whitespace intact.
  if (text.trim()) return { kind: 'text', text };
  if (clip && clip.hasImage === true) return { kind: 'image', data: IMAGE_PASTE_BYTES };
  return { kind: 'none' };
}

// Plain Ctrl+V on keydown only -- keyup as well would paste twice. Any extra
// modifier is someone else's binding. Case-insensitive for Caps Lock.
function isPasteKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey
    && typeof e.key === 'string' && e.key.toLowerCase() === 'v';
}

// What Ctrl+C does: copy the terminal's selection when there is one, else
// pass through so the CLI gets ^C (interrupt, exit) exactly as before --
// Windows Terminal's rule (Ricardo, 2026-09-27). `selection` is
// term.getSelection(): '' when nothing is selected. Any whitespace the user
// selected is copied as-is; only an empty or non-string selection passes.
//
// `visible` says whether the selection is on screen (selectionVisible). xterm
// anchors a selection to the buffer, so an old one can sit scrolled out of
// sight, and Ctrl+C then copied it silently while the ^C the user meant --
// to stop a runaway claude -- never went out (Miguel, PR #58, I1). A
// selection the user can't see is 'stale': the renderer drops it and lets
// ^C through.
function copyKeyAction(e, selection, visible) {
  const plainCtrlC = !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey
    && typeof e.key === 'string' && e.key.toLowerCase() === 'c';
  if (!plainCtrlC || typeof selection !== 'string' || selection === '') return { kind: 'pass' };
  if (visible !== true) return { kind: 'stale' };
  return { kind: 'copy', text: selection };
}

// Does a selection touch the viewport? `range` is term.getSelectionPosition(),
// whose rows are 0-based buffer lines -- measured in the real window
// (verify/probe-paste.js, copy/rows), whatever xterm.d.ts says. `viewportY`
// is the buffer line at the top of the screen, `rows` the screen height.
// Anything missing or not a number is not visible: the safe answer is ^C.
function selectionVisible(range, viewportY, rows) {
  const num = n => typeof n === 'number' && Number.isFinite(n);
  if (!range || !range.start || !range.end) return false;
  const a = range.start.y, b = range.end.y;
  if (!num(a) || !num(b) || !num(viewportY) || !num(rows)) return false;
  return Math.min(a, b) <= viewportY + rows - 1 && Math.max(a, b) >= viewportY;
}

// The WebSocket frame a text paste travels in. Miguel, PR #55, B1.
//
// NOT term.paste(). That sends the text RAW when the CLI hasn't turned on
// bracketed paste (xterm's default, and the state at boot or under some Ink
// screens), and host/control.js reads any raw frame that is JSON with an
// allow-listed `type` as a CONTROL MESSAGE. A clipboard holding exactly
// `{"type":"open","path":...}` -- which any web page can put there -- would
// have run as a host action instead of being typed. Before #12 no single frame
// could carry clipboard contents; this PR opened that path, so it closes it.
//
// So the text always rides in the explicit `{type:'input', data}` wrapper the
// top-bar switch already uses, which the host writes to the pty literally.
// The bytes inside are exactly what xterm's own paste would produce: line
// endings to CR, and brackets ONLY when the CLI asked for them -- forcing
// them on a process that didn't enable the mode would type control junk.
function pasteFrame(text, bracketed) {
  const body = String(text).replace(/\r?\n/g, '\r');
  const data = bracketed === true ? '\x1b[200~' + body + '\x1b[201~' : body;
  return JSON.stringify({ type: 'input', data });
}

// The on-screen note (renderer's flourish) for a Ctrl+V that could not read
// the clipboard. Miguel, PR #55, S2: silence here reads as "Ctrl+V doesn't
// work", the exact state #12 exists to end. `why` is an Error or nothing.
function pasteFailureNote(why) {
  const reason = why && typeof why.message === 'string' && why.message ? ': ' + why.message : '';
  return { icon: '⛔', name: 'Ctrl+V could not read the clipboard' + reason };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pasteAction, isPasteKey, copyKeyAction, selectionVisible, pasteFrame, pasteFailureNote, IMAGE_PASTE_BYTES };
} else {
  root.pasteAction = pasteAction;
  root.isPasteKey = isPasteKey;
  root.copyKeyAction = copyKeyAction;
  root.selectionVisible = selectionVisible;
  root.pasteFrame = pasteFrame;
  root.pasteFailureNote = pasteFailureNote;
}

})(typeof window !== 'undefined' ? window : globalThis);
