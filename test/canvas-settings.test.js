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

// verify/ probes run a stand-in for `claude` (cmd.exe, a fake input box). cmd.exe takes --mcp-config's JSON for a command line, prints
// errors and EXITS, killing the session the probe is looking at. An overridden binary is not assumed to understand the flag.
test('a binary override (CLAUDE_CUSTOM_BIN) switches the injection off, unless it is asked for explicitly', () => {
  const dir = state();
  assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:/Windows/System32/cmd.exe' }, stateDir: dir }), false);
  for (const v of ['1', 'on', 'true', 'yes', 'ON']) {
    assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:/x/claude.exe', CLAUDE_CUSTOM_CANVAS_MCP: v }, stateDir: dir }), true, v);
  }
  assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:/x/claude.exe', CLAUDE_CUSTOM_CANVAS_MCP: '0' }, stateDir: dir }), false);
  assert.strictEqual(canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: '' }, stateDir: dir }), true, 'an empty override is no override');
});

// ---- the Style tab's switch (#71 question 8, decided 2026-10-06: the recommendation) -------------------------------------------------------------

const { readMcpSetting, writeMcpSetting } = require('../host/canvas-settings');

test('the checkbox reads the file: on with no file, off only for { "mcp": false }, unknown for a read that failed', () => {
  const dir = state();
  const put = (v) => fs.writeFileSync(path.join(dir, 'canvas-settings.json'), typeof v === 'string' ? v : JSON.stringify(v));
  assert.strictEqual(readMcpSetting(dir), true, 'no file');
  put({ mcp: false }); assert.strictEqual(readMcpSetting(dir), false);
  for (const v of [{ mcp: true }, {}, { mcp: 0 }, { mcp: 'false' }, [], 'null', '{nope']) { put(v); assert.strictEqual(readMcpSetting(dir), true, JSON.stringify(v)); }
  for (const bad of [undefined, null, '', 5]) assert.strictEqual(readMcpSetting(bad), null);
  const folder = state();
  fs.mkdirSync(path.join(folder, 'canvas-settings.json'));
  assert.strictEqual(readMcpSetting(folder), null, 'a read that fails for a reason other than "missing" is unknown, not a guess');
});

test('writing the checkbox: the file says what was chosen, other keys stay, and a non-boolean writes nothing', () => {
  const dir = path.join(state(), 'fresh');
  assert.strictEqual(writeMcpSetting(dir, false), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')), { mcp: false });
  assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: dir }), false, 'the injection reads exactly what the checkbox wrote');
  fs.writeFileSync(path.join(dir, 'canvas-settings.json'), JSON.stringify({ mcp: false, other: 1 }));
  assert.strictEqual(writeMcpSetting(dir, true), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')), { mcp: true, other: 1 });
  assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: dir }), true);
  for (const bad of ['false', 0, 1, null, undefined, {}]) {
    assert.strictEqual(writeMcpSetting(dir, bad), null, String(bad));
  }
  assert.strictEqual(writeMcpSetting('', true), null);
  assert.strictEqual(writeMcpSetting(undefined, true), null);
  assert.deepStrictEqual(fs.readdirSync(dir), ['canvas-settings.json'], 'no temp file is left behind');
});

test('a corrupt file is replaced by the choice, and a folder where the file should be is a failed write (null), not a throw', () => {
  const dir = state();
  fs.writeFileSync(path.join(dir, 'canvas-settings.json'), '{nope');
  assert.strictEqual(writeMcpSetting(dir, false), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')), { mcp: false });
  const blocked = state();
  fs.mkdirSync(path.join(blocked, 'canvas-settings.json'));
  assert.strictEqual(writeMcpSetting(blocked, true), null);
});

test('property: whatever sequence of choices, the file always reads back as the last one', () => {
  const fc = require('fast-check');
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), (choices) => {
    const dir = state();
    for (const c of choices) assert.strictEqual(writeMcpSetting(dir, c), c);
    assert.strictEqual(readMcpSetting(dir), choices[choices.length - 1]);
    assert.strictEqual(canvasMcpEnabled({ env: {}, stateDir: dir }), choices[choices.length - 1]);
  }), { numRuns: 40 });
});

test('PR #125 Miguel M1: a settings write that fails leaves no temp file', () => {
  const blocked = state();
  fs.mkdirSync(path.join(blocked, 'canvas-settings.json'));
  assert.strictEqual(writeMcpSetting(blocked, true), null);
  assert.deepStrictEqual(fs.readdirSync(blocked), ['canvas-settings.json']);
});
