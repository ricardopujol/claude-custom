'use strict';
/**
 * verify/probe-kill-switch-detached.js (BACKLOG #127) starts real ptys and detached sleepers, so the properties that keep it safe and
 * honest are pinned as source assertions (it is not run by `npm test`), in the style of test/probe-shell-tab-hygiene.test.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const PROBE = strip(fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-kill-switch-detached.js'), 'utf8'));

test('PR #235 Miguel I7: the pty and every grandchild go through process-hygiene, so Ctrl+C and an uncaught error end them too', () => {
  assert.match(PROBE, /const \{ createHygieneRegistry \} = require\('\.\/lib\/process-hygiene'\);/);
  assert.match(PROBE, /hygiene\.install\(\);/);
  assert.match(PROBE, /hygiene\.registerChild\(term\);/, 'the pty, whose exit is tracked so a later cleanup never reaches a reused pid');
  assert.match(PROBE, /endGrandchild = \(\) => kt\.killProven\(gpid, gStart\);\s*hygiene\.addCleanup\(endGrandchild\);/, 'the grandchild, by pid and start');
  assert.match(PROBE, /hygiene\.removeCleanup\(endGrandchild\)/);
  assert.doesNotMatch(PROBE, /taskkill|\/IM\b|Stop-Process|killall|pkill/i, 'never by name');
});

test('a failed process-table query is no answer: never "ended", never skipped by the cleanup (the absence-as-zero trap)', () => {
  assert.match(PROBE, /const alive = async \(pid\) => \{ const m = await startTimes\(\[pid\]\); return m \? m\.has\(pid\) : null; \};/);
  assert.match(PROBE, /if \(g !== null\) result\.grandchildSurvived = g;/);
  assert.match(PROBE, /if \(c !== null\) result\.claudeSurvived = c;/);
  assert.match(PROBE, /if \(result\.grandchildSurvived === null \|\| result\.claudeSurvived === null\) throw new Error/);
  assert.match(PROBE, /await alive\(gpid\) !== false\) kt\.killProven\(gpid, gStart\)/);
  assert.match(PROBE, /await alive\(term\.pid\) !== false\) kt\.killProven\(term\.pid, claudeStart\)/);
});

test('the launcher case proves adoption: it attaches only once the stand-in runs, and fails with 0 adopted (PR #235 Dexter 7)', () => {
  assert.match(PROBE, /if \(kind === 'launcher'\) \{\s*for \(let i = 0; i < 150 && !fs\.existsSync\(upFile\); i\+\+\) await sleep\(100\);/);
  assert.ok(PROBE.indexOf("!fs.existsSync(upFile)") < PROBE.indexOf('guard.attach('), 'the wait comes before the attach');
  assert.match(PROBE, /if \(kind === 'launcher' && !\/\^\[1-9\]\\d\* descendant\/\.test\(result\.adopted \|\| ''\)\) throw new Error/);
});

test('the stop is the host\'s: the spawn window as host.js takes it, the bundled ConPTY, the tree kill then the job and its answer', () => {
  assert.match(PROBE, /const before = Date\.now\(\);/);
  assert.match(PROBE, /const spawnWindow = \{ before, after: Date\.now\(\) \};/);
  assert.match(PROBE, /guard\.attach\(\{ pid: term\.pid, startOf: async \(\) => exact, spawnWindow \}\)/);
  assert.strictEqual(PROBE.split('useConptyDll: true').length - 1, 2, 'both pty spawns on the bundled ConPTY');
  assert.match(PROBE, /stopPty\(term, \{ killChildTree: kt\.killChildTree \}\);\s*if \(guard\) \{ guard\.kill\(\); result\.job = await guard\.settled\(15000\); \}/);
});
