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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pasteAction, isPasteKey, pasteFrame, IMAGE_PASTE_BYTES };
} else {
  root.pasteAction = pasteAction;
  root.isPasteKey = isPasteKey;
  root.pasteFrame = pasteFrame;
}

})(typeof window !== 'undefined' ? window : globalThis);
