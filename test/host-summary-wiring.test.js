'use strict';
/**
 * host.js's half of the "where are we" summary (backlog #39 job 1): source assertions in the style of
 * test/host-bar-wiring.test.js, because host.js can't be loaded by a unit test. The behaviour runs end to end in
 * verify/probe-where-summary.js (a fake Ollama, a real window).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

function summaryBlock() {
  const start = HOST.indexOf('const summary = createSummaryService({');
  assert.ok(start !== -1, 'the summary service is built in host.js');
  return HOST.slice(start, HOST.indexOf('summaryTimer.unref();', start) + 'summaryTimer.unref();'.length);
}

test('every module is required once', () => {
  for (const [name, file] of [['createSummaryService', 'summary-service'], ['createScheduler', 'summary-scheduler'], ['createSlot', 'summary-slot'],
    ['createOllamaClient', 'summary-ollama'], ['createSummaryStore', 'summary-store'], ['createPowerProbe', 'summary-power']]) {
    assert.match(HOST, new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = require\\('\\./${file}'\\);`), file);
  }
});

test('the service reads THIS session\'s transcript where the ledger finds it, and uses the probe seams when set', () => {
  const b = summaryBlock();
  assert.match(b, /sessionId: \(\) => sessionId,/);
  assert.match(b, /transcriptFile: \(id\) => path\.join\(seams\.projectsDir \|\| defaultProjectsDir\(\), projectDirName\(CWD\), id \+ '\.jsonl'\),/);
  assert.match(b, /createOllamaClient\(\{ baseUrl: seams\.ollamaUrl \|\| undefined \}\)/);
});

test('summaries and the GPU slot live in one folder under the harness state, or the probe\'s own', () => {
  assert.match(HOST, /const SUMMARY_DIR = seams\.summaryDir \|\| path\.join\(HARNESS_DIR, 'state', 'summaries'\);/);
  const b = summaryBlock();
  assert.match(b, /createSummaryStore\(\{ dir: SUMMARY_DIR \}\)/);
  assert.match(b, /createSlot\(\{ file: path\.join\(SUMMARY_DIR, '\.job\.lock'\) \}\)/);
});

test('it pushes through the control channel and ticks on an unref\'d timer that never throws into the host', () => {
  const b = summaryBlock();
  assert.match(b, /broadcast: \(m\) => broadcastControl\(m\),/);
  assert.match(b, /onBattery: createPowerProbe\(\)\.onBattery,/);
  assert.match(b, /const summaryTimer = setInterval\(\(\) => \{ summary\.tick\(\)\.catch\(\(\) => \{ \/\* logged inside \*\/ \}\); \}, TICK_MS\);/);
});

test('hello carries the summary and why there is none, so a window that attached late shows it', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf('agentStats: lastAgentStats'));
  assert.match(hello, /summary: summaryNow\.summary,/);
  assert.match(hello, /summaryOff: summaryNow\.off,/);
  assert.match(HOST, /const summaryNow = summary\.snapshot\(\);/);
});

test('nothing in the host feeds the summary into a session: it is never typed to the pty', () => {
  const b = summaryBlock();
  assert.doesNotMatch(b, /term\.write|ptyWrite|sendToPty|handleFrame/);
});
