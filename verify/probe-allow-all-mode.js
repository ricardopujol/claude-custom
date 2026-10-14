'use strict';
/**
 * BACKLOG #89: can allow-all permission RULES stand in for --dangerously-skip-permissions?  (re-runnable)
 *
 *   node verify/probe-allow-all-mode.js <bypass|allowall|manual|dontask|acceptedits> <scratch-dir> [only-step-labels,comma,separated]
 *
 * Starts the REAL `claude` in a node-pty pty (as host/host.js does) inside a fresh scratch git folder and drives it:
 *   bypass     the argv the host uses today: --dangerously-skip-permissions
 *   allowall   no bypass flag and NO --permission-mode (the CLI's normal mode; passing 'manual' draws a "manual mode on" badge, and 'default' is not a choice in 2.1.299),
 *              --settings with permissions.allow naming every built-in tool
 * It records the footer rows (the last rows of the rendered screen) and, for each scripted action, whether a permission prompt
 * appeared (its text) or the tool just ran. EVERY prompt is answered with Esc (= no); nothing is ever approved.
 *
 * SAFE by construction: runs only under <scratch-dir> (the caller points it at the session scratchpad), never in a real repo;
 * the "outside the folder" targets are a sibling folder of the scratch git repo; ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN are stripped so only the plan can be used; --setting-sources project keeps the person's own user rules and
 * hooks out of the measurement; the pty is ended through host/kill-tree.js by pid, never by name.
 * Uses plan quota (a handful of short prompts). Write results to <scratch-dir>/<mode>/result.json and print a table.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
const { Terminal } = require(path.join(ROOT, 'node_modules', '@xterm', 'headless'));
const { trackExit, killChildTree } = require(path.join(ROOT, 'host', 'kill-tree'));

const MODE = process.argv[2];
const SCRATCH = process.argv[3] ? path.resolve(process.argv[3]) : null;
const ONLY = process.argv[4] ? process.argv[4].split(',') : null;
if (!['bypass', 'allowall', 'manual', 'dontask', 'acceptedits'].includes(MODE) || !SCRATCH) {
  console.log('usage: node verify/probe-allow-all-mode.js <bypass|allowall|manual|dontask|acceptedits> <scratch-dir> [labels]');
  process.exit(2);
}

const COLS = 140, ROWS = 40;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'TodoWrite'];

const base = path.join(SCRATCH, MODE);
const work = path.join(base, 'work');
const outside = path.join(base, 'outside');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const git = (...a) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...a], { cwd: work, stdio: 'pipe', encoding: 'utf8' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(work, 'a.txt'), 'alpha\n');
fs.mkdirSync(path.join(work, 'sub'));
fs.mkdirSync(path.join(work, '.claude'));
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}\n');
fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep me\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const settingsFile = path.join(base, 'allow-all-settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: TOOLS } }, null, 2));

// allowall = no --permission-mode at all: in 2.1.299 that is AUTO mode (a classifier), which the footer shows as "auto mode on".
// manual / dontask / acceptedits pass the CLI's own --permission-mode value, with the same allow-all rules.
const PM = { manual: 'manual', dontask: 'dontAsk', acceptedits: 'acceptEdits' };
const args = MODE === 'bypass'
  ? ['--dangerously-skip-permissions', '--setting-sources', 'project']
  : [...(PM[MODE] ? ['--permission-mode', PM[MODE]] : []), '--settings', settingsFile, '--setting-sources', 'project'];

const claudeBin = [
  path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
  path.join(os.homedir(), '.local/bin/claude.exe'),
].find(p => fs.existsSync(p)) || 'claude.exe';

const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE']) delete env[k];

const screen = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const term = pty.spawn(claudeBin, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
trackExit(term);
let exited = false;
term.onExit(() => { exited = true; });
let lastChange = Date.now();
term.onData((d) => { lastChange = Date.now(); screen.write(d); });
console.log(`[probe] ${MODE}: pid ${term.pid}  ${claudeBin} ${args.join(' ')}`);

const rows = () => {
  const b = screen.buffer.active;
  const out = [];
  for (let i = 0; i < ROWS; i++) { const l = b.getLine(b.viewportY + i); out.push(l ? l.translateToString(true) : ''); }
  return out;
};
const text = () => rows().join('\n');
const footer = () => rows().filter(r => r.trim() !== '').slice(-6);
const PROMPT_RE = /Do you want to|Esc to cancel|Yes, and don|Allow this|Do you trust|trust this folder|needs your permission/i;
const IDLE_MS = 12000;

async function waitIdle(maxMs, stopOnPrompt) {
  const t0 = Date.now();
  let seenChange = false;
  const startChange = lastChange;
  for (;;) {
    await sleep(500);
    if (exited) return { kind: 'exited' };
    if (lastChange !== startChange) seenChange = true;
    const t = text();
    if (stopOnPrompt && PROMPT_RE.test(t)) { await sleep(1500); return { kind: 'prompt', screen: text() }; }
    if (seenChange && Date.now() - lastChange > IDLE_MS) return { kind: 'idle', screen: t };
    if (Date.now() - t0 > maxMs) return { kind: 'timeout', screen: t };
  }
}

const results = [];
async function step(label, prompt, maxMs = 150000) {
  if (ONLY && !ONLY.includes(label)) return;
  const before = text();
  term.write(prompt);
  await sleep(400);
  term.write('\r');
  let r = await waitIdle(maxMs, true);
  let prompted = null;
  let guard = 0;
  while (r.kind === 'prompt' && guard++ < 4) {
    prompted = prompted || r.screen.split('\n').filter(l => l.trim() !== '').slice(-14).join('\n');
    term.write('\x1b');                 // Esc = no. Never yes.
    await sleep(1500);
    r = await waitIdle(maxMs, true);
  }
  const final = r.screen || text();
  const row = { label, prompted: prompted !== null, promptText: prompted, ended: r.kind,
    tail: final.split('\n').filter(l => l.trim() !== '').slice(-14).join('\n') };
  results.push(row);
  console.log(`[probe] ${label}: ${row.prompted ? 'PROMPTED' : 'ran/no prompt'} (${r.kind})`);
}

const P = (s) => s.replace(/\\/g, '/');
(async () => {
  let startup = await waitIdle(60000, true);
  const startupLog = [];
  // a trust dialog for the scratch folder is the CLI's own first-run question; accept it so the session can start (it names only the scratch folder)
  if (startup.kind === 'prompt' || /trust/i.test(startup.screen || '')) {
    startupLog.push(text().split('\n').filter(l => l.trim() !== '').slice(-14).join('\n'));
    term.write('\x1b[B');               // the default is "No, exit": move to "Yes, I trust this folder"
    await sleep(500);
    term.write('\r');
    await sleep(3000);
    startup = await waitIdle(60000, false);
  }
  // bypass mode shows its own one-time warning on some installs; record it, accept nothing beyond Enter on the default
  if (exited) throw new Error('claude exited during startup');
  fs.writeFileSync(path.join(base, 'startup-screen.txt'), text());
  const footerRows = footer();
  console.log('[probe] footer rows:\n' + footerRows.map(r => '  | ' + r).join('\n'));

  await step('bash-compound', `Use the Bash tool to run exactly this one command and nothing else: cd sub && echo hi > made.txt && cat made.txt`);
  await step('powershell', `Use the PowerShell tool to run exactly: Get-Date -Format yyyy. If there is no PowerShell tool say so.`);
  await step('edit-in-folder', `Use the Edit tool to change the word alpha to beta in ${P(path.join(work, 'a.txt'))}. Read it first if you must.`);
  await step('write-in-folder', `Use the Write tool to create ${P(path.join(work, 'b.txt'))} containing the single line: hello`);
  await step('write-outside', `Use the Write tool to create ${P(path.join(outside, 'o.txt'))} containing the single line: outside`);
  await step('bash-rm-outside', `Use the Bash tool to run exactly: rm -rf ${P(path.join(outside, 'victim.txt'))}`);
  await step('write-dot-git', `Use the Write tool to create ${P(path.join(work, '.git', 'info', 'probe-note.txt'))} containing the single line: note`);
  await step('write-claude-settings', `Use the Write tool to overwrite ${P(path.join(work, '.claude', 'settings.json'))} with exactly: {"probe":true}`);
  await step('webfetch', `Use the WebFetch tool on https://example.com and tell me the page title in a few words.`);
  await step('subagent', `Use the Agent tool (general-purpose subagent) to list the files in the current folder with its Glob tool, then tell me what it found.`);

  const out = { mode: MODE, args, claudeBin, footer: footerRows, startupLog, results,
    afterFiles: { 'work/a.txt': fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), outsideListing: fs.readdirSync(outside),
      workListing: fs.readdirSync(work) } };
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(out, null, 2));
  console.log('\n' + results.map(r => `${r.label.padEnd(22)} ${r.prompted ? 'PROMPTED' : 'ran'}`).join('\n'));
  console.log('outside now:', out.afterFiles.outsideListing.join(', '), ' work now:', out.afterFiles.workListing.join(', '));
  console.log(`[probe] wrote ${path.join(base, 'result.json')}`);
})().catch(e => { console.log('[probe] error', e); process.exitCode = 1; })
  .finally(() => { killChildTree(term); setTimeout(() => process.exit(process.exitCode || 0), 1500); });
