'use strict';
/**
 * OSC 7501 (the Program Status Protocol, BACKLOG #116): does the host answer the CLI's query BEFORE the DA1 sentinel's
 * answer, and does the state reach the window?
 *
 *   node verify/probe-osc-7501.js     parts A, B and E (nothing billed)
 *   CLAUDE_CUSTOM_PROBE_REAL_CLAUDE=1 node verify/probe-osc-7501.js     ... and C and D, which start a REAL, BILLED `claude`
 *
 * A. THE HOST (real host.js, a real pty running cmd.exe, a tiny Node program inside it standing in for the CLI).
 *    The program sends "OSC 7501 ; ? ST" + "CSI c" and logs every byte that comes back on its stdin.
 *      - with a window attached (a headless xterm that answers DA1 exactly as the renderer's xterm does): the 7501 answer
 *        arrives BEFORE the DA1 answer, in every one of many rounds (the named check: "7501 reply precedes DA1 reply");
 *      - the states working -> blocked:permission -> done -> clear arrive as `program-status` frames, with the matching
 *        attention frames (blocked = urgent input-needed, done = finished);
 *      - with NO window answering DA1 (a bare typist connection): the 7501 answer still arrives, and no DA1 answer ever
 *        does. That is the measured answer to "who answers DA1 today": only a window's xterm.
 * B. THE WINDOW (a real Electron window on renderer.html attached to that same host): per state, the header dot's
 *    class and tooltip, the status the page reports to the shell (working / needsInput / finished / program), and the cue.
 * C. THE REAL CLI (opt-in: CLAUDE_CUSTOM_PROBE_REAL_CLAUDE=1, and `claude` logged in; otherwise skipped with a named reason): start a
 *    real session, send one tiny prompt (about one short reply), and confirm a `working` report arrives.
 * D. THE REAL CLI, A BACKGROUND SUBAGENT (same opt-in): a subagent that stops on a permission prompt and outlives the turn. Records
 *    whether the CLI reports it as a child record with an `id`, as the root, or not at all (PR #201 Dexter 2 and 3). A measurement:
 *    it prints MEASURED lines and fails nothing but "the session did not start".
 * E. SHUTDOWN (both backends): a child of the pty's process must be gone after the host is stopped (PR #201 Miguel R1). Under the
 *    bundled ConPTY node-pty's kill() no longer walks the console's process list; host/pty-stop.js kills the tree by pid.
 *
 * Takes the machine-wide heavy lock through verify/lib/launch-electron (required first, as every probe does). Stops only
 * the processes it started, by PID, through host/kill-tree.js (the hygiene registry). Nothing here edits the repo.
 */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const ROOT = path.join(__dirname, '..');
const REAL_CLAUDE = process.env.CLAUDE_CUSTOM_PROBE_REAL_CLAUDE === '1';
const TOKEN = 'probe-token';
const ROUNDS = 40;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const hygiene = createHygieneRegistry();
hygiene.install();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const until = async (fn, ms = 10000, step = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

// The stand-in for the CLI. It asks, then logs every byte that comes back; the probe drives it through a control file.
// String.raw: the escapes below are for the PROGRAM's source, not for this file.
const PROGRAM = String.raw`
const fs = require('fs');
const [log, ctl] = process.argv.slice(2);
if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(log, JSON.stringify(d.toString('latin1')) + '\n'));
process.stdout.write('\x1b]7501;?\x07\x1b[c');
let last = '';
setInterval(() => {
  let c; try { c = fs.readFileSync(ctl, 'utf8'); } catch { return; }
  if (c === last) return;
  last = c;
  const out = JSON.parse(c).out;
  if (out === '__exit__') process.exit(0);
  process.stdout.write(out);
}, 40);
`;

const REPLY_RE = /\x1b\]7501;\?:states=[^\x1b]*\x1b\\/g;
const DA1_RE = /\x1b\[\?[\d;]*c/g;
const read = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).join(''); } catch { return ''; } };
const orderOf = (stream) => {
  const marks = [];
  for (const m of stream.matchAll(REPLY_RE)) marks.push([m.index, '7501']);
  for (const m of stream.matchAll(DA1_RE)) marks.push([m.index, 'DA1']);
  return marks.sort((a, b) => a[0] - b[0]).map(m => m[1]);
};

async function startHost({ bin, cwd, tmp, env: extraEnv = {} }) {
  const helper = process.env.CLAUDE_CUSTOM_HELPER || path.join(ROOT, '.harness', 'hook-helper.exe');
  const mainHelper = fs.existsSync(helper) ? helper : path.join(ROOT, '..', 'dev', '.harness', 'hook-helper.exe');
  const port = await freePort();
  const sessionId = 'osc7501' + process.pid + '-' + port;
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_CWD: cwd, CLAUDE_CUSTOM_PORT: String(port), CLAUDE_CUSTOM_TOKEN: TOKEN,
    CLAUDE_CUSTOM_SESSION_ID: sessionId, CLAUDE_CUSTOM_HELPER: mainHelper,
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  if (bin) env.CLAUDE_CUSTOM_BIN = bin;
  delete env.CLAUDE_CUSTOM_CONPTY;
  Object.assign(env, extraEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  noteChild(host);
  hygiene.registerChild(host);
  const state = { host, port, out: '', env };
  host.stdout.on('data', d => { state.out += d; });
  host.stderr.on('data', d => { state.out += d; });
  const up = await until(() => /listening on ws:/.test(state.out) || /EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(state.out), 25000, 100);
  if (!up || !/listening on ws:/.test(state.out)) throw new Error('host did not start:\n' + state.out.split('\n').slice(-20).join('\n'));
  return state;
}

// A client of the host. `answerDa1` makes it what the renderer is: an xterm whose answers (DA1 and friends) go straight back as input.
async function connect(port, { answerDa1, control = false }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}${control ? '&role=control' : ''}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = { ws, frames: [], bytes: 0, term: null };
  c.term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  if (answerDa1) c.term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { c.bytes += data.length; c.term.write(data.toString('utf8')); return; }
    try { c.frames.push(JSON.parse(data.toString())); } catch { /* not control */ }
  });
  c.type = (text) => ws.send(JSON.stringify({ type: 'input', data: text }));
  c.of = (type) => c.frames.filter(f => f.type === type);
  c.close = () => { try { ws.close(); } catch { /* gone */ } };
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  return c;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const osc = (body) => `\x1b]7501;${body}\x07`;

async function runProgram(client, tmp, name) {
  const progFile = path.join(tmp, 'prog.js');
  fs.writeFileSync(progFile, PROGRAM);
  const log = path.join(tmp, `${name}.log`);
  const ctl = path.join(tmp, `${name}.ctl`);
  fs.writeFileSync(log, '');
  await until(() => client.bytes > 0, 15000);
  await sleep(1200);                                     // cmd.exe's prompt
  client.type(`node "${progFile}" "${log}" "${ctl}"\r`);
  // the program polls the file: one say at a time, with room for it to be read
  return { log, ctl, say: async (out) => { fs.writeFileSync(ctl, JSON.stringify({ out, n: Math.random() })); await sleep(160); } };
}

// ---- A. the host --------------------------------------------------------------------------------------------------------
async function partA(tmp) {
  console.log('-- A. the host (real host.js, a real pty, a stand-in program)');
  const h = await startHost({ bin: 'C:\\Windows\\System32\\cmd.exe', cwd: tmp, tmp });
  const win = await connect(h.port, { answerDa1: true });
  const hello = await until(() => win.of('hello')[0], 10000);
  check('the hello lists program-status among the control types', Boolean(hello) && hello.controls.includes('program-status'));
  check('and carries the (empty) snapshot', Boolean(hello) && hello.programStatus && hello.programStatus.live === false && hello.programStatus.root === null,
    hello && JSON.stringify(hello.programStatus));

  const prog = await runProgram(win, tmp, 'win');
  const firstPair = await until(() => { const o = orderOf(read(prog.log)); return o.length >= 2 ? o : null; }, 15000);
  check('the program gets an answer to its query and its DA1 sentinel', Boolean(firstPair), firstPair && firstPair.join(' then '));
  console.log('   first round, as the program saw it: ' + (firstPair || []).join(' then '));

  // Many rounds, each one query + sentinel written in ONE chunk: the window answers DA1 at loopback speed.
  const rounds = ROUNDS;
  for (let i = 0; i < rounds; i++) { await prog.say('\x1b]7501;?\x07\x1b[c'); }
  await until(() => orderOf(read(prog.log)).length >= 2 * (rounds + 1), 15000);
  const order = orderOf(read(prog.log));
  const pairs = [];
  for (let i = 0; i + 1 < order.length; i += 2) pairs.push(order[i] + '>' + order[i + 1]);
  const good = pairs.filter(p => p === '7501>DA1').length;
  console.log(`   reply order over ${pairs.length} rounds: ${good} x "7501 then DA1", ${pairs.length - good} other. first 6: ${order.slice(0, 6).join(',')}`);
  check('7501 reply precedes DA1 reply (every round, window attached)', pairs.length >= rounds && good === pairs.length, `${good}/${pairs.length} rounds`);
  check('and nothing was answered twice or out of pairs', order.length === pairs.length * 2, `${order.length} answers`);

  // The states, as control frames and as attention.
  const statesSeen = () => win.of('program-status').map(f => f.root && f.root.state);
  const wait = (n) => until(() => (win.of('program-status').length >= n ? true : null), 6000);
  await prog.say(osc('state=working:progress=10'));
  check('state=working arrives as a program-status frame', await wait(1) && statesSeen().slice(-1)[0] === 'working', JSON.stringify(statesSeen()));
  const nAtt = win.of('attention').length;
  await prog.say(osc(`state=blocked:kind=permission:title=${b64('Edit a.js')}:msg=${b64('Allow Edit on a.js?')}`));
  check('state=blocked:kind=permission arrives, kind and decoded message intact', await wait(2) && (() => {
    const r = win.of('program-status').slice(-1)[0].root; return r.state === 'blocked' && r.kind === 'permission' && r.msg === 'Allow Edit on a.js?' && r.title === 'Edit a.js';
  })());
  const needs = await until(() => win.of('attention').slice(nAtt).find(a => a.kind === 'input-needed'), 5000);
  check('and raises an urgent input-needed attention, in the program\'s own words', Boolean(needs) && needs.urgent === true && /Allow Edit on a\.js\?/.test(needs.body), needs && needs.body);
  await prog.say(osc('state=done'));
  check('state=done arrives', await wait(3) && statesSeen().slice(-1)[0] === 'done');
  const fin = await until(() => win.of('attention').slice(nAtt).find(a => a.kind === 'finished'), 5000);
  check('and raises a non-urgent finished attention', Boolean(fin) && fin.urgent === false);
  await prog.say(osc('state=working:id=job'));
  await prog.say(osc('state=clear'));
  check('state=clear empties the root', await until(() => { const l = win.of('program-status').slice(-1)[0]; return l && l.root === null && l.children.length === 0; }, 6000) !== null);
  const before = win.of('program-status').length;
  await prog.say(osc('state=nonsense'));
  await prog.say(osc(`state=idle:title=${'!!!!'}`));
  await prog.say(osc('state=done:zz=' + 'z'.repeat(5000)));      // over 4096 bytes
  await sleep(700);
  check('reports the protocol says to discard (unknown state, bad base64, over 4096 bytes) change nothing', win.of('program-status').length === before);
  await prog.say('__exit__');

  // No window: a typist that does not answer DA1 (what a detached host sees).
  win.close();
  await sleep(500);
  // role=control: a one-shot control client is not a window, so the host sees no window attached (host/control.js isControlClient).
  const typist = await connect(h.port, { answerDa1: false, control: true });
  const prog2 = await runProgram(typist, tmp, 'bare');
  const got = await until(() => (orderOf(read(prog2.log)).includes('7501') ? true : null), 15000);
  check('with no window attached the 7501 query is still answered (the host is the answerer)', Boolean(got));
  await sleep(2000);
  const bare = orderOf(read(prog2.log));
  console.log('   with no window attached the program saw: ' + (bare.length ? bare.join(' then ') : '(nothing)'));
  check('and the host answers DA1 itself, once, AFTER the 7501 answer', bare.join(',') === '7501,DA1', JSON.stringify(bare));
  await prog2.say('__exit__');          // the program ends, so the shell in the pty is free for part B
  typist.close();
  return h;
}

// ---- B. the window ------------------------------------------------------------------------------------------------------
const mainSource = (port, ctl, tmp) => `
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { probeWindowOptions } = require(path.join(ROOT, 'host', 'probe-window'));
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'userdata'))});
const results = [];
const check = (name, ok, detail) => { results.push({ ok: !!ok }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const say = async (out) => { fs.writeFileSync(${JSON.stringify(ctl)}, JSON.stringify({ out, n: Math.random() })); await sleep(160); };
const osc = (body) => String.fromCharCode(27) + ']7501;' + body + String.fromCharCode(7);
app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({ width: 1000, height: 700, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } }));
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: { port: ${JSON.stringify(String(port))}, cwd: ROOT, project: 'probe', token: ${JSON.stringify(TOKEN)} } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* not ready */ } await sleep(120); }
    return null;
  };
  const view = () => js('(() => { const d = document.getElementById("dot"); const s = lastReportedTabStatus; return { cls: [...d.classList].filter(c => c.startsWith("ps-")), title: d.title || null,' +
    ' working: s && s.working, needsInput: s && s.needsInput, finished: s && s.finished, program: s && s.program, pending: JSON.parse(JSON.stringify(tabPending)) }; })()');
  try {
    const up = await until('typeof applyProgramStatus === "function" && ws && ws.readyState === 1 && hostControls && hostControls.includes("program-status")', 60000);
    check('the renderer and the host are up', up, up ? undefined : await js('({ fn: typeof applyProgramStatus, ws: typeof ws !== "undefined" && ws ? ws.readyState : null, controls: typeof hostControls !== "undefined" ? hostControls : "undeclared", href: location.href })').catch(e => String(e)));
    // the program is already running in the pty (part A started it)
    await say(osc('state=working:progress=40'));
    check('working: the header dot is ps-working with the progress in its tooltip, and the tab reports working', await until('document.getElementById("dot").classList.contains("ps-working")'));
    let v = await view();
    check('working: tooltip, status', /40%/.test(v.title || '') && v.working === true && v.program && v.program.state === 'working', v);
    await say(osc('state=blocked:kind=permission:msg=' + b64('Allow Edit on a.js?')));
    check('blocked: the header dot is ps-blocked', await until('document.getElementById("dot").classList.contains("ps-blocked")'));
    check('blocked: the status says needsInput once the host\\'s attention frame lands', await until('lastReportedTabStatus && lastReportedTabStatus.needsInput === true'));
    v = await view();
    check('blocked: the kind and the decoded message are in the tooltip', /permission/.test(v.title || '') && /Allow Edit on a\\.js\\?/.test(v.title || ''), v.title);
    check('blocked: program.kind is permission and the cue is urgent', v.program && v.program.kind === 'permission' && v.pending.urgent === true, v);
    await say(osc('state=working'));
    check('working again: the need is answered (needsInput clears)', await until('document.getElementById("dot").classList.contains("ps-working") && lastReportedTabStatus.needsInput === false'));
    await say(osc('state=done'));
    check('done: ps-done, and the status says finished', await until('document.getElementById("dot").classList.contains("ps-done") && lastReportedTabStatus.finished === true && lastReportedTabStatus.working === false'));
    await sleep(4500);        // host/attention.js raises each kind at most once per 4 s (the rate limit the protocol asks for): blocked raised input-needed a moment ago
    await say(osc('state=error:msg=' + b64('Rate limited')));
    check('error: ps-error, and it needs you', await until('document.getElementById("dot").classList.contains("ps-error") && lastReportedTabStatus.needsInput === true'));
    await say(osc('state=clear'));
    check('clear: no program class, no program state', await until('document.querySelectorAll("#dot[class*=ps-]").length === 0 && lastReportedTabStatus.program === null'));
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

async function partB(tmp, h) {
  console.log('-- B. the window (a real Electron window attached to that host)');
  // Part A left no program running (the last one exited); start one with a typist, then let the window drive it.
  const typist = await connect(h.port, { answerDa1: true });
  await until(() => typist.of('hello')[0], 10000);
  const prog = await runProgram(typist, tmp, 'window');
  await until(() => orderOf(read(prog.log)).length >= 2, 15000);
  const mainFile = path.join(tmp, 'probe-main.js');
  fs.writeFileSync(mainFile, mainSource(h.port, prog.ctl, tmp));
  const keep = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_SESSION_ID'];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: keep });
  hygiene.registerChild(electron);
  electron.stdout.on('data', d => process.stdout.write(d));
  electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
  const killer = setTimeout(() => { console.log('FAIL: window part timed out after 120s'); hygiene._emergencyCleanup('timeout'); }, 120000);
  const code = await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);
  check('the window part passed', code === 0, `exit ${code}`);
  await prog.say('__exit__');
  typist.close();
}

// ---- C. the real CLI ----------------------------------------------------------------------------------------------------
function realClaudeReady(part) {
  if (!REAL_CLAUDE) { console.log(`SKIP  part ${part}: it starts a real, billed claude; set CLAUDE_CUSTOM_PROBE_REAL_CLAUDE=1 to run it`); return false; }
  const status = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', shell: true, timeout: 30000 });
  let loggedIn = false;
  try { loggedIn = JSON.parse(status.stdout).loggedIn === true; } catch { /* not JSON */ }
  if (!loggedIn) { console.log(`SKIP  part ${part}: claude is not logged in on this machine (claude auth status: ` + String(status.stdout || status.stderr).trim().slice(0, 80) + ')'); return false; }
  return true;
}

async function partC(tmp) {
  console.log('-- C. the real claude');
  if (!realClaudeReady('C')) return;
  const h = await startHost({ bin: null, cwd: ROOT, tmp });
  const win = await connect(h.port, { answerDa1: true });
  try {
    const ready = await until(() => win.term.buffer.active && [...Array(30).keys()].some(y => { const l = win.term.buffer.active.getLine(y); return l && /❯|> /.test(l.translateToString(true)); }), 60000, 500);
    if (!ready) { check('the real claude drew its prompt', false, 'no prompt within 60 s'); return; }
    await sleep(1500);
    win.type('Reply with the single word ok.');
    await sleep(500);
    win.type('\r');
    const working = await until(() => win.of('program-status').find(f => f.root && f.root.state === 'working'), 90000, 200);
    const states = win.of('program-status').map(f => f.root && f.root.state);
    console.log('   states the real claude reported: ' + JSON.stringify(states));
    check('a working report arrives on the first prompt', Boolean(working), `host log tail: ${h.out.split('\n').slice(-3).join(' | ')}`);
    await until(() => win.of('program-status').find(f => f.root && f.root.state === 'done'), 60000, 200);
    console.log('   states after the turn: ' + JSON.stringify(win.of('program-status').map(f => f.root && f.root.state)));
  } finally {
    win.type('\x03'); await sleep(300); win.type('\x03');
    win.close();
  }
}

async function partD(tmp) {
  console.log('-- D. the real claude, a background subagent that stops on a permission prompt');
  if (!realClaudeReady('D')) return;
  const scratch = path.join(tmp, 'subagent-wrote-this.txt');
  const h = await startHost({ bin: null, cwd: ROOT, tmp });
  const win = await connect(h.port, { answerDa1: true });
  try {
    const ready = await until(() => win.term.buffer.active && [...Array(30).keys()].some(y => { const l = win.term.buffer.active.getLine(y); return l && /❯|> /.test(l.translateToString(true)); }), 60000, 500);
    if (!ready) { check('the real claude drew its prompt', false, 'no prompt within 60 s'); return; }
    await sleep(1500);
    win.type('Start ONE background subagent with the Agent tool (run_in_background true). Its only task: create the file ' + scratch.split(path.sep).join('/') + ' containing the word hello, using the Write tool. Do NOT wait for it and do not do anything else: as soon as it has started, end your turn with the single word started.');
    await sleep(500);
    win.type('\r');
    const t0 = Date.now();
    await sleep(100000);        // long enough for the turn to end and the subagent to reach its prompt
    const all = win.of('program-status');
    const roots = all.map(f => f.root && f.root.state);
    const kids = new Map();
    for (const f of all) for (const c of f.children) kids.set(c.id, (kids.get(c.id) || []).concat(c.state));
    console.log('   MEASURED root states over ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + JSON.stringify(roots));
    console.log('   MEASURED child records: ' + (kids.size ? JSON.stringify([...kids.entries()]) : 'none ever'));
    console.log('   MEASURED attention frames: ' + JSON.stringify(win.of('attention').map(a => [a.kind, a.urgent, String(a.body).slice(0, 60)])));
    console.log('   MEASURED hook lines: ' + JSON.stringify(h.out.split('\n').filter(l => /\[hook\] (Notification|Stop|SubagentStop|PermissionRequest)/.test(l)).slice(0, 12)));
    const screen = [...Array(30).keys()].map(y => { const l = win.term.buffer.active.getLine(y); return l ? l.translateToString(true).trimEnd() : ''; }).filter(Boolean).slice(-8);
    console.log('   MEASURED the screen at the end: ' + JSON.stringify(screen));
    check('the session ran (the numbers above are the answer)', roots.length > 0);
  } finally {
    win.type('\x1b'); await sleep(300); win.type('\x03'); await sleep(300); win.type('\x03');
    win.close();
    try { fs.rmSync(scratch, { force: true }); } catch { /* not written, as hoped */ }
  }
}

// ---- E. shutdown --------------------------------------------------------------------------------------------------------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function partE(tmp) {
  console.log('-- E. shutdown: a child of the pty process is gone after the host stops (both ConPTY backends)');
  for (const backend of ['bundled', 'builtin']) {
    const h = await startHost({ bin: 'C:\\Windows\\System32\\cmd.exe', cwd: tmp, tmp, env: backend === 'builtin' ? { CLAUDE_CUSTOM_CONPTY: 'builtin' } : {} });
    const win = await connect(h.port, { answerDa1: true });
    let pid = null;
    try {
      check(backend + ': the host says which ConPTY it runs on', new RegExp('pty backend\\s*: ' + (backend === 'bundled' ? 'node-pty' : 'OS ConPTY')).test(h.out), (h.out.match(/pty backend.*/) || [''])[0]);
      await until(() => win.bytes > 0, 15000);
      await sleep(1200);
      win.type('node -e "console.log(String.fromCharCode(67,72,73,76,68)+process.pid);setInterval(()=>{},1000)"\r');
      const found = await until(() => {
        for (let y = 0; y < 30; y++) { const l = win.term.buffer.active.getLine(y); const m = l && /CHILD(\d+)/.exec(l.translateToString(true)); if (m) return m[1]; }
        return null;
      }, 20000);
      pid = found ? Number(found) : null;
      check(backend + ': a child process is running under the pty', Boolean(pid) && alive(pid), 'pid ' + pid);
      if (!pid) continue;
      win.ws.send(JSON.stringify({ type: 'stop' }));
      const hostGone = await until(() => (h.host.exitCode !== null || h.host.signalCode ? true : null), 15000);
      check(backend + ': the host exits on stop', Boolean(hostGone));
      const childGone = await until(() => (alive(pid) ? null : true), 5000, 100);
      check(backend + ': the child is gone within 5 s of the stop', Boolean(childGone), 'pid ' + pid + (childGone ? '' : ' still running'));
    } finally {
      win.close();
      if (pid && alive(pid)) { try { require('../host/kill-tree').killPidTree(pid); } catch { /* best effort */ } }   // our own child pid, by pid
    }
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-osc7501-'));
  let h = null;
  try {
    h = await partA(tmp);
    await partB(tmp, h);
    hygiene._emergencyCleanup('between');
    await partE(tmp);
    hygiene._emergencyCleanup('after E');
    await partC(tmp);
    hygiene._emergencyCleanup('after C');
    await partD(tmp);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
    if (h) console.log('---- host log (tail) ----\n' + h.out.split('\n').slice(-25).join('\n'));
  } finally {
    hygiene._emergencyCleanup('done');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(failures ? `\nprobe-osc-7501: ${failures} FAILED` : '\nprobe-osc-7501: every check held');
  process.exit(failures ? 1 : 0);
})();
