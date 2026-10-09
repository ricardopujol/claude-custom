'use strict';
/**
 * host.js's and the page's half of docs drift (BACKLOG #39 job 2): source assertions in the style of
 * test/host-summary-wiring.test.js, because host.js can't be loaded by a unit test.
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CONTROL_TYPES, parseControlFrame } = require('../host/control');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOST = read('host', 'host.js');
const RENDERER = read('app', 'renderer.js');
const HTML = read('app', 'renderer.html');

function block() {
  const start = HOST.indexOf('const drift = createDriftService({');
  assert.ok(start !== -1, 'the drift service is built in host.js');
  return HOST.slice(start, HOST.indexOf('driftFirst.unref();', start) + 'driftFirst.unref();'.length);
}

test('every module is required once', () => {
  for (const [name, file] of [['createDriftService', 'drift-service'], ['createDriftStore', 'drift-store'], ['createDriftGit', 'drift-git'],
    ['readDocsDir', 'drift-docs-fs'], ['createAskOllama', 'ask-ollama']]) {
    assert.match(HOST, new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = require\\('\\./${file}'\\);`), file);
  }
});

test('it watches the project\'s develop checkout and reads that checkout\'s documentation folder', () => {
  const b = block();
  assert.match(b, /createDriftGit\(\{ cwd: STATE_ROOT \}\)/);
  assert.match(b, /readDocsDir\(path\.join\(STATE_ROOT, 'documentation'\)\)/);
});

test('it talks to the same Ollama as the probes point at, with a generate timeout inside the GPU slot\'s stale time', () => {
  const b = block();
  assert.match(b, /createAskOllama\(\{ baseUrl: seams\.ollamaUrl \|\| undefined, generateTimeoutMs: DRIFT_GENERATE_MS \}\)/);
});

test('it shares the summaries\' GPU slot file, so one Ollama job runs at a time across every host', () => {
  assert.match(block(), /createSlot\(\{ file: path\.join\(SUMMARY_DIR, '\.job\.lock'\) \}\)/);
});

test('its notes are kept per project under the harness state, and it ticks on unref\'d timers that never throw into the host', () => {
  const b = block();
  // ...or under the probe's own summaries folder when that seam is set, so a probe never writes into the real harness state
  assert.match(HOST, /const DRIFT_FILE = path\.join\(seams\.summaryDir \? path\.join\(seams\.summaryDir, 'docs-drift'\) : path\.join\(HARNESS_DIR, 'state', 'docs-drift'\),/);
  assert.match(b, /store: createDriftStore\(\{ file: DRIFT_FILE \}\)/);
  assert.match(b, /broadcast: \(m\) => broadcastControl\(m\),/);
  assert.match(b, /driftTimer\.unref\(\);/);
  assert.match(b, /drift\.tick\(\)\.catch\(\(\) => \{ \/\* logged inside \*\/ \}\)/);
});

test('hello carries the list, so a window that attached late shows it', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf('agentStats: lastAgentStats'));
  assert.match(hello, /docsDrift: drift\.snapshot\(\),/);
});

test('the dismiss frame is a control type (or it would be TYPED into the pty) and the host answers it', () => {
  assert.ok(CONTROL_TYPES.has('docs-drift'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'docs-drift', action: 'dismiss', id: 'abc' })), { type: 'docs-drift', action: 'dismiss', id: 'abc' });
  const i = HOST.indexOf("if (msg.type === 'docs-drift') {");
  assert.ok(i !== -1);
  const handler = HOST.slice(i, HOST.indexOf("if (msg.type === 'git-tree')", i));
  assert.match(handler, /msg\.action === 'dismiss' && typeof msg\.id === 'string'/);
  assert.match(handler, /const r = drift\.dismiss\(msg\.id\);/);
  // a failed write is said to the window that asked (PR #153 Miguel I4); a good one is not echoed on top of the broadcast
  assert.match(handler, /if \(!r\.ok\) \{[\s\S]*sendControl\(ws, \{ type: 'docs-drift', \.\.\.drift\.snapshot\(\), error: /);
  assert.doesNotMatch(handler, /term\.write|ptyWrite/);
});

test('the page draws it in the git panel and sends only a dismiss', () => {
  assert.match(HTML, /<div id="drift-list" hidden><\/div>/);
  assert.match(HTML, /<script src="\.\/docs-drift-display\.js"><\/script>/);
  assert.match(RENDERER, /applyDocsDrift\(msg\.docsDrift\);/);
  assert.match(RENDERER, /if \(msg\.type === 'docs-drift'\) \{\s*applyDocsDrift\(msg\);/);
  assert.match(RENDERER, /JSON\.stringify\(\{ type: 'docs-drift', action: 'dismiss', id \}\)/);
});
