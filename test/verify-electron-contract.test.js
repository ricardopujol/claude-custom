'use strict';
/**
 * Source contract (BACKLOG #74 B): no file under verify/ starts an Electron except through verify/lib/launch-electron.js
 * (spawnElectron / launchElectron), and none kills a process by image name. A probe that spawns Electron itself skips
 * the clean env, the ledger entry and the exit sweep, which is how probe Electrons were left running for hours; a kill
 * by name (`taskkill /IM electron.exe`) also takes Ricardo's own windows with it.
 *
 * The scanner reads text, so it is pinned on fixtures first (it must be able to fail), then run over the real tree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VERIFY = path.join(__dirname, '..', 'verify');
const LAUNCHER = path.join(VERIFY, 'lib', 'launch-electron.js');
const SPAWNERS = 'spawn|spawnSync|execFile|execFileSync|exec|execSync|fork';

// Block comments and whole-line // comments go; strings stay (a URL's // is not a comment start here).
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

// The first argument of each spawner call: the text up to its first top-level comma or the call's close.
function firstArgs(src) {
  const out = [];
  // `foo.spawn(` (pty.spawn) is another API; `child_process.spawn(` and `require('child_process').spawn(` are this one.
  const re = new RegExp(`(?<![\\w$])(?<![\\w$]\\.)(?:child_process\\.|cp\\.)?(${SPAWNERS})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = re.lastIndex, arg = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      arg += c;
    }
    out.push({ fn: m[1], arg: arg.trim() });
  }
  return out;
}

function electronSpawnViolations(source) {
  const src = code(source);
  // Names bound to an Electron executable in this file: `const exe = require('electron')`, `= path.join(.., 'electron.cmd')`.
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
    if (/require\([^)]*electron|electron\.(cmd|exe)|'electron'\)/i.test(m[2])) names.add(m[1]);
  }
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'electron'\s*\)/g)) names.add(m[1]);
  const out = [];
  for (const { fn, arg } of firstArgs(src)) {
    if (/electron/i.test(arg) || names.has(arg)) out.push(`${fn}(${arg.slice(0, 60)}`);
  }
  for (const m of src.matchAll(/taskkill[^\n]*['"]\/IM['"]/gi)) out.push(`kill by name: ${m[0].slice(0, 60)}`);
  return out;
}

test('scanner: flags a direct spawn of the electron package, its .cmd shim, or a name bound to either', () => {
  assert.strictEqual(electronSpawnViolations("const c = spawn(require('electron'), [REPO], { env });").length, 1);
  assert.strictEqual(electronSpawnViolations("spawn(require(path.join(ROOT, 'node_modules', 'electron')),\n  [x], {});").length, 1);
  assert.strictEqual(electronSpawnViolations("spawn(path.join(REPO, 'node_modules', '.bin', 'electron.cmd'), ['.'], { shell: true });").length, 1);
  assert.strictEqual(electronSpawnViolations("let exe; exe = require('electron');\nconst a = spawn(exe, [REPO]);").length, 1);
  assert.strictEqual(electronSpawnViolations("const electronExe = require('electron');\napp = spawn(electronExe, [REPO]);").length, 1);
  assert.strictEqual(electronSpawnViolations("require('child_process').spawnSync(require('electron'), []);").length, 1);
});

test('scanner: flags a kill by image name', () => {
  assert.strictEqual(electronSpawnViolations("spawnSync('taskkill', ['/IM', 'electron.exe', '/F']);").length, 1);
});

test('scanner: the launcher calls, a node spawn, and comments are not violations', () => {
  assert.deepStrictEqual(electronSpawnViolations([
    "const c = spawnElectron(require('electron'), [REPO], { env });",
    "const h = await launchElectron({ electronPath: require('electron') });",
    "const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env });",
    "// spawn(require('electron'), [REPO]) was the old way",
    "/* spawnSync('taskkill', ['/IM', 'electron.exe', '/F']) */",
    "spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);",
  ].join('\n')), []);
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
    if (f === LAUNCHER) continue;
    for (const v of electronSpawnViolations(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(VERIFY, f)}: ${v}`);
  }
  assert.deepStrictEqual(bad, [], 'use spawnElectron/launchElectron from verify/lib/launch-electron.js');
});
