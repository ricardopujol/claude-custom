'use strict';
/**
 * host.js's half of worktree occupancy (backlog #44 + #47): source assertions in the style of
 * test/host-layout-wiring.test.js, because host.js can't be loaded by a unit test. The behaviour runs end to
 * end in verify/probe-worktree-occupancy.js (a real claim file, a real liveness check).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const NL = /\r?\n/;

function handlerBody() {
  const start = HOST.indexOf("hookBridge.on('event', (ev) => {");
  assert.ok(start !== -1, 'the hook bridge event handler');
  return HOST.slice(start, HOST.indexOf("hookBridge.on('parse-error'", start));
}

test('the harness settings ask for the occupancy matcher', () => {
  const call = HOST.slice(HOST.indexOf('writeHarnessSettings(HARNESS_DIR, {'), HOST.indexOf('}, PORT);'));
  assert.match(call, /\n\s+occupancy: true,/);
});

test('the producer is built from the project\'s state folder, this host\'s own folder and its own start time', () => {
  assert.match(HOST, /createClaimWriter\(\{ stateRoot: STATE_ROOT/);
  assert.match(HOST, /createRootsProvider\(\{ cwd: CWD/);
  const block = HOST.slice(HOST.indexOf('createOccupancyProducer({'), HOST.indexOf('});', HOST.indexOf('createOccupancyProducer({')));
  assert.match(block, /ownRoot: CWD/);
  assert.match(block, /fromBranch: \(\) => currentBranch\(CWD\)/);
  assert.match(block, /hostPid: process\.pid/);
  assert.match(block, /hostStartedAt: \(\) => \(lockOwner && typeof lockOwner\.processStartedAt === 'string' \? lockOwner\.processStartedAt : null\)/);
  assert.match(block, /nameOf: /);
});

test('the hook handler gives every event to the producer, and keeps the file-tool events away from everything else', () => {
  const body = handlerBody();
  const give = body.indexOf('occupancy.handle(ev);');
  const only = body.indexOf('if (isOccupancyOnly(ev)) return;');
  assert.ok(give !== -1 && only !== -1 && give < only, 'handled first, then the early return');
  for (const consumer of ['attention.handle(ev)', 'turnState.handle(ev)', 'mood.handle(ev)', 'processes.handle(ev)', "console.log(`[hook]"]) {
    assert.ok(body.indexOf(consumer) > only, `${consumer} must come after the early return`);
  }
  // the Status document returns before it, so it never reaches the producer
  assert.ok(body.indexOf("if (ev.event === 'Status')") < give);
});

test('hook debug prints the occupancy-only events too, before the early return hides them from the debug lines below', () => {
  // verify/probe-teammate-occupancy.js reads `[hook:full]` to see what a teammate's Read and Grep really send.
  const body = handlerBody();
  const debug = body.indexOf("if (process.env.CLAUDE_CUSTOM_HOOK_DEBUG && isOccupancyOnly(ev)) console.log('[hook:full] ' + JSON.stringify(ev.payload || {}));");
  assert.ok(debug !== -1, 'the debug line');
  assert.ok(debug < body.indexOf('if (isOccupancyOnly(ev)) return;'), 'before the early return');
});

test('a teammate is recognised by its .meta.json, and its idle claim is expired on the host\'s own tick', () => {
  const block = HOST.slice(HOST.indexOf('createOccupancyProducer({'), HOST.indexOf('});', HOST.indexOf('createOccupancyProducer({')));
  assert.match(block, /isTeammate: teammateFromMeta,/);
  assert.match(HOST, /const \{ createOccupancyProducer, isOccupancyOnly, teammateFromMeta \} = require\('\.\/occupancy-producer'\);/);
  const timer = HOST.slice(HOST.indexOf('const moodTimer = setInterval(() => {'));
  const end = timer.indexOf('\n}, ');
  assert.ok(end !== -1 && timer.slice(0, end).includes('occupancy.tick();'), 'inside the mood timer');
});

test('boot sweeps dead claims with the SAME proof the readers use, and a host never sweeps on a missing helper', () => {
  assert.match(HOST, /sweepDead\(occupancyDir\(STATE_ROOT\), \{ judge: \(claims\) => judgeClaims\(claims, startTimes\)/);
  const sweepAt = HOST.indexOf('sweepDead(occupancyDir(STATE_ROOT)');
  const gate = HOST.lastIndexOf('if (helperExists)', sweepAt);
  assert.ok(gate !== -1 && sweepAt - gate < 400, 'only inside `if (helperExists)`');
});

test('a host that exits takes its own claims with it', () => {
  assert.match(HOST, /process\.on\('exit', \(\) => \{ occupancyWriter\.removeAll\(\); \}\);/);
});

test('the new modules are the ones host.js requires', () => {
  for (const m of ['./occupancy-producer', './occupancy-store', './occupancy-live', './worktree-roots']) {
    assert.ok(HOST.split(NL).some(l => l.includes(`require('${m}')`)), m);
  }
});
