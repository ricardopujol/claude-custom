'use strict';
/**
 * PROBE: the sandbox around Claude's panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md "Testing"). (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-canvas-sandbox.js        (exit 0 = every blocked path reported 0 hits)
 *
 * The page Claude writes for its panel is untrusted. This opens a real Electron window and runs the REAL panel code
 * (app/canvas-views.js and the modules it uses), ~50 escape attempts, one panel each: every fetch-like API, every element
 * that loads something, resource hints, WebRTC (STUN over UDP, TURN over TCP to a loopback port), WebTransport, DNS
 * prefetch, navigation, popups, the app's bridge, the clipboard, storage, devices, and a script pressing its own button.
 * Each network path has its own denied server on its own loopback port, so a hit is attributed to the vector that
 * caused it, counted twice: HTTP requests and bare TCP connections (what a preconnect or a TURN attempt makes). UDP
 * and TCP servers count WebRTC; a Chromium net-log shows DNS.
 *
 * TWO RUNS. SEALED is the panel as the app builds it: it must report 0 hits on every denied path. NAIVE is the CONTROL:
 * the same page in a WebContentsView with none of the sealing (default session, no dead proxy, no navigation guard, no
 * resolver rule). It must SEE the leaks, or a quiet sealed run could just mean the probe can't see a leak. (The iframe
 * route, measured first, leaked WebRTC TURN over TCP and DNS prefetch even with a CSP, a navigation guard and the WebRTC
 * policy: that is why the panel is a WebContentsView with its own session. See documentation/PLAN_LIVE_PANEL.md.)
 *
 * ZERO SPEND, no `claude`, no global config touched. The Electron child is started by this script and killed by its own
 * PID (host/kill-tree.js); nothing is ever stopped by name. ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable of an
 * enclosing tab are removed from the child's environment first (CLAUDE.md, the ELECTRON_RUN_AS_NODE trap).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const MAIN = path.join(__dirname, 'probe71', 'sandbox-main.js');

function runElectron(mode) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
    env.PROBE_MODE = mode;
    const out = path.join(os.tmpdir(), `probe-canvas-sandbox-${process.pid}-${mode}.json`);
    env.PROBE_OUT = out;
    env.PROBE_WATCH = '1';
    if (process.env.PROBE_OWNER_FOCUS) env.PROBE_ARM = path.join(os.tmpdir(), `probe-canvas-windows-${process.pid}-${mode}.armed`);
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-canvas-'));
    const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [MAIN, `--user-data-dir=${userData}`],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // The window watcher: every visible top-level window of the Electron tree is a native dialog. It logs each one and closes it by handle,
    // so a dialog can never hang the run (see verify/probe71/watch-windows.ps1).
    const winLog = path.join(os.tmpdir(), `probe-canvas-windows-${process.pid}-${mode}.jsonl`);
    const winStop = path.join(os.tmpdir(), `probe-canvas-windows-${process.pid}-${mode}.stop`);
    for (const f of [winLog, winStop, env.PROBE_ARM].filter(Boolean)) { try { fs.unlinkSync(f); } catch { /* none yet */ } }
    const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'probe71', 'watch-windows.ps1'),
      '-Root', String(child.pid), '-Log', winLog, '-Stop', winStop, ...(env.PROBE_ARM ? ['-Arm', env.PROBE_ARM] : [])], { stdio: 'ignore', windowsHide: true });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => { killPidTree(child.pid); reject(new Error('timeout\n' + log.slice(-800))); }, 280000);
    child.on('exit', () => {
      clearTimeout(timer);
      try { killPidTree(child.pid); } catch { /* already gone */ }
      try { fs.writeFileSync(winStop, 'stop'); } catch { /* the watcher also ends when the root process does */ }
      setTimeout(() => { try { killPidTree(watcher.pid); } catch { /* already gone */ } }, 1500);
      let data = null;
      try { data = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* reported below */ }
      let windows = [];
      try { windows = fs.readFileSync(winLog, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { /* none seen */ }
      if (data) data.windows = windows;
      for (const f of [winLog, winStop, env.PROBE_ARM].filter(Boolean)) { try { fs.unlinkSync(f); } catch { /* temp */ } }
      try { fs.unlinkSync(out); } catch { /* temp */ }
      try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
      if (!data) reject(new Error('no result\n' + log.slice(-800))); else resolve(data);
    });
  });
}

// The windows the watcher saw while one vector ran (its span, plus the half second a dialog takes to show).
const during = (run, name) => { const sp = run.spans && run.spans[name]; return sp ? (run.windows || []).filter(w => w.t >= sp.from && w.t <= sp.to + 500) : []; };
const isNativeDialog = (w) => w.cls === '#32770';
const leaked = (h) => (h ? h.requests + h.connections : 0);
const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const failures = [];
  const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

  console.log('SEALED RUN (the panel as the app builds it)');
  const s = await runElectron('sealed');
  console.log(`  Electron ${s.electron} (Chromium ${s.chrome})`);
  console.log('  ' + pad('path', 34) + pad('hits', 6) + 'answer');
  for (const name of s.names) console.log('  ' + pad(name, 34) + pad(leaked(s.hits[name]), 6) + String(s.results[name]).slice(0, 60));
  console.log(`  WebRTC STUN datagrams: ${s.rtc.stunDatagrams}   TURN-over-TCP connections: ${s.rtc.turnTcpConnections}   DNS queries for the hinted names: ${s.dns.queries} ${JSON.stringify(s.dns.kinds)}`);
  console.log(`  windows main was asked to open: ${s.windowOpens}   navigations of the app page: ${s.ownerNavigations.length}   messages delivered to the session: ${JSON.stringify(s.delivered)}`);

  console.log(`  native windows the watcher saw in the panel's process tree: ${s.windows.length} ${JSON.stringify(s.windows.map(w => ({ cls: w.cls, title: w.title })))}`);

  for (const name of s.names) {
    if (name === 'fetch-approved (control)') {
      check(String(s.results[name]) === '200' && s.approvedHits >= 1, 'control: the approved host IS reached through the broker (so a hit can be seen)');
    } else if (name === 'send-with-click') {
      continue;
    } else {
      check(leaked(s.hits[name]) === 0, `${name}: 0 hits on the denied server (saw ${leaked(s.hits[name])})`);
    }
  }
  const answer = (n) => String(s.results[n]);
  check(/^blocked/.test(answer('fetch-denied-host (broker)')) && s.asked.length >= 1, 'a new host is asked about, and the answer "deny" makes the fetch fail');
  check(/^blocked/.test(answer('fetch-redirect-offsite (broker)')), 'a redirect from the approved host to another host is refused by the broker');
  check(/^blocked/.test(answer('fetch-loopback-approved (broker)')) && /computer or its network/.test(answer('fetch-loopback-approved (broker)')), 'an APPROVED loopback address is still refused by the broker');
  check(/^blocked/.test(answer('fetch-rebind-approved (broker)')) && /computer or its network/.test(answer('fetch-rebind-approved (broker)')), 'an approved name that resolves to loopback (rebinding) is refused by the broker');
  check(answer('app-bridge') === 'undefined/undefined/undefined/undefined/undefined', `the panel sees no app bridge, require, process or electron (got ${answer('app-bridge')})`);
  check(answer('bridge-surface') === 'fetch,send', `the panel's own bridge is exactly fetch and send (got ${answer('bridge-surface')})`);
  check(answer('window-open') === 'null', 'window.open returns null');
  check(!/^read:/.test(answer('clipboard-read')), `the clipboard is unreadable (got ${answer('clipboard-read')})`);
  check(!/^(wrote|set|opened)/.test(answer('local-storage')) && !/^(set|opened)/.test(answer('cookie')) && !/^opened/.test(answer('indexed-db')), 'storage, cookies and indexedDB are unusable');
  check(answer('geolocation-camera') === 'rejected/rejected', `geolocation and camera are refused (got ${answer('geolocation-camera')})`);
  check(answer('dialog-loop') === 'past the dialogs', `alert, confirm and prompt return at once with no native dialog, so the page cannot lock the app's window (got ${answer('dialog-loop')})`);
  // Native dialogs that disableDialogs does not cover (PR #122 Dexter R2-1, R2-3). A native dialog (message box, print, file chooser) is a
  // visible top-level window of class #32770 in the Electron tree; the watcher closes it by handle. MEASURED (Electron 33.4.11, Windows 11):
  // window.print() raises NO window, it blocks the panel's own renderer instead (no report in 50 s, like for(;;){}; the app stays usable);
  // <input type=file> raises none either, even with nothing sealed and the owner focused; <input type=color> raises a Chromium popup widget
  // (Chrome_WidgetWin_1, not a dialog) when the owner has focus. So these three checks are guards: they fail if any becomes a native dialog.
  const dialogs = (run, name) => (name ? during(run, name) : (run.windows || [])).filter(isNativeDialog);
  // print-loop is a KNOWN GAP (verify/probe71/vector-modes.js): run only with PROBE_KNOWN_GAPS=1, because it hangs the process's exit.
  for (const name of ['print-loop', 'file-picker-with-click', 'color-picker-with-click'].filter(n => s.names.includes(n))) {
    check(dialogs(s, name).length === 0, `${name}: no native dialog window appeared (saw ${JSON.stringify(dialogs(s, name).map(w => w.cls + ':' + w.title))}; the panel answered "${answer(name)}")`);
  }
  check(dialogs(s).length === 0, `no native dialog window of any kind appeared in the panel's process tree during the run (saw ${dialogs(s).length})`);
  check(s.downloads.length >= 1 && s.downloads.every(d => d.prevented && !d.written), `a download the page starts itself (a data: link with download=) is cancelled: no Save-As box, no file (saw ${JSON.stringify(s.downloads)})`);
  check(answer('beforeunload-pin') === 'replaced', `a page whose beforeunload handler cancels leaving it is replaced by the next page Claude writes (got ${answer('beforeunload-pin')})`);
  check(s.rtc.stunDatagrams === 0, 'WebRTC STUN over UDP: 0 datagrams');
  check(s.rtc.turnTcpConnections === 0, 'WebRTC TURN over TCP to a loopback port: 0 connections');
  check(s.dns.queries === 0, `DNS prefetch / preconnect of a hinted name: 0 queries (saw ${s.dns.queries} ${JSON.stringify(s.dns.kinds)})`);
  check(s.windowOpens === 0, 'window.open and target=_blank never reach main');
  check(s.ownerNavigations.length === 0, 'the app page itself is never navigated');
  check(s.delivered.length === 1 && s.delivered[0].text === 'hello from a click', 'a real click delivers exactly one message, and a script pressing its own button delivers none');

  console.log('\nNAIVE RUN (the control: the same page, nothing sealed)');
  const n = await runElectron('naive');
  console.log(`  frame self-navigation reached its server: ${leaked(n.hits['self-location-href'])}   STUN datagrams: ${n.rtc.stunDatagrams}   TURN-over-TCP connections: ${n.rtc.turnTcpConnections}   DNS queries: ${n.dns.queries} ${JSON.stringify(n.dns.kinds)}`);
  check(leaked(n.hits['self-location-href']) >= 1, 'control: with nothing sealed, a self-navigation reaches its server');
  check(n.rtc.stunDatagrams >= 1, 'control: with nothing sealed, WebRTC STUN reaches its server');
  check(n.rtc.turnTcpConnections >= 1, 'control: with nothing sealed, WebRTC TURN over TCP reaches its server');
  check(n.dns.queries >= 1, 'control: with nothing sealed, DNS prefetch resolves the hinted name');

  console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : '\nOK: every blocked path reported 0 hits');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
