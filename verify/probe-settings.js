'use strict';
/* Does `--settings <file>` MERGE with the existing settings layers, or SHADOW
   them? Load-bearing: the design generates a merged file precisely because
   shadowing would silently drop hooks/MCP/Remote Control config.

   Run A: settings file with NO statusLine -> does the user's warpaint
          statusLine still render?  renders = merge, gone = shadow
   Run B: settings file WITH its own statusLine -> control, proves the file is
          actually being read (without this, "merge" is indistinguishable from
          "file silently ignored").

   Note: deliberately does NOT pass --dangerously-skip-permissions. The question
   under test is settings-layer precedence, which is orthogonal to permissions,
   and the probe should not spawn a bypassed agent just to read a status line. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const COLS = 100, ROWS = 30;
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';
const BIN = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));

function write(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

async function run(label, extraArgs) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.CLAUDE_CODE_CHILD_SESSION;   // avoid inheriting this session's marker

  const p = pty.spawn(BIN, extraArgs, {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env,
  });
  p.onData(d => term.write(d));
  await sleep(10000);

  const b = term.buffer.active, rows = [];
  for (let y = 0; y < ROWS; y++) {
    const l = b.getLine(y);
    if (l) rows.push(l.translateToString(true).replace(/\s+$/, ''));
  }
  try { p.kill(); } catch {}

  const all = rows.join('\n');
  console.log(`\n===== ${label} =====`);
  console.log('args            :', JSON.stringify(extraArgs));
  console.log('warpaint line   :', JSON.stringify(rows.find(s => /\u258C/.test(s)) || null));
  console.log('probe statusline:', /PROBE-CLI-STATUSLINE/.test(all) ? 'PRESENT' : 'absent');
  return { rows, all };
}

(async () => {
  const noStatus = write('no-status.json', { env: { CLAUDE_CUSTOM_PROBE: '1' } });
  const withStatus = write('with-status.json', {
    env: { CLAUDE_CUSTOM_PROBE: '1' },
    statusLine: { type: 'command', command: 'echo PROBE-CLI-STATUSLINE', padding: 0 },
  });

  // Run C: does the merge go DEEP inside a key, or replace the key wholesale?
  // Supplies statusLine.padding only, omitting the command warpaint needs.
  const partialStatus = write('partial-status.json', { statusLine: { padding: 1 } });

  const base = await run('BASELINE (no --settings)', []);
  const a = await run('RUN A (--settings, no statusLine key)', ['--settings', noStatus]);
  const b = await run('RUN B (--settings, own statusLine) [control]', ['--settings', withStatus]);

  const c = await run('RUN C (--settings, statusLine.padding only) [depth]', ['--settings', partialStatus]);

  const baseHas = /\u258C/.test(base.all);
  const aHas = /\u258C/.test(a.all);
  const fileRead = /PROBE-CLI-STATUSLINE/.test(b.all);

  console.log('\n================ VERDICT ================');
  console.log('baseline renders user statusLine  :', baseHas);
  console.log('--settings file demonstrably read :', fileRead);
  if (!fileRead) console.log('INCONCLUSIVE: control failed — file may be ignored entirely.');
  else if (baseHas && aHas) console.log('RESULT: MERGE — user layer survives --settings.');
  else if (baseHas && !aHas) console.log('RESULT: SHADOW — user layer dropped. Host MUST merge by hand.');
  else console.log('INCONCLUSIVE: baseline had no statusLine to observe.');
  const cHas = /▌/.test(c.all);
  console.log('--- merge depth within a single key ---');
  console.log('statusLine.command survived partial override :', cHas);
  console.log(cHas
    ? 'DEEP merge: harness may supply partial objects safely.'
    : 'SHALLOW merge: supplying a key REPLACES it wholesale.\n  => host MUST read user settings and hand-merge the full hooks object.\n     Writing hooks from scratch would silently drop all 12 user hook events.');
  console.log('=========================================');
  process.exit(0);
})();
