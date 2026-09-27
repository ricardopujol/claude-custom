'use strict';
/* Can the claude CLI's own colour theme be set per launch or per project,
   without touching the global user config?

   Why it matters: Claude Code draws most of its chrome in truecolor SGR
   (38;2;r;g;b), which ignores the terminal palette. A "light" project in
   claude-custom therefore needs the CLI itself in a light theme, and flipping
   the global `theme` would repaint every open window.

   What the CLI does (read from the bundled JS in claude.exe, v2.1.283):
     - `theme` is a "user intent setting" (USER_INTENT_SETTING_KEYS). It's read
       by resolveSetting(), which walks the enabled settings sources from the
       highest priority down -- policySettings > flagSettings (--settings) >
       localSettings > projectSettings > userSettings -- and only then falls
       back to the legacy `theme` in ~/.claude.json.
     - /theme writes it back with saveUserIntentSetting() -> userSettings.
     - Valid values: auto, dark, light, light-daltonized, dark-daltonized,
       light-ansi, dark-ansi. `auto` asks the terminal (OSC 11) or COLORFGBG.

   This probe doesn't trust that reading. It launches the real TUI once per
   candidate, never sends a prompt, and classifies the theme by MEASUREMENT:
   the set of truecolor SGR codes each run emits, compared against a baseline.

   Launching claude at all bumps counters in ~/.claude.json (numStartups etc.),
   so a whole-file hash can't prove "untouched". The probe hashes it anyway and
   additionally checks that its `theme` key didn't change, and hashes
   ~/.claude/settings.json, which a startup shouldn't write.

   Usage:  node verify/probe-cli-theme.js        (SETTLE_MS=12000 to wait longer)
*/
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Terminal } = require('@xterm/headless');

const COLS = 120, ROWS = 32;
const SETTLE_MS = Number(process.env.SETTLE_MS) || 10000;
const CLAUDE_BIN = process.env.CLAUDE_CUSTOM_BIN ||
  path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');

const HOME = os.homedir();
const GLOBAL_JSON = path.join(HOME, '.claude.json');
const USER_SETTINGS = path.join(HOME, '.claude', 'settings.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return '(missing)'; } };
const globalTheme = () => { try { return JSON.parse(fs.readFileSync(GLOBAL_JSON, 'utf8')).theme; } catch { return '(unreadable)'; } };

// The same scrub the host does, plus the two this machine needs: the global
// ANTHROPIC_API_KEY (claude prefers it) and ELECTRON_RUN_AS_NODE.
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID', 'CLAUDE_EFFORT', 'COLORFGBG']) delete env[k];
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}

// Pull every SGR sequence apart and bucket the colour parameters.
function colours(raw) {
  const fg = new Set(), bg = new Set(), palette = new Set();
  const re = /\x1b\[([0-9;:]*)m/g;
  let m;
  while ((m = re.exec(raw))) {
    const p = m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if ((c === 38 || c === 48) && p[i + 1] === 2) {
        (c === 38 ? fg : bg).add(`${p[i + 2]},${p[i + 3]},${p[i + 4]}`); i += 4;
      } else if ((c === 38 || c === 48) && p[i + 1] === 5) {
        palette.add(`${c === 38 ? 'fg' : 'bg'}256:${p[i + 2]}`); i += 2;
      } else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) palette.add(`fg${c}`);
      else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) palette.add(`bg${c}`);
    }
  }
  return { fg, bg, palette };
}

const lum = s => { const [r, g, b] = s.split(',').map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const meanLum = set => set.size ? Math.round([...set].reduce((a, s) => a + lum(s), 0) / set.size) : NaN;

async function run(c) {
  const dir = c.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-theme-probe-'));
  if (c.project) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    for (const [f, v] of Object.entries(c.project)) fs.writeFileSync(path.join(dir, '.claude', f), JSON.stringify(v));
  }
  const args = (c.args || []).map(a => a.replace('{dir}', dir));
  const settingsPath = path.join(dir, 'probe-settings.json');
  if (c.settingsFile) {
    const f = settingsPath;
    fs.writeFileSync(f, JSON.stringify(c.settingsFile));
    args.push('--settings', f);
  }
  const debugPath = path.join(dir, 'probe-debug.log');
  if (c.debugLog) args.push('--debug-file', debugPath);

  // A headless xterm stands in for our renderer. For the `auto` + OSC 11 case
  // it answers the CLI's colour query from its own theme background.
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true,
    theme: c.xtermBg ? { background: c.xtermBg, foreground: '#000000' } : undefined });
  let raw = '';
  const child = pty.spawn(CLAUDE_BIN, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: dir, env: childEnv(c.env) });
  child.onData(d => { raw += d; term.write(d); });
  let exitCode = null;
  child.onExit(e => { exitCode = e.exitCode; });
  // xterm.js's own query replies go back to the CLI (0 of them is itself a
  // finding: headless xterm doesn't answer OSC 11). `osc11` answers the CLI's
  // background query by hand, the way our renderer could.
  let replies = 0, osc11 = 0;
  if (c.answerQueries) term.onData(d => { replies++; try { child.write(d); } catch {} });
  child.onData(d => {
    if (!/\x1b\]11;\?/.test(d)) return;
    osc11++;
    if (c.osc11) try { child.write('\x1b]11;' + c.osc11 + '\x1b\\'); } catch {}
  });

  await sleep(SETTLE_MS);
  // Live phase: change a settings source mid-session, then force a redraw.
  // Only output emitted AFTER the mark is judged, so the startup paint can't
  // pass for a live change.
  let mark = null;
  const exitedAtSettle = exitCode;
  if (c.during) { mark = raw.length; await c.during({ child, dir, settingsPath }); }
  const screen = [];
  for (let y = 0; y < ROWS; y++) { const l = term.buffer.active.getLine(y); if (l) screen.push(l.translateToString(true).trimEnd()); }
  try { child.write('\x03'); await sleep(300); child.write('\x03'); await sleep(800); } catch {}
  try { child.kill(); } catch {}
  await sleep(500);
  let debug = '';
  if (c.debugLog) try { debug = fs.readFileSync(debugPath, 'utf8'); } catch {}
  if (!c.keepDir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { raw, screen, replies, osc11, dir, exitedAtSettle, debug, ...colours(raw),
    live: mark === null ? null : { after: colours(raw.slice(mark)), bytes: raw.length - mark } };
}

const CANDIDATES = [
  { name: 'baseline (no change)' },
  { name: '--settings JSON {"theme":"light"}', args: ['--settings', '{"theme":"light"}'] },
  { name: '--settings <file> {"theme":"light"}', settingsFile: { theme: 'light' } },
  { name: 'project .claude/settings.json light', project: { 'settings.json': { theme: 'light' } } },
  { name: 'project .claude/settings.local.json light', project: { 'settings.local.json': { theme: 'light' } } },
  { name: '--settings theme light-ansi', args: ['--settings', '{"theme":"light-ansi"}'] },
  { name: '--settings theme dark-ansi', args: ['--settings', '{"theme":"dark-ansi"}'] },
  { name: 'auto + COLORFGBG=0;15 (light bg)', args: ['--settings', '{"theme":"auto"}'], env: { COLORFGBG: '0;15' } },
  { name: 'auto + xterm answers OSC 11 white', args: ['--settings', '{"theme":"auto"}'], xtermBg: '#ffffff', answerQueries: true },
  { name: 'auto + xterm answers OSC 11 black', args: ['--settings', '{"theme":"auto"}'], xtermBg: '#000000', answerQueries: true },
  { name: 'auto + hand-answered OSC 11 white', args: ['--settings', '{"theme":"auto"}'], osc11: 'rgb:ffff/ffff/ffff' },
];

// ---------------------------------------------------------------------------
// Live reload: does a settings change reach a RUNNING CLI?
//
// Read from the bundle (v2.1.283): the settingsChangeDetector watches settings
// files with chokidar (polling fallback when native fs.watch is silent). Its
// file list comes from a loop over the sources that explicitly skips
// flagSettings (`if(Z==="flagSettings")continue`), so a --settings file is
// never watched; user, project, local and policy files are. Separately, the
// ThemeProvider seeds its state from resolveSetting('theme') once, in a
// useState initializer. The probe measures whether either path repaints.
//
// Colour signatures, measured by the static phase above:
const LIGHT_SIG = ['102,102,102', '150,108,30'];
const DARK_SIG = ['136,136,136', '255,193,7'];

// A harmless redraw: resize the pty away and back, then type a character and
// delete it. Enter is never pressed.
async function redraw(child) {
  child.resize(COLS - 1, ROWS); await sleep(1500);
  child.resize(COLS, ROWS); await sleep(1500);
  child.write('x'); await sleep(800);
  child.write('\x7f'); await sleep(1500);
}

function judgeLive(r) {
  const a = r.live.after.fg;
  const light = LIGHT_SIG.filter(x => a.has(x)), dark = DARK_SIG.filter(x => a.has(x));
  const verdict = light.length && !dark.length ? 'LIVE: repainted light'
    : dark.length && !light.length ? 'NOT LIVE: repainted, still dark'
    : light.length && dark.length ? 'MIXED' : 'INCONCLUSIVE: redraw emitted no signature colour';
  return { verdict, light, dark };
}

async function livePhase() {
  const writeTheme = (f, theme) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ theme })); };
  const cases = [
    { name: 'control: --settings file dark, no change, redraw', settingsFile: { theme: 'dark' },
      during: async ({ child }) => { await sleep(4000); await redraw(child); } },
    { name: '--settings file dark -> light', settingsFile: { theme: 'dark' },
      during: async ({ child, settingsPath }) => { writeTheme(settingsPath, 'light'); await sleep(5000); await redraw(child); } },
    { name: 'project settings.local.json dark -> light', project: { 'settings.local.json': { theme: 'dark' } },
      during: async ({ child, dir }) => { writeTheme(path.join(dir, '.claude', 'settings.local.json'), 'light'); await sleep(5000); await redraw(child); } },
    { name: 'project settings.json dark -> light', project: { 'settings.json': { theme: 'dark' } },
      during: async ({ child, dir }) => { writeTheme(path.join(dir, '.claude', 'settings.json'), 'light'); await sleep(5000); await redraw(child); } },
  ];
  console.log('\n=== LIVE RELOAD (only output after the change is judged) ===');
  for (const c of cases) {
    // --debug-file shows whether the settings watcher saw the edit at all, which
    // separates "file not watched" from "watched, but the theme isn't re-read".
    c.debugLog = true;
    let r = await run(c);
    if (r.raw.length < 500) r = await run(c);
    const j = judgeLive(r);
    console.log(`\n[${j.verdict}] ${c.name}`);
    console.log(`  after-change output: ${r.live.bytes} bytes, fg truecolor: ${[...r.live.after.fg].sort().join(' | ') || '(none)'}`);
    const log = r.debug.split(/\r?\n/);
    const watching = log.find(l => /Watching for changes in setting files/.test(l));
    const detected = log.filter(l => /Detected (change|creation|deletion)|settings change/i.test(l) && !/Watching/.test(l));
    console.log(`  watcher: ${watching ? watching.replace(/^.*?Watching/, 'Watching').slice(0, 260) : '(no "Watching" line in debug log)'}`);
    console.log(`  change events: ${detected.length ? detected.map(l => l.replace(/^\S+\s+\[\w+\]\s*/, '').slice(0, 160)).join(' || ') : '(none)'}`);
  }
}

// Fallback: quit, then relaunch in the same folder with --continue and the new
// theme. A fresh folder has no conversation, so this checks the flag doesn't
// abort the launch and that the theme applies.
async function relaunchPhase() {
  console.log('\n=== RELAUNCH WITH --continue ===');
  const first = await run({ settingsFile: { theme: 'dark' }, keepDir: true });
  const r = await run({ dir: first.dir, settingsFile: { theme: 'light' }, args: ['--continue'] });
  const light = LIGHT_SIG.filter(x => r.fg.has(x)), dark = DARK_SIG.filter(x => r.fg.has(x));
  const err = r.screen.find(s => /no conversation|not found|error/i.test(s));
  console.log(`first launch (dark): ${first.raw.length} bytes, dark sig: ${DARK_SIG.filter(x => first.fg.has(x)).join(' ') || '(none)'}`);
  console.log(`relaunch --continue (light): ${r.raw.length} bytes, exited before settle: ${r.exitedAtSettle !== null ? 'yes, code ' + r.exitedAtSettle : 'no'}`);
  console.log(`  light sig: ${light.join(' ') || '(none)'} | dark sig: ${dark.join(' ') || '(none)'}${err ? ` | screen says: "${err}"` : ''}`);
  console.log(`  -> ${r.exitedAtSettle === null && light.length && !dark.length ? 'WORKS: session stays up and comes back light' : 'DOES NOT WORK cleanly (see above)'}`);
}

// PHASES=static,live,relaunch (default all). The baseline always runs.
const PHASES = (process.env.PHASES || 'static,live,relaunch').split(',');

(async () => {
  const before ={ global: sha(GLOBAL_JSON), user: sha(USER_SETTINGS), theme: globalTheme() };
  console.log('claude binary :', CLAUDE_BIN);
  console.log('before        : ~/.claude.json', before.global, 'theme=', before.theme, '| settings.json', before.user);

  const results = [];
  for (const c of PHASES.includes('static') ? CANDIDATES : CANDIDATES.slice(0, 1)) {
    process.stdout.write(`running: ${c.name} ... `);
    // node-pty's ConPTY agent occasionally dies with "AttachConsole failed"
    // and the run yields ~50 bytes. That's the instrument, not the CLI: retry.
    let r = await run(c);
    if (r.raw.length < 500) { process.stdout.write(`(only ${r.raw.length} bytes, retrying) `); r = await run(c); }
    results.push({ c, r });
    console.log(`${r.raw.length} bytes, ${r.fg.size} fg / ${r.bg.size} bg truecolor, ${r.palette.size} palette codes, ${r.osc11} OSC 11 queries${c.answerQueries ? `, ${r.replies} xterm replies` : ''}`);
  }

  const base = results[0].r;
  if (process.env.DUMP) console.log('\n--- baseline screen ---\n' + base.screen.filter(Boolean).join('\n'));
  const trust = base.screen.some(s => /trust/i.test(s));
  if (!base.fg.size) { console.log('\nINCONCLUSIVE: the baseline emitted no truecolor at all -- instrument not working.'); process.exit(1); }

  console.log('\n=== RESULTS (baseline mean fg luminance', meanLum(base.fg) + ')', trust ? '[trust dialog seen]' : '', '===');
  for (const { c, r } of results) {
    const added = [...r.fg].filter(x => !base.fg.has(x));
    const removed = [...base.fg].filter(x => !r.fg.has(x));
    const changed = added.length + removed.length > 0 || r.palette.size !== base.palette.size;
    const l = meanLum(r.fg);
    const verdict = r === base ? 'BASELINE' : r.raw.length < 500 ? 'NO OUTPUT' : !changed ? 'NOT APPLIED' :
      r.fg.size === 0 ? 'APPLIED (palette-only)' : l < meanLum(base.fg) - 10 ? 'APPLIED (darker text = light theme)' : 'CHANGED';
    console.log(`\n[${verdict}] ${c.name}`);
    console.log(`  fg truecolor (${r.fg.size}) mean lum ${l}: ${[...r.fg].sort().join(' | ')}`);
    if (r !== base) console.log(`  vs baseline: +${added.length} -${removed.length}`);
    console.log(`  palette codes (${r.palette.size}): ${[...r.palette].sort().join(' ')}`);
  }

  if (PHASES.includes('live')) await livePhase();
  if (PHASES.includes('relaunch')) await relaunchPhase();

  const after = { global: sha(GLOBAL_JSON), user: sha(USER_SETTINGS), theme: globalTheme() };
  console.log('\n=== GLOBAL CONFIG ===');
  console.log('~/.claude.json         :', before.global, '->', after.global, before.global === after.global ? '(unchanged)' : '(changed -- expected: every launch bumps startup counters)');
  console.log('~/.claude.json .theme  :', JSON.stringify(before.theme), '->', JSON.stringify(after.theme), before.theme === after.theme ? 'UNCHANGED' : 'CHANGED!');
  console.log('~/.claude/settings.json:', before.user, '->', after.user, before.user === after.user ? 'UNCHANGED' : 'CHANGED!');
  process.exit(0);
})();
