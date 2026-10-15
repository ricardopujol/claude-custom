'use strict';
/* Renders the real Electron GUI with a populated agent roster and writes a PNG.

   The GUI is the one surface the headless probes cannot reach. This drives real
   hook events through the real helper and bridge so the sidebar is exercised in
   every mood state, rather than only in its empty state. */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7711;
const OUT = process.env.OUT || path.join(REPO, '.harness', 'gui-roster.png');
const HELPER = path.join(REPO, '.harness', 'hook-helper.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stdout.on('data', d => { hostLog += d.toString(); });
host.stderr.on('data', d => { hostLog += d.toString(); });

const fire = (pipe, event, payload) =>
  spawnSync(HELPER, ['--pipe', pipe, '--event', event], {
    input: JSON.stringify(payload), windowsHide: true,
  });

(async () => {
  await sleep(3500);
  const pipe = (hostLog.match(/hook bridge listening on (\S+)/) || [])[1];
  if (!pipe) { console.error('no bridge; host log:\n' + hostLog); process.exit(1); }
  console.log('bridge:', pipe);

  // Fired AFTER the GUI has attached and shortly before capture. happy and
  // stressed are 8-second flashes that decay to sleeping, so firing them up
  // front captures two sleeping agents and proves nothing about those styles.
  const task = agent => ({ tool_name: 'Agent', tool_input: { subagent_type: agent } });

  const SCREENSHOT_DELAY = 11000;

  // Fired early on purpose: its 8s flash expires before capture, so the
  // sleeping style is exercised alongside the live ones.
  fire(pipe, 'PreToolUse', task('archibaldo'));
  fire(pipe, 'SubagentStop', {});

  setTimeout(() => {
    // working
    fire(pipe, 'PreToolUse', task('code-reviewer'));
    // another working agent, so the sort order is visible
    fire(pipe, 'PreToolUse', task('ui-ux-tester'));
    // a long name, to exercise truncation
    fire(pipe, 'PreToolUse', task('reinforcement-learning-engineer'));
    // stressed: a failing Bash, then the agent finishes with errors
    fire(pipe, 'PreToolUse', task('logic-reviewer'));
    fire(pipe, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { exit_code: 1 } });
    fire(pipe, 'SubagentStop', {});
    // happy: a clean run
    fire(pipe, 'PreToolUse', task('mutation-tester'));
    fire(pipe, 'SubagentStop', {});
    // one that never ran, left sleeping for contrast
    fire(pipe, 'PreToolUse', task('spec-partner'));
    fire(pipe, 'SubagentStop', {});
  }, SCREENSHOT_DELAY - 2500);

  const electron = spawnElectron(require('electron'),
    ['.'],
    {
      cwd: REPO,
      env: {
        ...process.env,
        CLAUDE_CUSTOM_PORT: String(PORT),
        CLAUDE_CUSTOM_SCREENSHOT: OUT,
        CLAUDE_CUSTOM_SCREENSHOT_DELAY: String(SCREENSHOT_DELAY),
      },
      stdio: 'inherit',
    }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_SCREENSHOT', 'CLAUDE_CUSTOM_SCREENSHOT_DELAY'] }
  );

  electron.on('exit', () => {
    console.log('screenshot:', OUT);
    try { host.kill(); } catch {}
    process.exit(0);
  });
})();
