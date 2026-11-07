'use strict';
/**
 * BACKLOG #179: every verify/ script takes the machine's heavy lock, or is on the allow-list below with the reason it doesn't.
 * The heavy lock (host/heavy-lock.js) is how Electron probes, hosts, real `claude` runs and Ollama work are kept to one at a time
 * on this machine; on 2026-11-06 the audit (fix/heavy-lock-residuals, #113 M5) found 55 top-level scripts that started that kind
 * of work without it, and PR #243's review (Miguel I1) found four more in verify/probe71/. This reads the sources (no probe is
 * run). Every script means every .js under verify/, subfolders included, except verify/lib/ (helpers the scripts require; none
 * runs on its own).
 *
 * THE RULE (#243 Miguel S3). A script reaches the lock, or it's on ALLOWED. So a new script makes the choice on purpose, and an
 * allow-list entry is load-bearing, never documentation: the entry names what the classifier sees the script start (`starts`),
 * and that must still be what it starts, so an allow-listed script that later starts a host or a claude fails here too. An
 * Electron main that another probe launches under ITS lock names that probe (`launchedBy`), which must reach the lock and name it.
 *
 * WHAT THE CLASSIFIER CALLS HEAVY (comments stripped, strings kept: the names are in strings):
 *   - an Electron: an Electron main (`require('electron')`), the electron package's path, or a launch through the launcher;
 *   - a host: the path of host/host.js, written any way the probes write it;
 *   - a real claude: the CLI named (claude.exe, claude.cmd, the `claude` command in any quotes, CLAUDE_BIN, the npm package, a
 *     findClaude/resolveClaude helper, host/ask-claude) AND a process start in the same file, bare or as a member
 *     (`cp.spawnSync`, `child_process.execFileSync`; a file that only reads claude.exe off disk starts nothing);
 *   - Ollama: the word, or its port 11434.
 * WHAT "REACHES THE LOCK" MEANS: a require that opens its own line (indented is fine: probe-dim-restore, probe-electron-zombies,
 * probe-preview-bypass and sweep-orphans take it at the top of the function that does the heavy work) and comes before the
 * file's first process start, of verify/lib/launch-electron (it takes the lock when first required by a verify/ script), of
 * host/heavy-lock, or of verify/lib/electron-main-lock (an Electron main's own way in). Not a comment, not a trailing comment,
 * not one after code on its line, and not one after the first start.
 * WHAT IT CAN'T SEE (#243 Miguel S2): the check is textual, not a run. A require at the start of a line inside a multi-line
 * template string would pass, and so would one in a function that never runs before the starts it should cover (it is only
 * seen to come FIRST in the text). Neither shape is in verify/ today; read a new script's lock line, don't just trust this.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\r\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, m => ' '.repeat(m.length));

// A process start: bare, or as a member of whatever child_process was bound to (#243 Miguel I2). Not `<x>.exec(`: that's
// RegExp.prototype.exec.
const START = /(?<![\w$.])(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(|\.(?:spawn|spawnSync|fork|execFile|execFileSync|execSync)\s*\(/;
const CLAUDE_NAMED = /claude\.(?:exe|cmd)\b|[`'"]claude(?![\w-])|\bCLAUDE_BIN\b|claude-code|\bfindClaude|\bresolveClaude|ask-claude/;
const HEAVY = {
  electron: (s) => /require\(\s*['"]electron['"]\s*\)|node_modules[\\/'",\s]+electron|\b(?:spawnElectron|launchElectron)\s*\(/.test(s),
  host: (s) => /host[\\/'",\s]+host\.js|['"]host\.js['"]/.test(s),
  claude: (s) => CLAUDE_NAMED.test(s) && START.test(s),
  ollama: (s) => /ollama|\b11434\b/i.test(s),
};
// Opening its own line (not after code or a trailing comment), however the path is written
// ('./lib/launch-electron', path.join(__dirname, 'lib', 'launch-electron')); never heavy-lock-watch.
const LOCK_REQUIRE = /^[ \t]*(?:(?:const|let|var)\s+[^=\n]+=\s*)?require\([^)\n]*(?:lib[\\/'",\s]+(?:launch-electron|electron-main-lock)|host[\\/'",\s]+heavy-lock)(?:\.js)?['"]/m;

// What a source starts: the kinds above it matches, [] for none.
const heavyKinds = (src) => { const s = strip(src); return Object.keys(HEAVY).filter(k => HEAVY[k](s)); };
function reachesLock(src) {
  const s = strip(src);
  const lock = LOCK_REQUIRE.exec(s);
  if (!lock) return false;
  const start = START.exec(s);
  return !start || lock.index < start.index;
}

// The scripts that take no lock, and why. `starts`: the kinds the classifier above sees in it (none when absent), checked.
// `launchedBy`: the locked probe that starts this Electron main under its own hold, checked.
// Re-checked on 2026-11-07 at develop ce3ec3b (#243 Miguel I4: the timing-sensitive diagnose/measure scripts and
// probe-taskkill-stale-ppid now take the lock; probe-host-footprint's reason was wrong).
const ALLOWED = {
  '_tunesheet.js': { why: 'in-process: renders, parses or reads; starts nothing' },
  'actual-size.js': { why: 'in-process: renders, parses or reads; starts nothing' },
  'bridge-server.js': { why: 'in-process: a pipe server measure-hook-latency forks under its lock; starts nothing' },
  'compare.js': { why: 'in-process: renders, parses or reads; starts nothing' },
  'portrait-sheet.js': { why: 'in-process: renders, parses or reads; starts nothing' },
  'state-sheet.js': { why: 'in-process: renders, parses or reads; starts nothing' },
  'probe-git-tree-data.js': { why: 'in-process git data' },
  'probe-model-field.js': { why: 'reads files' },
  'probe-notifications.js': { why: 'reads files' },
  'probe-background-shell.js': { why: 'offline: reads claude.exe and transcripts on disk, never starts claude' },
  'probe-notification-type.js': { why: 'one `npm root -g`, then reads claude\'s files: never starts claude', starts: ['claude'] },
  'probe-fonts.js': { why: 'one read-only powershell query' },
  'probe-session-registry.js': { why: 'one read-only powershell query' },
  'probe-host-footprint.js': { why: 'samples the LIVE hosts with a powershell query per tick for 60 minutes by default: under the lock it would hold the slot an hour while starting nothing heavy' },
  'probe-kill-tree-straddle.js': { why: 'light node sleepers of its own, each ended by its marker; the experiment is the kill, not load' },
  'probe-kill-switch-detached.js': { why: 'node sleepers under a pty of its own, each ended by proven pid: no Electron, no host, no claude (its Electron sibling, probe-kill-switch-electron, locks)' },
  'probe-vault-concurrency.js': { why: 'N short node writers on a temp vault: light and bounded' },
  'reap-probes.js': { why: 'a cleanup tool: it must run while someone else holds the slot' },
  'probe71/canvas-mcp.js': { why: 'a stdio MCP server stub the probe71 probes hand to claude; starts nothing' },
  'probe71/vector-modes.js': { why: 'data: which escape vectors sandbox-main runs in which mode' },
  'probe71/sandbox-main.js': { why: 'an Electron main, started only by probe-canvas-sandbox through launch-electron, under that probe\'s lock', starts: ['electron'], launchedBy: 'probe-canvas-sandbox.js' },
  'anim-cost-window/main.js': { why: 'an Electron main, started only by probe-anim-cost through launch-electron, under that probe\'s lock', starts: ['electron'], launchedBy: 'probe-anim-cost.js' },
};

// Every verify/ script, subfolders included (#243 Miguel I1), but not verify/lib/ or node_modules. Names are relative, with
// forward slashes ('probe71/probe-mod-in-pty.js').
function scriptNames(dir = VERIFY, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if ((rel === '' && e.name === 'lib') || e.name === 'node_modules') continue;
      out.push(...scriptNames(path.join(dir, e.name), `${rel}${e.name}/`));
    } else if (e.name.endsWith('.js')) out.push(`${rel}${e.name}`);
  }
  return out.sort();
}
const scripts = () => scriptNames().map(name => ({ name, src: fs.readFileSync(path.join(VERIFY, name), 'utf8') }));

test('the classifier: each heavy kind is seen, a read of claude.exe or a comment is not', () => {
  assert.deepStrictEqual(heavyKinds("const { app } = require('electron');"), ['electron']);
  assert.deepStrictEqual(heavyKinds("const child = spawnElectron(electronBin, [mainJs], opts);"), ['electron']);
  assert.deepStrictEqual(heavyKinds("const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');"), ['electron']);
  assert.deepStrictEqual(heavyKinds("spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')])"), ['host']);
  assert.deepStrictEqual(heavyKinds("const HOST = path.join(__dirname, '..', 'host', 'host.js');"), ['host']);
  assert.deepStrictEqual(heavyKinds("const p = pty.spawn(BIN, args); // BIN = claude.exe\nconst BIN = 'claude.exe';"), ['claude']);
  assert.deepStrictEqual(heavyKinds("pty.spawn('cmd.exe', ['/c', 'claude', ...args])"), ['claude']);
  assert.deepStrictEqual(heavyKinds("const exe = resolveClaudeExe(); const s = spawnSync(ps, []);"), ['claude']);
  // path.join form: test/stryker-config.test.js reads a literal require('../host/...') in a test file as exercising that module
  assert.deepStrictEqual(heavyKinds("const { askClaude } = require(path.join(ROOT, 'host', 'ask-claude')); const r = execFile('git', []);"), ['claude']);
  assert.deepStrictEqual(heavyKinds("const o = createAskOllama();"), ['ollama']);
  assert.deepStrictEqual(heavyKinds("fetch('http://127.0.0.1:11434/api/tags')"), ['ollama']);
  assert.deepStrictEqual(heavyKinds("const exe = path.join(root, 'claude.exe'); fs.readFileSync(exe);"), [], 'reading claude.exe starts nothing');
  assert.deepStrictEqual(heavyKinds("const pipe = 'claude-custom-bench'; spawnSync(exe, []);"), [], 'claude-custom is not the claude CLI');
  assert.deepStrictEqual(heavyKinds("// require('electron') and host.js and ollama, in a comment\nconst a = 1;"), []);
  assert.deepStrictEqual(heavyKinds("const net = require('net');"), []);
});

test('#243 Miguel I2: the member start forms and the other claude names are seen', () => {
  const cases = [
    "const cp = require('child_process'); cp.spawnSync('claude', ['-p', 'hi']);",
    "const cp = require('child_process'); cp.execSync('claude -p hi');",
    "require('child_process').execFileSync('claude', ['-p', 'hi']);",
    "child_process.execFileSync(bin, ['-p']); const bin = 'claude.cmd';",
    "execSync(`claude -p ${prompt}`);",
    "const bin = process.env.CLAUDE_BIN || x; spawn(bin, ['-p']);",
  ];
  for (const c of cases) assert.deepStrictEqual(heavyKinds(c), ['claude'], c);
  assert.deepStrictEqual(heavyKinds("const m = /x/.exec(s); const bin = 'claude.cmd';"), [], 'RegExp#exec is not a start');
});

test('what reaches the lock: the three requires on their own line, before the first start; not a comment, a trailing comment, or a late require', () => {
  for (const r of ["require('./lib/launch-electron');", "const h = require('../host/heavy-lock');", "const m = require('./lib/electron-main-lock').takeMainLock({});",
    "const { noteChild } = require(path.join(__dirname, 'lib', 'launch-electron'));", "require('../host/heavy-lock.js');",
    "const { noteChild } = require('../lib/launch-electron');\nconst c = spawn('claude', []);"]) {
    assert.strictEqual(reachesLock(r), true, r);
  }
  assert.strictEqual(reachesLock("require('../host/heavy-lock-watch');"), false);
  assert.strictEqual(reachesLock("// require('./lib/launch-electron')\nconst a = 1;"), false, 'a comment is not a lock');
  assert.strictEqual(reachesLock("const a = 1; // require('./lib/launch-electron')"), false, 'a trailing comment is not a lock (S2)');
  assert.strictEqual(reachesLock("async function main() {\n  const { spawnElectron } = require('./lib/launch-electron');\n  const h = spawn(x);\n}"), true, 'taken at the top of the function that starts the work');
  assert.strictEqual(reachesLock("const a = 1; require('./lib/launch-electron');"), false, 'after code on its line (S2)');
  assert.strictEqual(reachesLock("const c = spawn('claude', []);\nrequire('./lib/launch-electron');"), false, 'after the first start is too late (S2)');
});

test('every verify/ script, subfolders included, reaches the heavy lock or is on the allow-list with why', () => {
  const all = scripts();
  assert.ok(all.length > 150, `the scan must see the verify scripts (${all.length})`);
  assert.ok(all.some(s => s.name.startsWith('probe71/')), 'the scan reads subfolders (#243 Miguel I1)');
  assert.ok(!all.some(s => s.name.startsWith('lib/')), 'verify/lib holds helpers, not scripts');
  const unlocked = all.filter(s => !reachesLock(s.src) && !(s.name in ALLOWED))
    .map(s => `${s.name} (${heavyKinds(s.src).join(', ') || 'starts nothing the classifier calls heavy'})`);
  const why = Object.entries(ALLOWED).map(([n, e]) => `  ${n}: ${e.why}`).join('\n');
  assert.deepStrictEqual(unlocked, [],
    `${unlocked.length} script(s) take no heavy lock. Require ./lib/launch-electron at the top, before the first start (and ` +
    `noteChild each host / claude), or for an Electron main ./lib/electron-main-lock; or, if it truly starts nothing heavy, ` +
    `add it to ALLOWED with why. The allow-list:\n${why}`);
});

test('the allow-list is current: each entry exists, takes no lock, starts what it says, and a launched main is launched by a locked probe', () => {
  const byName = new Map(scripts().map(s => [s.name, s]));
  const wrong = [];
  for (const [name, e] of Object.entries(ALLOWED)) {
    const s = byName.get(name);
    if (!s) { wrong.push(`${name}: gone`); continue; }
    if (reachesLock(s.src)) wrong.push(`${name}: takes the lock now, so it comes off`);
    const seen = heavyKinds(s.src);
    if (JSON.stringify(seen) !== JSON.stringify(e.starts || [])) wrong.push(`${name}: starts ${JSON.stringify(seen)}, the entry says ${JSON.stringify(e.starts || [])}`);
    if (e.launchedBy) {
      const parent = byName.get(e.launchedBy);
      const [dir, base] = name.includes('/') ? name.split('/') : ['', name];
      if (!parent || !reachesLock(parent.src)) wrong.push(`${name}: its launcher ${e.launchedBy} is gone or takes no lock`);
      else if (!parent.src.includes(base) || (dir && !parent.src.includes(dir))) wrong.push(`${name}: ${e.launchedBy} doesn't name it`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});

// #243 Miguel I5: a header that says "take heavy-lock.ps1 first" makes a script that locks itself wait on its own holder for
// 20 minutes and end NOT RUN; one that says the lock isn't needed is simply false once the script takes it.
const HEADER_LIES = /(?<!n't |not )\b(?:takes?|run it under)\b[^\n]{0,80}heavy-lock\.ps1|heavy(?:-work)? lock is not needed|doesn't take the heavy lock/i;
test('#243 Miguel I5: no script that takes the lock tells its reader to take it by hand, or says it needs none', () => {
  assert.ok(HEADER_LIES.test(' * HEAVY: take ~/.claude/scripts/heavy-lock.ps1 first.'));
  assert.ok(HEADER_LIES.test('   Run it under ~/.claude/scripts/heavy-lock.ps1.'));
  assert.ok(HEADER_LIES.test(' * started, so the heavy lock is not needed.'));
  assert.ok(HEADER_LIES.test(' * Take the heavy-work lock first (C:\\Users\\ricar\\.claude\\scripts\\heavy-lock.ps1): this starts Electron'));
  assert.ok(HEADER_LIES.test('   Takes the heavy-work lock first (C:\\Users\\ricar\\.claude\\scripts\\heavy-lock.ps1): one Electron at a time.'));
  assert.ok(!HEADER_LIES.test(" * it takes the heavy-work lock itself when it starts (verify/README.md): don't take the lock by hand first"));
  const lying = scripts().filter(s => reachesLock(s.src) && HEADER_LIES.test(s.src)).map(s => s.name);
  assert.deepStrictEqual(lying, [], 'say the script takes the heavy-work lock itself (verify/README.md, "The heavy lock")');
});
