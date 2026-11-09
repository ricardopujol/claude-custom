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
 *   boxAtRest({ screen, box, typing, drafts }) -> boolean     (BACKLOG #139; PR #236 Miguel G7)
 *     Is the CLI's box at its prompt, empty, nothing typing into it, and none of the page's other unsent inputs (`drafts`: the
 *     chat view's draft, the half-filled forms) holding text? What the page answers main before a merged tab's session is stopped.
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
  // A dialog the hooks announced, the CLI's own blocked report, or a dialog / picker the SCREEN shows (/model, /resume, trust, MCP approval:
  // none fire a hook): the person is needed in the terminal.
  if (s.turn === 'prompt' || s.blocked === true || s.screen === 'dialog') return { show: 'terminal', note: FLIP_NOTE };
  // Unknown is not at the prompt: before the session's first start the CLI may be showing a trust dialog or a resume picker, and the host
  // being gone says nothing either (PR #226 Miguel I1, Dexter 6).
  if (s.turn !== 'idle' && s.turn !== 'turn') return { show: 'terminal', note: null };
  return { show: 'chat', note: null };
}

// Ctrl+Shift+H, on keydown only. A held key repeats: the caller swallows the repeat too but toggles once (e.repeat). The CLI sees no Ctrl+Shift combination (a pty can't carry one), so it can't clash with it.
function isChatKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && e.shiftKey === true && !e.altKey && !e.metaKey && e.code === 'KeyH';
}

// BACKLOG #172: Ctrl+0 while the keyboard is in the chat puts its text zoom back to 100 % (the digit row or the keypad), keydown only.
function isChatZoomResetKey(e) {
  return !!e && e.type === 'keydown' && e.ctrlKey === true && !e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'Digit0' || e.code === 'Numpad0');
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
const typingKeysFn = () => (typeof module !== 'undefined' && module.exports ? require('./top-bar-display').typingKeys : root.typingKeys);

// A one-line message goes in 200-character writes (app/top-bar-display.js typingKeys, the one chunker every typed command uses): the CLI takes
// ONE big write for a paste and shows "[Pasted text #1]", which the read-back would never match (PR #226 Dexter R2-1). typingKeys leads with
// Ctrl-E and Ctrl-U, which the send doesn't want (it only types into a box it has just seen empty): they are dropped, the chunks are its own.
const textChunks = (text) => typingKeysFn()(text, false).slice(2);
const vimInsertShownFn = () => (typeof module !== 'undefined' && module.exports ? require('./top-bar-display').vimInsertShown : root.vimInsertShown);
const liveBoxFn = () => (typeof module !== 'undefined' && module.exports ? require('./top-bar-display').liveBox : root.liveBox);
const scrollCapRowsFn = () => (typeof module !== 'undefined' && module.exports ? require('./top-bar-display').scrollCapRows : root.scrollCapRows);

function planChatSend(raw, opts) {
  const text = sanitizeInput(raw);
  if (text === '') return [];
  const frame = (data) => JSON.stringify({ type: 'input', data });
  let texts;
  if (!text.includes('\n')) texts = textChunks(text).map(frame);
  else if (opts && opts.bracketed === true) texts = [pasteFrameFn()(text, true)];
  else texts = [frame(text.split('\n').join('\x1b\r'))];
  // The text frames, then Enter as the LAST entry: runChatSend spaces the text frames by the key gap.
  return [...texts.map(f => ({ frame: f, afterMs: 0 })), { frame: frame('\r'), afterMs: ENTER_DELAY_MS }];
}

// --- the type box's send: nothing goes to the pty that could answer a dialog (PR #226 Dexter 1, Miguel I2) --------------------------------
// The sequence is the one host/grant-sequence.js runs for a drop (PR #223): READ the live screen, type, READ it back, look once more,
// and only then press Enter. Every read-back is the page's own xterm (sync waits for what the host sent to be parsed).
const READBACK_WAIT_MS = 1500;       // how long the typed text may take to show on screen before it counts as a mismatch
const RECHECK_MS = 400;              // the look just before the Enter (the PR #106 pattern: a dialog can open mid-send)
const AFTER_POLL_MS = 150;           // after the Enter: is the text still in the box (the CLI swallowed the key)?
const AFTER_POLLS = 6;
// The clear's bound, in passes of Ctrl+E then Ctrl+U (PR #233 F2). MEASURED (verify/probe-chat-send-real.js --measure-clear, Claude Code
// v2.1.318): Ctrl+U empties the cursor's line, and on an empty line deletes the line break before it, so a cursor at the end empties two
// rows' worth per two passes (12 lines took 24 Ctrl+U). No key reaches the end of the whole input (Ctrl+End, Meta+> and End were tried), and a
// cursor moved up to line 1 empties line 1 and then makes no progress. So the clear stops at the first pass that changes nothing, and is
// bounded by 2 passes per row read plus 2; a box at the scroll cap may hide a head, so it gets CLEAR_PASSES_MAX instead.
const CLEAR_PASSES_PER_ROW = 2;
const CLEAR_PASSES_MAX = 100;
const CTRL_E = String.fromCharCode(5);
const CTRL_U = String.fromCharCode(21);

const NOTE = {
  dialog: 'Claude needs you in the terminal first, so nothing was sent. Your message is still here.',
  holds: 'An agent is writing in this folder, so nothing was sent. Switch to the terminal to answer its question. Your message is still here.',
  notReady: 'The terminal isn\'t at its prompt right now, so nothing was sent. Your message is still here.',
  draft: 'The terminal\'s input box already holds text, so nothing was sent. Send or clear it there first. Your message is still here.',
  draftStuck: 'The terminal\'s draft couldn\'t be cleared, so nothing was sent. Clear it there first. Your message is still here.',
  draftPartly: 'The terminal\'s draft couldn\'t be fully cleared and part of it is gone, so nothing was sent. Clear the rest there first. Your message is still here.',
  bang: 'A message starting with ! runs as a shell command in the CLI, so it wasn\'t sent. Your message is still here.',
  backslash: 'A message ending with a backslash makes a new line in the CLI instead of sending, so it wasn\'t sent. Your message is still here.',
  noReadback: 'The terminal didn\'t show your message as typed, so Enter was not pressed. Your message is still here.',
  changed: 'The screen changed before Enter (a dialog may have opened), so Enter was not pressed. Your message is still here.',
  swallowed: 'The terminal didn\'t take the Enter (a suggestion list or a line ending in a backslash?), so nothing was sent. Your message is still here.',
  offline: 'Not connected to the session, so nothing was sent. Your message is still here.',
  busy: 'Another command is still being typed in this tab, so nothing was sent. Your message is still here.',
};

const emptyBox = (box) => box === '' || /^Try "/.test(box);

// The CLI shows a bracketed paste of several lines as ONE placeholder, "[Pasted text #5 +7 lines]" (measured on the real CLI:
// verify/probe-chat-send-real.js --measure; 3 lines show whole, 8 collapse), and Enter submits the real text. The send began on a box it
// saw EMPTY, so a box holding nothing but one placeholder holds our paste. Only a bracketed paste is read back this way.
const PLACEHOLDER = /^\[Pasted text #\d+(?: \+\d+ lines?)?\]$/;
const onlyPlaceholder = (box) => typeof box === 'string' && PLACEHOLDER.test(box.trim());

/**
 * BACKLOG #139: is the CLI's box at rest -- at its prompt, holding nothing anyone typed, with nothing being typed into it by this
 * page? Main asks before it closes a merged tab by itself; anything else (a draft, a dialog, a multi-line box, a screen it can't
 * read) is "no". Pure; the same reading of the box as sendBlocker's. `drafts` (PR #236 Dexter 2): the values of the page's other unsent
 * inputs (the chat view's #chat-input, which lives in the DOM only, and the half-filled forms); any one holding text is "no", and a
 * `drafts` that isn't a list can't be read, so it is "no" too. Left out, there are none.
 */
function boxAtRest({ screen, box, typing, drafts } = {}) {
  if (drafts !== undefined && !(Array.isArray(drafts) && drafts.every(d => typeof d !== 'string' || d.trim() === ''))) return false;
  return typing !== true && screen === 'ready' && typeof box === 'string' && emptyBox(box);
}

// Appended to a failure that came after the CLI's draft was cleared (#174): the person's draft is gone (the CLI's Ctrl+Y brings back a
// single line), and the note must not read as if nothing had happened.
const CLEARED = ' The terminal\'s draft was cleared.';
const PARTLY_CLEARED = ' The terminal\'s draft was partly cleared.';                 // a read showed part of it gone
const MAYBE_PARTLY_CLEARED = ' The terminal\'s draft may have been partly cleared.';   // a key went that no read saw land
// Appended when the after-failure clear could not empty the box (a dialog or a prompt turn came up: no key may go then): our text is left
// typed in the CLI's box, and the person must not find it there unannounced (PR #233 F5).
const TEXT_LEFT = ' Your text is still typed in the terminal\'s box.';

/**
 * Why this message must not be typed now, or null. Pure. `screen` is top-bar-display's inputState, `box` its boxText.
 * NOTE.draft is the LAST check and the only one runChatSend acts on (#174: it clears the CLI's draft, then sends): every other refusal
 * (a dialog, a prompt turn, the blocked report, a hold, a screen that isn't the box, a `!`, a trailing backslash) comes first, so the clear
 * can never start in one of those states.
 */
function sendBlocker({ text, turn, blocked, screen, box, holds }) {
  if (turn === 'prompt' || blocked === true) return NOTE.dialog;
  if (holds === true) return NOTE.holds;
  if (screen !== 'ready' && screen !== 'multiline') return screen === 'dialog' ? NOTE.dialog : NOTE.notReady;
  if (typeof text === 'string' && text.startsWith('!')) return NOTE.bang;
  if (typeof text === 'string' && text.endsWith('\\')) return NOTE.backslash;
  if (screen === 'multiline' || typeof box !== 'string' || !emptyBox(box)) return NOTE.draft;
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
  const asPaste = text.includes('\n') && env.bracketed() === true;
  // Is our message in the box: shown as typed, or (a bracketed paste) as the CLI's lone paste placeholder.
  const inBox = (lines) => env.commandTyped(lines, text, opts()) || (asPaste && onlyPlaceholder(env.boxText(lines)));
  const frame = (data) => JSON.stringify({ type: 'input', data });

  // The screen as the send judges it: inputState, except that vim NORMAL is vim NORMAL whatever the box's row count. inputState says
  // 'multiline' before it looks at vim mode (top-bar-display.js), which every other caller needs (planTyping refuses 'multiline' but turns
  // 'vim-normal' into an `i` and a command, which would submit a multi-row draft with it), so the chat corrects it here (PR #233 F1).
  const screenOf = (lines) => {
    const s = env.inputState(lines, { vim: env.vim() });
    if (s === 'multiline' && env.vim() === true && !vimInsertShownFn()(lines)) return 'vim-normal';
    return s;
  };
  const rowsOf = (lines) => { const live = liveBoxFn()(lines); return live && live.box ? live.box : null; };
  // The clear's "empty": '' or the CLI's dim `Try "..."` hint, but never a box that holds our own text (a real draft starting `Try "` with our
  // text typed after it reads as the hint by its text alone, F6).
  const clearedBox = (lines) => { const b = env.boxText(lines) || ''; return b === '' || (emptyBox(b) && !env.boxHoldsLine(lines, text)); };

  env.lock(true);
  try {
    /**
     * Empties the box with the CLI's own keys, in passes of Ctrl+E (to the line's end) then Ctrl+U (back to its start, or the line break
     * before an empty line), the screen READ before every key. A key goes only while the screen shows the box (one row or several) and
     * nothing says a dialog, a prompt turn or the blocked report; the DRAFT's clear also stops for a hold (an agent writing in the folder), so
     * the person's draft isn't thrown away behind the occupancy question. The clear after a failed attempt doesn't: its keys go through send(),
     * which the question never holds, and they only empty our own text (PR #233 F5).
     * It stops at the first pass that changes nothing, and after 2 passes per row read (+2), or CLEAR_PASSES_MAX when the box is at the
     * scroll cap and may hide a head (F2).
     * -> { empty: true, keys, gone } once a read shows the READY box empty, else { empty: false, keys, gone, stop } where stop is the refusal
     *    that ended it (null: no progress, or the bound). gone: 'yes' a read showed part of the box removed, 'maybe' the last key was never
     *    seen land, 'no' nothing was removed.
     */
    const clear = async (forDraft) => {
      let keys = 0;
      let start = null;          // the box's rows at the first read
      let passStart = null;      // ... at the start of the current pass
      let lastSeen = null;
      let maxRows = 1;
      let passes = 0;
      let capSeen = false;
      const gone = (rows) => {
        const now = rows ? JSON.stringify(rows) : lastSeen;
        if (start !== null && now !== null && now !== start) return 'yes';
        return keys > 0 && rows === null ? 'maybe' : 'no';
      };
      for (;;) {
        const lines = await screenNow();
        const state = screenOf(lines);
        const rows = state === 'dialog' ? null : rowsOf(lines);
        const stop = (s) => ({ empty: false, keys, gone: gone(rows), stop: s });
        if (env.turn() === 'prompt' || env.blocked() === true || state === 'dialog') return stop(NOTE.dialog);
        if (forDraft && env.holds() === true) return stop(NOTE.holds);
        if (state !== 'ready' && state !== 'multiline') return stop(NOTE.notReady);
        if (state === 'ready' && clearedBox(lines)) return { empty: true, keys, gone: gone(rows) };
        const sig = JSON.stringify(rows);
        if (start === null) start = sig;
        lastSeen = sig;
        if (keys % 2 === 0) {                                  // a pass begins: did the last one change anything, and is there room for another?
          if (keys > 0 && sig === passStart) return stop(null);
          const n = rows ? rows.length : 1;
          maxRows = Math.max(maxRows, n);
          if (n >= 2 && n === scrollCapRowsFn()(env.termRows())) capSeen = true;   // once at the cap, the rows read never told the whole draft
          const bound = capSeen ? CLEAR_PASSES_MAX : Math.min(CLEAR_PASSES_MAX, CLEAR_PASSES_PER_ROW * maxRows + 2);
          if (passes >= bound) return stop(null);
          passStart = sig;
          passes++;
        }
        env.send(frame(keys % 2 === 0 ? CTRL_E : CTRL_U));
        keys++;
        await env.sleep(env.keyGap || 120);
      }
    };
    const partlyNote = (c) => (c.gone === 'yes' ? PARTLY_CLEARED : c.gone === 'maybe' ? MAYBE_PARTLY_CLEARED : '');

    const first = await screenNow();
    const why = sendBlocker({ text, turn: env.turn(), blocked: env.blocked(), holds: env.holds(),
      screen: screenOf(first), box: env.boxText(first) });
    // A draft in the CLI's box is thrown away on purpose (#174, Ricardo: the chat's send overwrites it), and only once every other check
    // passed. Nothing is typed until a read shows the box empty; that read is the last one before the text goes.
    let cleared = false;
    if (why === NOTE.draft) {
      const c = await clear(true);
      if (!c.empty) {
        if (c.stop === null) return { ok: false, note: c.gone === 'no' ? NOTE.draftStuck : NOTE.draftPartly };
        return { ok: false, note: c.stop + partlyNote(c) };
      }
      cleared = c.keys > 0;                 // F3: a box that emptied by itself before the first key was not cleared by us
    } else if (why) return { ok: false, note: why };
    // After a failed attempt: empty what we typed. When the box can't be emptied (a dialog, a prompt turn), say our text is still there (F5).
    // `extra`: the box held more than our text (a real draft that started `Try "`, read as the CLI's empty hint, F6), so a clear that removed
    // anything also threw a draft away.
    const failAfter = async (note, extra) => {
      const c = await clear(false);
      let out = note;
      if (cleared || (extra && c.keys > 0 && c.gone === 'yes')) out += CLEARED;
      if (!c.empty) out += TEXT_LEFT;
      return { ok: false, note: out };
    };
    // Does the box hold our text AND something more? Rows joined, whitespace collapsed, as the read-back judges them.
    const holdsMore = (lines) => {
      const rows = rowsOf(lines);
      if (!rows || !env.boxHoldsLine(lines, text)) return false;
      const box = rows.join(' ').replace(/^❯/, '').replace(/\s+/g, ' ').trim();
      return box.length > text.replace(/\s+/g, ' ').trim().length;
    };

    const enter = plan[plan.length - 1];
    if (env.type(plan[0].frame) === 'held') { env.cancelHold(); return { ok: false, note: cleared ? NOTE.holds + CLEARED : NOTE.holds }; }
    // The rest of a long message, one chunk per key gap: written together they would be one paste again.
    // A dialog that opens between two chunks must not get the rest of the text as keys.
    for (let k = 1; k < plan.length - 1; k++) {
      await env.sleep(env.keyGap || 120);
      const lines = await screenNow();
      const now = screenOf(lines);
      if ((now !== 'ready' && now !== 'multiline') || env.turn() === 'prompt' || env.blocked() === true) return failAfter(NOTE.changed, holdsMore(lines));
      env.send(plan[k].frame);
    }
    let typed = false;
    let seen = null;
    for (let waited = 0; waited <= READBACK_WAIT_MS; waited += env.keyGap || 120) {
      await env.sleep(env.keyGap || 120);
      seen = await screenNow();
      if (inBox(seen)) { typed = true; break; }
    }
    if (!typed) return failAfter(NOTE.noReadback, holdsMore(seen));

    await env.sleep(RECHECK_MS);
    const last = await screenNow();
    const state = screenOf(last);
    if ((state !== 'ready' && state !== 'multiline') || env.turn() === 'prompt' || env.blocked() === true || !inBox(last)) {
      return failAfter(NOTE.changed, false);
    }

    env.send(enter.frame);
    for (let i = 0; i < AFTER_POLLS; i++) {
      await env.sleep(AFTER_POLL_MS);
      const now = await screenNow();
      if (!env.boxHoldsLine(now, text) && !(asPaste && onlyPlaceholder(env.boxText(now)))) return { ok: true };
    }
    return failAfter(NOTE.swallowed, false);
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

const api = { viewFor, isChatKey, isChatZoomResetKey, sanitizeInput, planChatSend, runChatSend, sendBlocker, boxAtRest, readWanted, writeWanted, FLIP_NOTE, ENTER_DELAY_MS, SEND_NOTES: NOTE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.chatViewState = api;

})(typeof window !== 'undefined' ? window : globalThis);
