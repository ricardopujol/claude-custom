'use strict';
/**
 * host.js's half of the Schedules panel (BACKLOG #119 A7): source assertions in the style of test/host-bar-wiring.test.js, because host.js
 * can't be loaded by a unit test. The behaviour runs end to end in verify/probe-schedules.js (real hook events through the host's
 * bridge to a real window).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

function handlerBody() {
  const start = HOST.indexOf("hookBridge.on('event', (ev) => {");
  assert.ok(start !== -1, 'the hook bridge event handler');
  return HOST.slice(start, HOST.indexOf("hookBridge.on('parse-error'", start));
}

test('the harness settings ask for the cron matcher', () => {
  const call = HOST.slice(HOST.indexOf('writeHarnessSettings(HARNESS_DIR, {'), HOST.indexOf('}, PORT);'));
  assert.match(call, /\n\s+schedules: true,/);
});

test('the control is built once from the shared store, keyed by this host\'s port AND folder, and started only once the port is bound', () => {
  assert.match(HOST, /const \{ createSchedulesControl, isSchedulesOnly \} = require\('\.\/schedules-control'\);/);
  const at = HOST.indexOf('const schedulesControl = createSchedulesControl({');
  assert.ok(at !== -1);
  const block = HOST.slice(at, HOST.indexOf('});', at));
  assert.match(block, /store,/);
  assert.match(block, /key: `\$\{PORT\}:\$\{CWD\}`/, 'a port outlives its host: the folder is part of who owns an entry (PR #200 Dexter 5)');
  assert.doesNotMatch(block, /key: String\(PORT\)/);
  assert.match(block, /cwd: CWD/);
  assert.match(block, /nightView: \(\) => night\.payload\(\)/);
  assert.match(block, /emit: \(frame\) => broadcastControl\(frame\)/);
  assert.doesNotMatch(HOST.slice(at, HOST.indexOf('\nconst night = createNightStatus({', at)), /schedulesControl\.start\(\)/, 'not at module load: a host that loses the bind must never write the file');
  const listening = HOST.slice(HOST.indexOf("wss.on('listening', () => {"), HOST.indexOf("wss.on('error'"));
  assert.match(listening, /schedulesControl\.start\(\);/, 'started once the socket is listening');
});

test('every hook event reaches the schedule, and a cron call goes no further than it', () => {
  const body = handlerBody();
  const feed = body.indexOf('schedulesControl.event(ev);');
  assert.ok(feed !== -1, 'the schedule sees every event');
  assert.ok(feed < body.indexOf('if (isOccupancyOnly(ev)) { mood.handle(ev); return; }'), 'before any early return');
  const stop = body.indexOf('if (isSchedulesOnly(ev)) return;');
  assert.ok(stop !== -1, 'a CronCreate / CronDelete is the panel\'s and nobody else\'s');
  assert.ok(feed < stop);
  assert.ok(stop > body.indexOf('if (isBedtimeOnly(ev)) return;'), 'after the bedtime one, which owns ScheduleWakeup');
});

test('the night\'s PR count refreshes the schedule, so a bedtime row\'s detail follows it', () => {
  const at = HOST.indexOf('const night = createNightStatus({');
  const block = HOST.slice(at, HOST.indexOf('\n});', at));
  assert.match(block, /schedulesControl\.touch\(\)/);
  assert.ok(HOST.indexOf('const schedulesControl = createSchedulesControl({') < HOST.indexOf('const night = createNightStatus({'), 'built before the night that calls it');
});

test('hello carries the list, a window\'s request is answered to that window, and another host\'s write reaches this host\'s windows', () => {
  assert.match(HOST, /\n\s+schedules: schedulesControl\.payload\(\),/);
  assert.match(HOST, /if \(schedulesControl\.handles\(msg\.type\)\) \{\s*sendControl\(ws, schedulesControl\.reply\(msg\)\);\s*return;\s*\}/);
  const at = HOST.indexOf("match: (f) => f === 'schedules.json'");
  assert.ok(at !== -1, 'a watch on the shared file');
  assert.match(HOST.slice(at, at + 260), /schedulesControl\.changed\(\)[\s\S]*broadcastControl\(frame\)/);
});

test('a heartbeat keeps a host with rows alive, and a clean exit says so', () => {
  assert.match(HOST, /setInterval\(\(\) => \{ schedulesControl\.beat\(\); \}, 30_000\)/);
  const shut = HOST.slice(HOST.indexOf('function shutdown('), HOST.indexOf('// SIGINT is not how this host usually dies'));
  assert.match(shut, /schedulesControl\.end\(\)/);
  assert.match(HOST, /process\.on\('exit', \(\) => \{ schedulesControl\.end\(\); \}\);/);
});
