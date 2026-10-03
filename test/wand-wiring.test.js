'use strict';
/**
 * host.js's half of the wand (BACKLOG #51): source assertions in the style of test/host-layout-wiring.test.js,
 * because host.js can't be loaded by a unit test; the behaviour runs end to end in verify/probe-wand.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CONTROL_TYPES, parseControlFrame } = require('../host/control');
const { WAND_TYPES, createWandControl } = require('../host/wand-control');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('every wand message is a KNOWN control type, or it is typed into the pty as literal JSON', () => {
  // The hole host/control.js describes: a frame left off the list falls through to term.write,
  // into a session that may be running --dangerously-skip-permissions.
  for (const t of WAND_TYPES) {
    assert.ok(CONTROL_TYPES.has(t), `${t} must be in CONTROL_TYPES`);
    assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: t })), { type: t }, t);
  }
});

test('the host builds the control from the shared store and the skill reader, seeded from the claude-home seam', () => {
  assert.match(HOST, /const \{ createWandControl \} = require\('\.\/wand-control'\);/);
  assert.match(HOST, /const wandControl = createWandControl\(\{ store, log:/);
  assert.match(HOST, /claudeHomeOf\(\{ seam: seams\.claudeHome, env: process\.env, home: os\.homedir\(\) \}\)/);
  assert.match(HOST, /discoverSkills\(\{ claudeHome: CLAUDE_HOME, projectDir: CWD \}\)/);
});

test('every attaching window is told the wand in its hello', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf('});', HOST.indexOf("type: 'hello',")));
  assert.match(hello, /\n\s+wand: wandControl\.payload\(\),/);
});

test('a wand message is answered by wandControl.handle and BROADCAST to every window', () => {
  const at = HOST.indexOf('if (wandControl.handles(msg.type)) {');
  assert.ok(at !== -1, 'the wand branch must be findable');
  const block = HOST.slice(at, HOST.indexOf('\n    }', at));
  assert.match(block, /broadcastControl\(wandControl\.handle\(msg\)\);/);
  assert.match(block, /return;/);
});

test('another host\'s edit and a skill added on disk both reach this host\'s windows, quietly', () => {
  assert.match(HOST, /watchDir\(\{\s*dir: path\.join\(HARNESS_DIR, 'state'\),\s*create: true,\s*match: \(f\) => f === 'wand\.json',/);
  assert.match(HOST, /wandControl\.changed\(\)/);
  assert.match(HOST, /wandControl\.skillsChanged\(\)/);
  // the CLI's own directories are watched, never created
  for (const dir of ["path.join(CLAUDE_HOME, 'skills')", "path.join(CLAUDE_HOME, 'plugins')", "path.join(CWD, '.claude', 'skills')"]) {
    assert.ok(HOST.includes(dir), dir);
  }
  const skillWatches = HOST.slice(HOST.indexOf('// The wand watches'), HOST.indexOf('// One record per distinct bug CLASS'));
  assert.doesNotMatch(skillWatches.replace(/\/\/[^\n]*/g, '').replace(/watchDir\(\{\s*dir: path\.join\(HARNESS_DIR[\s\S]*?\}\);/, ''), /create: true/,
    "only the state dir is ours to create");
});

test('the control answers exactly the types on the allow-list, and no other wand-* type', () => {
  const control = createWandControl({ store: { read: () => undefined, write() {} }, readSkills: () => ({ skills: [] }) });
  for (const t of WAND_TYPES) assert.strictEqual(control.handles(t), true, t);
  for (const t of ['wand-nope', 'wand', 'loadout-equip', undefined, null, 5, {}]) assert.strictEqual(control.handles(t), false, String(t));
  assert.ok([...CONTROL_TYPES].filter(t => String(t).startsWith('wand-')).every(t => WAND_TYPES.includes(t)),
    'no wand-* type is on the allow-list without being answered');
});
