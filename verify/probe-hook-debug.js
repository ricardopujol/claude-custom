'use strict';
/* Settles H1 vs H2 by reading Claude Code's own --debug hook-execution log in
   the REAL environment, with nothing modified and no alternate home.

   Earlier instruments and why they failed, so nobody retries them:
     - alternate home (probe-user-layer.js): relocating the config dir stops
       hooks running at all, including the --settings ones. Cannot distinguish
       shadowing from a disabled layer.
     - /hooks menu (probe-hooks-command.js): identical output with and without
       --settings (18 hooks, SessionStart 4 -> 4), so the menu is BLIND to the
       CLI layer and its reassuring output proves nothing.

   Here the question is asked of execution itself: run with --settings supplying
   one marker SessionStart hook, and see whether the USER's real SessionStart
   hook (pixel-agents claude-hook.js) still executes alongside it.

     both execute    -> H1: hooks accumulate; do NOT union (would double-fire)
     only marker     -> H2: user hooks replaced; the writer MUST union */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const BIN = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hookdbg-'));
const markers = path.join(tmp, 'markers.txt').replace(/\\/g, '/');
const cliSettings = path.join(tmp, 'cli-settings.json');
fs.writeFileSync(cliSettings, JSON.stringify({
  hooks: {
    SessionStart: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node -e "require('fs').appendFileSync('${markers}','CLI\\n')"`,
        timeout: 10,
      }],
    }],
  },
}, null, 2));

async function run(label, args) {
  try { fs.unlinkSync(markers); } catch {}
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
                   'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_SESSION_ID']) delete env[k];

  const p = pty.spawn(BIN, ['--debug', ...args], {
    name: 'xterm-256color', cols: 200, rows: 50, cwd: REPO, env,
  });
  let out = '';
  p.onData(d => { out += d; });
  await sleep(15000);
  try { p.kill(); } catch {}

  let got = '';
  try { got = fs.readFileSync(markers, 'utf8'); } catch {}

  const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const hookLines = plain.split('\n')
    .map(s => s.trim())
    .filter(s => /hook/i.test(s) && s.length > 8);

  const userHookRan = /pixel-agents|claude-hook\.js/i.test(plain);
  const cliMarkerRan = /CLI/.test(got);

  console.log(`\n===== ${label} =====`);
  console.log('args              :', JSON.stringify(args));
  console.log('marker file       :', JSON.stringify(got.trim()));
  console.log('user hook in log  :', userHookRan);
  console.log('sample hook lines :');
  for (const l of hookLines.slice(0, 12)) console.log('   ', l.slice(0, 160));
  return { userHookRan, cliMarkerRan, hookLines };
}

(async () => {
  const base = await run('BASELINE --debug (no --settings) [control]', []);
  const cli = await run('--debug WITH --settings supplying SessionStart', ['--settings', cliSettings]);

  console.log('\n================ VERDICT ================');
  if (!base.userHookRan) {
    console.log('INCONCLUSIVE: the control run shows no evidence the user SessionStart');
    console.log('hook executed, so its absence in the second run would prove nothing.');
    console.log('--debug may not name hook commands in this version.');
  } else if (cli.cliMarkerRan && cli.userHookRan) {
    console.log('H1 CONFIRMED: user hook STILL executed alongside the --settings hook.');
    console.log('=> hooks ACCUMULATE. The writer must NOT union the user hooks;');
    console.log('   doing so would run every one of them twice.');
  } else if (cli.cliMarkerRan && !cli.userHookRan) {
    console.log('H2 CONFIRMED: the user hook stopped executing once --settings');
    console.log('supplied a hooks key. => The writer MUST union the user hooks.');
  } else {
    console.log('UNEXPECTED: the --settings hook itself did not run.');
  }
  console.log('=========================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
