'use strict';
/**
 * The chat's type box (PR #226 Dexter 1, Miguel I2): its Enter must never answer a dialog, and its box clears only when the message went.
 * runChatSend (app/chat-view-state.js) is run against a small model of the CLI's screen: an idle prompt box between two rules, or a
 * permission dialog with no box at all, the real app/top-bar-display.js reading both. The model records every key that reached it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const state = require('../app/chat-view-state');
const { inputState, commandTyped, boxText, boxHoldsLine } = require('../app/top-bar-display');

const RULE = '─'.repeat(40);
const PASTE_THRESHOLD = 200;
const PASTE_LINES = 4;
const EIGHT_LINES = Array.from({ length: 8 }, (_, k) => `line ${k + 1} of the message, about seventy-five characters long, give or take`).join('\n');

function makeCli(opts = {}) {
  const cli = {
    box: opts.box || '', dialog: !!opts.dialog, submitted: [], keys: [], confirmedDialog: 0, sleeps: 0,
    cancelled: 0, locked: [], turn: opts.turn || 'idle', blocked: false, pastes: 0, pasteTexts: {},
  };
  const press = (data) => {
    cli.keys.push(data);
    if (data === '\r') {
      if (cli.dialog) { cli.confirmedDialog++; cli.dialog = false; return; }
      if (opts.swallowEnter) return;
      if (cli.box !== '') {
        cli.submitted.push(cli.box.replace(/\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g, (m, n) => cli.pasteTexts[n] || m));
        cli.box = '';
      }
      return;
    }
    if (data === '\x05') return;
    if (data === '\x15') { if (!cli.dialog) cli.box = ''; return; }
    if (cli.dialog) return;                      // keys typed into a dialog are not text
    if (opts.dropText) return;
    const text = data.replace(/\x1b\[20[01]~/g, '').replace(/\r/g, ' ');
    // The real CLI takes a big write for a paste and shows "[Pasted text #N]" (verify/probe-chat-send-real.js --measure: from about 1,000
    // characters, unpredictably; the fake uses 200, the largest write the app makes elsewhere, to stay conservative).
    // A BRACKETED paste of several lines collapses to "[Pasted text #N +K lines]" (measured: 3 lines stay, 4 and more collapse, as here).
    // Enter then submits the real text, as the CLI does.
    const bracketed = data.startsWith('\x1b[200~');
    const rows = bracketed ? data.replace(/\x1b\[20[01]~/g, '').split('\r').length : 1;
    if (bracketed && rows >= PASTE_LINES) {
      cli.pasteTexts[++cli.pastes] = data.replace(/\x1b\[20[01]~/g, '').replace(/\r/g, '\n');
      cli.box += `[Pasted text #${cli.pastes} +${rows - 1} lines]`;
      return;
    }
    if (Array.from(text).length > PASTE_THRESHOLD) { cli.box += `[Pasted text #${++cli.pastes}]`; return; }
    cli.box += text;
  };
  cli.env = {
    turn: () => cli.turn,
    blocked: () => cli.blocked,
    holds: () => !!opts.holds,
    lines: () => (cli.dialog
      ? ['Claude wants to run: rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']
      : ['some conversation', RULE, '❯ ' + cli.box, RULE, ' ? for shortcuts']),
    sync: async () => {},
    termRows: () => 40,
    vim: () => false,
    connected: () => opts.connected !== false,
    busy: () => !!opts.busy,
    lock: (on) => cli.locked.push(on),
    bracketed: () => true,
    type: (frame) => { if (opts.hold) return 'held'; press(JSON.parse(frame).data); return 'sent'; },
    cancelHold: () => { cli.cancelled++; },
    send: (frame) => press(JSON.parse(frame).data),
    sleep: async () => { cli.sleeps++; if (opts.dialogAtSleep === cli.sleeps) cli.dialog = true; },
    keyGap: 120,
    inputState, commandTyped, boxText, boxHoldsLine,
  };
  return cli;
}

test('an idle prompt: the text is typed, read back, and Enter submits it', async () => {
  const cli = makeCli();
  const r = await state.runChatSend('hello there', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello there']);
  assert.strictEqual(cli.confirmedDialog, 0);
  assert.deepStrictEqual(cli.locked, [true, false], 'the typing lock is taken and always given back');
});

test('a long message is typed in chunks the CLI does not take for a paste: it reads back and is submitted whole (PR #226 Dexter R2-1)', async () => {
  for (const n of [201, 400, 2000]) {
    const text = 'x'.repeat(n);
    const cli = makeCli();
    const r = await state.runChatSend(text, cli.env);
    assert.deepStrictEqual(r, { ok: true }, `${n} characters`);
    assert.deepStrictEqual(cli.submitted, [text], `${n} characters`);
    assert.strictEqual(cli.pastes, 0, 'no write was big enough to be collapsed');
  }
});

test('property: a single-line message of any length over the chunk size is submitted exactly as written', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...'abcdefg é'), { minLength: 201, maxLength: 1200 }).map(a => a.join('').replace(/ +/g, ' ').trim() + 'z').filter(s => s.length > 1), async (text) => {
    const cli = makeCli();
    const r = await state.runChatSend(text, cli.env);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(cli.submitted, [text]);
  }), { numRuns: 40 });
});

test('a multi-line message the CLI collapses to [Pasted text #N +K lines] is a valid read-back: it is submitted whole (PR #226, measured on the real CLI)', async () => {
  const cli = makeCli();
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(cli.pastes, 1, 'it did go as one collapsed paste');
  assert.deepStrictEqual(cli.submitted, [EIGHT_LINES.replace(/\n/g, '\n')]);
  assert.strictEqual(cli.confirmedDialog, 0);
});

test('property: wherever a dialog opens while a collapsed paste is being sent, no Enter reaches it', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 14 }), async (at) => {
    const cli = makeCli({ dialogAtSleep: at });
    await state.runChatSend(EIGHT_LINES, cli.env);
    assert.strictEqual(cli.confirmedDialog, 0, `a dialog opened at sleep ${at} took an Enter`);
  }), { numRuns: 40 });
});

test('a collapsed paste whose Enter the CLI swallowed is not a send: the placeholder still in the box counts as unsent, and is cleared', async () => {
  const cli = makeCli({ swallowEnter: true });
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't take the Enter/);
  assert.strictEqual(cli.box, '');
});

test('a placeholder already in the box is a draft, not ours: refused before a key', async () => {
  const cli = makeCli({ box: '[Pasted text #1 +5 lines]' });
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /already holds text/);
  assert.deepStrictEqual(cli.keys, []);
});

test('a placeholder is a read-back only for a bracketed paste: a plain-joined multi-line message that shows one is refused', async () => {
  const cli = makeCli({ dropText: true });
  cli.env.bracketed = () => false;
  cli.env.lines = () => ['x', RULE, '❯ [Pasted text #1 +7 lines]', RULE, ' ? for shortcuts'];
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(cli.keys.includes('\r'), false);
});

test('a dialog that opens between two chunks of a long message gets none of the remaining text and no Enter', async () => {
  const cli = makeCli({ dialogAtSleep: 1 });
  const r = await state.runChatSend('y'.repeat(600), cli.env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(cli.keys.length, 1, 'only the first chunk went; the dialog saw nothing');
  assert.strictEqual(cli.confirmedDialog, 0);
});

test('a dialog is on screen although the hooks say idle: nothing at all is sent, no Enter', async () => {
  const cli = makeCli({ dialog: true, turn: 'idle' });
  const r = await state.runChatSend('thanks', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /needs you in the terminal/);
  assert.deepStrictEqual(cli.keys, []);
  assert.strictEqual(cli.confirmedDialog, 0);
});

test('the host says a dialog is open, or the CLI says it is blocked: nothing is sent', async () => {
  for (const mutate of [(c) => { c.turn = 'prompt'; }, (c) => { c.blocked = true; }]) {
    const cli = makeCli();
    mutate(cli);
    const r = await state.runChatSend('thanks', cli.env);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(cli.keys, []);
  }
});

test('property: wherever in the send a permission dialog opens, no Enter ever reaches it', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 14 }), async (at) => {
    const cli = makeCli({ dialogAtSleep: at });
    const r = await state.runChatSend('also run the tests', cli.env);
    assert.strictEqual(cli.confirmedDialog, 0, `a dialog opened at sleep ${at} took an Enter`);
    if (!r.ok) assert.strictEqual(typeof r.note, 'string');
  }), { numRuns: 60 });
});

test('a dialog that opens between the read-back and the Enter (the 400 ms look) stops the Enter and keeps the text with the caller', async () => {
  // sleeps: 1 = the first read-back wait; 2 = the recheck wait
  const cli = makeCli({ dialogAtSleep: 2 });
  const r = await state.runChatSend('ship it', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /screen changed|didn't show/);
  assert.strictEqual(cli.keys.includes('\r'), false);
});

test('the terminal box already holds a draft: refused, nothing typed, the draft untouched', async () => {
  const cli = makeCli({ box: 'fix the' });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /already holds text/);
  assert.deepStrictEqual(cli.keys, []);
  assert.strictEqual(cli.box, 'fix the');
});

test('a leading ! and a trailing backslash are refused: they would run a shell command / make a new line', async () => {
  for (const text of ['! rm x', 'the folder is C:\\temp\\']) {
    const cli = makeCli();
    const r = await state.runChatSend(text, cli.env);
    assert.strictEqual(r.ok, false, text);
    assert.deepStrictEqual(cli.keys, [], text);
  }
});

test('the typed text never read back (the CLI dropped it): no Enter, and the box is left empty', async () => {
  const cli = makeCli({ dropText: true });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't show your message as typed/);
  assert.strictEqual(cli.keys.includes('\r'), false);
});

test('an Enter the CLI swallowed is not a send: the line is cleared and the text stays with the caller', async () => {
  const cli = makeCli({ swallowEnter: true });
  const r = await state.runChatSend('look at @README', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't take the Enter/);
  assert.strictEqual(cli.box, '', 'what was typed is cleared, not left half-sent');
});

test('the occupancy question holds the text: the hold is cancelled and the send reports it was not sent', async () => {
  const cli = makeCli({ hold: true });
  const r = await state.runChatSend('ship it', cli.env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(cli.cancelled, 1);
  assert.deepStrictEqual(cli.keys, []);
});

test('an agent writing here is refused before a key; an offline socket and a busy tab too', async () => {
  for (const o of [{ holds: true }, { connected: false }, { busy: true }]) {
    const cli = makeCli(o);
    const r = await state.runChatSend('hi', cli.env);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(cli.keys, []);
  }
});

test('sendBlocker: the placeholder is an empty box; vim NORMAL, multi-line drafts and unknown screens are not ready', () => {
  const ok = { text: 'hi', turn: 'idle', blocked: false, screen: 'ready', box: 'Try "edit <filepath> to..."', holds: false };
  assert.strictEqual(state.sendBlocker(ok), null);
  for (const screen of ['multiline', 'vim-normal', 'dialog', 'unknown']) assert.notStrictEqual(state.sendBlocker({ ...ok, screen }), null, screen);
});
