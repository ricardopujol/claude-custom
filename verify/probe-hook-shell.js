'use strict';
/* The hook COMMAND STRING, run exactly as a shell would run it.

   The settings file is correct and Claude Code does invoke it -- verified
   separately -- yet no event arrives. The remaining suspect is what the shell
   does to the command on the way: the pipe name starts with two backslashes,
   and a shell that treats backslash as an escape inside double quotes eats one
   of them, leaving a name that cannot connect to anything. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { posixShell } = require('../test/posix-shell');

const REPO = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: '7801', CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  await sleep(11000);
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.harness', 'harness-settings.json'), 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  console.log('command as written:\n  ' + command + '\n');

  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: {} });
  const before = () => (log.match(/\[hook\] PreToolUse/g) || []).length;

  // windowsVerbatimArguments for cmd: without it Node escapes the embedded
  // quotes as \" , which cmd does not understand -- a failure of the probe
  // rather than of the command, and one that reads identically.
  const shells = [
    // cmd strips the first and last quote of a /c line, so a command that
    // STARTS with a quoted path needs the whole line wrapped again. That is
    // cmd's calling convention, not a property of the command.
    ['cmd.exe',  ['/c', '"' + command + '"'], { windowsVerbatimArguments: true }],
    // Not a bare 'bash': from PowerShell that is the WSL launcher, which fails
    // and would blame the command for a PATH problem (BACKLOG #72, #24).
    ...(posixShell() ? [[posixShell(), ['-c', command], {}]] : []),
  ];
  if (!posixShell()) console.log('SKIP  no POSIX shell on this machine');
  for (const [bin, args, extra] of shells) {
    const n = before();
    const r = spawnSync(bin, args, { input: payload, windowsHide: true, encoding: 'utf8', ...extra });
    await sleep(900);
    const delivered = before() > n;
    check(`${path.basename(bin)} delivers the event`, delivered,
      delivered ? '' : `exit=${r.status} err=${(r.stderr || '').trim().slice(0, 120)}`);
  }

  try { host.kill(); } catch {}
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
