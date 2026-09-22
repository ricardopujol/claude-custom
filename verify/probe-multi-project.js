'use strict';
/**
 * Two projects, two hosts, no cross-talk.  (re-runnable)
 *
 * Records the bug this feature removed: `app/main.js` used to ask only whether
 * something was listening on port 7681 and reattach if so. The host is spawned
 * DETACHED on purpose -- it must outlive its window so a Remote Control session
 * survives closing the GUI -- so opening project B while project A's host was
 * alive gave you A's session inside B's window. Right title, wrong files, no
 * error anywhere.
 *
 * The unit tests cover the decision. Nothing covers the WIRING: that two real
 * hosts pick different ports, publish who they are, and that the handshake
 * reaches the right verdict about the files they actually wrote. That is what
 * this measures, with real processes and real sockets.
 *
 *   node verify/probe-multi-project.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const HARNESS_DIR = path.join(REPO, '.harness');
const { portForCwd } = require(path.join(REPO, 'host', 'port-for-project'));
const { readIdentity } = require(path.join(REPO, 'host', 'host-identity'));
const { decideAttach } = require(path.join(REPO, 'host', 'handshake'));

const listening = port => new Promise(resolve => {
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = r => { sock.destroy(); resolve(r); };
  sock.setTimeout(500);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});

const waitFor = async (fn, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-b-'));
  console.log('project A:', a);
  console.log('project B:', b);

  const portA = portForCwd(a);
  const portB = portForCwd(b);
  check('two projects derive two different ports', portA !== portB, `${portA} vs ${portB}`);

  const kids = [];
  const start = (cwd, port) => {
    const log = fs.openSync(path.join(os.tmpdir(), `cc-probe-${port}.log`), 'a');
    const child = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
      stdio: ['ignore', log, log],
      env: { ...process.env, CLAUDE_CUSTOM_CWD: cwd, CLAUDE_CUSTOM_PORT: String(port) },
    });
    kids.push(child);
    return child;
  };

  try {
    start(a, portA);
    start(b, portB);

    const upA = await waitFor(() => listening(portA));
    const upB = await waitFor(() => listening(portB));
    check('host A came up', upA, `port ${portA}`);
    check('host B came up', upB, `port ${portB}`);
    if (!upA || !upB) {
      console.log(`(host logs: ${path.join(os.tmpdir(), `cc-probe-${portA}.log`)} and ...${portB}.log)`);
      return;
    }

    const identA = readIdentity({ dir: HARNESS_DIR, port: portA });
    const identB = readIdentity({ dir: HARNESS_DIR, port: portB });
    check('host A published which project it serves', !!identA, identA && identA.cwd);
    check('host B published which project it serves', !!identB, identB && identB.cwd);

    // THE REGRESSION. Before the fix, a window for B seeing a live socket on
    // A's port would have attached to it.
    const wrong = decideAttach({ requestedCwd: b, occupant: identA });
    check("project B REFUSES project A's host", wrong.action === 'refuse',
      `${wrong.action}/${wrong.reason}`);

    const right = decideAttach({ requestedCwd: a, occupant: identA });
    check('project A reattaches to its own host', right.action === 'attach', right.action);

    // Per-port tokens, the bug found while wiring: one shared file is
    // last-writer-wins, so A's window would have been refused by its own
    // gatekeeper after B started.
    const tokA = path.join(HARNESS_DIR, 'hosts', `${portA}.token`);
    const tokB = path.join(HARNESS_DIR, 'hosts', `${portB}.token`);
    const bothExist = fs.existsSync(tokA) && fs.existsSync(tokB);
    check('each host wrote its own token file', bothExist);
    if (bothExist) {
      check('and the two tokens differ',
        fs.readFileSync(tokA, 'utf8') !== fs.readFileSync(tokB, 'utf8'));
    }
  } finally {
    for (const k of kids) { try { process.kill(k.pid); } catch {} }
    await new Promise(r => setTimeout(r, 800));
    // The identity file must not outlive the host as a live claim.
    const goneA = !readIdentity({ dir: HARNESS_DIR, port: portA });
    const goneB = !readIdentity({ dir: HARNESS_DIR, port: portB });
    check('a killed host stops claiming its port', goneA && goneB);
    try { fs.rmSync(a, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(b, { recursive: true, force: true }); } catch {}
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
