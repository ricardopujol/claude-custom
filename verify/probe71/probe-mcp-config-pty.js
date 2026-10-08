'use strict';
/* Probe #71 (c): does `claude --mcp-config '<json string>'` at spawn hand the session a claude-custom-owned MCP
   server, with no edit to any config file and no approval prompt, and does an env var set in that JSON reach the
   server (so it knows which session/tab it serves)? Runs `claude -p` against a fake endpoint (zero spend) in a
   throwaway CLAUDE_CONFIG_DIR and reads the tools list of the request the CLI sends. Own PID only. */
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync, spawn } = require('child_process');
const claudeBin = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(), '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe71c-'));
  const work = path.join(base, 'work'); const config = path.join(base, 'config');
  for (const d of [work, config]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5,
    projects: { [work]: { hasTrustDialogAccepted: true }, [work.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
  const mcpLog = path.join(base, 'mcp.log');
  const seen = [];
  const server = http.createServer((q, res) => {
    let raw = ''; q.on('data', d => { raw += d; }); q.on('end', () => {
      try { const b = JSON.parse(raw); seen.push((b.tools || []).map(t => t.name)); } catch { seen.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const s = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      s('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      s('content_block_stop', { type: 'content_block_stop', index: 0 });
      s('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      s('message_stop', { type: 'message_stop' }); res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k !== 'CLAUDE_CODE_GIT_BASH_PATH' && (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE; delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const mcp = JSON.stringify({ mcpServers: { canvas: { command: process.execPath, args: [path.join(__dirname, 'canvas-mcp.js')], env: { CANVAS_SESSION: 'tab-7', CANVAS_MCP_LOG: mcpLog } } } });
  const before = fs.readFileSync(path.join(config, '.claude.json'), 'utf8');
  const pty = require('C:/Users/ricar/VibeCode/claude-custom/dev/node_modules/node-pty'); const { Terminal } = require('C:/Users/ricar/VibeCode/claude-custom/dev/node_modules/@xterm/headless'); const term = new Terminal({ cols: 140, rows: 40, allowProposedApi: true }); const child = pty.spawn(claudeBin, ['--model', 'haiku', '--mcp-config', mcp], { name: 'xterm-256color', cols: 140, rows: 40, cwd: work, env }); require('C:/Users/ricar/VibeCode/claude-custom/dev/host/kill-tree').trackExit(child); child.onData(d => term.write(d)); const scr = async () => { await new Promise(r => term.write('', r)); const b = term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\n'); };
  let out = ''; await new Promise(r => setTimeout(r, 8000)); out = await scr(); child.write('hello'); await new Promise(r => setTimeout(r, 400)); child.write(String.fromCharCode(13)); await new Promise(r => setTimeout(r, 6000));
  const code = 'pty'; const dialog = /approve|trust|allow.*mcp|new MCP/i.test(out); out = dialog ? out : 'no approval dialog on screen at start'; require('C:/Users/ricar/VibeCode/claude-custom/dev/host/kill-tree').killChildTree(child);
  const mainTools = seen.filter(Boolean).find(t => t.length > 5) || [];
  const after = fs.readFileSync(path.join(config, '.claude.json'), 'utf8');
  const res = { exit: code, stdout: out.trim().slice(0, 200), canvasTools: mainTools.filter(n => n.startsWith('mcp__canvas')),
    totalTools: mainTools.length, serverLog: fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [],
    configMentionsCanvas: /canvas/.test(after), configChanged: before !== after };
  server.close();
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  console.log('RESULT ' + JSON.stringify(res, null, 1));
  process.exit(0);
})();
