'use strict';
/**
 * Dexter 3 (PR #187): a probe takes the heavy-work lock when verify/lib/launch-electron.js is first required, so that
 * require has to come BEFORE the probe starts anything else heavy (a host.js, a claude CLI, a server). Pinned by reading
 * every verify/*.js that requires the launcher: its first require of the launcher must come before its first spawn.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length)).replace(/^\s*\/\/.*$/gm, m => ' '.repeat(m.length));
const LAUNCHER_REQUIRE = /require\([^)]*launch-electron/;
const HEAVY_START = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/;

// Returns the line of the first heavy start that precedes the launcher require, or 0.
function startsBeforeLauncher(source) {
  const s = strip(source);
  const req = s.search(LAUNCHER_REQUIRE);
  if (req < 0) return 0;
  const m = HEAVY_START.exec(s);
  return m && m.index < req ? s.slice(0, m.index).split('\n').length : 0;
}

test('the checker finds a spawn that comes before the launcher require, and ignores comments', () => {
  assert.strictEqual(startsBeforeLauncher("const h = spawn(x);\nconst L = require('./lib/launch-electron');"), 1);
  assert.strictEqual(startsBeforeLauncher("const L = require('./lib/launch-electron');\nconst h = spawn(x);"), 0);
  assert.strictEqual(startsBeforeLauncher("// spawn(x) later\nconst L = require('./lib/launch-electron');"), 0);
  assert.strictEqual(startsBeforeLauncher("const h = spawn(x);"), 0, 'a file that never requires the launcher is not this test\'s business');
});

test('every verify script requires the launcher before it starts anything heavy', () => {
  const late = [];
  for (const f of fs.readdirSync(VERIFY)) {
    if (!f.endsWith('.js')) continue;
    const line = startsBeforeLauncher(fs.readFileSync(path.join(VERIFY, f), 'utf8'));
    if (line) late.push(`verify/${f}:${line}`);
  }
  assert.deepStrictEqual(late, [], 'move the require of ./lib/launch-electron above the first spawn (it takes the heavy-work lock)');
});

// BACKLOG #112: a probe that starts a host.js (or the claude CLI) by hand with a plain spawn must tell the lock, or a
// dead probe with a live host reads as a dead holder. Every such spawn needs a noteChild call.
const HAND_SPAWN = /\bspawn\(\s*(?:process\.execPath,\s*\[[^\]]*host\.js|exe,\s*\['-p')/g;
test('the checker finds a hand-started host.js', () => {
  assert.strictEqual(("h = spawn(process.execPath, [path.join(R, 'host', 'host.js')], {});".match(HAND_SPAWN) || []).length, 1);
});
test('every probe that takes the lock and hand-starts a host.js or claude records it with noteChild', () => {
  const missing = [];
  for (const f of fs.readdirSync(VERIFY)) {
    if (!f.endsWith('.js')) continue;
    const s = strip(fs.readFileSync(path.join(VERIFY, f), 'utf8'));
    if (!LAUNCHER_REQUIRE.test(s)) continue;
    const spawns = (s.match(HAND_SPAWN) || []).length;
    const notes = (s.match(/\bnoteChild\(/g) || []).length;
    if (spawns > notes) missing.push(`verify/${f}: ${spawns} spawn(s), ${notes} noteChild call(s)`);
  }
  assert.deepStrictEqual(missing, [], 'call noteChild(child) from ./lib/launch-electron right after the spawn');
});
