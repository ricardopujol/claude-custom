// @ts-nocheck
'use strict';
/* When `--settings` supplies a `hooks` key, WHICH layers does it replace?

   This decides the merged-settings writer's contract:
     - replaces every layer  -> the writer must union hooks from all of them
     - replaces only `user`  -> unioning the project layer too would make
                                project hooks fire TWICE

   Both failure modes are silent, so this is measured, not assumed.

   Method: run claude in a throwaway cwd that carries its own
   .claude/settings.json, with a SessionStart hook that appends a marker to a
   file. The --settings file carries a SessionStart hook with a different
   marker. Which markers land tells us what survived. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const BIN = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-layers-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });

const markers = path.join(tmp, 'markers.txt').replace(/\\/g, '/');

// A SessionStart hook that appends `tag` to the markers file.
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

fs.writeFileSync(
  path.join(work, '.claude', 'settings.json'),
  JSON.stringify({ hooks: hookFor('PROJECT') }, null, 2)
);

const cliSettings = path.join(tmp, 'cli-settings.json');
fs.writeFileSync(cliSettings, JSON.stringify({ hooks: hookFor('CLI') }, null, 2));

async function run(label, args) {
  try { fs.unlinkSync(markers); } catch {}
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
                   'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_SESSION_ID']) delete env[k];

  const p = pty.spawn(BIN, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: work, env });
  let out = '';
  p.onData(d => { out += d; });
  await sleep(12000);
  try { p.kill(); } catch {}

  let got = '';
  try { got = fs.readFileSync(markers, 'utf8'); } catch {}
  const tags = got.split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`\n===== ${label} =====`);
  console.log('args    :', JSON.stringify(args));
  console.log('markers :', JSON.stringify(tags));
  return new Set(tags);
}

(async () => {
  const base = await run('BASELINE (no --settings) [control]', []);
  const cli = await run('WITH --settings supplying hooks', ['--settings', cliSettings]);

  console.log('\n================ VERDICT ================');
  if (!base.has('PROJECT')) {
    console.log('INCONCLUSIVE: project-layer hook never fired in the control run;');
    console.log('cannot tell shadowing from a hook that simply does not run here.');
  } else if (cli.has('CLI') && cli.has('PROJECT')) {
    console.log('PROJECT LAYER SURVIVES --settings.');
    console.log('=> Writer must union ONLY the layers that are actually replaced.');
    console.log('   Unioning the project layer as well would DOUBLE-FIRE its hooks.');
  } else if (cli.has('CLI') && !cli.has('PROJECT')) {
    console.log('PROJECT LAYER IS REPLACED by --settings hooks.');
    console.log('=> Writer must union hooks from EVERY layer, project included,');
    console.log('   or those hooks are silently lost.');
  } else {
    console.log('UNEXPECTED: CLI hook did not fire. markers =', JSON.stringify([...cli]));
  }
  console.log('=========================================');
  process.exit(0);
})();
