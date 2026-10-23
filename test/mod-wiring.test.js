'use strict';
/**
 * host.js's half of the claude-custom mod (BACKLOG #119 A2): source assertions in the style of test/canvas-wiring.test.js, because host.js
 * can't be loaded by a unit test. The behaviour is in test/mod-feed.test.js, test/mod-records.test.js (what each record does, with injected
 * collaborators), test/mod-quota-share.test.js, test/mood-machine-mod-status.test.js, test/attention-mod-ask.test.js,
 * test/context-source.test.js and test/cc-mod-settings.test.js; the end-to-end run is verify/probe-cc-mod.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const CODE = strip(HOST);

test('the arguments are rebuilt with the mod once the CLI\'s version is known, from the same options', () => {
  assert.match(CODE, /const ARGS_OPTIONS = \{ settingsFile, helperExists, canvasMcp, side: SIDE \};/);
  assert.match(CODE, /let ARGS = buildClaudeArgs\(ARGS_OPTIONS\);/);
  assert.match(CODE, /ARGS = buildClaudeArgs\(\{ \.\.\.ARGS_OPTIONS, modDir: modPluginDirFor\(\{ enabled, version, dir: MOD_DIR, forced \}\) \}\);/);
});

test('the mod is decided by the switch, the CLI\'s version and the directory, before the session starts', () => {
  assert.match(CODE, /const \[processStartedAt, excluded\] = await Promise\.all\(\[createSelfStartTime\(\)\(\), excludedRanges\(\), prepareMod\(\)\]\);/);
  const prep = CODE.slice(CODE.indexOf('async function prepareMod()'), CODE.indexOf('async function prepareMod()') + 2200);
  assert.match(prep, /modEnabled\(\{ env: process\.env, stateDir: path\.join\(HARNESS_DIR, 'state'\) \}\)/);
  assert.match(prep, /readCliVersion\(CLAUDE_BIN\)/);
  assert.match(prep, /modOffReason\(\{ enabled, version, dir: MOD_DIR, forced \}\)/);
  assert.match(prep, /modPort = await modServer\.listen\(\);/);
  assert.match(prep, /catch \(err\) \{\s*modPort = null;/, 'a failure leaves the session without the mod, never without a session');
});

test('Miguel Y9: a mod that is not loaded says why, once in the log and in the status the diagnostics pane shows', () => {
  const prep = CODE.slice(CODE.indexOf('async function prepareMod()'), CODE.indexOf('async function prepareMod()') + 2200);
  assert.match(prep, /console\.log\('\[host\] claude-custom mod: not loaded --', why\);/);
  assert.match(prep, /setModStatus\(\{ state: enabled \? 'not-loaded' : 'off', reason: why \}\);/);
  assert.match(prep, /setModStatus\(\{ state: 'not-loaded', reason: 'the claude-custom mod failed to start: '/);
  assert.match(CODE, /function setModStatus\(status\) \{\s*modStatus = status;\s*broadcastControl\(\{ type: 'modStatus', modStatus \}\);/);
  const hello = CODE.slice(CODE.indexOf("type: 'hello',"), CODE.indexOf("type: 'hello',") + 900);
  assert.match(hello, /\n\s+modStatus,/, 'a window that attaches later is told too');
});

test('Miguel Y9: the page writes the reason into the diagnostics log, for a mod that is off or failed, once per reason', () => {
  assert.match(RENDERER, /if \(msg\.type === 'modStatus'\) \{ noteModStatus\(msg\.modStatus\); return; \}/);
  assert.match(RENDERER, /if \(msg\.type === 'hello'\) \{\s*noteModStatus\(msg\.modStatus\);/);
  const fn = RENDERER.slice(RENDERER.indexOf('function noteModStatus('), RENDERER.indexOf('function handleControl('));
  assert.match(fn, /status\.state === 'on'/);
  assert.match(fn, /status\.reason === lastModStatusLogged/);
  assert.match(fn, /logLine\('claude-custom mod', status\.reason\)/);
});

test('the mod\'s port and token reach the child through its environment, and only when the server is up', () => {
  assert.match(CODE, /\.\.\.\(modPort === null \? \{\} : \{ CLAUDE_CUSTOM_MOD_PORT: String\(modPort\), CLAUDE_CUSTOM_MOD_TOKEN: MOD_TOKEN \}\),/);
});

test('an inherited port or token (a host launched from inside a harness tab) never reaches the child', () => {
  const list = CODE.slice(CODE.indexOf('const INHERITED_SESSION_VARS = ['), CODE.indexOf('];', CODE.indexOf('const INHERITED_SESSION_VARS = [')));
  assert.match(list, /'CLAUDE_CUSTOM_MOD_PORT'/);
  assert.match(list, /'CLAUDE_CUSTOM_MOD_TOKEN'/);
});

test('the mod token is the host\'s own fresh one, minted once per host process, never the window\'s session token', () => {
  assert.match(CODE, /const MOD_TOKEN = newToken\(\);/);
  assert.doesNotMatch(CODE, /CLAUDE_CUSTOM_MOD_TOKEN: SESSION_TOKEN/);
  assert.match(CODE, /createModServer\(\{ token: MOD_TOKEN, onRecord: \(rec\) => handleModRecord\(rec\),/);
});

test('the relay feeds the context through the one source, and the mod through its record handler', () => {
  assert.match(CODE, /const contextSource = createContextSource\(\);/);
  assert.match(CODE, /setContext\(contextSource\.fromRelay\(readContext\(ev\.payload\)\)\);/);
  assert.doesNotMatch(CODE, /contextSource\.fromMod\(/, 'only host/mod-records.js speaks for the mod, and only with a figure (Miguel Y5)');
});

test('a clear or a compaction forgets both context sources before it clears the fill', () => {
  const at = CODE.indexOf('contextSource.reset();');
  assert.ok(at !== -1);
  assert.ok(at < CODE.indexOf('setContext(null);', at));
  assert.match(CODE.slice(at - 400, at), /source === 'clear' \|\| ev\.payload\.source === 'compact'/);
});

test('the record handler is built from the host\'s own collaborators: its session id, the shared quota file with no poll, the mood machine and attention', () => {
  const at = CODE.indexOf('const handleModRecord = createModRecordHandler({');
  assert.ok(at !== -1);
  const body = CODE.slice(at, CODE.indexOf('});', at));
  assert.match(body, /getSessionId: \(\) => sessionId,/, 'a record for another session is dropped (Dexter 7)');
  assert.match(body, /writeWindows: \(windows\) => recordModWindows\(\{ windows \}\),/);
  assert.match(body, /readQuota: \(\) => hostQuota\.readNow\(\),/);
  assert.doesNotMatch(body, /refreshQuota|readQuota\(\)\s*=>\s*readQuota|pollOnce/, 'a record every couple of seconds must never cost a poll');
  assert.match(body, /broadcastQuota: \(quota\) => broadcastControl\(\{ type: 'quota', quota \}\),/);
  assert.match(body, /\s+mood,\s+attention,/);
});

test('the mod server closes with the host', () => {
  const fn = CODE.slice(CODE.indexOf('function shutdown('), CODE.indexOf('function shutdown(') + 600);
  assert.match(fn, /modServer\.close\(\)/);
});
