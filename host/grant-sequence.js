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
  if (!idleBox((await readScreen(env)))) return { ok: false, reason: 'the prompt is not showing (a dialog, a menu or a permission prompt has the keyboard)' };
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

/**
 * One drop, start to end. Grants run one at a time, each with its own read-back; the next waits for the previous one's dialog to be
 * answered. `onGranted(dir)` runs only after that grant's Enter went out, `onFailed(dir, reason)` for every folder that was not
 * requested. The path text is typed last, only at an idle prompt.
 *   env: { lines(), termRows(), write(data), sleep(ms), keyGap, exclusive(fn), log(line) }
 */
async function runDrop({ dirs = [], text = '', env, onGranted = () => {}, onFailed = () => {} }) {
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const r = await env.exclusive(() => grantOne(dir, env));
    if (!r.ok) { env.log(`[host] grant of ${dir} not requested: ${r.reason}`); onFailed(dir, r.reason); continue; }
    onGranted(dir);
    if (i < dirs.length - 1 || text) {
      // First see the dialog DRAWN, then wait for it to go: right after the Enter the screen can still read as an idle prompt
      // (the dialog's frame is on its way), and the next keys would land in it (Dexter R2-2).
      if (!(await waitDrawn(env))) env.log(`[host] grant: no dialog drawn within ${DIALOG_SEEN_MS} ms of the Enter for ${dir}; carrying on`);
      if (!(await waitIdle(env))) {
        const why = 'the Add-directory dialog was still open, so the rest of the drop was left alone';
        for (const rest of dirs.slice(i + 1)) { env.log(`[host] grant of ${rest} not requested: ${why}`); onFailed(rest, why); }
        env.log('[host] drop text not typed: ' + why);
        return;
      }
    }
  }
  if (!text) return;
  if (dirs.length && !idleBox((await readScreen(env)))) { env.log('[host] drop text not typed: the prompt is not showing'); return; }
  await env.exclusive(async () => { env.write(text); });
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
  runDrop, grantOne, clearBox, waitIdle, idleBox, boxEmpty, createInputGate, scrollCapRows,
  CTRL_E, CTRL_U, MAX_CLEAR_PASSES, KEY_GAP_MS, DIALOG_WAIT_MS,
};
