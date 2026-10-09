'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21 (2026-10-09), host/canvas-control.js (constructor argument guards,
 * pointer-write and watch failure paths, the canvas-hosts answers) and host/canvas-mcp.js (JSON-RPC message guards, the
 * initialize answer, the error answers for an unknown method or tool, the shelf listing).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createCanvasControl } = require('../host/canvas-control');
const { createCanvasMcp, TOOLS, INSTRUCTIONS } = require('../host/canvas-mcp');
const { MAX_HTML_BYTES } = require('../host/canvas-store');

const SID = '0f6c8a1e-3b8e-4a5b-9f0e-1d2c3b4a5f6e';
const SID2 = '1a2b3c4d-3b8e-4a5b-9f0e-1d2c3b4a5f6e';

function rig({ sessionId = SID, watch, pointer = true } = {}) {
  const stateDir = tmpDir('cc-canvas-control-kills-');
  const pointerFile = pointer ? path.join(stateDir, 'canvas', '_tab-4242.json') : null;
  const frames = []; const watchers = []; const logs = [];
  const state = { sessionId };
  const control = createCanvasControl({
    stateDir, getSessionId: () => state.sessionId, emit: (f) => frames.push(f), log: (m) => logs.push(m), pointerFile,
    watch: watch || ((opts) => { const w = { opts, closed: 0, close() { this.closed++; } }; watchers.push(w); return w; }),
  });
  return { control, frames, watchers, logs, state, stateDir, pointerFile, dir: (id = SID) => path.join(stateDir, 'canvas', id) };
}

// ---- canvas-control: constructor guards ---------------------------------------------------------------------------------

test('S21 canvas-control: each required argument is named when it is missing, and nothing is created', () => {
  const ok = { stateDir: 'x', getSessionId: () => null, emit: () => {}, watch: () => ({}) };
  assert.doesNotThrow(() => createCanvasControl(ok));
  assert.throws(() => createCanvasControl(), /stateDir is required/);
  assert.throws(() => createCanvasControl({ ...ok, stateDir: '' }), /stateDir is required/);
  assert.throws(() => createCanvasControl({ ...ok, getSessionId: undefined }), /getSessionId is required/);
  assert.throws(() => createCanvasControl({ ...ok, getSessionId: 'x' }), /getSessionId is required/);
  assert.throws(() => createCanvasControl({ ...ok, emit: undefined }), /emit is required/);
  assert.throws(() => createCanvasControl({ ...ok, emit: {} }), /emit is required/);
  assert.throws(() => createCanvasControl({ ...ok, watch: undefined }), /watch is required/);
  assert.throws(() => createCanvasControl({ ...ok, watch: 5 }), /watch is required/);
});

test('S21 canvas-control: payload with no session carries the empty hosts, an empty shelf and the page limit', () => {
  const r = rig({ sessionId: null });
  assert.deepStrictEqual(r.control.payload(), {
    sessionId: null, status: 'empty', bytes: 0, signature: 'empty',
    hosts: { approved: [], denied: [] }, shelf: [], limitBytes: MAX_HTML_BYTES,
  });
  assert.strictEqual(r.control.handles('canvas-get'), true);
  assert.strictEqual(r.control.handles('canvas-hosts'), true);
  assert.strictEqual(r.control.handles('canvas'), false);
  assert.strictEqual(r.control.handles(undefined), false);
});

// ---- canvas-control: session changes -----------------------------------------------------------------------------------

test('S21 canvas-control: the same session again does nothing (no frame, no second watch); an invalid id is no session', () => {
  const r = rig({ sessionId: null });
  r.control.sessionChanged(SID);
  r.control.sessionChanged(SID);
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.watchers.length, 1);
  r.control.sessionChanged('../escape');
  assert.strictEqual(r.watchers[0].closed, 1, 'the old watch is closed');
  assert.strictEqual(r.frames.length, 2);
  assert.strictEqual(r.frames[1].sessionId, null);
  assert.strictEqual(r.watchers.length, 1, 'no watch for no session');
  assert.strictEqual(fs.existsSync(r.pointerFile), false, 'and the pointer goes');
  r.control.sessionChanged(null);
  assert.strictEqual(r.frames.length, 2, 'null after null is no change');
});

test('S21 canvas-control: the watch is created on the session folder and matches only the page and the shelf', () => {
  const r = rig({ sessionId: null });
  r.control.sessionChanged(SID);
  const { opts } = r.watchers[0];
  assert.strictEqual(opts.dir, r.dir());
  assert.strictEqual(opts.create, true);
  assert.deepStrictEqual(['index.html', 'shelf.json', 'hosts.json', 'x', 'index.html.tmp'].map(opts.match), [true, true, false, false, false]);
});

test('S21 canvas-control: a watch that cannot be made is logged and the session is still announced', () => {
  const r = rig({ sessionId: null, watch: () => { throw new Error('EMFILE'); } });
  r.control.sessionChanged(SID);
  assert.deepStrictEqual(r.logs, ['[canvas] could not watch the panel folder: EMFILE']);
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.frames[0].sessionId, SID);
  assert.strictEqual(r.frames[0].changed, false);
});

test('S21 canvas-control: a watcher whose close throws does not break a session change or close()', () => {
  const closes = [];
  const r = rig({ sessionId: null, watch: () => ({ close() { closes.push(1); throw new Error('already closed'); } }) });
  r.control.sessionChanged(SID);
  assert.doesNotThrow(() => r.control.sessionChanged(SID2));
  assert.doesNotThrow(() => r.control.close());
  assert.strictEqual(closes.length, 2);
  assert.strictEqual(r.frames.at(-1).sessionId, SID2);
});

test('S21 canvas-control: a change reported after close() says nothing', () => {
  const r = rig({ sessionId: null });
  r.control.sessionChanged(SID);
  const { onChange } = r.watchers[0].opts;
  fs.mkdirSync(r.dir(), { recursive: true });
  fs.writeFileSync(path.join(r.dir(), 'index.html'), '<p>x</p>');
  r.control.close();
  const before = r.frames.length;
  onChange();
  assert.strictEqual(r.frames.length, before);
});

test('S21 canvas-control: close() removes an empty session folder and its pointer, and leaves a folder that holds a page', () => {
  const r = rig({ sessionId: null });
  r.control.sessionChanged(SID);
  assert.ok(fs.existsSync(r.pointerFile));
  r.control.close();
  assert.strictEqual(fs.existsSync(r.pointerFile), false);
  const keep = rig({ sessionId: null });
  keep.control.sessionChanged(SID);
  fs.mkdirSync(keep.dir(), { recursive: true });
  fs.writeFileSync(path.join(keep.dir(), 'index.html'), 'page');
  keep.control.sessionChanged(SID2);
  assert.ok(fs.existsSync(path.join(keep.dir(), 'index.html')), 'a page is never deleted');
});

// ---- canvas-control: pointer failures ------------------------------------------------------------------------------------

test('S21 canvas-control: a pointer that cannot be written is logged with its reason, and the session is still announced', () => {
  const r = rig({ sessionId: null });
  // The pointer's parent is a FILE, so the folder cannot be made.
  fs.mkdirSync(r.stateDir, { recursive: true });
  fs.writeFileSync(path.join(r.stateDir, 'canvas'), 'i am a file');
  r.control.sessionChanged(SID);
  assert.strictEqual(r.logs.length >= 1, true);
  assert.match(r.logs[0], /^\[canvas\] could not write the session pointer: \S/);
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.frames[0].sessionId, SID);
});

// ---- canvas-control: host answers --------------------------------------------------------------------------------------

test('S21 canvas-control: canvas-hosts with no session says why, with the empty panel figures', () => {
  const r = rig({ sessionId: null });
  r.control.handle({ type: 'canvas-hosts', action: 'allow', origin: 'https://a.example.com' });
  assert.deepStrictEqual(r.frames[0], {
    type: 'canvas', ok: false, reason: 'no session yet, so there is no panel to answer for', sessionId: null, status: 'empty', bytes: 0,
    signature: 'empty', hosts: { approved: [], denied: [] }, shelf: [], limitBytes: MAX_HTML_BYTES, changed: false,
  });
});

test('S21 canvas-control: a refused host answer says so and keeps the list; a host list that cannot be saved is logged and refused the same way', () => {
  const r = rig();
  r.control.handle({ type: 'canvas-hosts', action: 'allow', origin: 'https://ok.example.com' });
  r.control.handle({ type: 'canvas-hosts', action: 'wipe', origin: 'https://ok.example.com' });
  const refused = r.frames[1];
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'that host answer was not accepted');
  assert.deepStrictEqual(refused.hosts, { approved: ['https://ok.example.com'], denied: [] });
  assert.strictEqual(refused.changed, false);
  assert.strictEqual(refused.sessionId, SID);
  assert.deepStrictEqual(r.logs, []);

  fs.rmSync(path.join(r.dir(), 'hosts.json'), { force: true });
  fs.mkdirSync(path.join(r.dir(), 'hosts.json'));         // the file's place is taken by a folder: the write fails
  r.control.handle({ type: 'canvas-hosts', action: 'allow', origin: 'https://new.example.com' });
  assert.match(r.logs[0], /^\[canvas\] could not save the host list: \S/);
  assert.strictEqual(r.frames.at(-1).ok, false);
  assert.strictEqual(r.frames.at(-1).reason, 'that host answer was not accepted');
});

test('S21 canvas-control: an unknown message type is ignored without a frame', () => {
  const r = rig();
  r.control.handle({ type: 'canvas-other' });
  assert.deepStrictEqual(r.frames, []);
});

test('S21 canvas-control: a shelf that cannot be written is logged and nobody is told', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.dir(), 'shelf.json'), { recursive: true });   // the file's place is taken by a folder
  r.control.shelfEvent({ event: 'PostToolUse', payload: { tool_name: 'Artifact', tool_response: { url: 'https://claude.ai/artifact/abc', title: 'T' } } });
  assert.match(r.logs[0], /^\[canvas\] could not save the shelf: \S/);
  assert.deepStrictEqual(r.frames, []);
});

// ---- canvas-mcp --------------------------------------------------------------------------------------------------------

function mcpRig(sessionId = SID) {
  const base = tmpDir('cc-canvas-mcp-kills-');
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'canvas'), { recursive: true });
  const pointerFile = path.join(root, 'canvas', '_tab-1.json');
  if (sessionId) fs.writeFileSync(pointerFile, JSON.stringify({ sessionId }));
  const mcp = createCanvasMcp({ root, pointerFile });
  return { mcp, root, pointerFile, dir: path.join(root, 'canvas', SID) };
}
const rpc = (mcp, method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params });
const textOf = (a) => a.result.content.map(c => c.text).join('\n');

test('S21 canvas-mcp: only an object with a string method and an id is answered; id 0 and "" are ids', () => {
  const { mcp } = mcpRig();
  for (const junk of [null, undefined, 5, 'ping', true, [], { jsonrpc: '2.0', id: 1 }, { id: 1, method: 5 }, { id: 1, method: null }]) {
    assert.strictEqual(mcp.handle(junk), null, JSON.stringify(junk));
  }
  assert.strictEqual(mcp.handle({ method: 'ping' }), null, 'no id: a notification');
  assert.strictEqual(mcp.handle({ method: 'ping', id: null }), null);
  assert.deepStrictEqual(mcp.handle({ method: 'ping', id: 0 }), { jsonrpc: '2.0', id: 0, result: {} });
  assert.deepStrictEqual(mcp.handle({ method: 'ping', id: '' }), { jsonrpc: '2.0', id: '', result: {} });
  assert.deepStrictEqual(mcp.handle({ method: 'ping', id: 'abc' }), { jsonrpc: '2.0', id: 'abc', result: {} });
});

test('S21 canvas-mcp: initialize echoes a string protocol version, defaults otherwise, and names the server', () => {
  const { mcp } = mcpRig();
  const a = rpc(mcp, 'initialize', { protocolVersion: '2025-03-26' });
  assert.deepStrictEqual(a.result, {
    protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'claude-custom-canvas', version: '1.0.0' }, instructions: INSTRUCTIONS,
  });
  for (const params of [undefined, null, {}, { protocolVersion: 5 }, { protocolVersion: null }, 'x']) {
    assert.strictEqual(rpc(mcp, 'initialize', params).result.protocolVersion, '2024-11-05', JSON.stringify(params));
  }
});

test('S21 canvas-mcp: an unknown method is a -32601 error that names it (cut at 80 characters); tools/list answers the two tools', () => {
  const { mcp } = mcpRig();
  const e = rpc(mcp, 'nope/never');
  assert.deepStrictEqual(e, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: nope/never' } });
  assert.strictEqual(rpc(mcp, 'x'.repeat(200)).error.message, `Method not found: ${'x'.repeat(80)}`);
  assert.deepStrictEqual(rpc(mcp, 'tools/list').result, { tools: TOOLS });
  assert.deepStrictEqual(TOOLS.map(t => t.name), ['canvas_render', 'canvas_list_artifacts']);
  assert.deepStrictEqual(TOOLS[0].inputSchema.required, ['html']);
  assert.ok(Object.isFrozen(TOOLS));
});

test('S21 canvas-mcp: tools/call with an unknown tool, a missing name or no params is an error answer naming it (cut at 80)', () => {
  const { mcp } = mcpRig();
  const unknown = rpc(mcp, 'tools/call', { name: 'rm_rf' }).result;
  assert.strictEqual(unknown.isError, true);
  assert.strictEqual(unknown.content[0].text, 'Unknown tool: rm_rf');
  assert.strictEqual(rpc(mcp, 'tools/call', undefined).result.content[0].text, 'Unknown tool: undefined');
  assert.strictEqual(rpc(mcp, 'tools/call', null).result.content[0].text, 'Unknown tool: undefined');
  assert.strictEqual(rpc(mcp, 'tools/call', {}).result.content[0].text, 'Unknown tool: undefined');
  assert.strictEqual(rpc(mcp, 'tools/call', 'canvas_render').result.content[0].text, 'Unknown tool: undefined');
  assert.strictEqual(rpc(mcp, 'tools/call', { name: 'y'.repeat(200) }).result.content[0].text, `Unknown tool: ${'y'.repeat(80)}`);
});

test('S21 canvas-mcp: a render reports its BYTES (not characters), and an over-size page names both numbers', () => {
  const r = mcpRig();
  const ok = rpc(r.mcp, 'tools/call', { name: 'canvas_render', arguments: { html: 'é€' } }).result;
  assert.notStrictEqual(ok.isError, true);
  assert.match(ok.content[0].text, /^Rendered 5 bytes into the user's Claude's panel\./);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8'), 'é€');
  const big = rpc(r.mcp, 'tools/call', { name: 'canvas_render', arguments: { html: 'x'.repeat(MAX_HTML_BYTES + 1) } }).result;
  assert.strictEqual(big.isError, true);
  assert.ok(big.content[0].text.includes(`${MAX_HTML_BYTES + 1} bytes`) && big.content[0].text.includes(`limit is ${MAX_HTML_BYTES}`), big.content[0].text);
});

test('S21 canvas-mcp: with no root or no pointer file configured, every call is an error answer and nothing is written', () => {
  const base = tmpDir('cc-canvas-mcp-kills-');
  for (const cfg of [{}, { root: base }, { pointerFile: path.join(base, 'p.json') }, undefined]) {
    const mcp = createCanvasMcp(cfg);
    const out = rpc(mcp, 'tools/call', { name: 'canvas_render', arguments: { html: 'x' } }).result;
    assert.strictEqual(out.isError, true);
    assert.match(out.content[0].text, /not ready/);
    assert.match(textOf(rpc(mcp, 'tools/call', { name: 'canvas_list_artifacts' })), /shelf is empty/);
  }
  assert.deepStrictEqual(fs.readdirSync(base), []);
});

test('S21 canvas-mcp: canvas_list_artifacts prints one "title - address (time)" line per entry, newest first', () => {
  const r = mcpRig();
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'shelf.json'), JSON.stringify({ version: 1, items: [
    { title: 'Second', url: 'https://claude.ai/artifact/b', time: '2026-10-09T02:00:00Z' },
    { title: 'First', url: 'https://claude.ai/artifact/a', time: '2026-10-09T01:00:00Z' },
  ] }));
  const out = rpc(r.mcp, 'tools/call', { name: 'canvas_list_artifacts' }).result;
  assert.notStrictEqual(out.isError, true);
  assert.strictEqual(out.content[0].text, 'Second - https://claude.ai/artifact/b (2026-10-09T02:00:00Z)\nFirst - https://claude.ai/artifact/a (2026-10-09T01:00:00Z)');
});
