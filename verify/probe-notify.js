'use strict';
/* End-to-end: a real Electron window, a real host, a real hook fired through the
   real helper -- ending in a real OS toast raised by the main process.

   Written because the bug it fixes was invisible to every other check: the
   renderer received the attention message, ran its handler without error, and
   showed nothing, because the handler's own focus guard skipped the toast. Only
   a probe that watches MAIN can tell "delivered" from "displayed". */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 7797;
const LOG = path.join(REPO, '.harness', 'host.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  try { fs.truncateSync(LOG, 0); } catch {}

  // The electron module exports the path to the real binary. The .cmd shim
  // swallows stdout when spawned with shell:true, which reads exactly like the
  // app printing nothing.
  const app = spawn(require('electron'), [REPO], {
    env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', d => { out += d.toString(); });
  app.stderr.on('data', d => { out += d.toString(); });

  await sleep(14000);

  const hostLog = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
  const pipe = (hostLog.match(/hook bridge listening on (\S+)/) || [])[1];
  check('the app spawned a host with a hook bridge', !!pipe, pipe);
  if (!pipe) { console.log('--- app output ---'); console.log(out.slice(0, 1500));
               console.log('--- host log ---'); console.log(hostLog.slice(0, 600)); }

  const helper = path.join(REPO, '.harness', 'hook-helper.exe');
  const fire = (event, payload) => spawnSync(helper, ['--pipe', pipe, '--event', event],
    { input: JSON.stringify(payload), windowsHide: true });

  if (pipe) {
    fire('Stop', {});
    await sleep(2500);
    check('a finished turn reached MAIN, i.e. an OS toast was raised',
      /\[main\] attention:.*finished/.test(out),
      (out.match(/\[main\] attention:.*/) || ['(nothing)'])[0]);
    // THE REGRESSION GUARD. The window is focused here, exactly as it is when
    // you sit watching a task run -- the case that used to be silenced.
    check('it was raised despite the window having focus',
      /\[main\] attention:.*finished.*silent=true/.test(out));

    fire('Notification', { message: 'Claude needs your permission to use Bash' });
    await sleep(2500);
    check('a blocked session reached MAIN too',
      /\[main\] attention:.*needs you/.test(out),
      (out.match(/\[main\] attention:.*needs you.*/) || ['(nothing)'])[0]);
    check('a blocked session is NOT silent, even with focus',
      /\[main\] attention:.*needs you.*silent=false/.test(out));
  }

  check('no renderer errors on the attention path', !/notification failed/.test(out),
    (out.match(/notification failed.*/) || [''])[0]);

  // The body is the whole message in a toast corner: it has to say WHICH of
  // "need permission / waiting / finished" this is, in a glance.
  const bodies = (out.match(/\[main\] attention body: .*/g) || []).map(l => l.replace(/.*body: /, ''));
  console.log('bodies raised:', JSON.stringify(bodies));
  check('the permission toast names the tool', bodies.some(b => /permission.*Bash/i.test(b)));
  check('every body is ten words or fewer',
    bodies.length > 0 && bodies.every(b => b.trim().split(/\s+/).length <= 10),
    bodies.map(b => b.trim().split(/\s+/).length + 'w').join(', '));

  try { app.kill(); } catch {}
  spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { windowsHide: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
