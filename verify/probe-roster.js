'use strict';
/* Does an agent actually appear in the roster when one is deployed?

   Reported as: "I asked the session to deploy dexter and miguel, it did, but
   they were not visible in their portrait tab." Every headless check of this
   path passes, so this one drives the REAL window and photographs the result. */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');


// The host refuses any connection without the session token -- see
// host/gatekeeper.js. A local tool reads it from the file the host writes,
// which is precisely what a web page cannot do.
function sessionToken() {
  try {
    return require('fs').readFileSync(
      require('path').join(__dirname, '..', '.harness', 'session-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const withToken = (url) => url + '?token=' + encodeURIComponent(sessionToken());


const REPO = path.join(__dirname, '..');
const PORT = 7798;
const LOG = path.join(REPO, '.harness', 'host.log');
const SHOT = path.join(REPO, '.harness', 'roster.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  try { fs.truncateSync(LOG, 0); } catch {}
  try { fs.unlinkSync(SHOT); } catch {}

  const app = spawnElectron(require('electron'), [REPO], {
    env: {
      ...process.env,
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: REPO,
      CLAUDE_CUSTOM_SCREENSHOT: SHOT,
      CLAUDE_CUSTOM_SCREENSHOT_DELAY: '26000',
      CLAUDE_CUSTOM_FLOURISH: process.env.CLAUDE_CUSTOM_FLOURISH || '',
      // Which side tab to photograph: the sidebar is the one surface the
      // headless checks cannot look at.
      CLAUDE_CUSTOM_SIDE_TAB: process.env.CLAUDE_CUSTOM_SIDE_TAB || '',
      CLAUDE_CUSTOM_DEMO_SECRET: process.env.CLAUDE_CUSTOM_DEMO_SECRET || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', d => { out += d.toString(); });
  app.stderr.on('data', d => { out += d.toString(); });

  await sleep(15000);
  const hostLog = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
  const pipe = (hostLog.match(/hook bridge listening on (\S+)/) || [])[1];
  check('hook bridge is up', !!pipe, pipe);

  if (pipe) {
    const helper = path.join(REPO, '.harness', 'hook-helper.exe');
    // Exactly what Claude Code sends when a Task deploys a subagent.
    // Two agents WITH generated portraits, two without: only a handful of the
    // ~80 agents have art, so the placeholder is the common case and has to
    // look deliberate rather than broken.
    for (const agent of ['logic-reviewer', 'code-reviewer', 'mutation-tester',
                         'ui-ux-tester', 'agent-organizer', 'spec-partner',
                         'security-auditor', 'media-pipeline-engineer']) {
      spawnSync(helper, ['--pipe', pipe, '--event', 'PreToolUse'], {
        input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: agent } }),
        windowsHide: true,
      });
      await sleep(400);
    }
  }

  // Finish mutation-tester so a COOLDOWN exists to render. Mortimer is the
  // motivating case for the feature: the project rule is one run per stable
  // tree, and that rule has already been broken once, wasting a full run.
  if (pipe) {
    const helper = path.join(REPO, '.harness', 'hook-helper.exe');
    spawnSync(helper, ['--pipe', pipe, '--event', 'SubagentStop'], {
      input: JSON.stringify({ agent_type: 'mutation-tester' }), windowsHide: true,
    });
  }

  // Ask the host to run the suite. The host BROADCASTS health to every client,
  // so requesting it from a second connection lands in the Electron window too
  // -- which is how the screenshot gets a real bar instead of "no result yet".
  // Deliberately not automatic on launch: running someone's test suite the
  // moment they open a window is intrusive and slow.
  await new Promise((resolve) => {
    const probe = new WebSocket(withToken(`ws://127.0.0.1:${PORT}`));
    probe.on('open', () => {
      probe.send(JSON.stringify({ type: 'health' }));
      setTimeout(() => { try { probe.close(); } catch {} resolve(); }, 6000);
    });
    probe.on('error', resolve);
  });

  await sleep(14000);
  const log2 = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
  check('the host saw both Task hooks',
    (log2.match(/\[hook\] PreToolUse/g) || []).length >= 8,
    (log2.match(/\[hook\].*/g) || []).join(' | '));
  check('a screenshot of the real window exists', fs.existsSync(SHOT),
    fs.existsSync(SHOT) ? fs.statSync(SHOT).size + ' bytes' : 'missing');
  const rendererNoise = (out.match(/\[renderer:[a-z]+\].*/g) || []);
  check('the renderer reported no errors',
    !rendererNoise.some(l => /error|not defined|undefined is not|cannot read/i.test(l)),
    rendererNoise.filter(l => /error|not defined|undefined is not|cannot read/i.test(l)).slice(0, 3).join(' | '));
  if (!fs.existsSync(SHOT) || process.env.PROBE_VERBOSE) {
    console.log('--- app output ---');
    console.log(out.slice(-3000));
  }

  // The tree this probe started, by pid; never by name (#74 B: /IM electron.exe also killed Ricardo's own windows).
  try { require('../host/kill-tree').killPidTree(app.pid); } catch {}
  console.log(failures === 0 ? '\nALL PASS — now LOOK at ' + SHOT : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
