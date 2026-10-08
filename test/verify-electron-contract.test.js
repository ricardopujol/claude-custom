'use strict';
/**
 * Source contract (BACKLOG #74 B): no file under verify/ starts an Electron except through verify/lib/launch-electron.js
 * (spawnElectron / launchElectron), and none kills a process by image name. A probe that spawns Electron itself skips
 * the clean env, the ledger entry and the exit sweep, which is how probe Electrons were left running for hours; a kill
 * by name (`taskkill /IM electron.exe`) also takes Ricardo's own windows with it.
 *
 * THE RULE IS ABOUT THE EXECUTABLE, NOT THE CALL (PR #130 review, Dexter #4 + Miguel M3). The first version recognised
 * spawn calls and missed every way of spelling one (an aliased destructure, `childProcess.spawn`, a helper such as
 * spawnWithTimeout({ cmd }), a template string, an argument on the next line). Now every expression that names the
 * Electron executable is a violation unless it sits where only the launcher can use it:
 *   - the first argument of spawnElectron( / launchElectron( (or launchElectron's `electronPath:`);
 *   - a destructured `const { app, ... } = require('electron')`: the module API, inside an Electron main;
 *   - a name bound to it (`const exe = require('electron')`) that is itself only used in those places or in `typeof`.
 * Anything else that names it (a spawn of any spelling, a string such as 'electron.cmd' or 'electron.exe') is reported,
 * so the scanner does not need to know how a process is started. ALLOWED lists the deliberate exceptions, with reasons.
 *
 * Kill by name: `/IM`, `IMAGENAME`, `Stop-Process -Name`, `Get-Process <name> | Stop-Process`, pkill, killall, in code.
 *
 * Comments are stripped by a small string-aware scanner (a `'app/*'` string no longer swallows code up to the next
 * `*` + `/`).
 *
 * KNOWN GAP, out of scope by decision (Dexter #4 item 8): `spawn(process.execPath, ...)` with ELECTRON_RUN_AS_NODE
 * deleted starts a full Electron if the probe itself runs under Electron-as-Node. Probes are run with `node`, where
 * process.execPath is node.exe, and about 20 of them spawn their host that way on purpose; a text scanner cannot tell
 * which side of a dual-mode file runs where. The last fixture pins the gap so it stays visible.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');
const LAUNCHER = path.join(VERIFY, 'lib', 'launch-electron.js');
// path relative to verify/ -> why its Electron references are not a launch
const ALLOWED = new Map([
  [path.join('lib', 'proc-census.js'), "'electron.exe' is the image name it READS from the process table (Win32_Process filter)"],
]);

// Comments out, strings and template literals kept (their contents can name the executable).
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break;           // an unterminated string ends at the line
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// [start, end) of every '...' / "..." literal in comment-free code. Templates are left out on purpose: `${exe}` is code.
function quoteRanges(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '`') { i++; while (i < code.length && code[i] !== '`') { if (code[i] === BS) i++; i++; } continue; }
    if (c !== "'" && c !== '"') continue;
    const from = i++;
    while (i < code.length && code[i] !== c && code[i] !== '\n') { if (code[i] === BS) i++; i++; }
    out.push([from, i + 1]);
  }
  return out;
}
const BS = String.fromCharCode(92);
const inQuotes = (ranges, at) => ranges.some(([a, b]) => at > a && at < b);

// Expressions that evaluate to the Electron executable (or a launcher shim of it).
const EXE_RE = /require\(\s*(?:'electron'|"electron"|path\.join\([^()]*['"]electron['"]\s*\))\s*\)|['"`][^'"`\n]*\belectron\.(?:cmd|exe)\b[^'"`\n]*['"`]/g;
const LAUNCH_ARG = /(?:spawnElectron|launchElectron)\(\s*$|electronPath:\s*$/;

function electronSpawnViolations(source) {
  const src = stripComments(source);
  const out = [];
  const names = new Set();
  const quoted = quoteRanges(src);
  for (const m of src.matchAll(EXE_RE)) {
    if (m[0].startsWith('require') && inQuotes(quoted, m.index)) continue;   // the words inside a message string
    const before = src.slice(0, m.index);
    const after = src.slice(m.index + m[0].length);
    if (m[0].startsWith('require') && /^\s*\./.test(after)) continue;       // require('electron').ipcMain: the module API
    if (!m[0].startsWith('require') && (/[!=]==?\s*$/.test(before) || /^\s*[!=]==?/.test(after))) continue;  // name === 'electron.exe': a read
    if (LAUNCH_ARG.test(before)) continue;                                   // spawnElectron(<exe>, ...)
    if (/(?:const|let|var)\s*\{[^}]*\}\s*=\s*$/.test(before)) continue;      // { app } = require('electron')
    const bound = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
    if (bound) { names.add(bound[1]); continue; }                            // judged by its uses, below
    out.push(`names the Electron executable: ${m[0].slice(0, 60)}`);
  }
  for (const name of names) {
    const use = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    for (const m of src.matchAll(use)) {
      if (inQuotes(quoted, m.index)) continue;
      const before = src.slice(0, m.index);
      const after = src.slice(m.index + name.length);
      if (/['"]$/.test(before) && after[0] === before[before.length - 1]) continue;   // the word as a 'literal', not the name
      if (/(?:const|let|var)\s+$/.test(before) || /^\s*=(?!=)/.test(after)) continue;   // its own binding
      if (LAUNCH_ARG.test(before) || /typeof\s+$/.test(before)) continue;
      out.push(`${name} (the Electron executable) used outside the launcher: ...${src.slice(Math.max(0, m.index - 30), m.index + name.length + 10).replace(/\s+/g, ' ')}`);
    }
  }
  const KILL_BY_NAME = [/['"`\s]\/IM\b/i, /IMAGENAME/i, /Stop-Process\b[^\n]*-Name\b/i, /Get-Process\s+['"]?[A-Za-z][\w.-]*['"]?\s*\|\s*Stop-Process/i, /\bpkill\b/, /\bkillall\b/];
  for (const re of KILL_BY_NAME) {
    const m = re.exec(src);
    if (m) out.push(`kill by name: ${src.slice(m.index, m.index + 50).replace(/\s+/g, ' ')}`);
  }
  return out;
}

const one = (s) => electronSpawnViolations(s).length;
const killByName = (s) => electronSpawnViolations(s).some(v => v.startsWith('kill by name'));

test('scanner: the direct spawns of the first version are still caught', () => {
  assert.strictEqual(one("const c = spawn(require('electron'), [REPO], { env });"), 1);
  assert.strictEqual(one("spawn(require(path.join(ROOT, 'node_modules', 'electron')),\n  [x], {});"), 1);
  assert.strictEqual(one("spawn(path.join(REPO, 'node_modules', '.bin', 'electron.cmd'), ['.'], { shell: true });"), 1);
  assert.strictEqual(one("let exe; exe = require('electron');\nconst a = spawn(exe, [REPO]);"), 1);
  assert.strictEqual(one("const electronExe = require('electron');\napp = spawn(electronExe, [REPO]);"), 1);
  assert.strictEqual(one("require('child_process').spawnSync(require('electron'), []);"), 1);
});

test('scanner: each bypass from the PR #130 review is caught (Dexter #4, Miguel M3)', () => {
  // 4. aliased destructure
  assert.strictEqual(one("const { spawn: sp } = require('child_process');\nsp(require('electron'), []);"), 1);
  // 5. child_process under another name
  assert.strictEqual(one("const childProcess = require('child_process');\nchildProcess.spawn(require('electron'), ['.']);"), 1);
  assert.strictEqual(one("const proc = require('child_process'); const e = require('electron'); proc.spawnSync(e, []);"), 1);
  // 6. a helper that spawns its parameter
  assert.strictEqual(one("spawnWithTimeout({ cmd: require('electron'), args: ['.'], timeoutMs: 1000 });"), 1);
  // 7. a template string
  assert.strictEqual(one("const exe = require('electron');\nexecSync(`\"${exe}\" .`);"), 1);
  // multi-line argument list with the executable on its own line
  assert.strictEqual(one("spawn(\n  require('electron'),\n  [REPO],\n  { env },\n);"), 1);
  // the executable as a string
  assert.strictEqual(one("execFile('C:/x/node_modules/electron/dist/electron.exe', ['.']);"), 1);
});

test('scanner: kill by name in any spelling (Dexter #4 items 1-3)', () => {
  for (const fx of [
    "execSync('taskkill /IM electron.exe /F');",
    "spawnSync('taskkill', [\n  '/F', '/IM', 'electron.exe']);",
    "spawnSync('taskkill', ['/IM', 'node.exe', '/F']);",
    "spawnSync('powershell', ['-Command', 'Stop-Process -Name electron -Force']);",
    "execSync('powershell -Command \"Get-Process electron | Stop-Process\"');",
    "execSync('taskkill /FI \"IMAGENAME eq node.exe\" /F');",
    "execSync('pkill electron');",
  ]) assert.ok(killByName(fx), fx);
});

test('scanner: reads of the image name, the module API, and the word inside a generated main are not launches', () => {
  assert.deepStrictEqual(electronSpawnViolations("if (name === 'electron.exe') return 'electron:main';"), []);
  assert.deepStrictEqual(electronSpawnViolations("bridge.register({ ipcMain: require('electron').ipcMain });"), []);
  assert.deepStrictEqual(electronSpawnViolations(
    "const electron = require('electron');\nfs.writeFileSync(m, `const { app } = require('electron'); app.quit();`);\nspawnElectron(electron, [m]);"), []);
});

test('scanner: the words require("electron") inside a message string are not a launch', () => {
  assert.deepStrictEqual(electronSpawnViolations("console.log('SKIP: require(\"electron\") did not give a path');"), []);
});

test('scanner: comment stripping is string-aware (Miguel M3): a glob string does not hide the code after it', () => {
  assert.strictEqual(one("const glob = 'app/*';\nspawn(require('electron'), []);\nconst end = '*/';"), 1);
  assert.strictEqual(stripComments("a // x\nb /* y */ c 'd // e' \"f /* g */\""), "a \nb  c 'd // e' \"f /* g */\"");
});

test('scanner: the launcher forms, the module API, a node spawn, a pid kill and comments are not violations', () => {
  assert.deepStrictEqual(electronSpawnViolations([
    "const c = spawnElectron(require('electron'), [REPO], { env });",
    "const d = spawnElectron(\n  require(path.join(ROOT, 'node_modules', 'electron')),\n  [x], {});",
    "const h = await launchElectron({ electronPath: require('electron') });",
    "const electronExe = require('electron'); if (typeof electronExe !== 'string') return; app = spawnElectron(electronExe, [REPO]);",
    "const { app, BrowserWindow } = require('electron');",
    "const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env });",
    "spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);",
    "// spawn(require('electron'), [REPO]) was the old way",
    "/* spawnSync('taskkill', ['/IM', 'electron.exe', '/F']) */",
  ].join('\n')), []);
});

test('scanner: KNOWN GAP (documented above) - spawn(process.execPath) with ELECTRON_RUN_AS_NODE deleted is not flagged', () => {
  assert.deepStrictEqual(electronSpawnViolations("delete env.ELECTRON_RUN_AS_NODE;\nspawn(process.execPath, [main], { env });"), []);
});

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : jsFiles(p);
    return /\.(c|m)?js$/.test(d.name) ? [p] : [];
  });
}

test('contract: no file under verify/ starts Electron except through launch-electron.js, and none kills by name', () => {
  const bad = [];
  for (const f of jsFiles(VERIFY)) {
    if (f === LAUNCHER || ALLOWED.has(path.relative(VERIFY, f))) continue;
    for (const v of electronSpawnViolations(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(VERIFY, f)}: ${v}`);
  }
  assert.deepStrictEqual(bad, [], 'use spawnElectron/launchElectron from verify/lib/launch-electron.js');
});

test('contract: every ALLOWED file exists and still names the executable (a stale exception is removed, not kept)', () => {
  for (const rel of ALLOWED.keys()) {
    const src = fs.readFileSync(path.join(VERIFY, rel), 'utf8');
    assert.ok(electronSpawnViolations(src).length > 0, `${rel} no longer needs its exception`);
  }
});
