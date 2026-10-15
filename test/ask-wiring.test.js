'use strict';
/**
 * "Ask the repo" wiring that only a running host has (BACKLOG #33): a frame of an unlisted type is TYPED into the pty as JSON (it has
 * happened twice in this repo), so the `ask` type must be listed, dispatched, and never reach a host that does not know it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseControlFrame, CONTROL_TYPES } = require('../host/control');

const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the ask frame is a known control type, never pty input', () => {
  assert.ok(CONTROL_TYPES.has('ask'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'ask', op: 'status', seq: 1 })), { type: 'ask', op: 'status', seq: 1 });
});

test('host.js dispatches ask to the service and answers on the same socket', () => {
  const at = HOST_SRC.indexOf("msg.type === 'ask'");
  assert.ok(at !== -1, 'dispatchControl must handle ask');
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf("if (msg.type ===", at + 10));
  assert.match(branch, /askService\.handle\(msg\)/);
  assert.match(branch, /ws\.send\(JSON\.stringify\(reply\)\)/);
  assert.match(branch, /return;/);
});

test('the host builds the Claude answerer from the claude it resolved for the session, with no API key of its own', () => {
  assert.match(HOST_SRC, /createClaudeAnswerer\(\{ claudeBin: CLAUDE_BIN, anchor: CWD \}\)/, 'the tab\'s own cwd anchors a relative CLAUDE_CONFIG_DIR (PR #169 Dexter N5)');
  assert.doesNotMatch(HOST_SRC, /ANTHROPIC_API_KEY/);
});

// --- gamification (BACKLOG #33): the explainer's life in the host ---------------------------------------------------------------------

test('the host gives the service the explainer and the counts, and tells every window when either changes', () => {
  assert.match(HOST_SRC, /createAskService\(\{\s*log: \(\.\.\.a\) => console\.log\(\.\.\.a\), explainer: askExplainer, counts: askCounts, onCounts:/, 'a refused count is logged, not dropped (PR #178 Dexter F3)');
  assert.match(HOST_SRC, /askExplainer\.on\('change', broadcastExplainer\)/);
  assert.match(HOST_SRC, /const broadcastExplainer = \(\) => broadcastControl\(explainerFrame\(\)\)/);
});

test('the explainer frame carries its state, how many panels are open, the counts (null when unknown) and its picture', () => {
  const at = HOST_SRC.indexOf('const explainerFrame');
  const frame = HOST_SRC.slice(at, HOST_SRC.indexOf('\n};', at));
  assert.match(frame, /type: 'explainer'/);
  for (const k of ['state: s.state', 'detail: s.detail', 'panels: s.panels', 'counts: askCounts.read()', 'portrait: describe(EXPLAINER_AGENT']) assert.ok(frame.includes(k), k);
});

test('a new window is handed the explainer in its handshake', () => {
  const hello = HOST_SRC.indexOf("type: 'hello'");
  assert.ok(hello !== -1);
  assert.match(HOST_SRC.slice(hello, hello + 12000), /explainer: explainerFrame\(\)/);
});

test('the `panel` op tells the explainer which window has the panel open, is never answered, and a closed window stops counting', () => {
  const at = HOST_SRC.indexOf("msg.type === 'ask'");
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf("if (msg.type ===", at + 10));
  assert.match(branch, /msg\.op === 'panel'\) \{ askExplainer\.setPanel\(ws, msg\.open === true\); return; \}/);
  assert.ok(branch.indexOf("msg.op === 'panel'") < branch.indexOf('askService.handle(msg)'), 'before the service, which would answer it as an unknown op');
  assert.match(HOST_SRC, /askExplainer\.dropViewer\(ws\)/);
});

test('the explainer\'s clock runs on the host\'s 1 s timer and the counts of another tab are looked at every 3 s', () => {
  assert.match(HOST_SRC, /askExplainer\.tick\(\)/);
  assert.match(HOST_SRC, /askCountsWatch\.tick\(\)/);
});

test('a new picture for the explainer re-sends its frame, so its card wears it', () => {
  assert.match(HOST_SRC, /out\.reply\.agent === EXPLAINER_AGENT\) broadcastExplainer\(\)/);
});
