'use strict';
/**
 * host.js's half of the terminal bar (backlog #49 + #52): source assertions in the style of
 * test/host-occupancy-wiring.test.js, because host.js can't be loaded by a unit test. The behaviour runs end to
 * end in verify/probe-terminal-bar.js (a real hook event through the native helper to a real window).
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

test('the harness settings ask for the bedtime matcher', () => {
  const call = HOST.slice(HOST.indexOf('writeHarnessSettings(HARNESS_DIR, {'), HOST.indexOf('}, PORT);'));
  assert.match(call, /\n\s+bedtime: true,/);
});

test('the keeper and the night are built once, and the night pushes through the control channel', () => {
  assert.match(HOST, /const \{ createPromptKeeper \} = require\('\.\/prompt-keeper'\);/);
  assert.match(HOST, /const \{ createBedtime, isBedtimeOnly \} = require\('\.\/bedtime-state'\);/);
  assert.match(HOST, /const \{ createNightStatus \} = require\('\.\/night-status'\);/);
  assert.match(HOST, /const \{ countNightPrs \} = require\('\.\/night-prs'\);/);
  assert.match(HOST, /const promptKeeper = createPromptKeeper\(\);/);
  const block = HOST.slice(HOST.indexOf('const night = createNightStatus({'), HOST.indexOf('});', HOST.indexOf('const night = createNightStatus({')));
  assert.match(block, /bedtime: createBedtime\(\)/);
  assert.match(block, /countPrs: \(since\) => countNightPrs\(CWD, since\)/);
  assert.match(block, /onChange: \(payload\) => broadcastControl\(\{ type: 'bedtime', bedtime: payload \}\)/);
});

test('every hook event reaches the keeper and the night, and a ScheduleWakeup goes no further than the night', () => {
  const body = handlerBody();
  const give = body.indexOf('occupancy.handle(ev);');
  const keeper = body.indexOf('if (promptKeeper.handle(ev)) broadcastControl({ type: \'prompt\', prompt: promptKeeper.snapshot() });');
  const nightAt = body.indexOf('night.handle(ev);');
  const occOnly = body.indexOf('if (isOccupancyOnly(ev)) return;');
  const bedOnly = body.indexOf('if (isBedtimeOnly(ev)) return;');
  for (const [name, at] of [['keeper', keeper], ['night', nightAt], ['bedtime-only return', bedOnly]]) assert.ok(at !== -1, name);
  assert.ok(give < keeper && give < nightAt, 'after the producer, before any early return: the main session\'s own file-tool calls keep a night awake');
  assert.ok(keeper < occOnly && nightAt < occOnly, 'before the occupancy-only return, so a Read in the night is seen');
  assert.ok(occOnly < bedOnly, 'then the two early returns');
  for (const consumer of ['attention.handle(ev)', 'turnState.handle(ev)', 'mood.handle(ev)', 'processes.handle(ev)', "console.log(`[hook]"]) {
    assert.ok(body.indexOf(consumer) > bedOnly, `${consumer} must come after the bedtime-only return`);
  }
  assert.ok(body.indexOf("if (ev.event === 'Status')") < keeper, 'the Status document never reaches them');
});

test('the person\'s words are never logged by the keeper wiring (the hook debug line is the only place a payload prints)', () => {
  const body = handlerBody();
  const near = body.slice(body.indexOf('promptKeeper.handle(ev)') - 200, body.indexOf('promptKeeper.handle(ev)') + 300);
  assert.doesNotMatch(near, /console\.log/);
});

test('hello carries the latest prompt and the night, for a window that attaches mid-session', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf("type: 'hello',") + 4000);
  assert.match(hello, /\n\s+prompt: promptKeeper\.snapshot\(\),/);
  assert.match(hello, /\n\s+bedtime: night\.payload\(\),/);
});

test('the night is re-judged on the host\'s own tick: overdue is a verdict of time', () => {
  const timer = HOST.slice(HOST.indexOf('const moodTimer = setInterval(() => {'));
  const end = timer.indexOf('\n}, ');
  assert.ok(end !== -1 && timer.slice(0, end).includes('night.tick();'), 'inside the mood timer');
});
