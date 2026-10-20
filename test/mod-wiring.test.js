'use strict';
/**
 * host.js's half of the claude-custom mod (BACKLOG #119 A2): source assertions in the style of test/canvas-wiring.test.js, because
 * host.js can't be loaded by a unit test. The behaviour is in test/mod-feed.test.js, test/mod-quota-share.test.js,
 * test/mood-machine-mod-status.test.js, test/attention-mod-ask.test.js, test/context-source.test.js and
 * test/cc-mod-settings.test.js; the end-to-end run is verify/probe-cc-mod.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const CODE = strip(HOST);

test('the arguments are rebuilt with the mod once the CLI\'s version is known, from the same options', () => {
  assert.match(CODE, /const ARGS_OPTIONS = \{ settingsFile, helperExists, canvasMcp, side: SIDE \};/);
  assert.match(CODE, /let ARGS = buildClaudeArgs\(ARGS_OPTIONS\);/);
  assert.match(CODE, /ARGS = buildClaudeArgs\(\{ \.\.\.ARGS_OPTIONS, modDir \}\);/);
});

test('the mod is decided by the switch, the CLI\'s version and the directory, before the session starts', () => {
  assert.match(CODE, /const \[processStartedAt, excluded\] = await Promise\.all\(\[createSelfStartTime\(\)\(\), excludedRanges\(\), prepareMod\(\)\]\);/);
  const prep = CODE.slice(CODE.indexOf('async function prepareMod()'), CODE.indexOf('async function prepareMod()') + 1800);
  assert.match(prep, /modEnabled\(\{ env: process\.env, stateDir: path\.join\(HARNESS_DIR, 'state'\) \}\)/);
  assert.match(prep, /readCliVersion\(CLAUDE_BIN\)/);
  assert.match(prep, /modPluginDirFor\(\{ enabled, version, dir: MOD_DIR, forced \}\)/);
  assert.match(prep, /modPort = await modServer\.listen\(\);/);
  assert.match(prep, /catch \(err\)[\s\S]*return;/, 'a failure leaves the session without the mod, never without a session');
});

test('the mod\'s port and token reach the child through its environment, and only when the server is up', () => {
  assert.match(CODE, /\.\.\.\(modPort === null \? \{\} : \{ CLAUDE_CUSTOM_MOD_PORT: String\(modPort\), CLAUDE_CUSTOM_MOD_TOKEN: MOD_TOKEN \}\),/);
});

test('an inherited port or token (a host launched from inside a harness tab) never reaches the child', () => {
  const list = CODE.slice(CODE.indexOf('const INHERITED_SESSION_VARS = ['), CODE.indexOf('];', CODE.indexOf('const INHERITED_SESSION_VARS = [')));
  assert.match(list, /'CLAUDE_CUSTOM_MOD_PORT'/);
  assert.match(list, /'CLAUDE_CUSTOM_MOD_TOKEN'/);
});

test('the mod token is the host\'s own fresh one, never the window\'s session token', () => {
  assert.match(CODE, /const MOD_TOKEN = newToken\(\);/);
  assert.doesNotMatch(CODE, /CLAUDE_CUSTOM_MOD_TOKEN: SESSION_TOKEN/);
  assert.match(CODE, /createModServer\(\{ token: MOD_TOKEN, onRecord: handleModRecord,/);
});

test('the relay and the mod both feed the context through the one source', () => {
  assert.match(CODE, /const contextSource = createContextSource\(\);/);
  assert.match(CODE, /setContext\(contextSource\.fromRelay\(readContext\(ev\.payload\)\)\);/);
  assert.match(CODE, /setContext\(contextSource\.fromMod\(contextFromUsage\(rec\.usage\)\)\);/);
});

test('a clear or a compaction forgets both context sources before it clears the fill', () => {
  const at = CODE.indexOf('contextSource.reset();');
  assert.ok(at !== -1);
  assert.ok(at < CODE.indexOf('setContext(null);', at));
  assert.match(CODE.slice(at - 400, at), /source === 'clear' \|\| ev\.payload\.source === 'compact'/);
});

test('a usage record writes its windows through the shared quota file and reads them back with no poll', () => {
  const fn = CODE.slice(CODE.indexOf('function handleModRecord(rec)'), CODE.indexOf('function handleModRecord(rec)') + 2200);
  assert.match(fn, /recordModWindows\(\{ windows: windowsFromRateLimits\(rec\.usage\.rateLimits\) \}\)/);
  assert.match(fn, /hostQuota\.readNow\(\)/);
  assert.doesNotMatch(fn, /refreshQuota\(|readQuota\(/, 'a record every couple of seconds must never cost a poll');
  assert.match(fn, /broadcastControl\(\{ type: 'quota', quota \}\)/);
});

test('agents feed the mood machine\'s second source, asks feed attention, and an ask also marks the card', () => {
  const fn = CODE.slice(CODE.indexOf('function handleModRecord(rec)'), CODE.indexOf('function handleModRecord(rec)') + 2800);
  assert.match(fn, /mood\.observeAgents\(rec\.agents\)/);
  assert.match(fn, /attention\.ask\(rec\.ask\)/);
});

test('a throw in a record\'s handling is the mod feed\'s to log, not the host\'s to die of', () => {
  const fn = CODE.slice(CODE.indexOf('function handleModRecord(rec)'), CODE.indexOf('function handleModRecord(rec)') + 2800);
  assert.match(fn, /try \{[\s\S]*\} catch \(err\) \{ console\.log\('\[host\] mod record:'/);
});

test('the mod server closes with the host', () => {
  const fn = CODE.slice(CODE.indexOf('function shutdown('), CODE.indexOf('function shutdown(') + 600);
  assert.match(fn, /modServer\.close\(\)/);
});
