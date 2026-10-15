'use strict';
/**
 * host/canvas-mcp.js: the MCP server claude-custom injects into every tab's `claude` with --mcp-config (BACKLOG #71, design call
 * 3). It is how the running Claude learns the panel exists and how it fills it: `canvas_render(html)` writes the file the host
 * watches, `canvas_list_artifacts()` reads the shelf the host keeps. Stdio, newline-delimited JSON-RPC, measured working with
 * the real CLI (verify/probe71/probe-mcp-config.js, verify/probe-canvas-mcp.js).
 *
 * The server knows its tab only through a POINTER FILE the host keeps (<state>/canvas/_tab-<port>.json: the CLI's session id,
 * which does not exist yet when the server is spawned), re-read on every call so /clear and --resume follow.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createCanvasMcp, TOOLS } = require('../host/canvas-mcp');
const { MAX_HTML_BYTES } = require('../host/canvas-store');

const SID = '0f6c8a1e-3b8e-4a5b-9f0e-1d2c3b4a5f6e';

// Each rig's root is a CHILD of a temp dir the test owns, so a `..` that escapes the root lands inside that dir, never in the
// shared %TEMP% (where a leftover `escape` turned this suite red forever: Mortimer, release gate 2026-10-09).
const owned = [];
test.after(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); });

function rig(sessionId = SID) {
  const base = tmpDir('cc-canvas-mcp-');
  owned.push(base);
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const pointerFile = path.join(root, 'canvas', '_tab-4242.json');
  const point = (id) => { fs.mkdirSync(path.dirname(pointerFile), { recursive: true }); fs.writeFileSync(pointerFile, JSON.stringify({ sessionId: id })); };
  if (sessionId !== false) point(sessionId);
  const mcp = createCanvasMcp({ root, pointerFile });
  const call = (name, args) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { root, pointerFile, point, mcp, call, dir: (id = SID) => path.join(root, 'canvas', id) };
}
const text = (r) => r.result.content.map(c => c.text).join('\n');

test('initialize answers with the protocol the client asked for, tools only, and short instructions', () => {
  const r = rig();
  const res = r.mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude' } } });
  assert.strictEqual(res.id, 0);
  assert.strictEqual(res.result.protocolVersion, '2025-03-26');
  assert.deepStrictEqual(Object.keys(res.result.capabilities), ['tools']);
  assert.strictEqual(res.result.serverInfo.name, 'claude-custom-canvas');
  assert.ok(res.result.instructions.length < 600, 'always-on context: keep it short');
  assert.match(res.result.instructions, /only when the user asks/i);
});

test('a notification gets no answer; an unknown request gets a JSON-RPC error; ping is answered', () => {
  const r = rig();
  assert.strictEqual(r.mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual(r.mcp.handle({ jsonrpc: '2.0', method: 'whatever' }), null);
  const bad = r.mcp.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.strictEqual(bad.error.code, -32601);
  assert.deepStrictEqual(r.mcp.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }), { jsonrpc: '2.0', id: 3, result: {} });
  assert.strictEqual(r.mcp.handle(null), null);
  assert.strictEqual(r.mcp.handle('x'), null);
});

test('tools/list: exactly canvas_render and canvas_list_artifacts, and each says the panel changes only when the user asks', () => {
  const r = rig();
  const res = r.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepStrictEqual(res.result.tools.map(t => t.name), ['canvas_render', 'canvas_list_artifacts']);
  assert.strictEqual(TOOLS.length, 2);
  const render = res.result.tools[0];
  assert.match(render.description, /only (do this )?when the user asks/i);
  assert.deepStrictEqual(render.inputSchema.required, ['html']);
  assert.strictEqual(render.inputSchema.properties.html.type, 'string');
  for (const word of ['fetch(', 'claudePanel.send', 'claudePanel.shelf', 'claudePanel.open', 'sandbox', '1 MB']) assert.ok(render.description.includes(word), `the description must teach ${word}`);
  assert.ok(render.description.length < 2600, 'always-on context: the contract, not an essay');
  assert.match(res.result.tools[1].description, /read-only/i);
});

test('canvas_render writes the page atomically into the session folder and reports its size', () => {
  const r = rig();
  const out = r.call('canvas_render', { html: '<h1>héllo</h1>' });
  assert.ok(!out.result.isError, text(out));
  assert.match(text(out), /15 bytes/);
  assert.strictEqual(fs.readFileSync(path.join(r.dir(), 'index.html'), 'utf8'), '<h1>héllo</h1>');
  assert.deepStrictEqual(fs.readdirSync(r.dir()), ['index.html'], 'no temp file is left behind');
  r.call('canvas_render', { html: '<p>two</p>' });
  assert.strictEqual(fs.readFileSync(path.join(r.dir(), 'index.html'), 'utf8'), '<p>two</p>', 'a second call replaces the whole page');
});

test('canvas_render: exactly 1 MB is written; one byte more is refused and nothing is touched', () => {
  const r = rig();
  assert.ok(!r.call('canvas_render', { html: 'x'.repeat(MAX_HTML_BYTES) }).result.isError);
  const over = r.call('canvas_render', { html: 'y'.repeat(MAX_HTML_BYTES + 1) });
  assert.strictEqual(over.result.isError, true);
  assert.match(text(over), /too big/i);
  assert.strictEqual(fs.readFileSync(path.join(r.dir(), 'index.html'), 'utf8').charAt(0), 'x', 'the old page stays');
});

test('canvas_render: a bad argument is an error answer, never a throw or a write', () => {
  const r = rig();
  for (const args of [undefined, null, {}, { html: 5 }, { html: null }, { html: ['x'] }, 'x']) {
    const out = r.call('canvas_render', args);
    assert.strictEqual(out.result.isError, true, JSON.stringify(args));
  }
  assert.ok(!fs.existsSync(path.join(r.dir(), 'index.html')));
});

test('with no session yet (no pointer, a corrupt one, or an id that is not a plain token) it refuses and writes nothing', () => {
  const none = rig(false);
  assert.strictEqual(none.call('canvas_render', { html: 'x' }).result.isError, true);
  assert.match(text(none.call('canvas_render', { html: 'x' })), /not ready|no session/i);
  const bad = rig('../../escape');
  assert.strictEqual(bad.call('canvas_render', { html: 'x' }).result.isError, true);
  assert.ok(!fs.existsSync(path.join(bad.root, 'escape')) && !fs.existsSync(path.join(bad.root, '..', 'escape')));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(bad.root)), ['root'], 'nothing was written beside the root either');
  const corrupt = rig(false);
  fs.mkdirSync(path.dirname(corrupt.pointerFile), { recursive: true });
  fs.writeFileSync(corrupt.pointerFile, '{nope');
  assert.strictEqual(corrupt.call('canvas_render', { html: 'x' }).result.isError, true);
});

test('the pointer is re-read on every call: /clear and --resume move the panel to the new session', () => {
  const r = rig();
  r.call('canvas_render', { html: '<p>one</p>' });
  const other = '11111111-2222-3333-4444-555555555555';
  r.point(other);
  r.call('canvas_render', { html: '<p>two</p>' });
  assert.strictEqual(fs.readFileSync(path.join(r.dir(), 'index.html'), 'utf8'), '<p>one</p>');
  assert.strictEqual(fs.readFileSync(path.join(r.dir(other), 'index.html'), 'utf8'), '<p>two</p>');
});

test('canvas_list_artifacts: the shelf as title and address, newest first; empty says so', () => {
  const r = rig();
  assert.match(text(r.call('canvas_list_artifacts', {})), /empty|no artifacts/i);
  fs.mkdirSync(r.dir(), { recursive: true });
  fs.writeFileSync(path.join(r.dir(), 'shelf.json'), JSON.stringify({ version: 1, items: [
    { title: 'Roadmap', url: 'https://claude.ai/artifact/aaa', time: '2026-10-05T12:00:00.000Z' },
    { title: 'Older', url: 'https://claude.ai/artifact/bbb', time: '2026-10-04T12:00:00.000Z' }] }));
  const out = text(r.call('canvas_list_artifacts', {}));
  assert.ok(out.indexOf('Roadmap') < out.indexOf('Older'));
  assert.match(out, /https:\/\/claude\.ai\/artifact\/aaa/);
  assert.match(out, /2026-10-05/);
});

test('an unknown tool is an error answer', () => {
  const r = rig();
  assert.strictEqual(r.call('canvas_add_button', { label: 'x' }).result.isError, true);
  assert.strictEqual(r.call(undefined, {}).result.isError, true);
});

test('PR #125 Miguel M1: a render whose write fails leaves no temp file in the session folder, and says so', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.dir(), 'index.html'), { recursive: true });         // the rename onto it is refused
  const res = r.call('canvas_render', { html: '<p>x</p>' });
  assert.strictEqual(res.result.isError, true);
  assert.deepStrictEqual(fs.readdirSync(r.dir()), ['index.html']);
});

