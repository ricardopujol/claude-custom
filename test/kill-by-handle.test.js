'use strict';
/**
 * PR #130 review, Dexter #1 (High) and #9: a probe that holds a ChildProcess may kill it by pid only while the child
 * is still running. Once its 'exit' has been handled Node has closed the process handle, the pid is free, and Windows
 * hands it to the next process: a later `taskkill /PID <pid> /T /F` kills a stranger and its tree. probe-notify and
 * probe-roster did exactly that after an early app.exit(1) and ~19 s of sleeps.
 *
 * Pinned here: killChildTree (host/kill-tree.js) kills only a child that has neither an exitCode nor a signalCode;
 * the hygiene registry's registerChild drops the pid when the child exits; and a source rule keeps verify/ from
 * killing `<x>.pid` any other way.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const fs = require('fs');
const path = require('path');
const { killChildTree, killTree, trackExit } = require('../host/kill-tree');
const { createHygieneRegistry } = require('../verify/lib/process-hygiene');

function child(pid, { exitCode = null, signalCode = null } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode, signalCode, kill() {} });
  return c;
}

test('killChildTree: a child that already exited (exitCode set) is NOT killed by pid', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77, { exitCode: 1 }), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree: a child that ended by a signal (signalCode set, exitCode null) is NOT killed by pid', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77, { signalCode: 'SIGTERM' }), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree: a running child is killed by its pid, once; no child or no pid is a no-op', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77), { killFn: (p) => kills.push(p) }), true);
  assert.strictEqual(killChildTree(null, { killFn: (p) => kills.push(p) }), false);
  assert.strictEqual(killChildTree(child(undefined), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, [77]);
});

// Fake ptys never get a real start-time read (a fake pid could be a real process's).
const NO_START = { startTimes: async () => new Map() };

function ptyLike(pid) {
  let onExit = null;
  return { pid, onExit(cb) { onExit = cb; }, kill() {}, exit() { if (onExit) onExit({ exitCode: 0 }); } };
}

test('killChildTree (node-pty): an IPty whose exit was never tracked is not killed (it cannot be judged)', () => {
  const kills = [];
  assert.strictEqual(killChildTree(ptyLike(88), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree (node-pty): a tracked IPty is killed while running, and not after its onExit fired', () => {
  const kills = [];
  const p = trackExit(ptyLike(88), NO_START);
  assert.strictEqual(killChildTree(p, { killFn: (x) => kills.push(x) }), true);
  p.exit();
  assert.strictEqual(killChildTree(p, { killFn: (x) => kills.push(x) }), false);
  assert.deepStrictEqual(kills, [88]);
});

test('registerChild (node-pty): the pid leaves the registry on onExit', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (x) => kills.push(x) });
  const p = trackExit(ptyLike(89), NO_START);   // tracked first: no real start-time read for a fake pid
  reg.registerChild(p);
  p.exit();
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, []);
});

test('killTree: a child that ended by a signal is not tree-killed either', () => {
  let spawned = 0;
  killTree(child(77, { signalCode: 'SIGKILL' }), { spawnFn: () => { spawned++; } });
  assert.strictEqual(spawned, 0);
});

test('registerChild: a child that exits before the cleanup is not killed by pid (Dexter #9)', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (p) => kills.push(p) });
  const a = child(10);
  const b = child(11);
  reg.registerChild(a);
  reg.registerChild(b);
  a.exitCode = 0; a.emit('exit', 0);
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, [11]);
});

test('registerChild: a child with no pid (spawn failed) is not registered', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (p) => kills.push(p) });
  reg.registerChild(child(undefined));
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, []);
});

// ---- the source rule ---------------------------------------------------------------------------------------------
//
// THE RULE BANS THE RAW PRIMITIVES, not one spelling of their argument (PR #130 review round 2, Dexter #3). Round 1
// matched only `killPidTree(<x>.pid)` as the sole argument, and the commonest way to reintroduce the bug (bind the pid
// to a local first, or put it in an array) passed. Now, in comment-free code, a line is a violation if it
//   - names killPidTree anywhere but a plain destructured import (a call with any arguments, an alias, a renamed
//     import, passing it as a value);
//   - calls registerSpawnedTree( (registerChild is the held-child form);
//   - calls process.kill( with any signal but 0 (0 only tests liveness);
//   - has a string or template that starts with `taskkill`.
// A reviewed exception says so ON ITS LINE: a `kill-ok(<class>): <reason>` comment. The class is from an ALLOW-LIST of reviewed
// provenance classes (below); a classless or unknown class is no exception. An identity-file or app-state pid has no class, so
// nothing excuses it: it goes through killProven (verify/lib/seen-pids.js). A class is a claim a reviewer checks, not one a lexer
// can prove; what the rule guarantees is that every exception names one and that none is free text. The handle-holding
// forms (killChildTree, registerChild, child.kill()) are never flagged.

// Comments blanked to spaces, strings kept, line breaks kept (so line numbers still match the source).
function blankComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += src[i] === '\r' ? '\r' : ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' || src[i] === '\r' ? src[i] : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break;
        out += src[i]; i++;
      }
      if (i < n && src[i] === q) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const KILL_CLASSES = ['held-handle', 'table-row', 'definition', 'own-spawn', 'guard-case'];   // held-handle: reached only while the child's handle is held; table-row: a row read from the process table with its command line this run; definition: the primitive's own definition or a re-export; own-spawn: a process this very test/probe spawned and still holds; guard-case: a command string handed to a guard hook under test to be REFUSED, never run by the probe itself, naming only a process that does not exist (verify/probe-shell-guard.js; its hygiene test pins where the class may appear)
const KILL_OK = new RegExp('//.*\\bkill-ok\\((?:' + KILL_CLASSES.join('|') + ')\\):[ \\t]*\\S');

function rawKills(source) {
  const orig = source.split(/\r?\n/);
  const code = blankComments(source).split(/\r?\n/);
  const out = [];
  code.forEach((line, i) => {
    if (KILL_OK.test(orig[i])) return;
    const hits = [];
    const imp = /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/.exec(line);
    if (imp) { if (/\bkillPidTree\s*:/.test(imp[1])) hits.push('renamed killPidTree import'); }
    else if (/(?<![\w$])killPidTree(?![\w$])/.test(line)) hits.push('killPidTree');
    if (/(?<![\w$])registerSpawnedTree\s*\(/.test(line)) hits.push('registerSpawnedTree(');
    for (const m of line.matchAll(/(?<![\w$])process\.kill\(/g)) {
      const rest = line.slice(m.index + m[0].length);
      if (!/^[^,()]*(?:\([^()]*\)[^,()]*)*,\s*0\s*\)/.test(rest)) hits.push('process.kill( without signal 0');
    }
    if (/['"`]\s*taskkill\b/i.test(line)) hits.push('taskkill');
    for (const h of hits) out.push(`${i + 1}: ${h}: ${orig[i].trim().slice(0, 90)}`);
  });
  return out;
}
const flagged = (s) => rawKills(s).length > 0;

test('rule fixtures: every bypass from the round-2 review is flagged (Dexter #3)', () => {
  for (const fx of [
    'const pid = host.pid; killPidTree(pid);',                                          // aliased pid (was live: teammate-occupancy)
    'for (const pid of [...kids, sh.pid]) process.kill(pid);',                         // array / spread (was live: resource-panel)
    'killPidTree(app.pid, { run });',                                                   // extra arguments
    'execSync(`taskkill /PID ${app.pid} /T /F`);',                                      // template-string taskkill
    "spawnSync('taskkill', ['/PID', `${app.pid}`, '/T', '/F']);",                      // argv without String(
    "const { killPidTree: kpt } = require('../host/kill-tree');\nkpt(app.pid);",        // aliased import
    'const k = killPidTree; k(app.pid);',                                               // the primitive passed as a value
    "require('../host/kill-tree').killPidTree(app.child.pid);",                         // the round-1 forms still caught
    'hygiene.registerSpawnedTree(electron.pid);',
    "process.kill(k.pid, 'SIGTERM');",
    'process.kill(pid);',
    'killPidTree(pid); // kill-ok:',                                                    // an exception needs a class and a reason
    'killPidTree(pid); // kill-ok(held-handle):',                                       // ...and a reason after the class
    'killPidTree(pid); // kill-ok(identity-file): the host pid from .harness/hosts/<port>.json',   // a class that is not on the list
    // BACKLOG #74 H, PR #135 Dexter 5: an identity-file / app-state pid has no class that excuses it; every spelling is flagged
    'killPidTree(id.pid);   // kill-ok: the host pid from .harness/hosts/<port>.json',
    'killPidTree(sel.pid);   // kill-ok: the pid the tab list gave',
    "killPidTree(out.hostPid);   // kill-ok: a pid from the app's state",
    'killPidTree(pid);   // kill-ok: read from the identity json',
    "for (const pid of seenPids) killPidTree(pid);   // kill-ok: identity-file pids, the seenPids class",
        "execFileSync('taskkill', ['/PID', String(pid)]);   // kill-ok: a host pid read from app state",
  ]) assert.ok(flagged(fx), fx);
});

test('rule fixtures: the held-child forms, a liveness probe, a reasoned exception, log text and comments are not flagged', () => {
  assert.deepStrictEqual(rawKills([
    "const { killPidTree, killChildTree } = require('../host/kill-tree');",
    'killChildTree(app);', 'hygiene.registerChild(electron);', 'child.kill();',
    'process.kill(out.hostPid, 0);', 'try { process.kill(pid, 0); return true; } catch {}',
    'try { process.kill(Number(id), 0); } catch {}',
    'killPidTree(h.pid);   // kill-ok(held-handle): reached only while h is unexited',
    "spawnSync('taskkill', ['/PID', String(row.ProcessId)]);   // kill-ok(table-row): matched by pid and command line this run",
    "console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');",
    '// killPidTree(app.pid) was the old way',
    "/* spawnSync('taskkill', ['/PID', String(c.pid)]) */",
  ].join('\n')), []);
});

test('rule: no file under verify/ uses a raw kill primitive without a reasoned kill-ok on that line (no file is exempt)', () => {
  const VERIFY = path.join(__dirname, '..', 'verify');
  const files = fs.readdirSync(VERIFY, { recursive: true }).filter(f => /\.js$/.test(f)).map(f => path.join(VERIFY, f));
  const bad = [];
  for (const f of files) for (const v of rawKills(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(VERIFY, f)}:${v}`);
  assert.deepStrictEqual(bad, []);
});

// ---- PR #130 review round 2, Dexter #1: node-pty frees the pid natively >= 1 s before onExit fires ------------------

// A fake with node-pty's real order: exitNative() (conpty.cc: CloseHandle, the pid is free), onExit only later.
function lateExitPty(pid) {
  let cb = null;
  return { pid, onExit(f) { cb = f; }, kill() {}, exitNative() {}, fireOnExit() { if (cb) cb({ exitCode: 0 }); } };
}

test('killChildTree runs at most once per child: a second call (finally, then the exit handler) kills nothing', () => {
  const kills = [];
  const c = child(77);
  assert.strictEqual(killChildTree(c, { killFn: (p) => kills.push(p) }), true);
  assert.strictEqual(killChildTree(c, { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, [77]);
});

test('node-pty with a late onExit: killed in the finally, freed natively, then killed() again from process exit -> no second kill', () => {
  const kills = [];
  const p = trackExit(lateExitPty(88), NO_START);
  killChildTree(p, { killFn: (x) => kills.push(x) });       // the finally
  p.exitNative();                                           // pid 88 is free from here; onExit has not fired
  killChildTree(p, { killFn: (x) => kills.push(x) });       // process.on('exit', killed)
  p.fireOnExit();
  assert.deepStrictEqual(kills, [88]);
});

test('node-pty: once its start time is known, the kill goes through killProven (proven on a held handle), never a raw pid kill', async () => {
  const raw = [];
  const proven = [];
  const p = trackExit(lateExitPty(89), { startTimes: async (pids) => new Map(pids.map(x => [x, '134000000000000777'])) });
  await p[Symbol.for('claude-custom.child.startRead')];
  p.exitNative();                                           // the pty ended by itself; onExit is still a second away
  killChildTree(p, { killFn: (x) => raw.push(x), provenKill: (pid, start) => { proven.push([pid, start]); return 'gone'; } });
  assert.deepStrictEqual(raw, []);
  assert.deepStrictEqual(proven, [[89, '134000000000000777']]);
});
