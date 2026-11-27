'use strict';
/**
 * The pty side of a drop that needs a grant (BACKLOG #136, PR #223 review).
 *
 * A drop from a folder outside the project types `/add-dir <dir>` and presses Enter. The old code wrote Ctrl-U + the command + CR as
 * one write, blind. MEASURED on the real CLI (verify/probe-paste-doc.js grant6, claude 2.1.312): Ctrl-U kills only the last wrapped
 * row, and a key sharing a write with text may not count as a key, so a 6-row draft kept its first rows, `/add-dir` was appended and
 * the Enter sent the lot to the model. A fixed count of Ctrl-U fixes only the measured shape (soft wraps, cursor at the end): a hard
 * newline, a draft taller than the box, a cursor mid-draft or a permission prompt on screen each bring the bug back (Dexter 1-3, 6).
 *
 * So nothing here counts, everything is READ BACK from the live screen, at write time:
 *   1. the screen must show an idle prompt box (no dialog, no menu), else nothing is written at all;
 *   2. clear: Ctrl-E, Ctrl-U (each its own write) until the box reads empty, up to MAX_CLEAR_PASSES;
 *   3. type `/add-dir <dir>` alone, then require the box to read back as exactly that command (commandTyped);
 *   4. only then send the Enter, alone. If the read-back fails: clear what was typed and send NO Enter.
 * The person's own keys are held while 1-4 run (createInputGate), and drops are run one after another by the caller.
 *
 * THE DRAFT IS KEPT (BACKLOG #136 residuals, Ricardo 2026-11-06). Before the first clear the box is read back as one line (draftOf);
 * once the grants are done and their dialogs answered, that line is typed back with the dropped paths after it. A draft that can't be
 * read back whole is never cleared: one taller than the box (its head is hidden), or one holding a `[Pasted text #N]` or `[Image #N]`
 * label (typing the label back would type the label, not what the CLI was holding). Then the folder is reported as not requested and
 * the paths go after the draft. A drop with no grant puts a space before the paths when the box already holds something (no gluing).
 * Rows are joined the way the CLI wrapped them (joinRows): a row that fills the whole width continues with NO space (a token wider than the
 * box wrapped mid-word: PR #246 Dexter D2), a soft wrap at a space swallowed exactly one (top-bar-display.js commandTyped), and a row whose
 * next word would still have FIT on it can only have ended in a real line break (Shift+Enter), which comes back as Shift+Enter's bytes
 * (ESC then CR, the way the app joins lines; never a bare CR, which would submit).
 * A draft that was read and cleared but cannot be typed back (the Add-directory dialog never answered, the prompt gone, ...) is handed
 * back as text in a notice (onDraftLeft), never dropped (D1). If the person typed into the emptied box meanwhile, the draft goes after it.
 */
const { quote } = require('./drop');
const { liveBox, inputState, commandTyped, scrollCapRows } = require('../app/top-bar-display');

const CTRL_E = String.fromCharCode(5);
const CTRL_U = String.fromCharCode(21);
// Each pass is two keys. The visible box is capped at floor(termRows / 2) - 5 rows and keeps the END of a longer text (top-bar-display.js
// scrollCapRows), so clearing the tail shows the head: a draft of any height needs passes until the box reads empty, not a fixed count.
// 60 passes cover a 54-row terminal's 22-row box many times over; reaching it fails closed (no Enter).
const MAX_CLEAR_PASSES = 60;
// Between two keys, so the CLI has taken one before the next arrives. NOT what makes this safe: the read-back is (every read waits for
// the screen to be parsed, and an Enter needs an exact match). MEASURED 2026-10-29 on the Katana under load (60+ node/Electron
// processes), verify/probe-paste-doc.js grant, claude 2.1.312: at 120 ms all six cases pass (1 to 6 clear passes each); at 80 ms and no
// screen sync, 2 of 6 read stale and fail closed (no Enter), which is why every read now syncs first.
const KEY_GAP_MS = 120;
const RECHECK_MS = 400;            // the look just before the Enter
const DIALOG_SEEN_MS = 3000;       // how long a grant's own dialog may take to be drawn after its Enter
const READBACK_WAIT_MS = 1500;     // how long the typed command may take to show on screen before it counts as a mismatch
const DIALOG_WAIT_MS = 120000;     // how long a grant's own "Add directory" dialog may stay open before the rest of the drop is dropped
const POLL_MS = 250;

// Anything on screen that says a dialog or menu has the keyboard. The box rule alone is not enough: a permission prompt can sit between
// two rules with a `❯ 1. Yes` row in it.
const DIALOG_TEXT = /Enter to confirm|Esc to cancel|Do you want to|^\s*❯\s*\d+\./;

function idleBox(lines) {
  if (!Array.isArray(lines)) return false;
  // Only the part of the screen from the box's top rule down: a dialog is drawn there, and the conversation above may quote these words.
  const rules = [];
  lines.forEach((l, i) => { if (typeof l === 'string' && /^─{10,}$/.test(l.trim())) rules.push(i); });
  const from = rules.length >= 2 ? rules[rules.length - 2] : (rules.length ? rules[0] : 0);
  if (lines.slice(from).some(l => typeof l === 'string' && DIALOG_TEXT.test(l.trim()))) return false;
  const state = inputState(lines);
  return state === 'ready' || state === 'multiline';
}

// Empty = the CLI's dim placeholder (`❯ Try "edit <filepath> to..."`, drawn only when the WHOLE input is empty), or one bare `❯` row
// in a box that is below its height cap. At the cap the box shows only the END of a longer text (scrollCapRows), so a bare row there
// can be hiding a head: it proves nothing (Dexter 2b), and the clear goes on until the placeholder shows.
function boxEmpty(lines, termRows) {
  const live = liveBox(lines);
  const box = live && live.box;
  if (!box || box.length !== 1) return false;
  if (/^❯\s+Try "/.test(box[0])) return true;
  return /^❯\s*$/.test(box[0]) && box.length < scrollCapRows(termRows);
}

// What the box holds, as the one line that would be typed back: { ok: true, text } ('' for an empty box), or { ok: false, why } when it
// can't be read back whole. Only an idle box is read; a menu or dialog holds no draft (and grantOne refuses it on its own).
const HELD_LABEL = /\[(?:Pasted text|Image) #\d+/;
const ESC_CR = '\x1b\r';            // Shift+Enter's bytes: a line break in the box that does not submit (probe-chat-send-real.js draft-multi)
const PREFIX_COLS = 2;             // every box row starts with `❯ ` or two spaces
const TYPE_BACK_CHUNK = 200;      // characters per write: one big write is taken for a paste and collapsed (top-bar-display.js COMMAND_CHUNK)
// The terminal's width, read off the box's own rule (the rows are trimmed, so their own length can't say); 0 when it can't be told.
function ruleWidth(lines) {
  const rules = lines.map(l => (typeof l === 'string' ? l.trim() : '')).filter(l => /^─{10,}$/.test(l));
  return rules.length ? rules[rules.length - 1].length : 0;
}

// Box rows (prefix off, trimmed) back into the text they hold. A row that reaches the box's usable width (prefix included) is FULL: the CLI
// wrapped mid-word, so the next row continues with no space. Otherwise the break was at a space (a soft wrap swallows one) unless the next
// row's first word would still have fitted on this one, in which case only a real line break explains it: '\n'. Unknown width: a space,
// never a guess. MEASURED on the real CLI (verify/probe-paste-doc.js draft-rows, claude 2.1.319, 134 columns): a token wider than the box
// fills its row to 132 columns, the width minus RIGHT_MARGIN_COLS; word-wrapped rows came out at 131 and 127; real line breaks read back
// as short rows. A word-wrapped row CAN end exactly at the usable width too, and nothing in the rows tells it from a mid-word fill: MEASURED
// (draft-rows `exact-limit-word-wrap`, same CLI): 'hello ' x21 + 'aaaa there' came back as rows of 132 and 7 columns, the second being
// `  there` with no extra blank, so the swallowed space leaves no trace (the wrap trims; PR #246 Dexter R2-1 guessed otherwise). What does
// tell them apart is the word itself: the CLI breaks inside a word only when the whole word is wider than a row's content (a word that
// would fit moves to the next row whole, which is why word-wrapped rows end short). So a full row continues with no space only when
// the word it cuts (its last token plus the next row's first) is wider than that; otherwise it is a wrap at a space. Prose is the common case.
const RIGHT_MARGIN_COLS = 2;
// Columns a string takes on screen (the CLI wraps by these, not by `.length`): emoji and East Asian wide characters take two, combining
// marks, joiners and variation selectors none. Not a full wcwidth table: the ranges that show up in a prompt.
const cpClass = (ranges) => new RegExp('[' + ranges.map(([a, b]) => String.fromCodePoint(a) + (b ? '-' + String.fromCodePoint(b) : '')).join('') + ']', 'u');
// code points, not literal characters: invisible ones in a source file are what test/renderer-scope.test.js refuses
const WIDE = cpClass([[0x1100, 0x115F], [0x2E80, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
  [0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0], [0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F], [0x2693], [0x26A1],
  [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE], [0x26D4], [0x26EA], [0x26F2, 0x26F3], [0x26F5], [0x26FA], [0x26FD], [0x2705],
  [0x270A, 0x270B], [0x2728], [0x274C], [0x274E], [0x2753, 0x2755], [0x2757], [0x2795, 0x2797], [0x27B0], [0x27BF], [0x2B1B, 0x2B1C], [0x2B50],
  [0x2B55], [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD]]);
const ZERO = cpClass([[0x0300, 0x036F], [0x200B, 0x200D], [0xFE00, 0xFE0F]]);
function cellWidth(s) {
  let n = 0;
  for (const ch of s) n += ZERO.test(ch) ? 0 : (WIDE.test(ch) ? 2 : 1);
  return n;
}
function joinRows(rows, width) {
  let out = rows[0] || '';
  const limit = width - RIGHT_MARGIN_COLS;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cols = PREFIX_COLS + cellWidth(prev);
    const head = rows[i].split(' ')[0];
    let sep = ' ';
    if (width > 0) {
      if (cols >= limit) {
        const cut = cellWidth(prev.slice(prev.lastIndexOf(' ') + 1)) + cellWidth(head);
        if (cut > limit - PREFIX_COLS) sep = '';
      } else if (cols + 1 + cellWidth(head) <= limit) sep = '\n';
    }
    out += sep + rows[i];
  }
  return out;
}

function draftOf(lines, termRows) {
  if (!idleBox(lines)) return { ok: false, why: 'the prompt is not showing' };
  if (boxEmpty(lines, termRows)) return { ok: true, text: '' };
  const box = liveBox(lines).box;
  const cap = scrollCapRows(termRows);
  if (cap < 1 || box.length >= cap) return { ok: false, why: 'the draft in the prompt is taller than the box, so it could not be read back whole' };
  const text = joinRows(box.map((row, i) => (i === 0 ? row.slice(1) : row).trim()), ruleWidth(lines));
  if (HELD_LABEL.test(text)) return { ok: false, why: 'the draft in the prompt holds a pasted block or an image that typing it back would lose' };
  return { ok: true, text };
}

// The screen as it is NOW: xterm parses the pty's output asynchronously, so a read right after a write can see a screen several seconds old
// on a loaded machine (measured: a draft typed 800 ms earlier still read as the empty placeholder). env.sync() resolves once everything
// the host has received is parsed. It cannot see bytes the pty has not delivered yet, which is why every read-back is also retried.
async function readScreen(env) {
  if (typeof env.sync === 'function') await env.sync();
  return env.lines();
}

// Ctrl-E first: Ctrl-U kills from the cursor back to the start of its row, so a cursor mid-draft would leave the tail (Dexter 6).
async function clearBox(env) {
  for (let pass = 0; pass < MAX_CLEAR_PASSES; pass++) {
    if (boxEmpty((await readScreen(env)), env.termRows())) { env.log('[host] grant: box empty after ' + pass + ' clear pass(es)'); return true; }
    env.write(CTRL_E);
    await env.sleep(env.keyGap);
    env.write(CTRL_U);
    await env.sleep(env.keyGap);
  }
  return boxEmpty((await readScreen(env)), env.termRows());
}

// One grant. { ok: true } once the Enter was sent; { ok: false, reason } with nothing sent that could submit or confirm anything.
async function grantOne(dir, env) {
  const command = '/add-dir ' + quote(dir);
  // `untouched`: refused before any key was written, so a draft read a moment ago is still whole in the box (runDrop forgets that read).
  if (!idleBox((await readScreen(env)))) return { ok: false, untouched: true, reason: 'the prompt is not showing (a dialog, a menu or a permission prompt has the keyboard)' };
  if (!(await clearBox(env))) return { ok: false, reason: 'the draft could not be cleared, so nothing was typed' };
  env.write(command);
  // The screen can lag the pty (a loaded machine, the slash-command list redrawing): give the read-back a few polls to catch up
  // before calling it a mismatch. A mismatch is never forced: no Enter.
  let typedOk = false;
  for (let waited = 0; waited <= READBACK_WAIT_MS; waited += env.keyGap || 1) {
    await env.sleep(env.keyGap);
    if (commandTyped((await readScreen(env)), command, { termRows: env.termRows() })) { typedOk = true; break; }
  }
  if (!typedOk) {
    const seen = liveBox(await readScreen(env));
    env.log('[host] grant: read-back saw ' + JSON.stringify(seen && seen.box));
    await clearBox(env);
    return { ok: false, reason: 'the prompt did not read back as the /add-dir line, so Enter was not pressed' };
  }
  // The last look (the PR #106 pattern): a permission prompt the CLI drew on its own, mid-turn, can take the Enter as `1. Yes`. The
  // read-back above is milliseconds old; this one is RECHECK_MS later and must still show the idle prompt holding exactly the command.
  await env.sleep(RECHECK_MS);
  const last = await readScreen(env);
  if (!idleBox(last) || !commandTyped(last, command, { termRows: env.termRows() })) {
    await clearBox(env);
    return { ok: false, reason: 'the screen changed before Enter (a dialog or prompt appeared), so Enter was not pressed' };
  }
  env.log('[host] grant: read back as ' + command + ', pressing Enter');
  env.write('\r');
  await env.sleep(env.keyGap);
  return { ok: true };
}

// Wait for the prompt to be back (the grant's own dialog answered). True when it is, false at the timeout.
async function waitIdle(env, ms = DIALOG_WAIT_MS) {
  for (let t = 0; t < ms; t += POLL_MS) {
    if (idleBox((await readScreen(env)))) { env.log('[host] grant: prompt back after ' + t + ' ms'); return true; }
    await env.sleep(POLL_MS);
  }
  return idleBox((await readScreen(env)));
}

// True once the prompt has LEFT idle (the dialog is drawn), false if it never does within DIALOG_SEEN_MS.
async function waitDrawn(env) {
  for (let t = 0; t < DIALOG_SEEN_MS; t += POLL_MS) {
    if (!idleBox(await readScreen(env))) return true;
    await env.sleep(POLL_MS);
  }
  return !idleBox(await readScreen(env));
}

// Type `out` into an emptied box: at most TYPE_BACK_CHUNK characters per write, a '\n' as Shift+Enter's bytes in a write of its own.
async function typeOut(env, out) {
  let first = true;
  for (const part of out.split('\n')) {
    if (!first) { await env.sleep(env.keyGap); env.write(ESC_CR); }
    first = false;
    const chars = Array.from(part);
    for (let at = 0; at < chars.length; at += TYPE_BACK_CHUNK) {
      if (at > 0) await env.sleep(env.keyGap);
      env.write(chars.slice(at, at + TYPE_BACK_CHUNK).join(''));
    }
  }
}

const LATE_WAIT_MS = 30 * 60 * 1000;   // how long a draft waits for an unanswered Add-directory dialog before it is handed back as a notice
const LATE_POLL_MS = 1000;

// A draft the grant cleared, while its dialog is still open past DIALOG_WAIT_MS: wait for the prompt to come back, then type the draft
// into the box (after whatever the person typed there meanwhile, never over it). It never throws; a draft that can't go back is handed
// back (handBack: the notice that stays). Resolves { restored: boolean }.
async function lateRetype(env, draft, handBack) {
  try {
    for (let t = 0; t < LATE_WAIT_MS; t += LATE_POLL_MS) {
      await env.sleep(LATE_POLL_MS);
      if (!idleBox(await readScreen(env))) continue;
      const done = await env.exclusive(async () => {
        const now = await readScreen(env);
        if (!idleBox(now)) return false;
        const empty = boxEmpty(now, env.termRows());
        env.log('[host] drop: the dialog was answered late; the draft is typed back (' + draft.length + ' characters)' + (empty ? '' : ' after what the box held by then'));
        await typeOut(env, empty ? draft : ' ' + draft);
        return true;
      });
      if (done) return { restored: true };
    }
    handBack('the Add-directory dialog was still open after ' + Math.round(LATE_WAIT_MS / 60000) + ' minutes');
  } catch (err) {
    handBack('typing it back failed: ' + (err && err.message));
  }
  return { restored: false };
}

/**
 * One drop, start to end. Grants run one at a time, each with its own read-back; the next waits for the previous one's dialog to be
 * answered. `onGranted(dir)` runs only after that grant's Enter went out, `onFailed(dir, reason)` for every folder that was not
 * requested. The path text is typed last, only at an idle prompt, after the draft the grants cleared (#136 (2)). `onDraftLeft(text, why)`
 * runs when a draft that was cleared could not be typed back (every such exit says so out loud: D1).
 *   env: { lines(), termRows(), write(data), sleep(ms), keyGap, exclusive(fn), log(line) }
 */
async function runDrop({ dirs = [], text = '', env, onGranted = () => {}, onFailed = () => {}, onDraftLeft = () => {} }) {
  // #136 (2): the draft is read in the SAME held stretch as the first grant's clear, so no key the person types can slip in between the
  // read and the clear and be lost. A draft that can't be read back whole stops the drop's grants before anything is cleared.
  let draft = '';
  let draftRead = false;
  // A cleared draft that does not come back is said, with its text (the notice) and in host.log: never just dropped (D1).
  const handBack = (why) => {
    if (!draft) return;
    env.log('[host] drop: the draft was not put back (' + why + '); it read ' + JSON.stringify(draft));
    onDraftLeft(draft, why);
  };
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const r = await env.exclusive(async () => {
      // The draft is read before the FIRST grant that reaches the box: a first grant refused on a dialog never cleared anything, so the
      // next one reads it (D3). Once read, it is not read again (the box holds the grants' own text by then).
      if (!draftRead) {
        const lines = await readScreen(env);
        const before = draftOf(lines, env.termRows());
        if (before.ok) { draft = before.text; draftRead = true; }
        else if (idleBox(lines)) return { ok: false, reason: before.why, keepDraft: true };
      }
      return grantOne(dir, env);
    });
    if (r.keepDraft) {
      for (const d of dirs.slice(i)) { env.log(`[host] grant of ${d} not requested: ${r.reason}`); onFailed(d, r.reason); }
      break;
    }
    if (!r.ok) {
      // A prompt drawn between the draft's read and the grant's first look: nothing was cleared, the draft is still in the box. Forget the
      // read (the next grant, or nothing, reads it again): keeping it would raise a false notice or type it a second time at the end.
      if (r.untouched) { draft = ''; draftRead = false; }
      env.log(`[host] grant of ${dir} not requested: ${r.reason}`); onFailed(dir, r.reason); continue;
    }
    onGranted(dir);
    if (i < dirs.length - 1 || text || draft) {
      // First see the dialog DRAWN, then wait for it to go: right after the Enter the screen can still read as an idle prompt
      // (the dialog's frame is on its way), and the next keys would land in it (Dexter R2-2).
      if (!(await waitDrawn(env))) env.log(`[host] grant: no dialog drawn within ${DIALOG_SEEN_MS} ms of the Enter for ${dir}; carrying on`);
      if (!(await waitIdle(env))) {
        const why = 'the Add-directory dialog was still open, so the rest of the drop was left alone';
        for (const rest of dirs.slice(i + 1)) { env.log(`[host] grant of ${rest} not requested: ${why}`); onFailed(rest, why); }
        env.log('[host] drop text not typed: ' + why);
        // The person is away (that is why it timed out): the draft waits for the dialog to be answered and is typed back then. Only when that
        // cannot happen does it come back as a notice that stays (PR #246 Dexter R2-2). Not awaited: the next drop must not queue behind it.
        if (draft) return { late: lateRetype(env, draft, handBack) };
        return;
      }
    }
  }
  if (!text && !draft) return;
  await env.exclusive(async () => {
    const now = await readScreen(env);
    if (dirs.length && !idleBox(now)) {
      env.log('[host] drop text not typed: the prompt is not showing');
      handBack('the prompt was not showing when the draft was to be typed back');
      return;
    }
    // An emptied box gets the draft back first; a box still holding something (no grant cleared it, or the person typed into the emptied
    // one) gets a space before what follows (#136 (3)); the draft goes after what is there, never over it, never dropped (D1, Y3).
    const empty = boxEmpty(now, env.termRows());
    const tail = text ? ' ' + text : '';
    const out = draft ? (empty ? draft + tail : ' ' + draft + tail) : (text ? (empty ? '' : ' ') + text : '');
    if (!out) return;
    if (draft) env.log('[host] drop: the draft is typed back (' + draft.length + ' characters)' + (empty ? '' : ' after what the box held by then') + (text ? ' with the path after it' : ''));
    await typeOut(env, out);
  });
}

/**
 * The person's own `input` frames and a grant must not interleave (Dexter 5). `exclusive(fn)` runs fn with input held; what was held
 * is written, in order, once fn ends. Anything else a window sends still goes straight through `input`.
 */
function createInputGate({ write }) {
  let busy = 0;
  let held = [];
  return {
    input(data) { if (busy) held.push(data); else write(data); },
    async exclusive(fn) {
      busy += 1;
      try { return await fn(); } finally {
        busy -= 1;
        if (!busy) { const out = held; held = []; for (const d of out) write(d); }
      }
    },
    heldCount: () => held.length,
  };
}

module.exports = {
  runDrop, grantOne, clearBox, waitIdle, idleBox, boxEmpty, draftOf, joinRows, createInputGate, scrollCapRows, LATE_WAIT_MS,
  CTRL_E, CTRL_U, MAX_CLEAR_PASSES, KEY_GAP_MS, DIALOG_WAIT_MS,
};
