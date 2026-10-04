'use strict';
/* Decides H1 vs H2 (see probe-user-layer.js) by asking Claude Code itself what
   its EFFECTIVE hook configuration is, via the `/hooks` command, against the
   REAL user settings -- no alternate home, nothing modified.

   Two alternate-home attempts failed because relocating the config dir stops
   hooks running at all (even the --settings ones), so that instrument cannot
   distinguish shadowing from a disabled layer. This one reads the answer
   straight out of the TUI instead.

   Baseline `/hooks` lists the user's real hook events. Then the same with
   `--settings` supplying a single SessionStart hook:
     - user events still listed  -> H1, hooks accumulate, do NOT union
     - only SessionStart listed  -> H2, user hooks replaced, MUST union */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const BIN = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';
const COLS = 100, ROWS = 40;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hookscmd-'));
const cliSettings = path.join(tmp, 'cli-settings.json');
fs.writeFileSync(cliSettings, JSON.stringify({
  hooks: {
    SessionStart: [{
      matcher: '',
      hooks: [{ type: 'command', command: 'node -e "0"', timeout: 5 }],
    }],
  },
}, null, 2));

async function run(label, args) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
                   'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_SESSION_ID']) delete env[k];

  const p = pty.spawn(BIN, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
  p.onData(d => term.write(d));
  await sleep(11000);

  p.write('/hooks');
  await sleep(1500);
  p.write('\r');
  await sleep(3500);

  // The menu is a scrolling list: only ~5 entries render at once, so walk it
  // with Down and accumulate. Without this, SessionStart -- the entry that
  // decides the question -- is never visible.
  const screen = () => {
    const b = term.buffer.active, out = [];
    for (let y = 0; y < ROWS; y++) {
      const l = b.getLine(y);
      if (l) out.push(l.translateToString(true).replace(/\s+$/, ''));
    }
    return out;
  };

  const rows = [...screen()];
  const collected = new Set(rows);
  for (let i = 0; i < 14; i++) {
    p.write('\x1b[B');            // Down arrow
    await sleep(320);
    for (const r of screen()) collected.add(r);
  }
  try { p.kill(); } catch {}

  const text = [...collected].join('\n');
  console.log(`\n===== ${label} =====`);
  const entries = [...collected]
    .map(r => r.match(/(\d+)\.\s+([A-Za-z]+)\s*(\((\d+)\))?/))
    .filter(Boolean)
    .map(m => ({ event: m[2], count: m[4] ? Number(m[4]) : 0 }));
  const byEvent = {};
  for (const e of entries) byEvent[e.event] = Math.max(byEvent[e.event] ?? 0, e.count);
  console.log('  total line   :', [...collected].find(r => /hooks configured/.test(r))?.trim());
  console.log('  per-event    :', JSON.stringify(byEvent));

  const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
                  'SessionStart', 'SessionEnd', 'Stop', 'SubagentStop', 'SubagentStart',
                  'PermissionRequest', 'TeammateIdle', 'TaskCompleted'];
  const seen = EVENTS.filter(e => new RegExp(e + '\\b').test(text));
  return { text, seen, byEvent, total: [...collected].find(r => /hooks configured/.test(r))?.trim() };
}

(async () => {
  const base = await run('BASELINE /hooks (real user settings)', []);
  console.log('\n  events seen:', JSON.stringify(base.seen));

  const cli = await run('/hooks WITH --settings supplying only SessionStart', ['--settings', cliSettings]);
  console.log('\n  events seen:', JSON.stringify(cli.seen));

  // Events the user has configured, other than the one the CLI file supplies.
  const others = base.seen.filter(e => e !== 'SessionStart');
  const survived = others.filter(e => cli.seen.includes(e));

  // Does the menu reflect the --settings file AT ALL? If SessionStart does not
  // gain an entry, the menu is blind to the CLI layer and cannot answer the
  // question, however reassuring the surviving user events look.
  const ssBase = base.byEvent.SessionStart ?? 0;
  const ssCli = cli.byEvent.SessionStart ?? 0;
  console.log('\n--- instrument check ---');
  console.log('SessionStart count  baseline:', ssBase, '-> with --settings:', ssCli);
  console.log('total line          baseline:', base.total, '| cli:', cli.total);
  const menuSeesCli = ssCli > ssBase;
  console.log(menuSeesCli
    ? 'Menu DOES reflect the --settings layer -> its answer is trustworthy.'
    : 'Menu does NOT reflect the --settings layer -> it shows user config either way,\n  so surviving user events prove NOTHING. Treat as inconclusive.');

  console.log('\n================ VERDICT ================');
  if (!menuSeesCli) {
    console.log('INCONCLUSIVE: instrument is blind to the CLI layer (see above).');
  } else if (others.length === 0) {
    console.log('INCONCLUSIVE: baseline /hooks did not list distinguishing events.');
    console.log('The menu may need navigation to reveal them.');
  } else if (survived.length === others.length) {
    console.log('H1 CONFIRMED: user hook events survive --settings.');
    console.log('   survived:', JSON.stringify(survived));
    console.log('=> hooks ACCUMULATE. Do NOT union -- it would double-fire them.');
  } else if (survived.length === 0) {
    console.log('H2 CONFIRMED: --settings REPLACED the user hooks wholesale.');
    console.log('   lost:', JSON.stringify(others));
    console.log('=> The writer MUST union the user hooks.');
  } else {
    console.log('PARTIAL:', JSON.stringify(survived), 'survived of', JSON.stringify(others));
  }
  console.log('=========================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
