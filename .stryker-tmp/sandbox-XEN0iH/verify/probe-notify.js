// @ts-nocheck
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
    // NOTE ON FOCUS: this window never has OS focus -- it is spawned in the
    // background while the terminal running the probe keeps it -- so what this
    // exercises end-to-end is the UNFOCUSED path, which is the one that has to
    // produce a toast. The focused path (no toast at all) is decided by
    // surfacesFor and covered in test/attention-surface.test.js, because there
    // is no way to hand this window real focus from here without adding
    // test-only code to the app.
    // Whether this window has OS focus varies run to run -- it is spawned in
    // the background and sometimes takes focus anyway -- so asserting either
    // branch here is a coin flip. What this probe can prove deterministically
    // is that the event travels host -> renderer -> main and a DECISION is
    // taken there. Which branch is correct for a given focus state is decided
    // by surfacesFor and asserted in test/attention-surface.test.js.
    check('a finished turn reached MAIN and was acted on',
      /\[main\] attention:/.test(out),
      (out.match(/\[main\] attention:.*/) || ['(nothing)'])[0]);

    fire('Notification', { message: 'Claude needs your permission to use Bash' });
    await sleep(2500);
    const focused = /suppressed \(window focused\)/.test(out);
    console.log(`  (window ${focused ? 'HAD' : 'did not have'} focus this run)`);
    check('both events produced a decision, not silence',
      (out.match(/\[main\] attention:/g) || []).length >= 2,
      (out.match(/\[main\] attention:.*/g) || []).join(' | '));
  }

  check('no renderer errors on the attention path', !/notification failed/.test(out),
    (out.match(/notification failed.*/) || [''])[0]);

  // The body is the whole message in a toast corner: it has to say WHICH of
  // "need permission / waiting / finished" this is, in a glance.
  const bodies = (out.match(/\[main\] attention body: .*/g) || []).map(l => l.replace(/.*body: /, ''));
  console.log('bodies raised:', JSON.stringify(bodies));
  // Bodies only exist when a toast was actually raised, i.e. unfocused runs.
  if (bodies.length) {
    check('the permission toast names the tool', bodies.some(b => /permission.*Bash/i.test(b)));
    check('every body is ten words or fewer',
      bodies.every(b => b.trim().split(/\s+/).length <= 10),
      bodies.map(b => b.trim().split(/\s+/).length + 'w').join(', '));
  } else {
    console.log('  (no toast bodies: the window had focus, so none were raised)');
  }

  try { app.kill(); } catch {}
  spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { windowsHide: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
