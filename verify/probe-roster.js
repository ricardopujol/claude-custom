'use strict';
/* Does an agent actually appear in the roster when one is deployed?

   Reported as: "I asked the session to deploy dexter and miguel, it did, but
   they were not visible in their portrait tab." Every headless check of this
   path passes, so this one drives the REAL window and photographs the result. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

  const app = spawn(require('electron'), [REPO], {
    env: {
      ...process.env,
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: REPO,
      CLAUDE_CUSTOM_SCREENSHOT: SHOT,
      CLAUDE_CUSTOM_SCREENSHOT_DELAY: '26000',
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
        input: JSON.stringify({ tool_name: 'Task', tool_input: { subagent_type: agent } }),
        windowsHide: true,
      });
      await sleep(400);
    }
  }

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

  try { app.kill(); } catch {}
  spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { windowsHide: true });
  console.log(failures === 0 ? '\nALL PASS — now LOOK at ' + SHOT : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
