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
  if (text) return { kind: 'text', text };
  if (clip && clip.hasImage === true) return { kind: 'image', data: IMAGE_PASTE_BYTES };
  return { kind: 'none' };
}

// Plain Ctrl+V on keydown only -- keyup as well would paste twice. Any extra
// modifier is someone else's binding. Case-insensitive for Caps Lock.
function isPasteKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey
    && typeof e.key === 'string' && e.key.toLowerCase() === 'v';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pasteAction, isPasteKey, IMAGE_PASTE_BYTES };
} else {
  root.pasteAction = pasteAction;
  root.isPasteKey = isPasteKey;
}

})(typeof window !== 'undefined' ? window : globalThis);
