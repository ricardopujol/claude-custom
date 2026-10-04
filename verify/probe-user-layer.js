'use strict';
/* Does `--settings` REPLACE the user layer's hooks, or accumulate with them?

   probe-settings.js showed the CLI file's `statusLine` replaced the user's.
   probe-hook-layers.js showed the CLI file's `hooks` did NOT replace the
   PROJECT layer's. Two hypotheses survive both results:

     H1  hooks accumulate across every layer, statusLine is single-valued
         => the writer needs no union; unioning would DOUBLE-FIRE user hooks
     H2  --settings substitutes for the USER layer specifically, while the
         project layer is always additive
         => the writer MUST union the user's hooks or all 12 are lost

   Only a user-layer measurement separates them, and the two failure modes are
   asymmetric (double-firing is visible, silent loss is not), so this is
   measured rather than reasoned.

   Isolation: an alternate home whose `.claude.json` (trust/onboarding state)
   and `.credentials.json` are HARD LINKS to the real ones -- no secret bytes
   are duplicated on disk, and unlinking the temp tree cannot affect the
   originals. The real ~/.claude/settings.json is never read as the user layer
   here; the alternate home supplies a marker instead. Nothing real is modified.

   An earlier attempt used a bare empty home and produced no marker at all:
   without `.claude.json` the directory is untrusted and hooks never run. That
   run is why the control below is mandatory. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const BIN = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REAL_HOME = os.homedir();
const WORK = 'C:/Users/ricar/VibeCode/claude-custom';   // already a trusted project

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-userlayer-'));
const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

const markers = path.join(tmp, 'markers.txt').replace(/\\/g, '/');

const hookFor = tag => ({
  SessionStart: [{
    matcher: '',
    hooks: [{
      type: 'command',
      command: `node -e "require('fs').appendFileSync('${markers}','${tag}\\n')"`,
      timeout: 10,
    }],
  }],
});

// Trust state + credentials by hard link: same bytes on disk, independent name.
let linked = [];
for (const [src, dst] of [
  [path.join(REAL_HOME, '.claude.json'), path.join(fakeHome, '.claude.json')],
  [path.join(REAL_HOME, '.claude', '.credentials.json'), path.join(fakeHome, '.claude', '.credentials.json')],
]) {
  try { fs.linkSync(src, dst); linked.push(path.basename(dst)); }
  catch (e) { try { fs.copyFileSync(src, dst); linked.push(path.basename(dst) + '(copy)'); } catch {} }
}

// The isolated USER layer.
fs.writeFileSync(
  path.join(fakeHome, '.claude', 'settings.json'),
  JSON.stringify({ hooks: hookFor('USER') }, null, 2)
);

const cliSettings = path.join(tmp, 'cli-settings.json');
fs.writeFileSync(cliSettings, JSON.stringify({ hooks: hookFor('CLI') }, null, 2));

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

async function run(label, args) {
  try { fs.unlinkSync(markers); } catch {}
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
                   'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_SESSION_ID']) delete env[k];
  env.USERPROFILE = fakeHome;
  env.HOME = fakeHome;
  env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude');

  const p = pty.spawn(BIN, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: WORK, env });
  let out = '';
  p.onData(d => { out += d; });
  await sleep(14000);
  try { p.kill(); } catch {}

  let got = '';
  try { got = fs.readFileSync(markers, 'utf8'); } catch {}
  const tags = got.split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`\n===== ${label} =====`);
  console.log('booted (prompt rendered):', /❯/.test(out));
  console.log('markers                 :', JSON.stringify(tags));
  return { tags: new Set(tags), booted: /❯/.test(out) };
}

(async () => {
  console.log('alternate home :', fakeHome);
  console.log('hard-linked    :', linked.join(', ') || '(none)');

  const base = await run('BASELINE (no --settings) [control]', []);
  const cli = await run('WITH --settings supplying hooks', ['--settings', cliSettings]);

  console.log('\n================ VERDICT ================');
  if (!base.tags.has('USER')) {
    console.log('INCONCLUSIVE: the isolated user layer did not fire in the control');
    console.log('run (booted=' + base.booted + '), so shadowing cannot be told apart');
    console.log('from a layer that never applied. Do NOT guess from this run.');
  } else if (cli.tags.has('CLI') && cli.tags.has('USER')) {
    console.log('H1 CONFIRMED: hooks ACCUMULATE across the user layer too.');
    console.log('=> --settings does NOT drop user hooks. No union needed, and');
    console.log('   unioning would make every user hook fire TWICE.');
  } else if (cli.tags.has('CLI') && !cli.tags.has('USER')) {
    console.log('H2 CONFIRMED: --settings REPLACES the user layer hooks.');
    console.log('=> The writer MUST union the user hooks, or all 12 are lost.');
  } else {
    console.log('UNEXPECTED: CLI hook did not fire. markers =', JSON.stringify([...cli.tags]));
  }
  console.log('=========================================');
  cleanup();
  console.log('temp tree removed.');
  process.exit(0);
})();
