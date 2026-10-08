'use strict';
/**
 * PROBE: Claude's panel's MCP server, through the REAL `claude` CLI (BACKLOG #71, design call 3). (re-runnable, zero spend)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-canvas-mcp.js        (exit 0 = every check held)
 *
 * The unit tests pin the server (test/canvas-mcp.test.js) and the argv (test/settings-writer.test.js). This runs the CLI itself
 * with exactly the arguments the host builds (host/settings-writer.js buildClaudeArgs, the real function) against a FAKE
 * /v1/messages endpoint, in a THROWAWAY CLAUDE_CONFIG_DIR that already has a user MCP server of its own, and checks:
 *
 *   1  the CLI lists mcp__canvas__canvas_render and mcp__canvas__canvas_list_artifacts in its request, AND the user's own server's tool
 *      (so --mcp-config ADDED to the user's servers, which probe-mcp-config.js could not show: its config had none)
 *   2  the descriptions the model is shown are the ones the server sends, including "only when the user asks"
 *   3  a tool call the fake model makes (canvas_render with a page) is run by the real CLI through the server: the page lands in
 *      <state>/canvas/<session-id>/index.html (the session id comes from the pointer file), the CLI's second request carries the
 *      tool's answer, and no temp file is left
 *   4  canvas_list_artifacts answers from the shelf on disk
 *   5  nothing about the panel was written to the throwaway .claude.json (the flag is the whole mechanism)
 *   6  with the setting off (CLAUDE_CUSTOM_CANVAS_MCP=0) no canvas tool is offered
 *
 * The fake endpoint, the throwaway config and the temp state dir keep it free: no network, no real account, no global config
 * touched. The CLI child is started by this script and killed by its own PID (host/kill-tree.js); nothing is stopped by name.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { killChildTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { buildClaudeArgs } = require(path.join(ROOT, 'host', 'settings-writer'));
const { canvasMcpEnabled } = require(path.join(ROOT, 'host', 'canvas-settings'));
const claudeBin = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(), '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`); if (!ok) failures++; };
const SID = 'probe-canvas-mcp-session';
const HTML = '<h1 id="probe">hello from the model</h1>';

// A user MCP server, so we can see the panel's is ADDED to it.
const USER_SERVER = `'use strict';
const readline = require('readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'userfake', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'user_tool', description: 'a user tool', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

async function runCli({ base, enabled, script }) {
  const work = path.join(base, 'work'); const config = path.join(base, 'config'); const state = path.join(base, 'state');
  for (const d of [work, config, state, path.join(state, 'canvas', SID)]) fs.mkdirSync(d, { recursive: true });
  const userServer = path.join(base, 'user-server.js');
  fs.writeFileSync(userServer, USER_SERVER);
  const nodePath = process.execPath;
  const claudeJson = path.join(config, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5,
    mcpServers: { userfake: { command: nodePath, args: [userServer] } },
    projects: { [work]: { hasTrustDialogAccepted: true }, [work.split(path.sep).join('/')]: { hasTrustDialogAccepted: true } } }));
  const pointerFile = path.join(state, 'canvas', '_tab-4242.json');
  fs.writeFileSync(pointerFile, JSON.stringify({ sessionId: SID }));
  fs.writeFileSync(path.join(state, 'canvas', SID, 'shelf.json'), JSON.stringify({ version: 1, items: [{ title: 'Roadmap', url: 'https://claude.ai/artifact/aaa', time: '2026-10-05T12:00:00.000Z' }] }));
  const before = fs.readFileSync(claudeJson, 'utf8');

  const requests = [];
  const server = http.createServer((q, res) => {
    let raw = ''; q.on('data', d => { raw += d; }); q.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
      requests.push(body);
      const turn = requests.filter(Boolean).filter(b => (b.tools || []).length > 0).length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const s = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      const msg = { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } };
      s('message_start', { type: 'message_start', message: msg });
      const lastUser = body && Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
      const hasResult = lastUser && Array.isArray(lastUser.content) && lastUser.content.some(c => c.type === 'tool_result');
      const callNo = body && Array.isArray(body.messages) ? body.messages.flatMap(m => (m.role === 'user' && Array.isArray(m.content) ? m.content : [])).filter(c => c.type === 'tool_result').length : 0;
      const tools = (body && body.tools || []).map(t => t.name);
      const planned = tools.includes('mcp__canvas__canvas_render')
        ? [['mcp__canvas__canvas_render', { html: HTML }], ['mcp__canvas__canvas_list_artifacts', {}]] : [];
      if (!hasResult && !planned.length) {
        s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
        s('content_block_stop', { type: 'content_block_stop', index: 0 });
        s('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      } else if (callNo < planned.length) {
        const [name, input] = planned[callNo];
        s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${callNo}`, name, input: {} } });
        s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        s('content_block_stop', { type: 'content_block_stop', index: 0 });
        s('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
      } else {
        s('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        s('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
        s('content_block_stop', { type: 'content_block_stop', index: 0 });
        s('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      }
      s('message_stop', { type: 'message_stop' }); res.end();
      void turn;
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k !== 'CLAUDE_CODE_GIT_BASH_PATH' && (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE; delete env.ANTHROPIC_API_KEY;
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  // exactly what the host passes: buildClaudeArgs, the real function, with the settings file left out (no hook helper here)
  const canvasMcp = enabled ? { nodePath: nodePath, scriptPath: script, root: state, pointerFile } : null;
  const args = [...buildClaudeArgs({ helperExists: false, canvasMcp }), '-p', 'show me something', '--model', 'haiku'];
  const child = spawn(claudeBin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const code = await new Promise(r => { const t = setTimeout(() => { try { killChildTree(child); } catch { /* gone */ } r('timeout'); }, 90000); child.on('exit', c => { clearTimeout(t); r(c); }); });
  server.close();
  return { requests, out: out.trim(), code, ms: Date.now() - started, state, args, claudeJsonChanged: fs.readFileSync(claudeJson, 'utf8') !== before, claudeJson: fs.readFileSync(claudeJson, 'utf8') };
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-canvas-mcp-'));
  const script = path.join(ROOT, 'host', 'canvas-mcp.js');
  try {
    check('the setting is ON by default (so the injection below is what a session gets)', canvasMcpEnabled({ env: {}, stateDir: path.join(base, 'none') }) === true);
    const on = await runCli({ base: path.join(base, 'on'), enabled: true, script });
    const first = on.requests.find(b => b && (b.tools || []).length > 5) || {};
    const toolList = (first.tools || []);
    const names = toolList.map(t => t.name);
    check('1: the CLI offers mcp__canvas__canvas_render and mcp__canvas__canvas_list_artifacts', names.includes('mcp__canvas__canvas_render') && names.includes('mcp__canvas__canvas_list_artifacts'), JSON.stringify(names.filter(n => n.startsWith('mcp__'))));
    check('1: ...and the user\'s own server\'s tool too: --mcp-config ADDED, it did not replace', names.includes('mcp__userfake__user_tool'), JSON.stringify(names.filter(n => n.startsWith('mcp__'))));
    const render = toolList.find(t => t.name === 'mcp__canvas__canvas_render');
    check('2: the model is shown the description that says the panel changes only when the user asks', !!render && /ONLY when the user asks/.test(render.description) && /claudePanel\.send/.test(render.description) && /fetch\(/.test(render.description), render ? render.description.slice(0, 120) : 'no tool');
    const page = path.join(on.state, 'canvas', SID, 'index.html');
    check('3: the real CLI ran canvas_render through the server: the page is on disk in the session folder from the pointer file', fs.existsSync(page) && fs.readFileSync(page, 'utf8') === '<h1 id="probe">hello from the model</h1>', fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : 'no file');
    check('3: ...and no temp file is left behind', fs.readdirSync(path.join(on.state, 'canvas', SID)).every(f => !f.endsWith('.tmp')), JSON.stringify(fs.readdirSync(path.join(on.state, 'canvas', SID))));
    const results = on.requests.filter(Boolean).flatMap(b => (b.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result')));
    const texts = results.map(r => (Array.isArray(r.content) ? r.content.map(c => c.text).join('') : String(r.content)));
    check('3: the tool\'s answer reached the model ("Rendered N bytes")', texts.some(t => new RegExp('Rendered ' + Buffer.byteLength(HTML) + ' bytes').test(t)), JSON.stringify(texts).slice(0, 300));
    check('4: canvas_list_artifacts answered from the shelf on disk', texts.some(t => /Roadmap - https:\/\/claude\.ai\/artifact\/aaa/.test(t)), JSON.stringify(texts).slice(0, 300));
    const cfgAfter = JSON.parse(on.claudeJson);
    check('5: nothing about the panel was written to the throwaway .claude.json: its MCP servers are still only the user own', JSON.stringify(Object.keys(cfgAfter.mcpServers || {})) === '["userfake"]' && !on.claudeJson.includes('canvas-mcp.js'), JSON.stringify(Object.keys(cfgAfter.mcpServers || {})));
    check('the argv had no --strict-mcp-config', !on.args.includes('--strict-mcp-config'));
    if (process.env.PROBE_DEBUG) console.log(JSON.stringify(on.requests.map(b => b ? { tools: (b.tools || []).length, msgs: (b.messages || []).map(m => m.role + ':' + (Array.isArray(m.content) ? m.content.map(c => c.type).join('+') : 'text')) } : null)));
    check('the CLI exited cleanly', on.code === 0, `exit ${on.code} after ${on.ms} ms: ${on.out.slice(0, 200)}`);

    const off = await runCli({ base: path.join(base, 'off'), enabled: false, script });
    const firstOff = off.requests.find(b => b && (b.tools || []).length > 5) || {};
    const offNames = (firstOff.tools || []).map(t => t.name);
    check('6: with the panel off, no canvas tool is offered (and the user\'s own still is)', !offNames.some(n => n.startsWith('mcp__canvas__')) && offNames.includes('mcp__userfake__user_tool'), JSON.stringify(offNames.filter(n => n.startsWith('mcp__'))));
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  }
  console.log(failures ? `\nFAILED: ${failures}` : '\nOK: every check held');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err && err.stack); process.exit(1); });
