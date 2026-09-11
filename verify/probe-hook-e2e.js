'use strict';
/* End-to-end wiring check for the hook path, through the real host process:
   host boots -> writes the settings file -> binds the bridge -> the native
   helper delivers an event the host actually logs.

   This is the first check that exercises the pieces together rather than the
   bridge and the helper separately. */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 7705;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
host.stdout.on('data', d => { log += d.toString(); });
host.stderr.on('data', d => { log += d.toString(); });

(async () => {
  await sleep(4000);

  const m = log.match(/hook bridge listening on (\S+)/);
  if (!m) {
    console.log('FAIL: host never reported a listening bridge.');
    console.log(log.split('\n').slice(0, 12).join('\n'));
    try { host.kill(); } catch {}
    process.exit(1);
  }
  const pipe = m[1];
  console.log('bridge pipe :', pipe);

  const helper = path.join(REPO, '.harness', 'hook-helper.exe');
  const payload = JSON.stringify({
    session_id: 'e2e',
    tool_name: 'Task',
    tool_input: { subagent_type: 'logic-reviewer' },
  });

  const before = log.length;
  const r = spawnSync(helper, ['--pipe', pipe, '--event', 'PreToolUse'], {
    input: payload, windowsHide: true,
  });
  console.log('helper exit :', r.status);
  await sleep(700);

  const fresh = log.slice(before);
  const sawEvent = /\[hook\] PreToolUse/.test(fresh);
  const sawSubagent = /logic-reviewer/.test(fresh);

  console.log('host logged event         :', sawEvent);
  console.log('subagent_type round-tripped:', sawSubagent);
  console.log('host output               :', fresh.trim().split('\n').filter(Boolean).slice(0, 3).join(' | '));

  try { host.kill(); } catch {}
  const ok = sawEvent && sawSubagent && r.status === 0;
  console.log('\n' + (ok
    ? 'PASS: hook path is wired end to end through the real host.'
    : 'FAIL: event did not reach the host.'));
  process.exit(ok ? 0 : 1);
})();
