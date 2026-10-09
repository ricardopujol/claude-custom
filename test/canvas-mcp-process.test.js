'use strict';
/**
 * host/canvas-mcp.js AS A PROCESS: the script over stdio, as the CLI runs it. Split out of test/canvas-mcp.test.js (release-gate lane,
 * 2026-10-09) because these tests spawn a real node child and name the script's path, and neither belongs in Stryker's command
 * (test/stryker-config.test.js: REPO_SCANNING). The in-process tests of createCanvasMcp stay in test/canvas-mcp.test.js and ARE mutated.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const SID = '0f6c8a1e-3b8e-4a5b-9f0e-1d2c3b4a5f6e';

// The same rig as test/canvas-mcp.test.js, without the in-process server: a root (a child of a temp dir the test owns) and a pointer file.
function rig(sessionId = SID) {
  const base = tmpDir('cc-canvas-mcp-proc-');
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const pointerFile = path.join(root, 'canvas', '_tab-4242.json');
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
  fs.writeFileSync(pointerFile, JSON.stringify({ sessionId }));
  return { root, pointerFile, dir: (id = SID) => path.join(root, 'canvas', id) };
}

// The real thing: the script, over stdio, as the CLI runs it.
test('as a process: newline-delimited JSON-RPC over stdio, tools/call writes the page', async () => {
  const r = rig();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'canvas-mcp.js')], {
    env: { ...process.env, CLAUDE_CUSTOM_CANVAS_ROOT: r.root, CLAUDE_CUSTOM_CANVAS_POINTER: r.pointerFile }, stdio: ['pipe', 'pipe', 'inherit'] });
  const answers = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canvas_render', arguments: { html: '<p>from a process</p>' } } });
  const deadline = Date.now() + 10000;
  while (answers.length < 3 && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
  child.stdin.end();
  await new Promise(res => child.on('exit', res));
  assert.deepStrictEqual(answers.map(a => a.id), [1, 2, 3], 'one answer per request, none for the notification');
  assert.strictEqual(fs.readFileSync(path.join(r.dir(), 'index.html'), 'utf8'), '<p>from a process</p>');
});

test('as a process with no environment it still starts and answers, and refuses to write', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'canvas-mcp.js')], {
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_'))), stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'canvas_render', arguments: { html: 'x' } } }) + '\n');
  const deadline = Date.now() + 10000;
  while (!buf.includes('\n') && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
  child.stdin.end();
  await new Promise(res => child.on('exit', res));
  assert.strictEqual(JSON.parse(buf.split('\n')[0]).result.isError, true);
});

test('PR #125 Miguel S3: when the CLI closes its end first, the server ends quietly (EPIPE is not an uncaught exception)', async () => {
  const r = rig();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'canvas-mcp.js')], {
    env: { ...process.env, CLAUDE_CUSTOM_CANVAS_ROOT: r.root, CLAUDE_CUSTOM_CANVAS_POINTER: r.pointerFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.destroy();                                   // the reader is gone
  for (let i = 0; i < 20; i++) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) + '\n');
  const code = await new Promise((res) => { const t = setTimeout(() => { child.kill(); res('hung'); }, 8000); child.on('exit', (c) => { clearTimeout(t); res(c); }); });
  assert.strictEqual(code, 0, err);
  assert.doesNotMatch(err, /EPIPE|Unhandled|uncaught/i);
});
