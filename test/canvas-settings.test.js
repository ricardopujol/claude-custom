'use strict';
/**
 * host/canvas-settings.js: whether the panel's MCP server is injected (BACKLOG #71, design call 3: "A setting turns the injection
 * off, and #62's lean mode will turn it off too"). Read once, when the host builds `claude`'s arguments: switching it takes effect
 * on the next session, the way every spawn flag does.
 *
 * Off when CLAUDE_CUSTOM_CANVAS_MCP is 0/off/false/no, or <state>/canvas-settings.json says { "mcp": false }. Anything unreadable
 * or unknown means ON: the default is the feature, and a corrupt file must not silently remove it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { canvasMcpEnabled } = require('../host/canvas-settings');

const state = () => tmpDir('cc-canvas-settings-');

test('on by default: no env, no file', () => {
  assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: state() }), true);
  assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: path.join(state(), 'nope') }), true);
  assert.strictEqual(canvasMcpEnabled({}), true);
});

test('the environment turns it off, in the usual spellings, and anything else leaves it on', () => {
  for (const v of ['0', 'off', 'OFF', 'false', 'False', 'no']) assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: v }, stateDir: state() }), false, v);
  for (const v of ['1', 'on', 'true', '', 'maybe', undefined]) assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: v }, stateDir: state() }), true, String(v));
});

test('the settings file turns it off with { "mcp": false } and only that', () => {
  const dir = state();
  const put = (v) => fs.writeFileSync(path.join(dir, 'canvas-settings.json'), typeof v === 'string' ? v : JSON.stringify(v));
  put({ mcp: false });
  assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: dir }), false);
  for (const v of [{ mcp: true }, {}, { mcp: 0 }, { mcp: 'false' }, [], 'null', '{nope', 'x']) { put(v); assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: dir }), true, JSON.stringify(v)); }
});

test('the environment wins in the "off" direction: either one is enough', () => {
  const dir = state();
  fs.writeFileSync(path.join(dir, 'canvas-settings.json'), JSON.stringify({ mcp: true }));
  assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: '0' }, stateDir: dir }), false);
});
