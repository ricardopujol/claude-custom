'use strict';
/**
 * BACKLOG #179: every top-level verify/*.js that starts heavy work takes the machine's heavy lock. The heavy lock
 * (host/heavy-lock.js) is how Electron probes, hosts, real `claude` runs and Ollama work are kept to one at a time on this
 * machine; on 2026-11-06 the audit (fix/heavy-lock-residuals, #113 M5) found 55 scripts that started that kind of work
 * without it. This reads the sources (no probe is run) and fails on any script that starts heavy work and reaches no lock,
 * unless it's on the allow-list below with its reason.
 *
 * WHAT "STARTS HEAVY WORK" MEANS here (comments stripped, strings kept: the names are in strings):
 *   - an Electron: an Electron main (`require('electron')`), the electron package's path, or a launch through the launcher;
 *   - a host: the path of host/host.js, written any way the probes write it;
 *   - a real claude: the CLI named (claude.exe, the `claude` command, the npm package, a findClaude/resolveClaude helper,
 *     host/ask-claude) AND a process start in the same file (a file that only reads claude.exe off disk starts nothing);
 *   - Ollama: the word, or its port 11434.
 * WHAT "REACHES THE LOCK" MEANS: a require of verify/lib/launch-electron (it takes the lock when first required by a
 * verify/ script), of host/heavy-lock, or of verify/lib/electron-main-lock (an Electron main's own way in).
 * Extend HEAVY for a new shape of heavy start rather than allow-listing it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\r\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, m => ' '.repeat(m.length));

const START = /(?<![\w$.])(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(|\.(?:spawn|fork|execFile)\s*\(/;
const HEAVY = {
  electron: (s) => /require\(\s*['"]electron['"]\s*\)|node_modules[\\/'",\s]+electron|\b(?:spawnElectron|launchElectron)\s*\(/.test(s),
  host: (s) => /host[\\/'",\s]+host\.js|['"]host\.js['"]/.test(s),
  claude: (s) => /claude\.exe|['"]claude['"]|claude-code|\bfindClaude|\bresolveClaude|ask-claude/.test(s) && START.test(s),
  ollama: (s) => /ollama|\b11434\b/i.test(s),
};
// However the path is written ('./lib/launch-electron' or path.join(__dirname, 'lib', 'launch-electron')); never heavy-lock-watch.
const REACHES_LOCK = /require\([^)]*(?:lib[\\/'",\s]+(?:launch-electron|electron-main-lock)|host[\\/'",\s]+heavy-lock)(?:\.js)?['"]/;

// What a source starts: the kinds above it matches, [] for none.
const heavyKinds = (src) => { const s = strip(src); return Object.keys(HEAVY).filter(k => HEAVY[k](s)); };
const reachesLock = (src) => REACHES_LOCK.test(strip(src));

// The scripts that start something but rightly take no lock, each with why (the 2026-11-06 audit's "no" rows that start
// anything, and the ones whose kind the scan above can't tell from the source; re-checked on 2026-11-07 at develop bbc2c30).
// A script that starts nothing heavy needs no entry; one is listed here only so the reason is on record.
const ALLOWED = {
  '_tunesheet.js': 'in-process: renders, parses or reads; starts nothing',
  'actual-size.js': 'in-process: renders, parses or reads; starts nothing',
  'bridge-server.js': 'in-process: a pipe server another script forks; starts nothing',
  'compare.js': 'in-process: renders, parses or reads; starts nothing',
  'diagnose-client.js': 'short bounded hook-client children (spawnSync); its timings skew on a loaded machine',
  'diagnose-pipe-loss.js': 'short bounded hook-client children (spawnSync in a loop); timing-sensitive',
  'diagnose-pipe-variants.js': 'short bounded hook-client children (spawnSync); timing-sensitive',
  'measure-hook-latency.js': 'forks bridge-server.js and runs the hook client: light, and a latency taken on a loaded machine is wrong',
  'portrait-sheet.js': 'in-process: renders, parses or reads; starts nothing',
  'probe-background-shell.js': 'offline: reads claude.exe and transcripts on disk, never starts claude',
  'probe-fonts.js': 'one read-only powershell query',
  'probe-git-tree-data.js': 'in-process git data',
  'probe-host-footprint.js': 'a read-only sampler of the LIVE hosts: under the lock it would have nothing to measure',
  'probe-kill-tree-straddle.js': 'light node sleepers of its own; the experiment is the kill, not load',
  'probe-model-field.js': 'reads files',
  'probe-notification-type.js': 'one `npm root -g`, then reads claude\'s files: never starts claude',
  'probe-notifications.js': 'reads files',
  'probe-session-registry.js': 'one read-only powershell query',
  'probe-taskkill-stale-ppid.js': 'light node sleepers of its own',
  'probe-vault-concurrency.js': 'N short node writers on a temp vault: light and bounded',
  'reap-probes.js': 'a cleanup tool: it must run while someone else holds the slot',
  'state-sheet.js': 'in-process: renders, parses or reads; starts nothing',
};

const scripts = () => fs.readdirSync(VERIFY).filter(n => n.endsWith('.js')).sort()
  .map(name => ({ name, src: fs.readFileSync(path.join(VERIFY, name), 'utf8') }));

test('the classifier: each heavy kind is seen, a read of claude.exe or a comment is not, and the three ways to the lock are recognised', () => {
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
  assert.deepStrictEqual(heavyKinds("// require('electron') and host.js and ollama, in a comment\nconst a = 1;"), []);
  assert.deepStrictEqual(heavyKinds("const net = require('net');"), []);
  for (const r of ["require('./lib/launch-electron')", "require('../host/heavy-lock')", "require('./lib/electron-main-lock')",
    "require(path.join(__dirname, 'lib', 'launch-electron'))", "require('../host/heavy-lock.js')"]) {
    assert.strictEqual(reachesLock(r), true, r);
  }
  assert.strictEqual(reachesLock("require('../host/heavy-lock-watch')"), false);
  assert.strictEqual(reachesLock("// require('./lib/launch-electron')\nconst a = 1;"), false, 'a comment is not a lock');
});

test('every verify/ script that starts Electron, a host, a claude or Ollama reaches the heavy lock (or is allow-listed, with why)', () => {
  const all = scripts();
  const heavy = all.filter(s => heavyKinds(s.src).length);
  assert.ok(heavy.length > 100, `the scan must see the probes that start heavy work (${heavy.length})`);
  const unlocked = heavy.filter(s => !reachesLock(s.src) && !(s.name in ALLOWED)).map(s => `${s.name} (${heavyKinds(s.src).join(', ')})`);
  const why = Object.entries(ALLOWED).map(([n, r]) => `  ${n}: ${r}`).join('\n');
  assert.deepStrictEqual(unlocked, [],
    `${unlocked.length} script(s) start heavy work without the heavy lock. Require ./lib/launch-electron before the first start ` +
    `(and noteChild each host / claude), or for an Electron main ./lib/electron-main-lock. The allow-list, and why each takes none:\n${why}`);
});

test('the allow-list is current: each entry exists and takes no lock (an entry that now locks, or is gone, comes off)', () => {
  const byName = new Map(scripts().map(s => [s.name, s]));
  const stale = Object.keys(ALLOWED).filter(n => !byName.has(n) || reachesLock(byName.get(n).src));
  assert.deepStrictEqual(stale, []);
  assert.strictEqual(Object.keys(ALLOWED).length, 22, 'the 22 scripts the 2026-11-06 audit found rightly unlocked');
});
