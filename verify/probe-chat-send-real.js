'use strict';
const { noteChild } = require('./lib/launch-electron');   // BACKLOG #179: takes the heavy-work lock now, before anything heavy starts; noteChild records each host / claude it starts
const { killChildTree, trackExit } = require('../host/kill-tree');
/* What does the chat view's type box (app/chat-view-state.js runChatSend) do against the REAL `claude` CLI? (PR #226 Dexter R2-1.
   Re-runnable. Zero spend, zero network: the fake-endpoint technique of verify/probe-panel-line-input.js.)

     node verify/probe-chat-send-real.js [--dump] [--only=<case,...>] [--measure] [--measure-clear] [--grant]

   --grant runs the drop's grant sequence (host/grant-sequence.js runDrop) instead: the draft is kept through a grant (BACKLOG #136).

   The interactive CLI runs in a node-pty at ANTHROPIC_BASE_URL (a local server speaking just enough of POST /v1/messages) with a fake
   token, in a throwaway config dir and folder. The page's own send runs against that CLI's screen (an @xterm/headless terminal fed by
   the pty), with the page's own readers (inputState, commandTyped, boxText, boxHoldsLine from app/top-bar-display.js): the real
   runChatSend, not a copy. A case passes when the send reports ok AND the endpoint received a request carrying the whole text.

     one-line-250 / one-line-2000   a long one-line message: chunked at 200 characters, so the CLI never sees a paste
     multi-3 / multi-8              a multi-line message (8 lines, ~600 characters): ONE bracketed paste, which the CLI may collapse to
                                    "[Pasted text #N +M lines]"
     draft-line / draft-multi       a draft typed in the terminal first (one line; three lines joined with Shift+Enter's bytes): the send
                                    clears it (#174) and passes only when no request carried any of the draft

   MEASURED (2026-11-05, Claude Code v2.1.318): both draft cases PASS. The three-line draft read as 'multiline' and the read-before-every-key
   Ctrl+E / Ctrl+U clear emptied it; the CLI then shows "Ctrl+Y to paste deleted text".
     draft-12 / draft-cursor-up (PR #233 F2)  a 12-line draft is cleared and the text sent; a draft with the cursor moved up to line 1 is
                                    REFUSED with the one-sentence "couldn't be fully cleared and part of it is gone" note, no request at all

   --measure-clear (PR #233 F2) prints the live box after every single key, a fresh CLI per scenario, nothing submitted. MEASURED 2026-11-05:
     Ctrl+U empties the cursor's line; on an empty line it deletes the line break before it (the cursor goes to the end of the line above);
     Ctrl+E only goes to the end of the cursor's line. A cursor at the end: 12 lines took 23 Ctrl+U (two per line but the first).
     The cursor moved up to line 1 (Up twice): Ctrl+U empties line 1, and every later key changes nothing.
     Ctrl+End and Meta+> do NOT reach the end of the whole input (Ctrl+U after them still emptied line 1 only); End gave an inconsistent
     result (it emptied line 2), so no key is used to get there.

   --measure also writes one raw block of each size (a single write, then a bracketed paste of N lines), each into a fresh CLI, and
   prints what the box shows. Prints RESULT lines; exit 1 when a case FAILs.

   MEASURED (2026-11-03, claude-code from npm root -g, 120 columns):
     bracketed paste   2 and 3 lines show whole; 4 lines and more collapse to "[Pasted text #1 +3 lines]" (4, 5, 6, 8, 12 lines all did).
                       The line count decides, not the length (4 lines = 163 characters collapsed). Enter submits the real text.
     ONE plain write   200 to 800 characters showed whole; 1,000 and 2,000 collapsed to "[Pasted text #1]"; 1,200 and 1,500 did NOT.
                       So there is no clean threshold: it depends on how the pty splits the write into reads, and anything from about 1,000
                       characters can collapse. Chunks of 200 (app/top-bar-display.js COMMAND_CHUNK) never did.
   So a long one-line message is chunked (R2-1), and a multi-line one, which cannot be, is accepted when the box holds exactly one paste
   placeholder (app/chat-view-state.js onlyPlaceholder).
   Only the pty this probe started is killed, by handle. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'app', 'chat-view-state'));
const { inputState, commandTyped, boxText, boxHoldsLine } = require(path.join(ROOT, 'app', 'top-bar-display'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROWS = 40;
const COLS = 120;

function findClaude() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
  for (const rel of [path.join('bin', exe), 'cli.js']) {
    const p = path.join(npmRoot, '@anthropic-ai', 'claude-code', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sse(res, n, text, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_probe_' + n, type: 'message', role: 'assistant',
    model: model || 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

const filler = (n) => { let s = ''; let i = 0; while (s.length < n) s += `word${i++} `; return s.slice(0, n).trim(); };
const lines = (count, each) => Array.from({ length: count }, (_, k) => `line${k + 1} ${filler(each)}`.slice(0, each)).join('\n');

const CASES = [
  { name: 'one-line-250', text: filler(250) },
  { name: 'one-line-2000', text: filler(2000) },
  { name: 'multi-3', text: lines(3, 40) },
  { name: 'multi-8', text: lines(8, 75) },
  // #174: a draft typed in the terminal first; the chat's send clears it (Ctrl+E / Ctrl+U, read back empty) and the request carries the chat
  // text alone. The multi-line draft is typed with Shift+Enter's bytes, the way the app joins lines; it also measures whether the real
  // CLI's Ctrl+U empties several lines (a draft it can't empty must end in the "couldn't be cleared" note, never a send).
  { name: 'draft-line', draft: ['OLDDRAFT fix the build'], text: 'the chat text, sent alone' },
  { name: 'draft-multi', draft: ['OLDDRAFT first line', '\x1b\r', 'OLDDRAFT second line', '\x1b\r', 'OLDDRAFT third'], text: 'the chat text after a multi-line draft',
    rowsAtLeast: 3 },
  // PR #233 F2: 12 lines, more than the old 40-key bound could empty; the bound now grows with the rows read
  { name: 'draft-12', draft: Array.from({ length: 12 }, (_, k) => `OLDDRAFT line ${k + 1}`).flatMap((l, i) => (i ? ['\x1b\r', l] : [l])), text: 'the chat text after a 12-line draft',
    rowsAtLeast: 12 },
  // PR #233 F2: the cursor moved up to line 1 (Up twice): line 1 empties, then no progress; the send must REFUSE with the one-sentence note,
  // send nothing at all, and leave the rest of the draft
  { name: 'draft-cursor-up', draft: ['OLDDRAFT first line', '\x1b\r', 'OLDDRAFT second line', '\x1b\r', 'OLDDRAFT third', '\x1b[A', '\x1b[A'],
    text: 'must not be sent', rowsAtLeast: 3, expect: 'refused' },
];

// One CLI session: fn({ p, screen, live, requests, term }) -> result.
async function withCli(claudeBin, fn) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-chat-send-'));
  const work = path.join(base, 'work');
  const config = path.join(base, 'config');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), '{}');
  const slashes = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] }, [slashes(work)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* as-is */ }
      const msgs = (body.messages || []).filter(m => m && m.role === 'user');
      requests.push({ main: !!(body.tools && body.tools.length), last: msgs.length ? JSON.stringify(msgs[msgs.length - 1].content) : '' });
      sse(res, requests.length, 'ok', body.model);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_GIT_BASH_PATH') continue;
    if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'probe-token-not-real',
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });

  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  const p = pty.spawn(claudeBin, ['--model', 'haiku'], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
  noteChild(p);   // the lock's work record: a live p keeps this probe a live holder (BACKLOG #112)
  trackExit(p);
  p.onData(d => term.write(d));
  const flush = () => new Promise(r => term.write('', r));
  const screen = async () => {
    await flush();
    const b = term.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - ROWS); i < b.length; i++) out.push(b.getLine(i).translateToString(true).replace(/\s+$/, ''));
    return out;
  };
  try {
    const t0 = Date.now();
    for (;;) {
      const l = await screen();
      if (inputState(l, {}) === 'ready') break;
      if (Date.now() - t0 > 60000) throw new Error('the CLI box never showed');
      await sleep(200);
    }
    await sleep(1500);
    return await fn({ p, screen, requests, term });
  } finally {
    try { killChildTree(p); } catch { /* gone */ }
    server.close();
    await sleep(500);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  }
}

async function runSend(claudeBin, c, dump) {
  return withCli(claudeBin, async ({ p, screen, requests, term }) => {
    let draftShown = null;
    if (c.draft) {
      for (const part of c.draft) { p.write(part); await sleep(150); }
      await sleep(600);
      const l = await screen();
      const live = require(path.join(ROOT, 'app', 'top-bar-display')).liveBox(l);
      draftShown = { state: inputState(l, {}), box: boxText(l), rows: live && live.box ? live.box.length : 0 };
    }
    let cur = await screen();
    const write = (frame) => p.write(JSON.parse(frame).data);
    const result = await state.runChatSend(c.text, {
      turn: () => 'idle', blocked: () => false, holds: () => false,
      lines: () => cur,
      sync: async () => { cur = await screen(); },
      termRows: () => ROWS, vim: () => false, connected: () => true, busy: () => false, lock: () => {},
      bracketed: () => term.modes.bracketedPasteMode === true,
      type: (frame) => { write(frame); return 'sent'; },
      cancelHold: () => {}, send: write, sleep, keyGap: 120,
      inputState, commandTyped, boxText, boxHoldsLine,
    });
    await sleep(3000);
    const ask = requests.filter(r => r.main).pop();
    const tail = c.text.slice(-12).replace(/\n/g, '\\n');
    const reached = !!ask && ask.last.includes(c.text.slice(0, 12)) && ask.last.includes(tail);
    if (dump) console.log(`--- ${c.name}\n${(await screen()).join('\n')}`);
    const draftLeaked = requests.some(r => r.last.includes('OLDDRAFT'));
    const after = await screen();
    const leftLive = require(path.join(ROOT, 'app', 'top-bar-display')).liveBox(after);
    return { name: c.name, chars: c.text.length, lines: c.text.split('\n').length, bracketed: term.modes.bracketedPasteMode === true,
      sendOk: !!result.ok, note: result.note || null, requestCarriedWholeText: reached, requests: requests.filter(r => r.main).length,
      ...(c.draft ? { draftShown, draftLeaked, boxAfter: leftLive && leftLive.box ? leftLive.box : null } : {}) };
  });
}

// --grant (BACKLOG #136 residuals, Ricardo 2026-11-06): the host's drop sequence (host/grant-sequence.js runDrop, the real one) against the
// real CLI's screen. A draft is typed, a drop that needs a grant runs (`/add-dir <a throwaway folder>`, the CLI's own "Add directory" dialog
// answered with Enter by a watcher here), and the box must then hold the draft with the path after it; nothing may reach the model. A draft
// taller than the box is never cleared (no Ctrl+U at all), the folder is reported, and the path goes after it. A drop with no grant puts a
// space before the path. Zero spend: the same fake endpoint.
const GRANT_CASES = [
  { name: 'grant-line', draft: ['OLDDRAFT fix the build'], expect: 'restored' },
  { name: 'grant-wrapped', draft: ['OLDDRAFT ' + filler(300)], expect: 'restored', rowsAtLeast: 3 },
  { name: 'grant-shift-enter', draft: ['OLDDRAFT first line', '\x1b\r', 'OLDDRAFT second line'], expect: 'restored', rowsAtLeast: 2 },
  { name: 'grant-taller-than-box', draft: Array.from({ length: 20 }, (_, k) => `OLDDRAFT row ${k + 1}`).flatMap((l, i) => (i ? ['\x1b\r', l] : [l])), expect: 'kept' },
  { name: 'drop-no-grant', draft: ['OLDDRAFT look at'], expect: 'spaced', noGrant: true },
];

async function runGrant(claudeBin, c) {
  const { runDrop, CTRL_U } = require(path.join(ROOT, 'host', 'grant-sequence'));
  const { liveBox } = require(path.join(ROOT, 'app', 'top-bar-display'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-grant-out-'));
  try {
    return await withCli(claudeBin, async ({ p, screen, requests }) => {
      for (const part of c.draft) { p.write(part); await sleep(150); }
      await sleep(800);
      let cur = await screen();
      const before = liveBox(cur);
      const draftRows = before && before.box ? before.box.length : 0;
      const writes = [];
      let dialogs = 0;
      let lastAnswer = 0;
      // The person answering the CLI's own Add-directory dialog: Enter on its default row, once per dialog drawn.
      const watcher = setInterval(async () => {
        const l = (await screen()).join('\n');
        if (/Add directory to workspace/.test(l) && Date.now() - lastAnswer > 1500) { lastAnswer = Date.now(); dialogs++; await sleep(300); p.write('\r'); }
      }, 300);
      const failed = [];
      const file = path.join(outside, 'note.md');
      fs.writeFileSync(file, '# note\n');
      const text = file + ' ';
      try {
        await runDrop({
          dirs: c.noGrant ? [] : [outside], text,
          env: { lines: () => cur, sync: async () => { cur = await screen(); }, termRows: () => ROWS,
            write: (d) => { writes.push(d); p.write(d); }, sleep, keyGap: 120, exclusive: fn => fn(), log: () => {} },
          onGranted: () => {}, onFailed: (d, why) => failed.push(why),
        });
      } finally { clearInterval(watcher); }
      await sleep(1500);
      const after = await screen();
      const live = liveBox(after);
      const rows = live && live.box ? live.box : [];
      const joined = rows.map((r, i) => (i === 0 ? r.slice(1) : r).trim()).join(' ').replace(/\s+/g, ' ').trim();
      const draftJoined = c.draft.filter(x => x !== '\x1b\r').join(' ');
      const leaked = requests.some(r => r.last.includes('OLDDRAFT'));
      let pass;
      if (c.expect === 'restored') pass = dialogs === 1 && commandTyped(after, `${draftJoined} ${text}`, { termRows: ROWS }) && failed.length === 0;
      else if (c.expect === 'kept') pass = dialogs === 0 && !writes.includes(CTRL_U) && failed.length === 1 && writes.length === 1 && writes[0] === ' ' + text && rows.length >= Math.floor(ROWS / 2) - 5;
      else pass = dialogs === 0 && writes.length === 1 && writes[0] === ' ' + text && joined === `${draftJoined} ${file}`;
      pass = pass && !leaked && (!c.rowsAtLeast || draftRows >= c.rowsAtLeast);
      return { name: c.name, pass, draftRows, dialogs, failed, clearKeys: writes.filter(w => w === CTRL_U).length, leaked,
        boxAfter: rows.length > 4 ? [...rows.slice(0, 2), '…', ...rows.slice(-2)] : rows };
    });
  } finally {
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// What does the box show for ONE write of N characters, and for a bracketed paste of N lines? (the paste threshold)
async function measure(claudeBin) {
  // A FRESH CLI per row: a box left holding an earlier paste (or its placeholder numbering) would colour the next row.
  const out = [];
  const rows = [
    ...[200, 201, 300, 500, 800, 1000, 1200, 1500, 2000].map(n => ({ kind: 'one write', n, send: () => filler(n) })),
    ...[[2, 20], [3, 40], [4, 40], [5, 40], [6, 40], [8, 75], [12, 75]].map(([count, each]) => ({ kind: 'bracketed', count, text: lines(count, each) })),
  ];
  for (const row of rows) {
    out.push(await withCli(claudeBin, async ({ p, screen, term }) => {
      const body = row.kind === 'one write' ? row.send() : `\x1b[200~${row.text}\x1b[201~`;
      p.write(body); await sleep(1200);
      const l = await screen();
      const whole = l.join('\n');
      return { kind: row.kind, n: row.n, lines: row.count, chars: row.kind === 'one write' ? row.n : row.text.length,
        shows: /\[Pasted text/.test(whole) ? 'PLACEHOLDER' : 'text', placeholder: (/\[Pasted text[^\]]*\]/.exec(whole) || [null])[0], state: inputState(l, {}) };
    }));
  }
  return out;
}

// --measure-clear (PR #233 F2): what Ctrl+E / Ctrl+U and the end-of-input candidates do to a multi-line draft, ONE key at a time, with the
// live box's rows read after each key. A fresh CLI per scenario. Nothing is ever submitted (no Enter is sent).
const SHIFT_ENTER = '\x1b\r';
const UP = '\x1b[A';
const KEYS = { E: '\x05', U: '\x15', CtrlEnd: '\x1b[1;5F', End: '\x1b[F', MetaGt: '\x1b>', Up: UP };
const draftOf = (n) => Array.from({ length: n }, (_, k) => `L${k + 1}draft`);
const CLEAR_SCENARIOS = [
  { name: 'cursor-last-3', lines: 3, before: [], keys: 'E U E U E U E U E U E U'.split(' ') },
  { name: 'cursor-first-3', lines: 3, before: ['Up', 'Up'], keys: 'E U E U E U E U'.split(' ') },
  { name: 'cursor-first-3-ctrlend', lines: 3, before: ['Up', 'Up', 'CtrlEnd'], keys: 'U U U U U U'.split(' ') },
  { name: 'cursor-first-3-metagt', lines: 3, before: ['Up', 'Up', 'MetaGt'], keys: 'U U U U U U'.split(' ') },
  { name: 'cursor-first-3-end', lines: 3, before: ['Up', 'Up', 'End'], keys: 'U U U U'.split(' ') },
  { name: 'cursor-last-12', lines: 12, before: [], keys: Array.from({ length: 48 }, (_, i) => (i % 2 ? 'U' : 'E')) },
  { name: 'cursor-last-12-U-only', lines: 12, before: [], keys: Array.from({ length: 26 }, () => 'U') },
];

async function measureClear(claudeBin) {
  const { liveBox } = require(path.join(ROOT, 'app', 'top-bar-display'));
  const out = [];
  for (const sc of CLEAR_SCENARIOS) {
    out.push(await withCli(claudeBin, async ({ p, screen }) => {
      const parts = draftOf(sc.lines);
      for (let i = 0; i < parts.length; i++) { if (i) { p.write(SHIFT_ENTER); await sleep(120); } p.write(parts[i]); await sleep(120); }
      for (const k of sc.before) { p.write(KEYS[k]); await sleep(200); }
      await sleep(500);
      const rows = async () => { const l = await screen(); const b = liveBox(l); return { state: inputState(l, {}), rows: b && b.box ? b.box : null }; };
      const steps = [{ key: 'start', ...(await rows()) }];
      for (const k of sc.keys) { p.write(KEYS[k]); await sleep(200); steps.push({ key: k, ...(await rows()) }); }
      return { scenario: sc.name, steps: steps.map(s => `${s.key}:${s.state}:${JSON.stringify(s.rows)}`) };
    }));
  }
  return out;
}

(async () => {
  if (process.argv.includes('--measure-clear')) {
    const bin = findClaude();
    if (!bin) { console.log('FAIL claude not found under npm root -g'); process.exit(1); }
    for (const r of await measureClear(bin)) { console.log(`SCENARIO ${r.scenario}`); for (const s of r.steps) console.log('  ' + s); }
    process.exit(0);
  }
  const claudeBin = findClaude();
  if (!claudeBin) { console.log('FAIL claude not found under npm root -g'); process.exit(1); }
  const only = process.argv.find(a => a.startsWith('--only='));
  let failed = false;
  if (process.argv.includes('--grant')) {
    for (const c of GRANT_CASES) {
      if (only && !only.slice(7).split(',').includes(c.name)) continue;
      let r;
      try { r = await runGrant(claudeBin, c); } catch (e) { r = { name: c.name, pass: false, error: e.message }; }
      if (!r.pass) failed = true;
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(r)}`);
    }
    process.exit(failed ? 1 : 0);
  }
  for (const c of CASES) {
    if (only && !only.slice(7).split(',').includes(c.name)) continue;
    let r;
    try { r = await runSend(claudeBin, c, process.argv.includes('--dump')); } catch (e) { r = { name: c.name, error: e.message }; }
    // A draft case passes when the draft really was in the box (over the rows it was typed on: a multi-line case must READ as 'multiline',
    // PR #233 F9), the send went, and no request carried any of the draft. An `expect: 'refused'` case passes when the send refused with the
    // one-sentence partly-cleared note and no request was made at all.
    const shownOk = !c.draft || (!!r.draftShown && r.draftShown.box !== '' && (!c.rowsAtLeast || (r.draftShown.state === 'multiline' && r.draftShown.rows >= c.rowsAtLeast)));
    const draftOk = !c.draft || (shownOk && r.draftLeaked === false);
    const pass = !r.error && (c.expect === 'refused'
      ? r.sendOk === false && r.requests === 0 && shownOk && state.SEND_NOTES.draftPartly === r.note
      : r.sendOk && r.requestCarriedWholeText && draftOk);
    if (!pass) failed = true;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(r)}`);
  }
  if (process.argv.includes('--measure')) {
    try { for (const row of await measure(claudeBin)) console.log('RESULT ' + JSON.stringify(row)); } catch (e) { console.log('FAIL measure: ' + e.message); failed = true; }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
