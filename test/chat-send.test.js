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
    box: opts.box || '', dialog: !!opts.dialog, submitted: [], keys: [], confirmedDialog: 0, sleeps: 0, reads: 0,
    cancelled: 0, locked: [], turn: opts.turn || 'idle', blocked: false, pastes: 0, pasteTexts: {},
    holds: !!opts.holds, readSinceSleep: false, unsafeWrites: [], heldDraftKeys: [], typedText: false, vimInsert: !!opts.vimInsert,
  };
  // The cursor's line in the box (0-based). MEASURED (verify/probe-chat-send-real.js --measure-clear, Claude Code v2.1.318): the cursor
  // stays at the end of what was typed (the last line) unless the person moved it; Ctrl+E goes to the end of the cursor's line only.
  cli.cursor = Number.isInteger(opts.cursorLine) ? opts.cursorLine : cli.box.split('\n').length - 1;
  const isClearKey = (d) => d === '\x05' || d === '\x15';
  const press = (data) => {
    cli.keys.push(data);
    // The send's write invariant (#174): a byte reaches the pty only when the screen was read since the last wait AND showed the input box,
    // with no dialog, no prompt turn and no blocked report. The fake changes state only inside a wait (or at a read hook, before the read),
    // so a write after a read sees what that read saw.
    if (!cli.readSinceSleep || cli.dialog || cli.turn === 'prompt' || cli.blocked) {
      cli.unsafeWrites.push({ data, read: cli.readSinceSleep, dialog: cli.dialog, turn: cli.turn, blocked: cli.blocked });
    }
    // A hold (an agent writing in the folder) is not a key-safety state: it is the occupancy question's, about the person's FIRST keystroke.
    // So it binds only the draft's clear, which runs before that keystroke and would throw the person's draft away without the question.
    if (cli.holds && !cli.typedText && isClearKey(data)) cli.heldDraftKeys.push(data);
    if (!isClearKey(data) && data !== '\r') cli.typedText = true;
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
    if (data === '\x15') {
      if (cli.dialog || opts.stuckBox) return;   // stuckBox: a draft Ctrl+U doesn't reach (a placeholder that stays, an editor mode)
      // MEASURED: Ctrl+U empties the cursor's line; on an already empty line it deletes the line break before it, the cursor going to the end
      // of the line above. On line 1, empty, it does nothing: a cursor moved up to line 1 empties line 1 and then makes no progress.
      const rows = cli.box.split('\n');
      const cur = Math.min(cli.cursor, rows.length - 1);
      if (rows[cur] !== '') rows[cur] = '';
      else if (cur > 0) { rows.splice(cur, 1); cli.cursor = cur - 1; }
      cli.box = rows.join('\n');
      return;
    }
    if (cli.dialog) return;                      // keys typed into a dialog are not text
    if (opts.vim && !cli.vimInsert) return;      // vim NORMAL: keys are motions, not text
    if (opts.dropText) return;
    cli.cursor = Infinity;                       // typing leaves the cursor at the end
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
    holds: () => cli.holds,
    lines: () => {
      cli.reads++;
      if (opts.atRead && typeof opts.atRead[cli.reads] === 'function') opts.atRead[cli.reads](cli);
      cli.readSinceSleep = true;
      if (cli.dialog) return ['Claude wants to run: rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
      // A line wider than `wrap` columns wraps onto more rows, as the real box does.
      const wrap = (s) => { if (!opts.wrap || s.length <= opts.wrap) return [s]; const out = []; for (let i = 0; i < s.length; i += opts.wrap) out.push(s.slice(i, i + opts.wrap)); return out; };
      const rows = cli.box.split('\n').flatMap(wrap);
      const footer = opts.vim && cli.vimInsert ? '-- INSERT --' : ' ? for shortcuts';
      return ['some conversation', RULE, '❯ ' + rows[0], ...rows.slice(1).map(r => '  ' + r), RULE, footer];
    },
    sync: async () => {},
    termRows: () => 40,
    vim: () => !!opts.vim,
    connected: () => opts.connected !== false,
    busy: () => !!opts.busy,
    lock: (on) => cli.locked.push(on),
    bracketed: () => true,
    type: (frame) => { if (opts.hold) return 'held'; press(JSON.parse(frame).data); return 'sent'; },
    cancelHold: () => { cli.cancelled++; },
    send: (frame) => press(JSON.parse(frame).data),
    sleep: async () => {
      cli.sleeps++;
      cli.readSinceSleep = false;
      if (opts.dialogAtSleep === cli.sleeps) cli.dialog = true;
      if (opts.promptAtSleep === cli.sleeps) cli.turn = 'prompt';
      if (opts.blockedAtSleep === cli.sleeps) cli.blocked = true;
      if (opts.holdsAtSleep === cli.sleeps) cli.holds = true;
    },
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

test('a placeholder already in the box is a draft, not ours: it is cleared first, and only our paste is submitted (#174)', async () => {
  const cli = makeCli({ box: '[Pasted text #1 +5 lines]' });
  cli.pastes = 1;
  cli.pasteTexts[1] = 'the old pasted draft';
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, [EIGHT_LINES], 'the old placeholder went with the clear, not with the Enter');
  assert.deepStrictEqual(cli.unsafeWrites, []);
});

test('a placeholder that Ctrl+U does not clear is not ours either: nothing is typed, the note says the draft could not be cleared (#174)', async () => {
  const cli = makeCli({ box: '[Pasted text #1 +5 lines]', stuckBox: true });
  const r = await state.runChatSend(EIGHT_LINES, cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /couldn't be cleared/);
  assert.ok(cli.keys.every(k => k === '\x05' || k === '\x15'), 'only the clearing keys went, never text or Enter');
  assert.strictEqual(cli.box, '[Pasted text #1 +5 lines]');
  // PR #233 F2: the first pass that changes nothing ends the clear (not 40 keys and ~5 s); F4: nothing was lost, so the note says only that
  assert.deepStrictEqual(cli.keys, ['\x05', '\x15'], 'one pass, no progress, stop');
  assert.doesNotMatch(r.note, /part/);
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

// --- #174: a draft in the CLI box no longer blocks the chat's send; the send empties it with the CLI's own keys, proves it empty, then sends.

test('a draft in the terminal box and a ready prompt: the draft is cleared, the chat text typed and sent alone (#174)', async () => {
  const cli = makeCli({ box: 'fix the' });
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello'], 'the transcript gets the chat text alone');
  const firstText = cli.keys.findIndex(k => k !== '\x05' && k !== '\x15');
  assert.ok(firstText > 0, 'the clearing keys went first');
  assert.ok(cli.keys.slice(0, firstText).includes('\x15'), 'Ctrl+U is among them');
  assert.deepStrictEqual(cli.unsafeWrites, []);
  assert.deepStrictEqual(cli.locked, [true, false]);
});

test('a multi-line draft Ctrl+U empties a line at a time: it is cleared in full, then the chat text is sent alone (#174)', async () => {
  const cli = makeCli({ box: 'first line of a draft\nsecond line\nthird' });
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello']);
  assert.deepStrictEqual(cli.unsafeWrites, []);
});

test('a multi-line draft with the cursor moved up to line 1: line 1 empties, the next pass changes nothing, the clear stops; the note says part is gone, once (PR #233 F2, F4)', async () => {
  // MEASURED (probe-chat-send-real.js --measure-clear, cursor-first-3): Ctrl+U empties line 1 and then does nothing; Ctrl+End, Meta+> and
  // End do not reach the end of the whole input, so nothing can make every pass progress from there.
  const cli = makeCli({ box: 'first line\nsecond line\nthird', cursorLine: 0 });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.note, state.SEND_NOTES.draftPartly, 'one sentence, no "couldn\'t be cleared ... may have been partly cleared" pair');
  assert.match(r.note, /Your message is still here/);
  assert.deepStrictEqual(cli.keys, ['\x05', '\x15', '\x05', '\x15'], 'a pass that empties line 1, then a pass with no progress: stop');
  assert.strictEqual(cli.box, '\nsecond line\nthird', 'what is left of the draft stays');
  assert.deepStrictEqual(cli.submitted, []);
});

test('a long draft (12 lines, more than the old 40-key bound could empty) is cleared in full and the chat text sent alone (PR #233 F2)', async () => {
  // MEASURED (cursor-last-12-U-only): two Ctrl+U per line but the first, 23 for 12 lines; the bound now grows with the rows read.
  const cli = makeCli({ box: Array.from({ length: 12 }, (_, k) => `L${k + 1}draft`).join('\n') });
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello']);
  assert.strictEqual(cli.keys.filter(k => k === '\x15').length, 23, 'more than the old bound of 20 Ctrl+U');
});

test('a draft over more rows than the box can show (at the scroll cap, a head may be hidden) still gets the long bound (PR #233 F2)', async () => {
  // termRows 40 -> the box shows at most 15 rows; a 30-line draft keeps 15 rows on screen while its head shrinks
  const lines30 = Array.from({ length: 30 }, (_, k) => `L${k + 1}`);
  const cli = makeCli({ box: lines30.join('\n') });
  const show = cli.env.lines;
  cli.env.lines = () => { const l = show(); const top = l.indexOf(RULE), bottom = l.lastIndexOf(RULE); const box = l.slice(top + 1, bottom);
    return box.length > 15 ? [...l.slice(0, top + 1), '❯ ' + box[box.length - 15].replace(/^\s+/, ''), ...box.slice(-14), ...l.slice(bottom)] : l; };
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello']);
});

test('F1: vim NORMAL with a draft over two rows (or one long line wrapped) is refused as before, with no key at all (PR #233 F1)', async () => {
  for (const o of [{ box: 'fix the\nsecond line' }, { box: 'w'.repeat(300), wrap: 40 }]) {
    const cli = makeCli({ ...o, vim: true });                 // vim seen this session, no -- INSERT -- under the box: NORMAL
    const r = await state.runChatSend('hello', cli.env);
    assert.strictEqual(r.ok, false, JSON.stringify(o));
    assert.match(r.note, /isn't at its prompt/);
    assert.deepStrictEqual(cli.keys, [], JSON.stringify(o));
    assert.strictEqual(cli.box, o.box);
  }
});

test('F1: vim INSERT with a two-row draft is the box: cleared, typed, sent alone', async () => {
  const cli = makeCli({ box: 'fix the\nsecond line', vim: true, vimInsert: true });
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello']);
});

test('F3: a draft gone by the clear\'s first read sends no key, and a later failure does not say the draft was cleared', async () => {
  // read 1 is sendBlocker's (the draft shows); before read 2 the box empties (the person submitted it, a suggestion replaced it)
  const cli = makeCli({ box: 'fix the', dropText: true, atRead: { 2: (c) => { c.box = ''; } } });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't show your message as typed/);
  assert.doesNotMatch(r.note, /draft was cleared/);
  assert.strictEqual(cli.keys[0], 'hello', 'no clearing key before the text');
});

test('F4: a clear stopped before its first key adds no "partly cleared" to the note', async () => {
  // read 1 (sendBlocker) shows the draft; a dialog is up by read 2 (the clear's first): refused, nothing touched, nothing claimed
  const cli = makeCli({ box: 'a\nb', atRead: { 2: (c) => { c.dialog = true; } } });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.note, state.SEND_NOTES.dialog);
  assert.deepStrictEqual(cli.keys, []);
});

test('F7: a draft that starts with a Shift+Enter (an empty first row, text under it) is not an empty box: it is cleared before the text goes', async () => {
  const cli = makeCli({ box: '\nfoo' });
  const r = await state.runChatSend('hello', cli.env);
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cli.submitted, ['hello'], 'the draft\'s "foo" did not go with it');
});

test('a draft in the box while a dialog is open is still a dialog: nothing is cleared, nothing sent (#174)', async () => {
  for (const o of [{ dialog: true }, { turn: 'prompt' }]) {
    const cli = makeCli({ box: 'fix the', ...o });
    const r = await state.runChatSend('hello', cli.env);
    assert.strictEqual(r.ok, false, JSON.stringify(o));
    assert.match(r.note, /needs you in the terminal/);
    assert.deepStrictEqual(cli.keys, [], JSON.stringify(o));
  }
  const cli = makeCli({ box: 'fix the' });
  cli.blocked = true;
  const r = await state.runChatSend('hello', cli.env);
  assert.match(r.note, /needs you in the terminal/);
  assert.deepStrictEqual(cli.keys, []);
  assert.strictEqual(cli.box, 'fix the');
});

test('every other refusal still wins over a draft: holds, offline, busy, a leading ! or a trailing backslash leave the draft untouched (#174)', async () => {
  const cases = [
    [{ holds: true }, 'hi', /agent is writing/],
    [{ connected: false }, 'hi', /Not connected/],
    [{ busy: true }, 'hi', /still being typed/],
    [{}, '! rm x', /shell command/],
    [{}, 'C:\\temp\\', /backslash/],
  ];
  for (const [o, text, note] of cases) {
    for (const box of ['fix the', 'two\nlines']) {
      const cli = makeCli({ box, ...o });
      const r = await state.runChatSend(text, cli.env);
      assert.strictEqual(r.ok, false, `${JSON.stringify(o)} ${text}`);
      assert.match(r.note, note, `${JSON.stringify(o)} ${text}`);
      assert.deepStrictEqual(cli.keys, [], `${JSON.stringify(o)} ${text} ${JSON.stringify(box)}`);
      assert.strictEqual(cli.box, box);
    }
  }
});

test('a vim NORMAL box with a draft is not ready: refused as before, nothing cleared (#174)', async () => {
  const cli = makeCli({ box: 'fix the' });
  cli.env.vim = () => true;                                    // vim seen, no -- INSERT -- under the box: NORMAL
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /isn't at its prompt/);
  assert.deepStrictEqual(cli.keys, []);
});

test('a dialog that opens while the draft is being cleared: the clear stops before its next key, nothing is typed (#174)', async () => {
  for (const at of [1, 2, 3]) {
    const cli = makeCli({ box: 'a\nb\nc\nd', dialogAtSleep: at });
    const r = await state.runChatSend('hello', cli.env);
    assert.strictEqual(r.ok, false, `dialog at sleep ${at}`);
    assert.match(r.note, /needs you in the terminal/);
    // sleeps 1 and 2: the key just sent was never seen land, so "may"; sleep 3: a read had shown a line gone, so "was"
    assert.match(r.note, at < 3 ? /The terminal's draft may have been partly cleared\.$/ : /The terminal's draft was partly cleared\.$/, `${at}: ${r.note}`);
    assert.deepStrictEqual(cli.unsafeWrites, [], `dialog at sleep ${at}`);
    assert.strictEqual(cli.confirmedDialog, 0);
    assert.ok(cli.keys.every(k => k === '\x05' || k === '\x15'));
  }
});

test('an agent that starts holding the folder mid-clear stops the clear before its next key (#174)', async () => {
  const cli = makeCli({ box: 'a\nb\nc\nd', holdsAtSleep: 1 });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /agent is writing/);
  assert.deepStrictEqual(cli.unsafeWrites, []);
  assert.ok(cli.keys.every(k => k === '\x05' || k === '\x15'));
});

test('the draft is cleared, then a dialog opens mid-send: no Enter, and the note says the terminal\'s draft was cleared (#174)', async () => {
  // 'fix the' clears in: Ctrl+E, wait 1, Ctrl+U, wait 2, read: empty. Then the text is typed; wait 3 is the first read-back wait, wait 4 the
  // look before the Enter (wait 5 already follows the Enter).
  for (const at of [3, 4]) {
    const cli = makeCli({ box: 'fix the', dialogAtSleep: at });
    const r = await state.runChatSend('hello', cli.env);
    assert.strictEqual(r.ok, false, `dialog at sleep ${at}`);
    assert.strictEqual(cli.keys.includes('\r'), false);
    assert.strictEqual(cli.confirmedDialog, 0);
    assert.match(r.note, /The terminal's draft was cleared\./, `dialog at sleep ${at}: ${r.note}`);
    assert.deepStrictEqual(cli.unsafeWrites, []);
  }
});

test('the draft is cleared, then the text never reads back: no Enter, and the note says the draft was cleared (#174)', async () => {
  const cli = makeCli({ box: 'fix the', dropText: true });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't show your message as typed/);
  assert.match(r.note, /The terminal's draft was cleared\./);
  assert.strictEqual(cli.keys.includes('\r'), false);
});

test('an empty box gets no clearing keys and no draft note: the send is as it was (#174)', async () => {
  const cli = makeCli({ dropText: true });
  const r = await state.runChatSend('hello', cli.env);
  assert.doesNotMatch(r.note, /draft/);
  assert.strictEqual(cli.keys[0], 'hello', 'the first key is the text');
});

test('F5: a dialog or a prompt turn at the look before the Enter: no key goes, and the note says the text is still typed in the terminal\'s box', async () => {
  // 'ship it' into an empty box: sleep 1 is the read-back wait, sleep 2 the look before the Enter
  for (const o of [{ promptAtSleep: 2 }, { dialogAtSleep: 2 }]) {
    const cli = makeCli(o);
    const r = await state.runChatSend('ship it', cli.env);
    assert.strictEqual(r.ok, false, JSON.stringify(o));
    assert.match(r.note, /Your text is still typed in the terminal's box\./, JSON.stringify(o));
    assert.deepStrictEqual(cli.keys, ['ship it'], 'nothing after the text: no clearing key into a dialog, no Enter');
    assert.strictEqual(cli.box, 'ship it', 'what the box holds afterwards');
  }
});

test('F5: a hold that starts during the send does not stop the after-failure clear: the box is emptied, as before the PR', async () => {
  // The clearing keys go through send(), not the occupancy confirm, so the question never holds them. Our text is left in the box (the
  // Enter swallowed) and the hold appears at sleep 3, the first wait after the Enter: the clear empties the box anyway.
  const sw = makeCli({ swallowEnter: true, holdsAtSleep: 3 });
  const r2 = await state.runChatSend('ship it', sw.env);
  assert.match(r2.note, /didn't take the Enter/);
  assert.strictEqual(sw.box, '', 'emptied');
  assert.doesNotMatch(r2.note, /still typed/);
});

test('F6: a real draft starting `Try "` reads as the empty hint; when the read-back then fails, the note says the terminal\'s draft was cleared', async () => {
  const cli = makeCli({ box: 'Try "x" first' });
  const r = await state.runChatSend('hello', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /didn't show your message as typed/);
  assert.match(r.note, /The terminal's draft was cleared\./, r.note);
  assert.strictEqual(cli.box, '', 'the after-failure clear emptied both');
  // the CLI's own hint with nothing typed under it (the read-back fails for another reason) says nothing about a draft
  const hint = makeCli({ box: 'Try "edit <filepath> to..."', dropText: true });
  const r2 = await state.runChatSend('hello', hint.env);
  assert.doesNotMatch(r2.note, /draft/);
});

test('F7: when the after-failure clear stops, what the box still holds is said: our text, left typed', async () => {
  // swallowed Enter, then a prompt turn before the after-failure clear's first read
  const cli = makeCli({ swallowEnter: true, promptAtSleep: 3 });
  const r = await state.runChatSend('ship it', cli.env);
  assert.strictEqual(r.ok, false);
  assert.match(r.note, /Your text is still typed in the terminal's box\./);
  assert.strictEqual(cli.box, 'ship it');
  assert.strictEqual(cli.keys.filter(k => k === '\x15').length, 0);
});

test('property (F8): a hold binds the draft\'s clear only: no clearing key goes before our text while an agent holds the folder', async () => {
  const draft = fc.constantFrom('fix the', 'a\nb', 'one\ntwo\nthree\nfour');
  await fc.assert(fc.asyncProperty(draft, fc.integer({ min: 1, max: 10 }), async (box, at) => {
    const cli = makeCli({ box, holdsAtSleep: at });
    await state.runChatSend('hello', cli.env);
    assert.deepStrictEqual(cli.heldDraftKeys, [], `box ${JSON.stringify(box)}, hold at sleep ${at}`);
    assert.deepStrictEqual(cli.unsafeWrites, []);
  }), { numRuns: 100 });
});

test('property: no byte reaches the pty unless the last screen read showed the box, with no dialog, prompt turn or blocked report (#174)', async () => {
  // A hold is generated too, but it is not part of THIS write invariant: it is the occupancy question's, about the first keystroke, and only
  // the draft's clear is bound by it (the property above). The chunks, the Enter and the after-failure clear go on through a hold, as before.
  const draft = fc.constantFrom('', 'fix the', 'a\nb', 'one\ntwo\nthree\nfour', '[Pasted text #1 +5 lines]', '\nfoo', 'Try "x" first');
  const text = fc.constantFrom('hello', 'y'.repeat(450), EIGHT_LINES);
  const event = fc.record({ kind: fc.constantFrom('dialogAtSleep', 'promptAtSleep', 'blockedAtSleep', 'holdsAtSleep'), at: fc.integer({ min: 1, max: 24 }) });
  await fc.assert(fc.asyncProperty(draft, text, event, fc.boolean(), fc.integer({ min: 0, max: 3 }), async (box, msg, ev, swallow, cursorLine) => {
    const cli = makeCli({ box, [ev.kind]: ev.at, swallowEnter: swallow, cursorLine: Math.min(cursorLine, box.split('\n').length - 1) });
    const r = await state.runChatSend(msg, cli.env);
    assert.deepStrictEqual(cli.unsafeWrites, [], `box ${JSON.stringify(box)}, ${ev.kind} ${ev.at}`);
    assert.deepStrictEqual(cli.heldDraftKeys, []);
    assert.strictEqual(cli.confirmedDialog, 0);
    // (A swallowed Enter followed by a dialog reads as a send, since the box is gone: the after-Enter check predates #174 and is not this property.)
    if (r.ok && !swallow) assert.deepStrictEqual(cli.submitted, [msg], 'a send that went carries the chat text alone');
    if (!r.ok) assert.strictEqual(typeof r.note, 'string');
  }), { numRuns: 300 });
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

test('sendBlocker: a draft is the LAST check, so the clear can only follow a send every other check let through (#174)', () => {
  const ok = { text: 'hi', turn: 'idle', blocked: false, screen: 'ready', box: 'a draft', holds: false };
  const N = state.SEND_NOTES;
  assert.strictEqual(state.sendBlocker(ok), N.draft);
  assert.strictEqual(state.sendBlocker({ ...ok, screen: 'multiline' }), N.draft);
  for (const screen of ['ready', 'multiline']) {
    assert.strictEqual(state.sendBlocker({ ...ok, screen, turn: 'prompt' }), N.dialog, screen);
    assert.strictEqual(state.sendBlocker({ ...ok, screen, blocked: true }), N.dialog, screen);
    assert.strictEqual(state.sendBlocker({ ...ok, screen, holds: true }), N.holds, screen);
    assert.strictEqual(state.sendBlocker({ ...ok, screen, text: '! ls' }), N.bang, screen);
    assert.strictEqual(state.sendBlocker({ ...ok, screen, text: 'a\\' }), N.backslash, screen);
  }
  assert.strictEqual(state.sendBlocker({ ...ok, screen: 'vim-normal' }), N.notReady);
  assert.strictEqual(state.sendBlocker({ ...ok, screen: 'dialog' }), N.dialog);
});
