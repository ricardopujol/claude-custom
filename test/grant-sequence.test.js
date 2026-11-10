'use strict';
/**
 * BACKLOG #136, PR #223 (Dexter 1-7, Miguel I1-I3, S2). A drop that needs a grant types `/add-dir <dir>` and presses Enter. The Enter
 * may only ever go out when the live screen reads back as exactly that line at an idle prompt; otherwise nothing is submitted or
 * confirmed. These drive host/grant-sequence.js against a fake CLI box whose Ctrl-U is deliberately pessimistic (one row at a time,
 * a hard newline needs an extra press, and a mode where Ctrl-U at column 0 does nothing), so the guarantee is the read-back, not a count.
 */
const test = require('node:test');
const assert = require('node:assert');
const { runDrop, createInputGate, idleBox, boxEmpty, MAX_CLEAR_PASSES, CTRL_E, CTRL_U } = require('../host/grant-sequence');

const RULE = '─'.repeat(60);

// rows: [{ t: text, hard: starts after a real newline }]; the visible box keeps the END, capped like the CLI (termRows/2 - 5).
function fakeCli({ rows = 24, draft = [''], dialog = null, ctrlUAtCol0 = 'crosses', dialogDelay = 0, permissionAtRead = 0 } = {}) {
  const cli = {
    rows, draft: draft.map(t => (typeof t === 'string' ? { t } : t)), dialog, writes: [], submitted: [], dialogOpened: false, pending: null, whileDialog: [], permLeft: null,
    lines() {
      // a dialog whose frame arrives `dialogDelay` reads after the Enter; a permission prompt the CLI draws on its own `permissionAtRead` reads after the command is typed
      if (cli.pending && cli.pending.reads-- <= 0) { cli.dialog = cli.pending.dialog; cli.pending = null; }
      if (cli.permLeft !== null && --cli.permLeft <= 0) { cli.dialog = ['Do you want to proceed?', '  ❯ 1. Yes', '    2. No']; cli.permLeft = null; }
      if (cli.dialog) return ['● some output', RULE, ...cli.dialog, RULE, '  footer'];
      const cap = Math.max(1, Math.floor(rows / 2) - 5);
      const shown = cli.draft.slice(-cap).map(r => r.t);
      const box = shown.map((t, i) => (i === 0 ? '❯ ' : '  ') + t);
      if (cli.draft.length === 1 && cli.draft[0].t === '') box[0] = '❯ Try "edit <filepath> to..."';
      return ['● earlier output', RULE, ...box, RULE, '  footer'];
    },
    write(d) {
      cli.writes.push(d);
      if (cli.pending || cli.dialog) cli.whileDialog.push(d);
      if (cli.dialog) return;
      if (permissionAtRead && d.startsWith('/add-dir')) cli.permLeft = permissionAtRead;
      const last = cli.draft[cli.draft.length - 1];
      if (d === CTRL_E) return;
      if (d === '\x1b\r') { cli.draft.push({ t: '', hard: true }); return; }          // Shift+Enter: a real line break, nothing submitted
      if (d === CTRL_U) {
        if (last.t) last.t = '';
        else if (cli.draft.length > 1 && ctrlUAtCol0 === 'crosses') cli.draft.pop();
        return;
      }
      if (d === '\r') {
        const text = cli.draft.map(r => r.t).join('\n');
        cli.submitted.push(text);
        if (/^\/add-dir /.test(text)) {
          const dlg = ['Add directory to workspace', text.slice(9), '  ❯ 1. Yes, for this session', '  Enter to confirm · Esc to cancel'];
          if (dialogDelay > 0) cli.pending = { dialog: dlg, reads: dialogDelay }; else cli.dialog = dlg;
          cli.dialogOpened = true;
        }
        cli.draft = [{ t: '' }];
        return;
      }
      last.t += d;
    },
  };
  return cli;
}

function envFor(cli, extra = {}) {
  return {
    lines: () => cli.lines(), sync: async () => {}, termRows: () => cli.rows, write: d => cli.write(d), sleep: async () => {}, keyGap: 0,
    exclusive: fn => fn(), log: () => {}, ...extra,
  };
}

const grant = (cli, dir = 'C:\\outside\\docs', over = {}) => {
  const granted = []; const failed = [];
  return runDrop({ dirs: [dir], text: '', env: envFor(cli), onGranted: d => granted.push(d), onFailed: (d, w) => failed.push([d, w]), ...over })
    .then(() => ({ granted, failed }));
};
const noDraftSubmitted = (cli) => assert.deepStrictEqual(cli.submitted.filter(s => !/^\/add-dir /.test(s)), [], 'no draft reached the model');

test('the measured case: a soft-wrapped draft is cleared and only the /add-dir line is submitted', async () => {
  const cli = fakeCli({ draft: Array.from({ length: 6 }, (_, i) => `row ${i} words words`) });
  const r = await grant(cli);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
  assert.deepStrictEqual(r.granted, ['C:\\outside\\docs']);
});

test('Dexter 1: a Shift+Enter two-line draft (hello / world) is fully cleared, not "hello/add-dir D"', async () => {
  const cli = fakeCli({ draft: [{ t: 'hello' }, { t: 'world', hard: true }] });
  await grant(cli);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
  noDraftSubmitted(cli);
});

// Since #136 (2) (Ricardo 2026-11-06: the grant keeps the draft) a draft whose head the box hides can't be read back, so it is never
// cleared: these two used to pin "cleared by looping"; they now pin "left whole, nothing submitted, the folder reported".
test('Dexter 2 / Miguel I1 / #136 (2): a 15-row draft in a 24-row pane (box capped at 7) is left whole: no clear, nothing submitted', async () => {
  const cli = fakeCli({ rows: 24, draft: Array.from({ length: 15 }, (_, i) => `r${i}`) });
  const r = await grant(cli);
  assert.deepStrictEqual(cli.submitted, []);
  assert.ok(!cli.writes.includes(CTRL_U));
  assert.strictEqual(cli.draft.length, 15);
  assert.deepStrictEqual(r.failed.map(f => f[0]), ['C:\\outside\\docs']);
});

test('Dexter 2b / #136 (2): a 10-row pane (box cap 0 rows -> shows 1) with a 6-row draft is left whole, nothing submitted', async () => {
  const cli = fakeCli({ rows: 10, draft: Array.from({ length: 6 }, (_, i) => `r${i}`) });
  const r = await grant(cli);
  assert.deepStrictEqual(cli.submitted, []);
  assert.strictEqual(cli.draft.length, 6);
  assert.strictEqual(r.failed.length, 1);
});

test('Dexter 2 (the loop still holds): clearBox loops until the box reads empty, however tall the draft, never a fixed count', async () => {
  // runDrop no longer clears a draft it can't read back whole, but clearBox's guarantee is still what every clear rests on.
  const { clearBox } = require('../host/grant-sequence');
  const cli = fakeCli({ rows: 24, draft: Array.from({ length: 15 }, (_, i) => `r${i}`) });
  assert.strictEqual(await clearBox(envFor(cli)), true);
  assert.ok(boxEmpty(cli.lines(), 24));
  assert.ok(cli.writes.filter(w => w === CTRL_U).length >= 15, 'one pass per row, not a fixed count');
});

test('Dexter 6: Ctrl-E comes before every Ctrl-U (a cursor mid-draft would leave its tail)', async () => {
  const cli = fakeCli({ draft: [{ t: 'fix the parser bug' }] });
  await grant(cli);
  cli.writes.forEach((w, i) => { if (w === CTRL_U) assert.strictEqual(cli.writes[i - 1], CTRL_E); });
  assert.ok(cli.writes.includes(CTRL_U));
});

test('Dexter 3: a drop while a permission prompt is open writes NOTHING (the Enter must never confirm it)', async () => {
  const cli = fakeCli({ dialog: ['Do you want to proceed?', '  ❯ 1. Yes', '    2. No'] });
  const r = await grant(cli);
  assert.deepStrictEqual(cli.writes, []);
  assert.strictEqual(r.granted.length, 0);
  assert.strictEqual(r.failed.length, 1);
});

test('fail closed: when Ctrl-U cannot empty the box (a no-op at column 0), no Enter is ever sent and the bound holds', async () => {
  const cli = fakeCli({ ctrlUAtCol0: 'stuck', draft: [{ t: 'hello' }, { t: '' , hard: true }, { t: 'x' }] });
  const r = await grant(cli);
  assert.ok(!cli.writes.includes('\r'), 'no Enter');
  assert.ok(cli.writes.filter(w => w === CTRL_U).length <= MAX_CLEAR_PASSES);
  assert.strictEqual(r.granted.length, 0);
  assert.strictEqual(r.failed.length, 1);
});

test('fail closed: if the typed line does not read back as exactly the command, it is cleared and no Enter is sent', async () => {
  const cli = fakeCli({ draft: [{ t: 'a' }] });
  const realWrite = cli.write.bind(cli);
  cli.write = d => { realWrite(d); if (d.startsWith('/add-dir')) cli.draft[cli.draft.length - 1].t += ' STRAY'; };   // something else typed into the box
  const r = await grant(cli);
  assert.ok(!cli.writes.includes('\r'));
  assert.deepStrictEqual(cli.submitted, []);
  assert.strictEqual(r.failed.length, 1);
  // what was typed is cleared again, and (#136 (2)) the person's draft is put back in its place, with none of the command left
  assert.strictEqual(cli.draft.map(x => x.t).join('\n'), 'a');
});

test('Dexter 7 / Miguel S2: every key and the command and the Enter are separate writes (a join would fail this)', async () => {
  const cli = fakeCli({ draft: [{ t: 'one' }, { t: 'two', hard: true }] });
  await grant(cli, 'C:\\outside\\docs');
  // up to the Enter: the grant's own writes. After it, only once the dialog is answered, the draft typed back (#136 (2)); here nobody
  // answers it, so nothing follows the Enter.
  for (const w of cli.writes) assert.ok(w === CTRL_E || w === CTRL_U || w === '\r' || w === '/add-dir C:\\outside\\docs', `a write that mixes things: ${JSON.stringify(w)}`);
  assert.strictEqual(cli.writes[cli.writes.length - 1], '\r');
  assert.strictEqual(cli.writes[cli.writes.length - 2], '/add-dir C:\\outside\\docs');
});

test('the directory is quoted (a space must not widen the grant)', async () => {
  const cli = fakeCli();
  await grant(cli, 'C:\\Users\\r\\Documents Backup');
  assert.deepStrictEqual(cli.submitted, ['/add-dir "C:\\Users\\r\\Documents Backup"']);
});

test('Dexter 4 / Miguel I3: two folders are granted one at a time; the second waits for the first dialog to be answered', async () => {
  const cli = fakeCli({ draft: [{ t: 'my draft' }] });
  let polls = 0;
  const env = envFor(cli, { sleep: async () => { if (cli.dialog && ++polls === 3) cli.dialog = null; } });   // the person answers the dialog a moment later
  const granted = [];
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: '', env, onGranted: d => granted.push(d), onFailed: () => assert.fail('no failure expected') });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\a', '/add-dir C:\\b']);
  assert.deepStrictEqual(granted, ['C:\\a', 'C:\\b']);
  // after the first grant the box is already empty: the second pays no clear
  const secondStart = cli.writes.indexOf('/add-dir C:\\b');
  assert.deepStrictEqual(cli.writes.slice(cli.writes.indexOf('\r') + 1, secondStart), []);
});

test('Dexter 4: a second folder is never recorded when the first dialog stays open (it is reported, not granted)', async () => {
  const cli = fakeCli();
  const granted = []; const failed = [];
  // the fake dialog never closes (nobody answers it); the injected sleep is instant, so the wait runs out at once
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: 'paths ', env: envFor(cli),
    onGranted: d => granted.push(d), onFailed: d => failed.push(d) });
  assert.deepStrictEqual(granted, ['C:\\a']);
  assert.deepStrictEqual(failed, ['C:\\b']);
  assert.ok(!cli.writes.includes('paths '), 'path text is not typed into a dialog');
});

test('the path text is typed last, at an idle prompt, after the grants', async () => {
  const cli = fakeCli();
  const env = envFor(cli, { sleep: async () => { cli.dialog = null; } });
  await runDrop({ dirs: ['C:\\a'], text: '"C:\\a\\x y.md" ', env });
  assert.strictEqual(cli.writes[cli.writes.length - 1], '"C:\\a\\x y.md" ');
});

test('Dexter 5: the person\'s keys are held while a grant is typed and written, in order, after it', async () => {
  const out = [];
  const gate = createInputGate({ write: d => out.push(d) });
  gate.input('a');
  await gate.exclusive(async () => { gate.input('p'); gate.input('q'); out.push('GRANT'); assert.strictEqual(gate.heldCount(), 2); });
  gate.input('z');
  assert.deepStrictEqual(out, ['a', 'GRANT', 'p', 'q', 'z']);
});

test('Dexter R2-1: a key typed mid-clear (a raw frame, through the gate) is held and lands after the Enter, not deleted nor glued into /add-dir', async () => {
  const cli = fakeCli({ draft: Array.from({ length: 6 }, (_, i) => `row ${i}`) });
  const gate = createInputGate({ write: d => cli.write(d) });
  let slept = 0;
  const env = envFor(cli, {
    exclusive: fn => gate.exclusive(fn),
    sleep: async () => { if (++slept === 3) { gate.input('p'); gate.input('q'); } },   // typed during the second clear pass
  });
  await runDrop({ dirs: ['C:\\outside\\docs'], text: '', env });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
  assert.deepStrictEqual(cli.writes.slice(-3), ['\r', 'p', 'q'], 'typed keys come out after the Enter, in order');
  assert.strictEqual(cli.writes.indexOf('p') > cli.writes.indexOf('\r'), true);
});

test('Dexter R2-1: every pty write in host.js goes through the gate (no raw keystroke path around it)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'host', 'host.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const calls = src.match(/\bwriteInput\(/g) || [];
  assert.strictEqual(calls.length, 2, 'writeInput( appears only in its definition and in ptyWrite, the gate\'s writer');
  assert.match(src, /handleFrame\(text, dispatchControl, \(t\) => \{ if \(term\) inputGate\.input\(t\); \}\)/);
  assert.match(src, /if \(term\) inputGate\.input\(raw\.toString\('utf8'\)\)/);
});

test('Dexter R2-3: a permission prompt the CLI draws between the read-back and the Enter stops the Enter', async () => {
  const cli = fakeCli({ draft: [{ t: 'a draft' }], permissionAtRead: 2 });   // read 1 = the read-back, read 2 = the last look
  const r = await grant(cli);
  assert.ok(!cli.writes.includes('\r'), 'no Enter reached the permission prompt');
  assert.deepStrictEqual(cli.submitted, []);
  assert.strictEqual(r.granted.length, 0);
  assert.strictEqual(r.failed.length, 1);
});

test('Dexter R2-2: the next folder\'s keys wait until the previous dialog has been DRAWN and then answered', async () => {
  const cli = fakeCli({ draft: [{ t: 'my draft' }], dialogDelay: 3 });   // the dialog frame shows up 3 reads after the Enter
  let shown = 0;
  const env = envFor(cli, { sleep: async () => { if (cli.dialog && ++shown === 4) cli.dialog = null; } });   // answered a moment after it is drawn
  const granted = [];
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: 'paths ', env, onGranted: d => granted.push(d) });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\a', '/add-dir C:\\b']);
  assert.deepStrictEqual(granted, ['C:\\a', 'C:\\b']);
  assert.deepStrictEqual(cli.whileDialog.filter(d => d !== '\r'), [], 'nothing but the Enters was written while a dialog was pending or open');
});

test('the gate releases held keys even when the grant throws', async () => {
  const out = [];
  const gate = createInputGate({ write: d => out.push(d) });
  await assert.rejects(gate.exclusive(async () => { gate.input('k'); throw new Error('boom'); }));
  assert.deepStrictEqual(out, ['k']);
});

test('idleBox: a box is idle, a menu or permission row or no box is not', () => {
  assert.ok(idleBox(['x', RULE, '❯ hi', RULE, 'f']));
  assert.ok(!idleBox(['x', RULE, '❯ 1. Yes', '  2. No', RULE, 'f']));
  assert.ok(!idleBox(['x', RULE, 'Add directory', 'Enter to confirm · Esc to cancel']));
  assert.ok(!idleBox(['no box']));
  assert.ok(!idleBox(undefined));
  assert.ok(idleBox(['"Do you want to" quoted in the conversation above', RULE, '❯ hi', RULE, 'f']), 'text above the box does not count');
});

test('boxEmpty: the placeholder, or one bare prompt row below the height cap; a bare row AT the cap proves nothing', () => {
  assert.ok(boxEmpty(['x', RULE, '❯ Try "edit foo"', RULE], 10));
  assert.ok(boxEmpty(['x', RULE, '❯ ', RULE], 24), 'cap is 7 rows at 24');
  assert.ok(!boxEmpty(['x', RULE, '❯ ', RULE], 10), 'cap is 0 rows at 10: the head could be hidden');
  assert.ok(!boxEmpty(['x', RULE, '❯ ', RULE], undefined), 'unknown height proves nothing');
  assert.ok(!boxEmpty(['x', RULE, '❯ hi', RULE], 24));
  assert.ok(!boxEmpty(['x', RULE, '❯ ', '  more', RULE], 24));
  assert.ok(!boxEmpty(['x', RULE, '❯ '], 24));
  assert.ok(!boxEmpty(['x', RULE, 'x'], 24));
});

test('a screen that lags the pty gets a few polls to show the typed command; the Enter follows once it reads back', async () => {
  const cli = fakeCli({ draft: [{ t: 'a draft' }] });
  let stale = 0;
  const realLines = cli.lines.bind(cli);
  const realWrite = cli.write.bind(cli);
  let before = null;
  cli.write = d => { if (d.startsWith('/add-dir')) { before = realLines(); stale = 4; } realWrite(d); };
  cli.lines = () => (stale > 0 && before ? (stale--, before) : realLines());
  const r = await grant(cli);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
  assert.strictEqual(r.granted.length, 1);
});

// ---- BACKLOG #136 residuals (Ricardo 2026-11-06, round 1) -------------------------------------------------------------------------
// (2) A drop that needs a grant keeps the draft: it is read back BEFORE the clear, the grant runs, and it is typed back with the path
// added. A draft that can't be read back whole (taller than the box, so its head is hidden, or holding a pasted block or an image the
// CLI keeps only while it is in the box) is never cleared: the folder is not requested and the path goes after the draft.
// (3) A drop with no grant puts a space before the path when the box already holds something, instead of gluing it on.

const boxNow = (cli) => cli.draft.map(r => r.t).join('\n');
// the person answers each Add-directory dialog a moment after it opens
const answering = (cli) => envFor(cli, { sleep: async () => { if (cli.dialog) cli.dialog = null; } });

test('#136 (2): a one-line draft survives a grant: only /add-dir is submitted, then the draft comes back with the path after it', async () => {
  const cli = fakeCli({ draft: [{ t: 'fix the bug in' }] });
  const granted = [];
  await runDrop({ dirs: ['C:\\outside\\docs'], text: 'C:\\outside\\docs\\a.md ', env: answering(cli), onGranted: d => granted.push(d) });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
  assert.deepStrictEqual(granted, ['C:\\outside\\docs']);
  assert.strictEqual(boxNow(cli), 'fix the bug in C:\\outside\\docs\\a.md ');
});

test('#136 (2) / D4: a draft with real line breaks comes back WITH them, as Shift+Enter bytes, never a bare CR', async () => {
  const cli = fakeCli({ draft: [{ t: 'look at this' }, { t: 'and that', hard: true }, { t: 'too' }] });
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli) });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\a']);
  assert.strictEqual(boxNow(cli), 'look at this\nand that\ntoo C:\\a\\x.md ');
  assert.ok(!cli.writes.some(w => /[\r\n]/.test(w) && w !== '\r' && w !== '\x1b\r'), 'no bare newline is ever typed back (a CR would submit)');
});

test('#136 (2): the empty-box placeholder is not a draft: the path is typed alone, with no space before it', async () => {
  const cli = fakeCli();
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli) });
  assert.strictEqual(boxNow(cli), 'C:\\a\\x.md ');
  assert.ok(!cli.writes.some(w => w.includes('Try "')), 'the placeholder is never typed');
});

test('#136 (2): a draft is put back even when the grant itself failed after the clear (read-back mismatch, no Enter)', async () => {
  const cli = fakeCli({ draft: [{ t: 'keep me' }] });
  const realWrite = cli.write.bind(cli);
  cli.write = d => { realWrite(d); if (d.startsWith('/add-dir')) cli.draft[cli.draft.length - 1].t += ' STRAY'; };
  const failed = [];
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli), onFailed: d => failed.push(d) });
  assert.deepStrictEqual(cli.submitted, []);
  assert.deepStrictEqual(failed, ['C:\\a']);
  assert.strictEqual(boxNow(cli), 'keep me C:\\a\\x.md ');
});

test('#136 (2): a draft taller than the box (its head hidden) is never cleared: no grant, a reason, and the path goes after it', async () => {
  const draft = Array.from({ length: 15 }, (_, i) => ({ t: `r${i}` }));
  const cli = fakeCli({ rows: 24, draft });
  const failed = [];
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli), onFailed: (d, why) => failed.push([d, why]) });
  assert.ok(!cli.writes.includes(CTRL_U), 'nothing was cleared');
  assert.deepStrictEqual(cli.submitted, []);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0][0], 'C:\\a');
  assert.match(failed[0][1], /draft/);
  assert.deepStrictEqual(cli.writes, [' C:\\a\\x.md '], 'only the path, with a space before it');
  assert.strictEqual(cli.draft.length, 15);
});

test('#136 (2): a draft holding a pasted block or an image is never cleared (typing its label back would lose what it holds)', async () => {
  for (const t of ['see [Pasted text #1 +12 lines] here', 'what is this [Image #1]']) {
    const cli = fakeCli({ draft: [{ t }] });
    const failed = [];
    await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli), onFailed: d => failed.push(d) });
    assert.ok(!cli.writes.includes(CTRL_U), t);
    assert.deepStrictEqual(failed, ['C:\\a'], t);
    assert.strictEqual(boxNow(cli), t + ' C:\\a\\x.md ', t);
  }
});

test('#136 (2): a long draft is typed back in writes of at most 200 characters (one big write is taken for a paste)', async () => {
  // five rows of 55 characters: with the 2-column prefix each is 57 of the 58 usable columns (60 less the CLI's 2-column right margin, measured) and the next word (3 letters) would not fit: soft wraps
  const long = Array.from({ length: 5 }, (_, i) => `row ${i} ` + 'w'.repeat(49));
  const cli = fakeCli({ draft: long.map(t => ({ t })) });
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: answering(cli) });
  const after = cli.writes.slice(cli.writes.lastIndexOf('\r') + 1);
  assert.ok(after.length > 1 && after.every(w => w.length <= 200), JSON.stringify(after.map(w => w.length)));
  assert.strictEqual(boxNow(cli), long.join(' ') + ' C:\\a\\x.md ');
});

test('#136 (2): two folders, one draft: it comes back once, after the last grant', async () => {
  const cli = fakeCli({ draft: [{ t: 'my draft' }] });
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: 'C:\\a\\x C:\\b\\y ', env: answering(cli) });
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\a', '/add-dir C:\\b']);
  assert.strictEqual(boxNow(cli), 'my draft C:\\a\\x C:\\b\\y ');
});

test('#136 (3): a drop with no grant onto a box holding a draft puts a space before the path', async () => {
  const cli = fakeCli({ draft: [{ t: 'look at' }] });
  await runDrop({ dirs: [], text: 'C:\\proj\\a.md ', env: envFor(cli) });
  assert.deepStrictEqual(cli.writes, [' C:\\proj\\a.md ']);
  assert.strictEqual(boxNow(cli), 'look at C:\\proj\\a.md ');
});

test('#136 (3): a drop with no grant onto an empty box types the path alone', async () => {
  const cli = fakeCli();
  await runDrop({ dirs: [], text: 'C:\\proj\\a.md ', env: envFor(cli) });
  assert.deepStrictEqual(cli.writes, ['C:\\proj\\a.md ']);
});

test('draftOf: the box as one line, or why it cannot be read back whole', () => {
  const { draftOf } = require('../host/grant-sequence');
  assert.strictEqual(typeof draftOf, 'function', 'draftOf is exported');
  assert.deepStrictEqual(draftOf(['x', RULE, '❯ Try "edit foo"', RULE], 24), { ok: true, text: '' });
  assert.deepStrictEqual(draftOf(['x', RULE, '❯ ', RULE], 24), { ok: true, text: '' });
  assert.deepStrictEqual(draftOf(['x', RULE, '❯ hello  world', RULE], 24), { ok: true, text: 'hello  world' });
  assert.deepStrictEqual(draftOf(['x', RULE, '❯ one', '  two', RULE], 24), { ok: true, text: 'one\ntwo' }, 'two short rows: the second word would have fit, so it is a line break');
  assert.strictEqual(draftOf(['x', RULE, '❯ a', '  b', '  c', '  d', '  e', '  f', '  g', RULE], 24).ok, false, 'at the 7-row cap');
  assert.strictEqual(draftOf(['x', RULE, '❯ hi', RULE], undefined).ok, false, 'an unknown height proves nothing');
  assert.strictEqual(draftOf(['x', RULE, '❯ [Pasted text #2 +4 lines]', RULE], 24).ok, false);
  assert.strictEqual(draftOf(['x', RULE, '❯ [Image #1]', RULE], 24).ok, false);
  assert.strictEqual(draftOf(['no box'], 24).ok, false);
  assert.strictEqual(draftOf(['x', RULE, '❯ 1. Yes', '  2. No', RULE], 24).ok, false, 'a menu is not a draft');
});

// ---- PR #246 review (Dexter D1-D4, Miguel Y3) ------------------------------------------------------------------------------------
// The box is 60 columns wide in these (RULE) and the CLI uses 58 of them (measured: 132 of 134); a row's width is its text plus the 2-column prefix.

test('D2: a token wider than the box wraps mid-word and comes back whole, with no space inside it', () => {
  const { draftOf } = require('../host/grant-sequence');
  const url = 'https://example.com/' + 'a'.repeat(80);                       // 100 characters
  const rows = ['❯ ' + url.slice(0, 56), "  " + url.slice(56)];               // the first row fills the 58 usable columns
  assert.deepStrictEqual(draftOf(['x', RULE, ...rows, RULE], 24), { ok: true, text: url });
  // two full rows and a rest
  const long = 'x'.repeat(150);
  const three = ["❯ " + long.slice(0, 56), "  " + long.slice(56, 112), "  " + long.slice(112)];
  assert.strictEqual(draftOf(['x', RULE, ...three, RULE], 24).text, long);
});

test('D2: words before a long path: the break before the path is a wrap at a space, the break inside it is not', () => {
  const { draftOf } = require('../host/grant-sequence');
  const p = 'C:\\Users\\ricar\\VibeCode\\claude-custom\\fix-quick-fixes-nov\\host\\grant-sequence.js';   // 78 characters, wider than the 56 left
  const rows = ["❯ see", "  " + p.slice(0, 56), "  " + p.slice(56)];
  assert.strictEqual(draftOf(['x', RULE, ...rows, RULE], 24).text, 'see ' + p);
});

test('D2: a row that ends exactly at the width continues without a space (the one reading the screen can give)', () => {
  const { joinRows } = require('../host/grant-sequence');
  assert.strictEqual(joinRows(['a'.repeat(56), 'bcd'], 60), 'a'.repeat(56) + 'bcd');
  assert.strictEqual(joinRows(['a'.repeat(55), 'bcdefg'], 60), 'a'.repeat(55) + ' bcdefg', 'one column short: a wrap at a space');
});

test('D2: a row that ends in a space joins with the one space the wrap swallowed, not two', () => {
  const { draftOf } = require('../host/grant-sequence');
  const rows = ['❯ ' + 'word '.repeat(11) + '   ', '  ' + 'tail words here that go on and on'];   // 2 + 54 + trailing blanks (trimmed by the screen read)
  assert.strictEqual(draftOf(['x', RULE, ...rows, RULE], 24).text, 'word '.repeat(10) + 'word' + ' tail words here that go on and on');
});

test('D4: a break after a short row is a real line break (the next word would have fit); a break after a nearly full row is a wrap', () => {
  const { joinRows } = require('../host/grant-sequence');
  assert.strictEqual(joinRows(['first line', 'second line'], 60), 'first line\nsecond line');
  assert.strictEqual(joinRows(['a', '', 'b'], 60), 'a\n\nb', 'a blank line is a line break too');
  assert.strictEqual(joinRows(['w '.repeat(28).trim(), 'next'], 60), 'w '.repeat(28).trim() + ' next', '2 + 55 columns of 58: "next" does not fit in the 1 left');
  assert.strictEqual(joinRows(['one', 'two'], 0), 'one two', 'an unknown width never guesses a break');
});

test('D1: an Add-directory dialog never answered: the draft is handed back in a notice with its text, and logged in full', async () => {
  const cli = fakeCli({ draft: [{ t: 'my important draft' }] });
  const left = []; const logs = [];
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', env: envFor(cli, { log: l => logs.push(l) }), onDraftLeft: (t, why) => left.push([t, why]) });
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0][0], 'my important draft');
  assert.match(left[0][1], /dialog/);
  assert.ok(logs.some(l => l.includes('my important draft')), 'the host.log line carries the text, not just its length');
});

test('D1: the prompt not showing when the draft is to be typed back: handed back, nothing typed into the wrong place', async () => {
  const cli = fakeCli({ draft: [{ t: 'keep this' }] });
  let calls = 0;
  const env = answering(cli);
  const left = [];
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', onDraftLeft: (t, why) => left.push([t, why]),
    env: { ...env, exclusive: async fn => { calls += 1; if (calls === 2) cli.dialog = ['Do you want to proceed?', '  ❯ 1. Yes', '    2. No']; return fn(); } } });
  assert.deepStrictEqual(left.map(l => l[0]), ['keep this']);
  assert.deepStrictEqual(cli.writes.filter(w => w.includes('keep this')), [], 'no text went into the permission prompt');
});

test('D1 / Y3: the person typed into the emptied box before the draft went back: nothing is lost, the draft follows what they typed, and it is logged', async () => {
  const cli = fakeCli({ draft: [{ t: 'my draft' }] });
  const logs = []; const left = [];
  let calls = 0;
  const env = answering(cli);
  await runDrop({ dirs: ['C:\\a'], text: 'C:\\a\\x.md ', onDraftLeft: (t) => left.push(t),
    env: { ...env, log: l => logs.push(l), exclusive: async fn => { calls += 1; if (calls === 2) cli.draft = [{ t: 'typed meanwhile' }]; return fn(); } } });
  assert.strictEqual(boxNow(cli), 'typed meanwhile my draft C:\\a\\x.md ');
  assert.deepStrictEqual(left, [], 'it went back, so no notice');
  assert.ok(logs.some(l => /typed back/.test(l) && /after what the box held/.test(l)));
});

test('D3: two folders, the first refused (a dialog is showing), the second reaches the box: the draft is read THEN, and comes back', async () => {
  const cli = fakeCli({ dialog: ['Do you want to proceed?', '  ❯ 1. Yes', '    2. No'] });
  let calls = 0;
  const env = answering(cli);
  const failed = [];
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: 'C:\\a\\x C:\\b\\y ', onFailed: d => failed.push(d),
    env: { ...env, exclusive: async fn => { calls += 1; if (calls === 2) { cli.dialog = null; cli.draft = [{ t: 'my draft' }]; } return fn(); } } });
  assert.deepStrictEqual(failed, ['C:\\a']);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\b']);
  assert.strictEqual(boxNow(cli), 'my draft C:\\a\\x C:\\b\\y ');
});

test('D1 wiring: the host broadcasts a draft that was not put back, and the page shows its text', () => {
  const fs = require('fs'); const path = require('path');
  const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.match(host, /onDraftLeft:\s*\(draftText, why\) => tell\(\{ draftLeft: \{ text: draftText, why \} \}\)/);
  assert.match(page, /note\.draftLeft\.text/);
  assert.match(page, /your draft was not put back/);
});

test('D3: a draft that cannot be read back whole reports every folder from the one it stopped at, once each', async () => {
  const cli = fakeCli({ rows: 24, draft: Array.from({ length: 15 }, (_, i) => ({ t: `r${i}` })) });
  const failed = [];
  await runDrop({ dirs: ['C:\\a', 'C:\\b'], text: 'C:\\a\\x C:\\b\\y ', env: answering(cli), onFailed: d => failed.push(d) });
  assert.deepStrictEqual(failed, ['C:\\a', 'C:\\b']);
});

test('measured on the real CLI (134 columns, claude 2.1.319): a mid-word wrap fills 132 columns; word wraps came out at 131 and 127; line breaks are short rows', () => {
  const { joinRows } = require('../host/grant-sequence');
  const token = 'T' + 'abcdefghij'.repeat(20);
  // "❯ see Tabcde...": 132 columns on the first row, the rest on the second
  const first = ('see ' + token).slice(0, 130);
  assert.strictEqual(joinRows([first, ('see ' + token).slice(130)], 134), 'see ' + token, 'a 132-column row continues with no space');
  assert.strictEqual(joinRows(['w'.repeat(129), 'w17xw17xw17x'], 134), 'w'.repeat(129) + ' w17xw17xw17x', 'a 131-column row whose next word does not fit is a wrap at a space');
  assert.strictEqual(joinRows(['first line here', 'second line', 'third'], 134), 'first line here\nsecond line\nthird');
});
