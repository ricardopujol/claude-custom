'use strict';
/* Does the claude-custom mod (mods/claude-custom, BACKLOG #119 A2) really feed the host from a REAL `claude`?
 *
 *     node verify/probe-cc-mod.js [A|B]        (one part only; both by default)
 *
 * Needs a logged-in CLI: without one it prints SKIPPED with the reason and exits 0. It sends two small prompts to the real CLI (a
 * one-word answer, and the creation of a scratch file it is then told not to make), so it spends a few tokens.
 *
 * PART A, the mod alone. A real `claude --permission-mode default --plugin-dir mods/claude-custom` in a pty (default mode, so the Bash
 * command asks whatever mode the person's own settings choose), its CLAUDE_CUSTOM_MOD_PORT / _TOKEN pointing at an
 * in-process host/mod-feed.js server that keeps every raw record. After a first turn it asserts a `usage` record arrived (a context
 * window, a rate-limits list), after a second prompt that makes the CLI ask permission it asserts an `ask` record for Bash arrived AND
 * the permission dialog still appeared (the mod never answers or hides it), and an `agents` record was posted. The raw records are printed.
 *
 * PART B, the harness. The real host (host/host.js) in this checkout, a real CLI under it. After a turn it asserts the host logged
 * the mod as on, the shared quota file now says source "mod" with the CLI's own figures, the header's `quota` frame carries them and a
 * `context` frame arrived. Then it waits past the host's 60 s poll tick and reports whether the poller yielded: the file stays
 * source "mod" when the mod covers every window the last poll found, and the poller keeps polling when it does not (a model-scoped
 * window such as Fable, which the CLI does not report): both are the designed behaviour, and the probe says which one it saw.
 * The real shared quota file and lease (~/.claude-custom) are snapshotted first and put back at the end.
 *
 * Traps (CLAUDE.md): ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable are stripped from what the children inherit. No Electron is
 * started, so the heavy lock is not needed. Nothing is killed by name: only the pids this probe started, through host/kill-tree.js.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const { createModServer } = require('../host/mod-feed');
const { newToken } = require('../host/gatekeeper');
const { quotaPath, leasePath, readShared } = require('../host/quota-share');
const { claudeConfigDir } = require('../host/claude-config-dir');
const { killChildTree } = require('../host/kill-tree');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');

const REPO = path.join(__dirname, '..');
const MOD_DIR = path.join(REPO, 'mods', 'claude-custom');
const HOST_PORT = 7743;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};

function claudeBin() {
  if (process.env.CLAUDE_CUSTOM_BIN) return process.env.CLAUDE_CUSTOM_BIN;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDECODE', 'CLAUDE_PID']) delete env[k];
  return env;
}

// A screen the probe can read: what the CLI draws is the only way to know it is ready, or asking.
function screenOf(term) {
  const b = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) { const l = b.getLine(b.baseY + y); if (l) rows.push(l.translateToString(true).trimEnd()); }
  return rows.join('\n');
}

async function until(fn, ms, step = 500) {
  for (let t = 0; t < ms; t += step) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

// The trust prompt for an unseen folder: Enter takes the default (yes, proceed). Called on every wait step, harmless when absent.
function maybeTrust(term, write) {
  const s = screenOf(term);
  if (/trust this folder|Do you trust the files/i.test(s)) write('\r');
}

// --- PART A ----------------------------------------------------------------------------------------------------------------

async function partA(bin) {
  console.log('\n=== PART A: the real CLI + the mod + an in-process receiver ===');
  const token = newToken();
  const records = [];
  const server = createModServer({ token, onRecord: (r) => records.push(r) });
  const port = await server.listen();
  const term = new Terminal({ cols: 110, rows: 40, allowProposedApi: true });
  const env = { ...cleanEnv(), CLAUDE_CUSTOM_MOD_PORT: String(port), CLAUDE_CUSTOM_MOD_TOKEN: token };
  // The person's own rules may allow a file write (they do on this machine), and then nothing asks. A deny/ask/allow rule set of our own
  // (ask beats allow) makes the Write ask, whatever the person's settings say; --settings replaces their permissions for this run only.
  const settingsFile = path.join(os.tmpdir(), `cc-mod-probe-settings-${Date.now()}.json`);
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { ask: ['Write'], allow: [], deny: [] } }));
  const child = pty.spawn(bin, ['--permission-mode', 'default', '--settings', settingsFile, '--plugin-dir', MOD_DIR.replace(/\\/g, '/')], { name: 'xterm-256color', cols: 110, rows: 40, cwd: REPO, env });
  hygiene.registerChild(child);
  child.onData((d) => term.write(d));
  const write = (s) => child.write(s);
  try {
    const ready = await until(() => { maybeTrust(term, write); return /❯|> /.test(screenOf(term)) && /\?|shortcuts|bypass|Try /.test(screenOf(term)); }, 60000);
    check('the CLI came up with the mod loaded', !!ready, ready ? '' : screenOf(term).slice(-400));
    check('the session.start hook posted a first usage record', !!(await until(() => records.some((r) => r.kind === 'usage'), 15000)));

    write('Reply with the single word ok.');
    await sleep(500);
    write('\r');
    const turnUsage = await until(() => records.filter((r) => r.kind === 'usage' && r.usage.context && typeof r.usage.context.tokens === 'number').pop(), 90000);
    check('after a turn a usage record carries the context fill', !!turnUsage, turnUsage ? JSON.stringify(turnUsage) : 'none');
    if (turnUsage) {
      check('...a context window as a number', typeof turnUsage.usage.context.window === 'number' && turnUsage.usage.context.window > 0);
      check('...a rate-limits list (empty only off a subscription)', Array.isArray(turnUsage.usage.rateLimits), JSON.stringify(turnUsage.usage.rateLimits));
    }
    check('an agents record was posted', records.some((r) => r.kind === 'agents'), JSON.stringify(records.find((r) => r.kind === 'agents')));
    await sleep(2500);

    // A file write asks in default mode unless the person's own rules allow it; the dialog is then refused with Esc, so nothing is written.
    const scratch = path.join(os.tmpdir(), `cc-mod-probe-${Date.now()}.txt`).replace(/\\/g, '/');
    write(`Use the Write tool to create the file ${scratch} containing the word hi.`);
    await sleep(500);
    write('\r');
    const ask = await until(() => records.find((r) => r.kind === 'ask'), 90000);
    check('a permission ask posted an ask record naming the tool, nothing else', !!ask && typeof ask.ask.tool === 'string' && JSON.stringify(ask.ask) === JSON.stringify({ tool: ask.ask.tool }), ask ? JSON.stringify(ask) : 'none');
    await sleep(1500);
    const dialog = /Do you want to proceed|Yes, and don't ask again|1\. Yes|Allow this|permission/i.test(screenOf(term));
    check('the permission dialog still appeared: the mod did not answer or hide it', dialog, dialog ? '' : screenOf(term).slice(-500));
    write('\u001b');                     // Esc: do not run the command
    await sleep(1000);

    // The same ask from inside a SUBAGENT: the record names the agent, and the roster posted while the dialog is open shows how the CLI
    // statuses it (the mood machine's `waiting` second source reads that). Whether the status is `waiting` is MEASURED here, not assumed.
    const before = records.length;
    write(`Launch one general-purpose subagent with the Agent tool. It must use the Write tool to create ${scratch.replace('.txt', '-agent.txt')} containing the word hi, and nothing else.`);
    await sleep(500);
    write('\r');
    const agentAsk = await until(() => records.slice(before).find((r) => r.kind === 'ask' && r.ask.agentId), 120000);
    check('an ask inside a subagent names the agent', !!agentAsk, agentAsk ? JSON.stringify(agentAsk.ask) : 'none (the main session may have asked instead)');
    await sleep(2500);
    const roster = records.slice(before).filter((r) => r.kind === 'agents').pop();
    console.log('  roster while the subagent\'s dialog is open:', roster ? JSON.stringify(roster.agents) : '(no agents record after the ask)');
    check('the roster lists that agent', !!(roster && agentAsk && roster.agents.some((a) => a.id === agentAsk.ask.agentId)));
    const waiting = !!(roster && roster.agents.some((a) => a.status === 'waiting'));
    console.log(`  MEASURED: an agent with an open permission dialog has status ${roster ? JSON.stringify(roster.agents.map((a) => a.status)) : '?'} -> ${waiting ? '"waiting" (the mood machine\'s second source fires)' : 'NOT "waiting" at the moment of the ask'}`);
    write('\u001b');
    await sleep(500);
    write('\u001b');
    await sleep(1500);

    console.log('\nraw records (as the host received them):');
    const firstOf = (k) => records.find((r) => r.kind === k);
    for (const k of ['usage', 'agents', 'ask']) console.log(`  ${k}: ${JSON.stringify(k === 'usage' ? (turnUsage || firstOf(k)) : firstOf(k))}`);
    console.log(`  counts: ${JSON.stringify(records.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {}))}`);
  } finally {
    hygiene.unregisterSpawnedTree(child.pid);
    try { killChildTree(child); } catch { /* gone */ }
    await server.close();
    fs.rmSync(settingsFile, { force: true });
  }
}

// --- PART B ----------------------------------------------------------------------------------------------------------------

async function partB() {
  console.log('\n=== PART B: the real host + a real CLI + the shared quota file ===');
  const file = quotaPath(undefined, claudeConfigDir());
  const lease = leasePath(undefined, claudeConfigDir());
  const snaps = [snapshotFile(file), snapshotFile(lease)];
  hygiene.addCleanup(() => snaps.forEach((s) => s.restore()));
  const token = newToken();
  const env = { ...cleanEnv(), CLAUDE_CUSTOM_PORT: String(HOST_PORT), CLAUDE_CUSTOM_CWD: REPO, CLAUDE_CUSTOM_TOKEN: token };
  const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  hygiene.registerChild(host);
  let log = '';
  host.stdout.on('data', (d) => { log += d.toString(); });
  host.stderr.on('data', (d) => { log += d.toString(); });
  const control = [];
  const term = new Terminal({ cols: 110, rows: 40, allowProposedApi: true });
  let ws = null;
  try {
    const on = await until(() => /claude-custom mod: on|claude-custom mod: (off|not loaded)/.test(log), 30000);
    check('the host decided about the mod at boot', !!on, (log.match(/claude-custom mod:[^\n]*/) || ['(no line)'])[0]);
    if (!/claude-custom mod: on/.test(log)) { check('the mod is on for this CLI', false, (log.match(/claude-custom mod:[^\n]*/) || [''])[0]); return; }
    ws = new WebSocket(`ws://127.0.0.1:${HOST_PORT}/?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.on('message', (d, bin) => {
      if (bin === true) term.write(Buffer.from(d).toString('utf8'));
      else { try { control.push(JSON.parse(d.toString())); } catch { /* not a frame */ } }
    });
    ws.send(JSON.stringify({ type: 'resize', cols: 110, rows: 40 }));
    const write = (s) => ws.send(Buffer.from(s, 'utf8'));
    await until(() => { maybeTrust(term, write); return /\?|shortcuts|bypass|Try /.test(screenOf(term)); }, 60000);
    const polledBefore = readShared({ dir: undefined, configDir: claudeConfigDir() });
    console.log('quota before the first turn:', polledBefore.state, (polledBefore.windows || []).map((w) => `${w.key}=${w.percent}`).join(' '));

    write('Reply with the single word ok.');
    await sleep(500);
    write('\r');
    const modFile = await until(() => {
      try { const f = JSON.parse(fs.readFileSync(file, 'utf8')); return f.source === 'mod' ? f : null; } catch { return null; }
    }, 90000);
    check('the shared quota file now says source "mod"', !!modFile, modFile ? `complete=${modFile.complete} windows=${modFile.windows.map((w) => `${w.key}=${w.percent}`).join(' ')}` : 'it never did');
    const frame = await until(() => control.filter((m) => m.type === 'quota' && m.quota && m.quota.ok === true).pop(), 20000);
    check('the header\'s quota frame carries the mod\'s figures', !!frame && !!modFile && frame.quota.windows.some((w) => modFile.windows.some((m) => m.key === w.key && m.percent === w.percent)),
      frame ? frame.quota.windows.map((w) => `${w.key}=${w.percent}`).join(' ') : 'no frame');
    check('a context frame arrived with a fill', !!(await until(() => control.find((m) => m.type === 'context' && m.context && m.context.used > 0), 20000)),
      JSON.stringify((control.filter((m) => m.type === 'context').pop() || {}).context));
    check('the host logged no mod record failure', !/mod record:/.test(log), (log.match(/mod record:[^\n]*/) || [''])[0]);

    if (modFile) {
      // Every GOOD poll renews the lease's stamp (host/quota-share.js renewPoller) and a yielding poller does not: that stamp is how the
      // probe sees a poll without touching the host. It only means something while THIS host holds the lease.
      const leaseNow = () => { try { return JSON.parse(fs.readFileSync(lease, 'utf8')); } catch { return null; } };
      const before = leaseNow();
      console.log('\nwaiting past the 60 s poll tick to see whether the poller yields (complete=' + modFile.complete + ')...');
      await sleep(70000);
      const after = leaseNow();
      const ours = !!(after && typeof after.owner === 'string' && after.owner.startsWith(host.pid + '-'));
      if (!ours) {
        console.log('  SKIPPED the poll check: another host holds the quota lease (' + (after && after.owner) + '), so this host would not poll either way');
      } else if (modFile.complete === true) {
        check('the mod covers every window, so the poller yielded: the lease was not renewed, no poll was made', !!before && after.at === before.at, `lease stamp ${before && before.at} -> ${after.at}`);
      } else {
        check('the mod leaves a window out (carried from the poll), so the poller kept polling: a good poll renewed the lease',
          !!before && after.at > before.at, `lease stamp ${before && before.at} -> ${after.at}`);
        console.log('  (expected on an account with a model-scoped window such as Fable: the CLI reports only five_hour and seven_day)');
      }
    }
  } finally {
    try { if (ws) ws.close(); } catch { /* gone */ }
    hygiene.unregisterSpawnedTree(host.pid);
    try { killChildTree(host); } catch { /* gone */ }
    await sleep(2000);
    snaps.forEach((s) => s.restore());
    console.log('\nthe real shared quota file and lease were put back');
  }
}

(async () => {
  const bin = claudeBin();
  if (!bin) { console.log('SKIPPED: no claude binary where the host looks for it'); process.exit(0); }
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', env: cleanEnv(), timeout: 30000, windowsHide: true });
  let loggedIn = false;
  try { loggedIn = JSON.parse(r.stdout).loggedIn === true; } catch { /* not JSON */ }
  if (!loggedIn) { console.log('SKIPPED: the CLI is not logged in (claude auth status says so); run `claude auth login` first'); process.exit(0); }
  console.log('claude', spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim());
  const only = (process.argv[2] || '').toUpperCase();
  if (only !== 'B') await partA(bin);
  if (only !== 'A') await partB();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('probe error:', err); process.exit(1); });
