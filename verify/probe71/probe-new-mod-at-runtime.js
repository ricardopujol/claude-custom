'use strict';
/* Probe #71 (a), part 2: claude spawned with --plugin-dir <root> where <root> holds NO mod yet (the way claude-custom
   would hand each session a canvas folder). While the session runs, a mod folder is copied in (as the model's Write
   would). Does the running session pick up a plugin that didn't exist at spawn? Then: same with an EMPTY mod folder
   passed directly as --plugin-dir, filled in at runtime. Fake endpoint, throwaway config, own PID only. */
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const REPO = require('path').join(__dirname, '..', '..').split(require('path').sep).join('/');
const pty = require(REPO + '/node_modules/node-pty');
const { Terminal } = require(REPO + '/node_modules/@xterm/headless');
const { killChildTree, trackExit } = require(REPO + '/host/kill-tree');
const MOD = path.join(__dirname, 'canvas-probe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const claudeBin = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(), '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
async function run(mode) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe71b-'));
  const work = path.join(base, 'work'); const config = path.join(base, 'config'); const root = path.join(base, 'canvas-root');
  for (const d of [work, config, root]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true }, [work.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } } }));
  const server = http.createServer((q, s) => { s.writeHead(500).end(); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k !== 'CLAUDE_CODE_GIT_BASH_PATH' && (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE; delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const target = mode === 'root' ? root : path.join(root, 'canvas-probe');
  if (mode === 'emptymod') fs.mkdirSync(target, { recursive: true });
  const term = new Terminal({ cols: 160, rows: 45, allowProposedApi: true });
  const args = ['--model', 'haiku'];
  if (mode === 'env') env.CLAUDE_CODE_PLUGIN_DIRS = root; else args.push('--plugin-dir', target);
  const p = pty.spawn(claudeBin, args, { name: 'xterm-256color', cols: 160, rows: 45, cwd: work, env });
  trackExit(p);
  p.onData(d => term.write(d));
  const scr = async () => { await new Promise(r => term.write('', r)); const b = term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\n'); };
  const res = { mode };
  try {
    await sleep(8000);
    let s = await scr(); res.bandBefore = /CANVAS-BAND/.test(s); res.startNotes = s.split('\n').filter(l => /plugin|canvas|mod/i.test(l)).map(l => l.trim()).slice(0, 6);
    fs.cpSync(MOD, path.join(root, 'canvas-probe'), { recursive: true });
    await sleep(6000);
    s = await scr(); res.bandAfterCopy = /CANVAS-BAND/.test(s); res.notes = s.split('\n').filter(l => /canvas-probe|reload|plugin/i.test(l)).map(l => l.trim()).slice(0, 6);
  } finally {
    try { killChildTree(p); } catch {} server.close();
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
  console.log('RESULT ' + JSON.stringify(res));
}
(async () => { for (const m of process.argv.slice(2)) await run(m); process.exit(0); })().catch(e => { console.log('FAIL ' + e.stack); process.exit(1); });
