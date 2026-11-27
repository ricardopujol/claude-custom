'use strict';
/**
 * BACKLOG #222: a lane opened with no CLI the first time. A stale `hosts/<port>.token` (left by the PREVIOUS host on that port)
 * won over the token the window had just spawned its host with, and the host refused the view for ever.
 *
 * Per trial this probe: writes a stale `hosts/<port>.token`; optionally holds the shared `state/schedules.json.lock` (stands in for
 * another host persisting the schedules file at a window launch); spawns the REAL host/host.js with a fresh token (cmd.exe as the
 * claude binary, so nothing bills); waits for the port as app/main.js waitForHost does; picks the token as app/tab-shell.js
 * tokenForOwnSpawn does (the identity file of OUR child's pid proves our token; 5 s bound); and does a WebSocket handshake with it.
 * `old` mode picks the way develop did (`tokenFile || own`). The fix is right when `faithful` shows 0 of N refused with the lock held.
 *
 * shortcut: the pick is a copy of tokenForOwnSpawn's rule, not the shell's own function (it is a closure inside createTabShell);
 * test/tab-shell.test.js pins the real one. Upgrade if the function is ever exported.
 *
 * Usage (it takes the heavy lock itself; ELECTRON_RUN_AS_NODE and CLAUDE_CUSTOM_* are removed for the child):
 *   node verify/probe-stale-token.js [port=7951] [faithful|old] [trials=5] [holdMs=1500]
 * Exit code 0 when no handshake was refused (faithful) and nonzero otherwise; `old` always reports and exits 0.
 * Kills only its own child, by pid. Writes only under this repo's gitignored .harness/ and a scratch project folder in os.tmpdir().
 */
require('./lib/mark-probe');   // BACKLOG #169: this script starts a host, so its children carry the probe mark
const { noteChild } = require('./lib/launch-electron');   // BACKLOG #179: takes the heavy-work lock now, before the first host starts
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { probePort } = require(path.join(ROOT, 'host', 'port-probe.js'));
const { killChildTree } = require(path.join(ROOT, 'host', 'kill-tree.js'));
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity.js'));
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

const PORT = Number(process.argv[2]) || 7951;
const MODE = process.argv[3] === 'old' ? 'old' : 'faithful';
const TRIALS = Number(process.argv[4]) || 5;
const HOLD_MS = process.argv[5] === undefined ? 1500 : Number(process.argv[5]);
const HARNESS = path.join(ROOT, '.harness');
const TOKEN_FILE = path.join(HARNESS, 'hosts', `${PORT}.token`);
const LOCK = path.join(HARNESS, 'state', 'schedules.json.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readTokenFile = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; } };

async function waitForHost(port, timeoutMs = 10000) {            // app/main.js waitForHost's shape
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probePort(port)) === 'listening') return true;
    await sleep(150);
  }
  return false;
}

function handshake(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(token)}`);
    const done = (v) => { try { ws.terminate(); } catch { /* closed */ } resolve(v); };
    ws.once('open', () => done('open'));
    ws.once('unexpected-response', (_req, res) => done(`http ${res.statusCode}`));
    ws.once('error', (e) => done(`error ${e.code || e.message}`));
    setTimeout(() => done('timeout'), 4000);
  });
}

async function trial(n) {
  const project = path.join(os.tmpdir(), `probe-stale-token-${PORT}`);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const stale = `stale-${n}-${Date.now()}`;
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, stale);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  Object.assign(env, {
    CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: project, CLAUDE_CUSTOM_TOKEN: fresh,
    CLAUDE_CUSTOM_BIN: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_REGISTRY: path.join(project, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(project, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(project, 'uploads'),
  });
  if (HOLD_MS > 0) {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    setTimeout(() => { try { fs.unlinkSync(LOCK); } catch { /* released */ } }, HOLD_MS);
  }
  const logFd = fs.openSync(path.join(os.tmpdir(), `probe-stale-token-${PORT}-${n}.log`), 'w');
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { env, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  noteChild(child);   // the lock's work record: a live host keeps this probe a live holder

  let result;
  try {
    const up = await waitForHost(PORT);
    let chosen = null;
    if (MODE === 'old') chosen = readTokenFile() || fresh;
    else {
      for (let i = 0; i < 50 && !chosen; i++) {
        const id = readIdentity({ dir: HARNESS, port: PORT });
        const isFresh = id && Number.isFinite(id.startedAt) && id.startedAt >= t0 && id.startedAt <= Date.now() + 5000;
        if (isFresh && id.pid === child.pid) chosen = fresh;
        else if (isFresh) chosen = readTokenFile() || fresh;
        else await sleep(100);
      }
      if (!chosen) chosen = fresh;
    }
    result = { n, up, ms: Date.now() - t0, chosen: chosen === fresh ? 'fresh' : chosen === stale ? 'STALE' : 'other', ws: await handshake(chosen) };
  } finally {
    try { killChildTree(child); } catch { /* already gone */ }
    for (let i = 0; i < 60 && (await probePort(PORT)) === 'listening'; i++) await sleep(250);
    if (HOLD_MS > 0) { await sleep(Math.max(0, HOLD_MS - (Date.now() - t0)) + 50); try { fs.unlinkSync(LOCK); } catch { /* released */ } }
  }
  console.log(JSON.stringify(result));
  return result;
}

(async () => {
  if ((await probePort(PORT)) !== 'refused') { console.log(`port ${PORT} is not free; stop`); process.exit(2); }
  const out = [];
  for (let n = 1; n <= TRIALS; n++) out.push(await trial(n));
  const stale = out.filter((r) => r.chosen === 'STALE').length;
  const refused = out.filter((r) => r.ws !== 'open').length;
  console.log(`summary ${MODE}, lock held ${HOLD_MS} ms: STALE chosen ${stale}/${out.length}; handshake refused ${refused}/${out.length}`);
  process.exit(MODE === 'faithful' && refused > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
