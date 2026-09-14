'use strict';
/* The secret store, in a REAL Electron window with REAL safeStorage.

   The unit tests inject a fake cipher, so they prove the vault's behaviour and
   nothing about DPAPI. This drives the actual UI: store a secret, confirm the
   file on disk holds no plaintext, copy it and read the OS clipboard back.

   It also asserts the property the whole feature rests on -- that the secret
   never reaches the host, which owns the pty. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const VAULT = path.join(REPO, '.harness', 'secrets.enc');
const SECRET = 'probe-secret-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  try { fs.unlinkSync(VAULT); } catch {}

  const app = spawn(require('electron'), [REPO], {
    env: {
      ...process.env,
      CLAUDE_CUSTOM_PORT: '7803',
      CLAUDE_CUSTOM_CWD: REPO,
      CLAUDE_CUSTOM_VAULT_PROBE: SECRET,
      CLAUDE_CUSTOM_SCREENSHOT: path.join(REPO, '.harness', 'vault.png'),
      CLAUDE_CUSTOM_SCREENSHOT_DELAY: '20000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', d => { out += d.toString(); });
  app.stderr.on('data', d => { out += d.toString(); });

  await sleep(24000);
  try { app.kill(); } catch {}

  const say = (re) => (out.match(re) || [])[1];

  check('safeStorage can encrypt on this machine', /\[vault-probe\] available: true/.test(out),
    say(/\[vault-probe\] available: (\w+)/));
  check('a secret was stored through the real UI path',
    /\[vault-probe\] stored: true/.test(out), say(/\[vault-probe\] stored: (\S+)/));
  check('it is listed by label', /\[vault-probe\] listed: 1/.test(out),
    say(/\[vault-probe\] listed: (\d+)/));
  check('list carries no secret value', /\[vault-probe\] list-leaks: false/.test(out));
  check('reveal returns the exact secret', /\[vault-probe\] revealed-matches: true/.test(out));
  check('copy puts it on the real OS clipboard', /\[vault-probe\] clipboard-matches: true/.test(out));

  // The file is the durable artifact. The entry is deliberately LEFT in place:
  // checking a vault the probe had just emptied made "no plaintext on disk"
  // pass vacuously against 25 bytes of {"entries":[]}.
  const onDisk = fs.existsSync(VAULT) ? fs.readFileSync(VAULT) : Buffer.alloc(0);
  check('the vault file exists and holds the entry', onDisk.length > 0, onDisk.length + ' bytes');
  check('the stored entry is really in the file, so the next check is not vacuous',
    onDisk.includes('probe entry'), 'label present');
  check('the file holds NO plaintext secret', !onDisk.includes(SECRET),
    onDisk.includes(SECRET) ? 'PLAINTEXT SECRET ON DISK' : '');

  // The property the design rests on: the host owns the pty, so a secret that
  // never reaches the host cannot be typed into the session by any wiring bug.
  const hostLog = (() => { try { return fs.readFileSync(path.join(REPO, '.harness', 'host.log'), 'utf8'); } catch { return ''; } })();
  check('the secret never appears in the host log', !hostLog.includes(SECRET));
  check('the secret never appears in the app output', !out.includes(SECRET));

  try { fs.unlinkSync(VAULT); } catch {}   // the probe cleans up after itself
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
