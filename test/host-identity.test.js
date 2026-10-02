'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeIdentity, readIdentity } = require('../host/host-identity');
const { tmpDir } = require('./tmp-dir');

const tmp = () => tmpDir('cc-ident-');
const ALIVE = () => true;

test('a host publishes which project it serves, and it reads back', () => {
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  const got = readIdentity({ dir, port: 7700, isAlive: ALIVE });
  assert.strictEqual(got.cwd, 'C:/proj');
});

test('a host that is no longer running reads as ABSENT, not as its last claim', () => {
  // The file outlives the process that wrote it. A host killed with the window
  // open, a machine that lost power, a crashed run -- all leave a file saying
  // "port 7700 serves C:/proj". Believing it means refusing to start a new
  // host for a project whose host is long dead, forever, with no way out but
  // deleting a file the user does not know exists.
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: () => false }), null);
});

test('an unreadable or nonsense identity is ABSENT, never a guess', () => {
  const dir = tmp();
  // Nothing written at all.
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }), null);

  // Half-written: the host writes this at startup, so a crash mid-write is an
  // ordinary state rather than a corrupt-disk story.
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hosts', '7701.json'), '{"port":7701,"cwd"', 'utf8');
  assert.strictEqual(readIdentity({ dir, port: 7701, isAlive: ALIVE }), null);

  // Parses, but says nothing useful. `decideAttach` would refuse this anyway;
  // reporting it as absent keeps "there is no host" and "there is a host that
  // will not identify itself" as the different things they are.
  fs.writeFileSync(path.join(dir, 'hosts', '7702.json'), '{"port":7702,"pid":1}', 'utf8');
  assert.strictEqual(readIdentity({ dir, port: 7702, isAlive: ALIVE }), null);
});

test('an identity filed under the wrong port is not trusted', () => {
  // Guards a copied .harness directory and a hand-edited file. The port is
  // recorded inside as well as in the filename precisely so the two can be
  // checked against each other.
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  fs.renameSync(path.join(dir, 'hosts', '7700.json'), path.join(dir, 'hosts', '7900.json'));
  assert.strictEqual(readIdentity({ dir, port: 7900, isAlive: ALIVE }), null);
});

test('a pid that is not a REAL pid is refused', () => {
  // Dexter, PR #31 Finding 9. `Number.isInteger(parsed.pid)` admits 0 and
  // negatives. On POSIX `process.kill(-1, 0)` targets every process the caller
  // may signal and SUCCEEDS, so `{"pid":-1}` reads as alive and the file is
  // trusted -- an attach decision made on a stranger's port. Contained, because
  // the token check then refuses loudly, but the guard is one `> 0` away from
  // closing it and a guard that admits -1 is not a guard.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
  for (const pid of [0, -1, -999, 1.5, NaN, '4242', null]) {
    fs.writeFileSync(path.join(dir, 'hosts', '7700.json'),
      JSON.stringify({ port: 7700, cwd: 'C:/proj', pid }));
    assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }), null,
      `pid ${String(pid)} must not be trusted`);
  }
});

test('the identity file is written ATOMICALLY, never left truncated', () => {
  // Dexter, Finding 7. This was a bare fs.writeFileSync, which truncates and
  // then writes. A reader landing between those two gets a parse error -> null
  // -> 'unidentified' -> and the caller's response to that is to STEP PAST the
  // live host and spawn a duplicate. Absence is honest about what we know; it
  // is not harmless when the answer to absence is "create a second session".
  //
  // host/store.js next door has done write-and-rename since it was written,
  // with a comment citing this project's own zeroed-PNG incident, and
  // CLAUDE.md names it: "Never open a file with 'w' before you are sure the
  // write succeeds." This was the one file in the PR that skipped it.
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/original', pid: 4242 });

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    real(p, ...rest);                       // truncate + write the temp
    throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => writeIdentity({ dir, port: 7700, cwd: 'C:/replacement', pid: 9999 }));
  } finally {
    fs.writeFileSync = real;
  }

  // The old identity must still be intact and readable -- old or new, never
  // half, which is the entire point of write-and-rename.
  const got = readIdentity({ dir, port: 7700, isAlive: ALIVE });
  assert.ok(got, 'the previous identity must survive a failed write');
  assert.strictEqual(got.cwd, 'C:/original');
});

test('a failed identity write leaves no temp file behind', () => {
  const dir = tmp();
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    real(p, ...rest);
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => writeIdentity({ dir, port: 7700, cwd: 'C:/x', pid: 1 }));
  } finally {
    fs.writeFileSync = real;
  }
  const leftovers = fs.readdirSync(path.join(dir, 'hosts')).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], `orphaned temps: ${leftovers.join(', ')}`);
});

test('the REAL liveness check recognises this process and rejects a free pid', () => {
  // Miguel: every other test injects `isAlive`, so `defaultIsAlive` -- the one
  // piece of this module with real OS semantics, and the thing the whole
  // attach decision rests on -- was never exercised.
  const { defaultIsAlive } = require('../host/host-identity');

  assert.strictEqual(defaultIsAlive(process.pid), true, 'this process is alive');

  // A pid that is almost certainly not in use. Not a guarantee, so the
  // assertion is on the SHAPE of the answer for a pid we then confirm is
  // absent, rather than on a number we hope is free.
  const unlikely = 0x7ffffffe;
  let reallyGone = false;
  try { process.kill(unlikely, 0); } catch (e) { reallyGone = e.code === 'ESRCH'; }
  if (reallyGone) {
    assert.strictEqual(defaultIsAlive(unlikely), false, 'a dead pid must read as dead');
  }

  // EPERM means the process EXISTS and belongs to someone else, which is alive
  // for our purposes -- the branch the module documents and nothing reached.
  const epermThrower = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  const realKill = process.kill;
  process.kill = epermThrower;
  try {
    assert.strictEqual(defaultIsAlive(1234), true, "EPERM means alive, not absent");
  } finally {
    process.kill = realKill;
  }
});

test('a host can publish its identity before .harness exists at all', () => {
  // Mortimer Survivor 4, and THE ONE RUN WHERE THIS FIRES IS EVERY USER'S
  // FIRST. `mkdirSync(..., {recursive:true})` -> `{}` survived because every
  // test here calls tmp() first, so only `hosts/` is ever missing -- one
  // level, which non-recursive mkdir handles. In production the path is
  // `.harness/hosts`, and on a machine that has never run this, `.harness`
  // does not exist either: non-recursive mkdir throws ENOENT and the host
  // cannot publish its identity at all.
  const dir = path.join(tmp(), 'harness-not-created-yet');   // two levels missing
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242 });
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }).cwd, 'C:/proj');
});

test('an identity file holding a JSON scalar is ABSENT, not a crash', () => {
  // Mortimer Survivor 5. The `!parsed || typeof parsed !== 'object'` guard was
  // unreached: the tests cover truncated JSON (a parse error) and a valid
  // object missing cwd, but never a valid JSON SCALAR. Without the guard, a
  // file whose whole content is `null` makes `parsed.cwd` throw a TypeError
  // OUT of readIdentity -- and app/main.js calls this BEFORE the window opens,
  // so the failure is a dead launch rather than the graceful 'unidentified'
  // this module's header promises.
  //
  // Only `null` actually crashes; 5, true and "C:/proj" reach `.cwd ===
  // undefined` and return null anyway. They are here to document that, not to
  // pad the case list.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
  for (const junk of ['null', '5', 'true', '"C:/proj"', '[]']) {
    fs.writeFileSync(path.join(dir, 'hosts', '7700.json'), junk, 'utf8');
    assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }), null, `content ${junk}`);
  }

  // Mortimer Survivor 6: a whitespace-only cwd. test/handshake.test.js tests
  // exactly this at the decideAttach layer -- so the rule was asserted one
  // level ABOVE where it is implemented, and nothing checked it here.
  fs.writeFileSync(path.join(dir, 'hosts', '7700.json'),
    JSON.stringify({ port: 7700, cwd: '   ', pid: 4242 }), 'utf8');
  assert.strictEqual(readIdentity({ dir, port: 7700, isAlive: ALIVE }), null,
    'a blank cwd is not an identity');
});

test('readTokenFile: the trimmed per-port token, or null for missing, empty or a bad port', () => {
  const { readTokenFile } = require('../host/host-identity');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hosts', '7700.token'), 'abc123\r\n');
  fs.writeFileSync(path.join(dir, 'hosts', '7701.token'), '  \n');
  assert.strictEqual(readTokenFile({ dir, port: 7700 }), 'abc123');
  assert.strictEqual(readTokenFile({ dir, port: 7701 }), null);
  assert.strictEqual(readTokenFile({ dir, port: 7702 }), null);
  for (const port of [null, 0, -1, 1.5, '7700', 70000]) {
    assert.strictEqual(readTokenFile({ dir, port }), null, String(port));
  }
});

// Dexter, PR 2 F1 (High): `startedAt` is a wall-clock reading, and a clock that
// steps back makes "started no later than the write" true of an unrelated
// process. The OS start time is exact, so the host records it when it knows it.
test('the identity carries the host\'s OS start time when given one, and only a string', () => {
  const dir = tmp();
  writeIdentity({ dir, port: 7700, cwd: 'C:/proj', pid: 4242, processStartedAt: '133000000000000000' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'hosts', '7700.json'), 'utf8'));
  assert.strictEqual(raw.processStartedAt, '133000000000000000');
  for (const bad of [undefined, null, 133, '']) {
    writeIdentity({ dir, port: 7701, cwd: 'C:/proj', pid: 4242, processStartedAt: bad });
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'hosts', '7701.json'), 'utf8'));
    assert.strictEqual('processStartedAt' in r, false, String(bad));
  }
});
