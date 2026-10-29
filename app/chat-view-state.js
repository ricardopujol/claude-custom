'use strict';
/**
 * Which display a tab shows, and what the chat's type box puts on the pty (BACKLOG #157, documentation/DESIGN_CHAT_VIEW.md).
 * Pure, so it can be tested; renderer.js only wires it.
 *
 *   viewFor({ wanted, turn, blocked }) -> { show: 'chat' | 'terminal', note }
 *     `wanted` is the tab's Hide tool lines switch, `turn` the host's 'idle' | 'turn' | 'prompt' | null (host/turn-state.js:
 *     'prompt' is an open dialog, i.e. a NEEDS_INPUT), `blocked` the CLI's own OSC 7501 report that it's blocked.
 *     The chat shows only when it was asked for AND nothing needs the person: a permission prompt, a choice menu or a
 *     question flips the tab to the terminal with a one-line note, and the chat returns by itself when the turn resumes
 *     or ends (the host's turn state moves off 'prompt').
 *
 *   planChatSend(text, { bracketed }) -> [{ frame, afterMs }]
 *     What the type box sends: the text exactly as typing would put it, then Enter as its own spaced frame (the way every
 *     typed command in this app is sent: renderer.js typePlanned). A multi-line message is ONE bracketed paste when the CLI
 *     turned that mode on, else its lines are joined with Shift+Enter's bytes so no line submits early. Every frame is the
 *     explicit `{type:'input', data}` wrapper (app/paste-action.js pasteFrame: host/control.js must never read typed text as
 *     a control message). Control characters are stripped first, so the text can't close the bracketed paste or inject a key.
 *
 * Loaded as a plain <script> in renderer.html, so it is wrapped: every file there shares ONE global scope (CLAUDE.md).
 */

(function (root) {

const FLIP_NOTE = 'Claude needs you here. The chat comes back once you\'ve answered.';
const ENTER_DELAY_MS = 120;          // renderer.js PTY_STEP_MS: the CLI's input box takes text and Enter as two events
const STORAGE_PREFIX = 'chatView:';

function viewFor(s) {
  const wanted = !!s && s.wanted === true;
  if (!wanted) return { show: 'terminal', note: null };
  if (s.turn === 'prompt' || s.blocked === true) return { show: 'terminal', note: FLIP_NOTE };
  return { show: 'chat', note: null };
}

// Ctrl+Shift+H, on keydown only. The CLI sees no Ctrl+Shift combination (a pty can't carry one), so it can't clash with it.
function isChatKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && e.shiftKey === true && !e.altKey && !e.metaKey && e.code === 'KeyH';
}

// Every C0 control but newline (tab is turned into spaces first), DEL, the C1 block and the two Unicode line separators.
// Built from code points so no control character ever sits in this source file.
const CONTROL = new RegExp('[' + [[0, 9], [11, 31], [127, 159], [8232, 8233]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

/** The person's text with every control character gone but newlines, and no blank edges. */
function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(CONTROL, '')
    .trim();
}

const pasteFrameFn = () => (typeof module !== 'undefined' && module.exports ? require('./paste-action').pasteFrame : root.pasteFrame);

function planChatSend(raw, opts) {
  const text = sanitizeInput(raw);
  if (text === '') return [];
  const frame = (data) => JSON.stringify({ type: 'input', data });
  let first;
  if (!text.includes('\n')) first = frame(text);
  else if (opts && opts.bracketed === true) first = pasteFrameFn()(text, true);
  else first = frame(text.split('\n').join('\x1b\r'));
  return [{ frame: first, afterMs: 0 }, { frame: frame('\r'), afterMs: ENTER_DELAY_MS }];
}

// The switch is remembered per tab, by its folder (localStorage is shared by the tab views of one window).
const keyFor = (cwd) => STORAGE_PREFIX + String(cwd);
function readWanted(storage, cwd) {
  try { return !!storage && storage.read(keyFor(cwd)) === '1'; } catch { return false; }
}
function writeWanted(storage, cwd, wanted) {
  try { if (storage) storage.write(keyFor(cwd), wanted === true ? '1' : '0'); } catch { /* a full or blocked store: the switch just isn't remembered */ }
}

const api = { viewFor, isChatKey, sanitizeInput, planChatSend, readWanted, writeWanted, FLIP_NOTE, ENTER_DELAY_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatViewState = api;

})(typeof window !== 'undefined' ? window : globalThis);
