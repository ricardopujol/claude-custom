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

// --- the type box's send: nothing goes to the pty that could answer a dialog (PR #226 Dexter 1, Miguel I2) --------------------------------
// The sequence is the one host/grant-sequence.js runs for a drop (PR #223): READ the live screen, type, READ it back, look once more,
// and only then press Enter. Every read-back is the page's own xterm (sync waits for what the host sent to be parsed).
const READBACK_WAIT_MS = 1500;       // how long the typed text may take to show on screen before it counts as a mismatch
const RECHECK_MS = 400;              // the look just before the Enter (the PR #106 pattern: a dialog can open mid-send)
const AFTER_POLL_MS = 150;           // after the Enter: is the text still in the box (the CLI swallowed the key)?
const AFTER_POLLS = 6;
const CLEAR_PASSES = 20;
const CTRL_E = String.fromCharCode(5);
const CTRL_U = String.fromCharCode(21);

const NOTE = {
  dialog: 'Claude needs you in the terminal first, so nothing was sent. Your message is still here.',
  holds: 'An agent is writing in this folder, so nothing was sent. Switch to the terminal to answer its question. Your message is still here.',
  notReady: 'The terminal isn\'t at its prompt right now, so nothing was sent. Your message is still here.',
  draft: 'The terminal\'s input box already holds text, so nothing was sent. Send or clear it there first. Your message is still here.',
  bang: 'A message starting with ! runs as a shell command in the CLI, so it wasn\'t sent. Your message is still here.',
  backslash: 'A message ending with a backslash makes a new line in the CLI instead of sending, so it wasn\'t sent. Your message is still here.',
  noReadback: 'The terminal didn\'t show your message as typed, so Enter was not pressed. Your message is still here.',
  changed: 'The screen changed before Enter (a dialog may have opened), so Enter was not pressed. Your message is still here.',
  swallowed: 'The terminal didn\'t take the Enter (a suggestion list or a line ending in a backslash?), so nothing was sent. Your message is still here.',
  offline: 'Not connected to the session, so nothing was sent. Your message is still here.',
  busy: 'Another command is still being typed in this tab, so nothing was sent. Your message is still here.',
};

const emptyBox = (box) => box === '' || /^Try "/.test(box);

/** Why this message must not be typed now, or null. Pure. `screen` is top-bar-display's inputState, `box` its boxText. */
function sendBlocker({ text, turn, blocked, screen, box, holds }) {
  if (turn === 'prompt' || blocked === true) return NOTE.dialog;
  if (holds === true) return NOTE.holds;
  if (screen === 'multiline') return NOTE.draft;
  if (screen !== 'ready') return screen === 'dialog' ? NOTE.dialog : NOTE.notReady;
  if (typeof box !== 'string' || !emptyBox(box)) return NOTE.draft;
  if (typeof text === 'string' && text.startsWith('!')) return NOTE.bang;
  if (typeof text === 'string' && text.endsWith('\\')) return NOTE.backslash;
  return null;
}

/**
 * env: { turn(), blocked(), holds(), lines(), sync(), termRows(), vim(), connected(), busy(), lock(on), bracketed(),
 *        type(frame) -> 'sent' | 'held', cancelHold(), send(frame), sleep(ms), inputState, commandTyped, boxText, boxHoldsLine }
 * -> { ok: true } once the Enter went out and the box let go of the text, else { ok: false, note } with the text still the caller's.
 */
async function runChatSend(raw, env) {
  const text = sanitizeInput(raw);
  const plan = planChatSend(raw, { bracketed: env.bracketed() });
  if (plan.length === 0) return { ok: false };
  if (!env.connected()) return { ok: false, note: NOTE.offline };
  if (env.busy()) return { ok: false, note: NOTE.busy };
  const screenNow = async () => { if (typeof env.sync === 'function') await env.sync(); return env.lines(); };
  const opts = () => ({ vim: env.vim(), termRows: env.termRows() });
  const frame = (data) => JSON.stringify({ type: 'input', data });

  env.lock(true);
  try {
    const first = await screenNow();
    const why = sendBlocker({ text, turn: env.turn(), blocked: env.blocked(), holds: env.holds(),
      screen: env.inputState(first, { vim: env.vim() }), box: env.boxText(first) });
    if (why) return { ok: false, note: why };

    // Empties what a failed attempt typed. Never a key into a dialog: a screen with no input box ends it.
    const clear = async () => {
      for (let pass = 0; pass < CLEAR_PASSES; pass++) {
        const lines = await screenNow();
        const state = env.inputState(lines, { vim: env.vim() });
        if (state === 'dialog' || state === 'unknown') return;
        if (state === 'ready' && emptyBox(env.boxText(lines) || '')) return;
        env.send(frame(CTRL_E));
        await env.sleep(env.keyGap || 120);
        env.send(frame(CTRL_U));
        await env.sleep(env.keyGap || 120);
      }
    };

    if (env.type(plan[0].frame) === 'held') { env.cancelHold(); return { ok: false, note: NOTE.holds }; }
    let typed = false;
    for (let waited = 0; waited <= READBACK_WAIT_MS; waited += env.keyGap || 120) {
      await env.sleep(env.keyGap || 120);
      if (env.commandTyped(await screenNow(), text, opts())) { typed = true; break; }
    }
    if (!typed) { await clear(); return { ok: false, note: NOTE.noReadback }; }

    await env.sleep(RECHECK_MS);
    const last = await screenNow();
    const state = env.inputState(last, { vim: env.vim() });
    if ((state !== 'ready' && state !== 'multiline') || env.turn() === 'prompt' || env.blocked() === true || !env.commandTyped(last, text, opts())) {
      await clear();
      return { ok: false, note: NOTE.changed };
    }

    env.send(plan[1].frame);
    for (let i = 0; i < AFTER_POLLS; i++) {
      await env.sleep(AFTER_POLL_MS);
      if (!env.boxHoldsLine(await screenNow(), text)) return { ok: true };
    }
    await clear();
    return { ok: false, note: NOTE.swallowed };
  } finally {
    env.lock(false);
  }
}

// The switch is remembered per tab, by its folder (localStorage is shared by the tab views of one window).
const keyFor = (cwd) => STORAGE_PREFIX + String(cwd);
function readWanted(storage, cwd) {
  try { return !!storage && storage.read(keyFor(cwd)) === '1'; } catch { return false; }
}
function writeWanted(storage, cwd, wanted) {
  try { if (storage) storage.write(keyFor(cwd), wanted === true ? '1' : '0'); } catch { /* a full or blocked store: the switch just isn't remembered */ }
}

const api = { viewFor, isChatKey, sanitizeInput, planChatSend, runChatSend, sendBlocker, readWanted, writeWanted, FLIP_NOTE, ENTER_DELAY_MS, SEND_NOTES: NOTE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatViewState = api;

})(typeof window !== 'undefined' ? window : globalThis);
