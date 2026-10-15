'use strict';
/**
 * host.js's half of Claude's panel (BACKLOG #71): source assertions in the style of test/wand-wiring.test.js, because host.js
 * can't be loaded by a unit test. The behaviour is in test/canvas-control.test.js; the end-to-end run is
 * verify/probe-canvas-panel.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CONTROL_TYPES, parseControlFrame } = require('../host/control');
const { CANVAS_TYPES } = require('../host/canvas-control');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('every canvas message is a KNOWN control type, or it is typed into the pty as literal JSON', () => {
  for (const t of CANVAS_TYPES) {
    assert.ok(CONTROL_TYPES.has(t), `${t} must be in CONTROL_TYPES`);
    assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: t })), { type: t }, t);
  }
});

test('the host builds the control on the state folder, the live session id and the shared watcher', () => {
  assert.match(HOST, /const \{ createCanvasControl \} = require\('\.\/canvas-control'\);/);
  assert.match(HOST, /const canvasControl = createCanvasControl\(\{\s*stateDir: path\.join\(HARNESS_DIR, 'state'\),\s*getSessionId: \(\) => sessionId,\s*emit: \(frame\) => \{[^\n]*usageCounters\.bump\('canvas:render'\); broadcastControl\(frame\); \},\s*watch: watchDir,/);
});

test("every attaching window is told the panel's state in its hello", () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf('});', HOST.indexOf("type: 'hello',")));
  assert.match(hello, /\n\s+canvas: canvasControl\.payload\(\),/);
});

test('a canvas message is answered by canvasControl.handle, which broadcasts', () => {
  const at = HOST.indexOf('if (canvasControl.handles(msg.type)) {');
  assert.ok(at !== -1, 'the canvas branch must be findable');
  const block = HOST.slice(at, HOST.indexOf('\n    }', at));
  assert.match(block, /canvasControl\.handle\(msg\);/);
  assert.match(block, /return;/);
});

test("the CLI's session id (SessionStart) re-points the panel, and shutdown closes it", () => {
  const at = HOST.indexOf("if (ev.event === 'SessionStart' && ev.payload && ev.payload.session_id) {");
  assert.ok(at !== -1);
  const block = HOST.slice(at, HOST.indexOf('\n    }', at));
  assert.match(block, /canvasControl\.sessionChanged\(sessionId\);/);
  const shut = HOST.slice(HOST.indexOf('function shutdown('), HOST.indexOf("process.on('SIGINT'"));
  assert.match(shut, /canvasControl\.close\(\)/);
});

test('the panel folder is the state dir, which the host owns: only it is ever created by the canvas watch', () => {
  assert.doesNotMatch(HOST, /watchDir\(\{[^}]*CLAUDE_HOME[^}]*canvas/);
});

test('an Artifact hook event goes to the shelf and nowhere else: after the occupancy and bedtime exits, before the mood engine', () => {
  const at = HOST.indexOf('if (canvasControl.handlesShelfEvent(ev)) {');
  assert.ok(at !== -1, 'the shelf branch must be findable');
  const block = HOST.slice(at, HOST.indexOf('\n    }', at));
  assert.match(block, /canvasControl\.shelfEvent\(ev\);/);
  assert.match(block, /return;/);
  assert.ok(at > HOST.indexOf('if (isBedtimeOnly(ev)) return;'), 'after the bedtime exit');
  assert.ok(at < HOST.indexOf("if (ev.event === 'SessionStart' && ev.payload"), 'before anything reads the event as work');
});

test("Claude's panel's MCP server is injected through buildClaudeArgs, only when the setting allows it, with the host's own pointer file", () => {
  assert.match(HOST, /const \{ canvasMcpEnabled \} = require\('\.\/canvas-settings'\);/);
  assert.match(HOST, /const CANVAS_POINTER_FILE = path\.join\(HARNESS_DIR, 'state', 'canvas', `_tab-\$\{PORT\}\.json`\);/);
  assert.match(HOST, /const canvasMcp = helperExists && canvasMcpEnabled\(\{ env: process\.env, stateDir: path\.join\(HARNESS_DIR, 'state'\) \}\)/, 'never without the hook helper (Dexter #8)');
  assert.match(HOST, /const ARGS = buildClaudeArgs\(\{ settingsFile, helperExists, canvasMcp, side: SIDE \}\);/);
  assert.match(HOST, /pointerFile: canvasMcp \? CANVAS_POINTER_FILE : null,/, 'the same file the server reads is the one the control writes, and none when no server is offered (Miguel S5)');
  assert.match(HOST, /scriptPath: path\.join\(__dirname, 'canvas-mcp\.js'\)/);
});
