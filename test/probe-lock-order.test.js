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
// Comments blanked to spaces, line breaks kept, so a line number in the stripped text is the source's line number.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\r\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, m => ' '.repeat(m.length));
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

// BACKLOG #112 / #113 Dexter 2, Miguel M2: a probe that takes the lock and starts a process by hand must tell the lock, or a
// dead probe with a live child reads as a dead holder (and frees the slot while its work runs). The scan used to match two
// literal shapes (`spawn(process.execPath, [..host.js` and `spawn(exe, ['-p'`) and compare COUNTS per file, so a spawn through
// another shape, `fork`, `execFile` or `pty.spawn` passed silently. Now it PAIRS them.
//
// WHAT IT RECOGNISES as a start (comments stripped): a bare `spawn(`, `fork(`, `execFile(` or `exec(`, and the method forms
// `<x>.spawn(` (pty.spawn, cp.spawn), `<x>.fork(` and `<x>.execFile(`. Not `<x>.exec(`: that is RegExp.prototype.exec. The
// Sync forms (spawnSync, execFileSync, execSync) aren't starts: they end before they return.
// EACH START MUST BE ONE OF:
//   - wrapped: `noteChild(` earlier on the same line (`kids.push(noteChild(spawn(...)))`);
//   - paired: assigned to a name (`const host = spawn(...)`, `w.c = spawn(...)`) and `noteChild(<that name>` after it,
//     before the next start and within PAIR_LINES lines (#237 Dexter 9 f, Miguel S6: any `noteChild(` used to pair it,
//     `noteChild(null)` or another child's, however far away);
//   - excused ON ITS LINE (or the line above) with `// lock-ok: <reason>`: a short, bounded child the probe waits for or
//     stops itself (a powershell sample, a git call), never a host, a claude or anything that outlives a step.
// NOT SEEN: a start inside a helper in verify/lib (launchElectron/spawnElectron record their Electron themselves;
// spawnWithTimeout is bounded by its own timeout), or a spawn built from a string the scan can't read. Extend START for a new
// shape rather than excusing it.
const START = /(?<![\w$.])(?:spawn|fork|execFile|exec)\s*\(|\.(?:spawn|fork|execFile)\s*\(/g;
const LOCK_OK = /\/\/.*\block-ok:[ \t]*\S/;
const PAIR_LINES = 6;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The name a start is assigned to on its own line (`const h = spawn(`, `w.c = cp.spawn(`, `x = await fork(`), or null.
function assignedName(s, at) {
  const lineStart = s.lastIndexOf('\n', at) + 1;
  const m = /(?:^|[\s;(,])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*)?$/.exec(s.slice(lineStart, at));
  return m ? m[1] : null;
}
// Probes that take the lock: through the launcher, through host/heavy-lock directly (createProcessLock / acquire), or, for an
// Electron main, through verify/lib/electron-main-lock (#179), however the path is written; never heavy-lock-watch.
const TAKES_LOCK = (src) => LAUNCHER_REQUIRE.test(src) || /require\([^)]*(?:host[\\/'",\s]+heavy-lock|lib[\\/'",\s]+electron-main-lock)(?:\.js)?['"]/.test(src);

// strip(), and every string's contents blanked too (quotes kept, line breaks kept): a word "spawn (" in a message, or the
// source of a child script handed to `node -e`, is not a start in this file.
function blankStrings(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c !== "'" && c !== '"' && c !== '`') { out += c; i++; continue; }
    out += c; i++;
    while (i < src.length && src[i] !== c) {
      if (src[i] === '\\') { out += '  '; i += 2; continue; }
      if (c !== '`' && src[i] === '\n') break;
      out += (src[i] === '\n' || src[i] === '\r') ? src[i] : ' '; i++;
    }
    if (i < src.length && src[i] === c) { out += c; i++; }
  }
  return out;
}

// The unrecorded starts of one source: [{ line, text }].
function unrecordedStarts(source) {
  const s = blankStrings(strip(source));
  const orig = source.split(/\r?\n/);
  const starts = [...s.matchAll(START)].map(m => m.index);
  const lineOf = (i) => s.slice(0, i).split('\n').length;
  const out = [];
  starts.forEach((at, k) => {
    const line = lineOf(at);
    const lineStart = s.lastIndexOf('\n', at) + 1;
    if (/\bnoteChild\s*\(/.test(s.slice(lineStart, at))) return;                          // wrapped
    const name = assignedName(s, at);
    if (name) {
      // The window: up to the next start, and no further than PAIR_LINES lines on.
      let end = k + 1 < starts.length ? starts[k + 1] : s.length;
      let lines = 0;
      for (let i = at; i < end; i++) if (s[i] === '\n' && ++lines > PAIR_LINES) { end = i; break; }
      if (new RegExp(`\\bnoteChild\\s*\\(\\s*${escapeRe(name)}\\s*[,)]`).test(s.slice(at, end))) return;   // paired, by name
    }
    if (LOCK_OK.test(orig[line - 1] || '') || LOCK_OK.test(orig[line - 2] || '')) return; // excused, with a reason
    out.push({ line, text: (orig[line - 1] || '').trim() });
  });
  return out;
}

test('the pairing scan: wrapped, paired and excused starts pass; fork, execFile, pty.spawn and a second unpaired spawn fail', () => {
  const ok = [
    "const h = spawn(process.execPath, [hostJs], {});\nnoteChild(h);",
    "kids.push(noteChild(spawn(process.execPath, ['-e', src])));",
    "const ps = spawn('powershell.exe', args);   // lock-ok: a 2 s counter sample, awaited\nps.on('exit', done);",
    "// lock-ok: a git call the probe awaits\nconst g = execFile('git', ['status']);",
    "const m = /x/.exec(s);\nconst r = re.exec(t);\nconst o = execFileSync('git', []);\nspawnSync('a');",
    "// spawn(x) in a comment\nconst a = 1;",
    "check('no new spawn (criterion 8)', ok);\nconst src = `spawn(process.execPath, [x])`;",
  ];
  for (const src of ok) assert.deepStrictEqual(unrecordedStarts(src), [], src);
  const bad = [
    ["const w = fork(path.join(__dirname, 'w.js'));", 1],
    ["const c = execFile(claudeBin, ['-p', 'hi']);", 1],
    ["const p = pty.spawn(claudeBin, ['--model', 'haiku'], {});", 1],
    ["const p = cp.spawn('x');", 1],
    ["const a = spawn('a');\nconst b = spawn('b');\nnoteChild(b);", 1],   // a's noteChild would have to come before b's start
    ["const a = spawn('a');   // lock-ok:\nnoteChild(null);", 1],           // #237 Dexter 9 f: noteChild(null) names no child
    ["const a = spawn('a');\nnoteChild(other);", 1],                       // another child's noteChild
    ["const a = spawn('a');\nnoteChild(ab);", 1],                          // a longer name is another name
    [`const a = spawn('a');\n${'x();\n'.repeat(8)}noteChild(a);`, 1],      // too far away to be its pairing
    ["kids.push(spawn('a'));\nnoteChild(kids[0]);", 1],                    // not assigned to a name: wrap it instead
    ["const a = spawn('a');   // lock-ok:", 1],                            // an excuse needs a reason
  ];
  for (const [src, n] of bad) assert.strictEqual(unrecordedStarts(src).length, n, src);
  const named = [
    "const h = spawn(process.execPath, [hostJs]);\nh.on('exit', f);\nnoteChild(h);",
    "w.c = cp.spawn('x');\nnoteChild(w.c, lock);",
    "let p;\np = fork('w.js');\nnoteChild(p);",
  ];
  for (const src of named) assert.deepStrictEqual(unrecordedStarts(src), [], src);
});

test('#237 Miguel S6: the scan covers a probe that takes the lock through host/heavy-lock, not only through the launcher', () => {
  assert.strictEqual(TAKES_LOCK(strip("const { createProcessLock } = require('../host/heavy-lock');")), true);
  assert.strictEqual(TAKES_LOCK(strip("const L = require('./lib/launch-electron');")), true);
  assert.strictEqual(TAKES_LOCK(strip("const x = require('../host/heavy-lock-watch');")), false);
  assert.strictEqual(TAKES_LOCK(strip("const h = require(path.join(__dirname, '..', 'host', 'heavy-lock'));")), true);
  assert.strictEqual(TAKES_LOCK(strip("const m = require('./lib/electron-main-lock').takeMainLock({ app, label });")), true);
  assert.strictEqual(TAKES_LOCK(strip("const fs = require('fs');")), false);
});

test('every probe that takes the lock records each process it starts by hand with noteChild (or excuses it, with a reason)', () => {
  const missing = [];
  for (const f of fs.readdirSync(VERIFY)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(VERIFY, f), 'utf8');
    if (!TAKES_LOCK(strip(src))) continue;
    for (const u of unrecordedStarts(src)) missing.push(`verify/${f}:${u.line}: ${u.text}`);
  }
  assert.deepStrictEqual(missing, [], 'call noteChild(child) from ./lib/launch-electron right after the start, or mark a short bounded child `// lock-ok: <reason>`');
});
