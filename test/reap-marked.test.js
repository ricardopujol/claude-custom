'use strict';
/**
 * BACKLOG #74 G: the #72 test's spawner left 9,287 detached `node -e setInterval` sleepers behind a killed `npm test`.
 * Every test that spawns detached children tags them with a per-run marker in argv (`<prefix>-<owner pid>-<time>`) and
 * reaps them in `finally`, on process exit, and (the leftovers of a run that was itself killed) at the next run's start.
 * A process is ended only after its start time is proven against the process table's creation time, on a held handle.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { reapMarked, reapDeadOwners, markedPids, SLEEPER_SRC } = require('../verify/lib/reap-marked');

const onWin = process.platform === 'win32';
const opts = { skip: !onWin, timeout: 120000 };

function sleeper(marker) {
  const c = spawn(process.execPath, ['-e', SLEEPER_SRC, marker], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(f, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 100)); } return f(); }

test('reapMarked ends the processes carrying the marker, and only those', opts, async () => {
  const mine = `ccreap-${process.pid}-${Date.now()}a`;
  const other = `ccreap-${process.pid}-${Date.now()}b`;
  const a = sleeper(mine); const b = sleeper(mine); const o = sleeper(other);
  try {
    assert.ok(await until(() => markedPids(mine).length === 2 && markedPids(other).length === 1), 'the scan does not see the sleepers it just started');
    assert.strictEqual(reapMarked(mine), 2);
    assert.ok(await until(() => !alive(a.pid) && !alive(b.pid)), 'a marked sleeper survived');
    assert.ok(alive(o.pid), 'a sleeper with another marker was ended');
  } finally { reapMarked(mine); reapMarked(other); }
});

test('markers that share a prefix do not match each other (the token boundary, PR #135 Miguel 4)', opts, async () => {
  const x = `ccbound-${process.pid}-${Date.now()}`;
  const longer = `${x}-2`;
  const a = sleeper(x); const b = sleeper(longer);
  try {
    assert.ok(await until(() => markedPids(x).length === 1 && markedPids(longer).length === 1), 'each marker sees only its own sleeper');
    assert.strictEqual(reapMarked(x), 1);
    assert.ok(await until(() => !alive(a.pid)));
    assert.ok(alive(b.pid), 'reaping X ended X-2');
  } finally { reapMarked(x); reapMarked(longer); }
});

test('the start-time proof: a creation time that does not match the process\'s StartTime spares it (PR #135 Miguel 4)', opts, async () => {
  const m = `ccproof-${process.pid}-${Date.now()}`;
  const a = sleeper(m);
  try {
    assert.ok(await until(() => markedPids(m).length === 1));
    assert.strictEqual(reapMarked(m, { forgeTicks: 10000000 }), 0, 'a process whose creation time is a second off was ended');   // 1 s in 100 ns ticks
    assert.ok(alive(a.pid), 'the proof let a mismatched process die');
    assert.strictEqual(reapMarked(m), 1, 'the unforged proof must still end it');
    assert.ok(await until(() => !alive(a.pid)));
  } finally { reapMarked(m); }
});

test('reapDeadOwners ends a killed run\'s leftovers, and leaves a live owner\'s alone', opts, async () => {
  const prefix = `ccdead${Date.now()}`;
  const deadOwner = 2147483646;                                  // above any Windows pid: provably not running, and never reusable
  const deadMarker = `${prefix}-${deadOwner}-1`;
  const liveMarker = `${prefix}-${process.pid}-1`;
  const d = sleeper(deadMarker); const l = sleeper(liveMarker);
  try {
    assert.ok(await until(() => markedPids(deadMarker).length === 1 && markedPids(liveMarker).length === 1));
    assert.strictEqual(reapDeadOwners(prefix), 1);
    assert.ok(await until(() => !alive(d.pid)), 'a dead owner\'s sleeper survived');
    assert.ok(alive(l.pid), 'a live owner\'s sleeper was ended');
  } finally { reapMarked(deadMarker); reapMarked(liveMarker); }
});

test('reapDeadOwners: an owner pid that is not an Int32 is skipped, it does not fail the sweep (Miguel 9)', opts, async () => {
  const prefix = `ccbig${Date.now()}`;
  const marker = `${prefix}-99999999999-1`;
  const s = sleeper(marker);
  try {
    assert.ok(await until(() => markedPids(marker).length === 1));
    assert.strictEqual(reapDeadOwners(prefix), 0);
    assert.ok(alive(s.pid));
  } finally { reapMarked(marker); }
});

test('a marker that could match more than itself is refused (no wildcard widening of the kill)', () => {
  for (const bad of ['', 'a b', "x'y", 'a%b', '*', 'a;b']) assert.throws(() => reapMarked(bad), /marker/, JSON.stringify(bad));
});

test('the sleeper expires by itself, so even a reaper that never runs cannot leave one for good', () => {
  assert.match(SLEEPER_SRC, /setTimeout\(\(\) => process\.exit\(\), \d+\)/);
});

// ---- the rule: every detached spawn site is accounted for, per site (PR #135 Dexter 8, Miguel 5) --------------------
//
// A "site" is any `detached:` option that is not `false` (an options object built apart from the spawn call carries it
// too). A site is accounted for if EITHER a `kill-test-ok: <reason>` comment sits on its line or the line above it, OR
// it feeds the shared sleeper (SLEEPER_SRC within 300 characters after it) AND the file calls reapMarked( or
// reapDeadOwners( in code. Comments and regex literals never count, in either direction.

function blank(src) {   // comments blanked to spaces, strings kept, line breaks kept
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += src[i] === '\r' ? '\r' : ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' || src[i] === '\r' ? src[i] : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break;
        // a comment inside a template literal that holds code (a spawned `node -e` program) is still a comment
        if (q === '`' && src[i] === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
        out += src[i]; i++;
      }
      if (i < n && src[i] === q) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function unaccountedDetached(source) {
  const orig = source.split(/\r?\n/);
  const code = blank(source);
  const lines = code.split(/\r?\n/);
  const reaps = /\b(?:reapMarked|reapDeadOwners)\s*\(/.test(code);
  // every spelling of the option: `detached: x`, a quoted key, the shorthand `{ detached, ... }`, and `o.detached = x`
  const SITE = /(?<![\w/.])(?:['"]?detached['"]?\s*:(?!\s*false\b)|detached(?=\s*[,}]))/g;
  const SITE_DOT = /\.detached\s*=(?!=)(?!\s*false\b)/g;
  const bad = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const hits = [...line.matchAll(SITE), ...line.matchAll(SITE_DOT)];
    for (const m of hits) {
      if (line[m.index - 1] === '/') continue;                                   // inside a regex literal
      // A process option, not data that happens to be called `detached` (git's worktree flag): a spawn/fork/execFile call or a
      // stdio/windowsHide/shell key within 5 lines either side. Options built on their own line are still caught.
      const around = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
      if (!/\b(?:spawn|fork|execFile)\s*\(|\b(?:stdio|windowsHide|shell)\s*:/.test(around)) continue;
      // An exception covers ITS OWN spawn: a comment on the same line, or one on a comment-only line directly above.
      const above = i > 0 && lines[i - 1].trim() === '' ? orig[i - 1] : '';
      const excused = /kill-test-ok:[ \t]*\S{3,}/.test(`${above}\n${orig[i]}`);
      // The shared sleeper: SLEEPER_SRC inside THIS spawn call (from the nearest spawn( at or before the site to its closing ');'),
      // which holds a single spawn.
      const pos = offset + m.index;
      const start = code.lastIndexOf('spawn(', pos);
      const end = code.indexOf(');', pos);
      const seg = start >= 0 && pos - start < 400 && end >= 0 ? code.slice(start, end + 2) : '';
      const feedsSleeper = /SLEEPER_SRC/.test(seg) && (seg.match(/spawn\(/g) || []).length === 1;
      if (!(excused || (feedsSleeper && reaps))) bad.push(`${i + 1}: ${orig[i].trim().slice(0, 90)}`);
    }
    offset += line.length + (code[offset + line.length] === '\r' ? 2 : 1);
  });
  return bad;
}

test('rule fixtures: one excused spawn does not excuse a second; a comment is not a reaper; a reason is required; options by variable count', () => {
  const D = 'detached';   // built, so this file's own scan does not read its fixtures as spawn sites
  const sleeperCall = `spawn(process.execPath, ['-e', SLEEPER_SRC, m], { ${D}: true });`;
  const bare = `spawn(a, b, { ${D}: true });`;
  assert.strictEqual(unaccountedDetached(`// kill-test-ok: reaped by pid in finally
${bare}
${bare}`).length, 1);
  assert.strictEqual(unaccountedDetached(`// reaps through reap-marked, honest
${sleeperCall}`).length, 1, 'a comment naming the reaper');
  assert.strictEqual(unaccountedDetached(`const reapMarked = 1; // x
const r = require('./reap-marked');
${sleeperCall}`).length, 1, 'a mention that is not a call');
  assert.strictEqual(unaccountedDetached(`// kill-test-ok:
${bare}`).length, 1, 'no reason');
  assert.strictEqual(unaccountedDetached(`const o = { stdio: 'ignore', ${D}: true };
spawn(cmd, args, o);`).length, 1, 'options object by variable');
  assert.strictEqual(unaccountedDetached(`const o = { stdio: 'ignore', ${D}: isWin };
spawn(cmd, args, o);`).length, 1, 'a non-literal value');
  // PR #135 Dexter D8-r2: each of these passed before
  assert.strictEqual(unaccountedDetached(`${bare}   // kill-test-ok: reaped by pid in finally
${bare}`).length, 1, 'a trailing comment excuses its own spawn only, not the next line');
  assert.strictEqual(unaccountedDetached(`const o = { ${D}: true };
spawn(cmd, args, o);`).length, 1, 'options built on their own line, spawn on the next');
  assert.strictEqual(unaccountedDetached(`const ${D} = true;
spawn(cmd, args, { ${D}, stdio: 'ignore' });`).length, 1, 'shorthand');
  assert.strictEqual(unaccountedDetached(`spawn(cmd, args, { '${D}': true, stdio: 'ignore' });`).length, 1, 'quoted key');
  assert.strictEqual(unaccountedDetached(`const o = { stdio: 'ignore' };
o.${D} = true;
spawn(cmd, args, o);`).length, 1, 'assignment');
  assert.strictEqual(unaccountedDetached(`spawn(process.execPath, ['-e', SLEEPER_SRC, m], { stdio: 'ignore' });
reapMarked(m);
${bare}`).length, 1, 'a detached spawn next to a sleeper spawn is not the sleeper spawn');
  // and the accepted forms
  assert.deepStrictEqual(unaccountedDetached(`reapMarked(m);
${sleeperCall}`), []);
  assert.deepStrictEqual(unaccountedDetached(`// kill-test-ok: reaped by the pid it reports in finally
${bare}`), []);
  assert.deepStrictEqual(unaccountedDetached(`spawn(a, b, { ${D}: false });
assert.match(body, /${D}: true/);`), []);
});

test('rule: every detached spawn in the test suite is accounted for', () => {
  const bad = [];
  for (const f of fs.readdirSync(__dirname).filter(n => n.endsWith('.test.js'))) {
    for (const b of unaccountedDetached(fs.readFileSync(path.join(__dirname, f), 'utf8'))) bad.push(`${f}:${b}`);
  }
  assert.deepStrictEqual(bad, []);
});
