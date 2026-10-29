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

test('Dexter 2 / Miguel I1: a 15-row draft in a 24-row pane (box capped at 7) is cleared by looping, not by a fixed count', async () => {
  const cli = fakeCli({ rows: 24, draft: Array.from({ length: 15 }, (_, i) => `r${i}`) });
  await grant(cli);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
});

test('Dexter 2b: a 10-row pane (box cap 0 rows -> shows 1) with a 6-row draft is still cleared', async () => {
  const cli = fakeCli({ rows: 10, draft: Array.from({ length: 6 }, (_, i) => `r${i}`) });
  await grant(cli);
  assert.deepStrictEqual(cli.submitted, ['/add-dir C:\\outside\\docs']);
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
  assert.ok(boxEmpty(cli.lines(), 24), 'what was typed is cleared again');
});

test('Dexter 7 / Miguel S2: every key and the command and the Enter are separate writes (a join would fail this)', async () => {
  const cli = fakeCli({ draft: [{ t: 'one' }, { t: 'two', hard: true }] });
  await grant(cli, 'C:\\outside\\docs');
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
