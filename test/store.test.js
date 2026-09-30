'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');
const { tmpDir } = require('./tmp-dir');

const tmp = () => tmpDir('cc-store-');

test('reading an absent file returns the default', () => {
  const s = createStore({ dir: tmp() });
  assert.deepStrictEqual(s.read('loadout', { agents: {} }), { agents: {} });
});

test('writes then reads back', () => {
  const s = createStore({ dir: tmp() });
  s.write('loadout', { agents: { miguel: ['whetstone'] } });
  assert.deepStrictEqual(s.read('loadout', {}), { agents: { miguel: ['whetstone'] } });
});

test('survives a process restart', () => {
  const dir = tmp();
  createStore({ dir }).write('stats', { runs: 3 });
  assert.deepStrictEqual(createStore({ dir }).read('stats', {}), { runs: 3 });
});

test('a corrupt file yields the default instead of throwing', () => {
  // One feature's state must not be able to take the session down. Everything
  // here is regenerable; none of it is worth an exception on a hot path.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault.json'), '{ not json');
  assert.deepStrictEqual(s.read('vault', { bugs: [] }), { bugs: [] });
});

test('one corrupt file does not affect the others', () => {
  // The reason for one file per concern rather than a single blob.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { runs: 7 });
  fs.writeFileSync(path.join(dir, 'vault.json'), 'garbage');
  assert.deepStrictEqual(s.read('stats', {}), { runs: 7 });
});

test('writes atomically, so a crash mid-write cannot truncate the file', () => {
  // Observed earlier in this project: a hard exit truncated a file to zero
  // bytes straight after a synchronous write. A half-written JSON file reads
  // as corrupt and silently resets whatever feature owned it.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { a: 1 });
  const before = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  s.write('stats', { a: 2 });
  const after = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  assert.notStrictEqual(before, after);
  assert.deepStrictEqual(JSON.parse(after), { a: 2 });
  // No temp files left lying around.
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => !f.endsWith('.json')), []);
});

test('creates its directory on demand', () => {
  const dir = path.join(tmp(), 'nested', 'deep');
  createStore({ dir }).write('stats', { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'stats.json')));
});

test('update applies a function to the current value', () => {
  const s = createStore({ dir: tmp() });
  s.write('stats', { runs: 1 });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 2);
});

test('update on an absent file starts from the default', () => {
  const s = createStore({ dir: tmp() });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 1);
});

test('a name that could escape the store directory is refused', () => {
  // Names may come from feature code and one day from config; a traversal here
  // would write outside the harness directory entirely.
  const dir = tmp();
  const s = createStore({ dir });
  assert.throws(() => s.write('../escape', { x: 1 }), /name/i);
  assert.throws(() => s.read('../../secrets', {}), /name/i);

  // MUTATION-DRIVEN. Mortimer's run on this branch surfaced a surviving
  // mutant that drops the `$` from `/^[A-Za-z0-9_-]+$/`, and the two cases
  // above do NOT kill it: both start with '.', which the character class
  // rejects with or without the end anchor. Unanchored, the regex matches a
  // PREFIX, so any traversal beginning with a legal character walks straight
  // out of the store directory. Measured:
  //
  //   '../escape'        anchored refuse   unanchored refuse
  //   'a/../../evil'     anchored refuse   unanchored ACCEPT
  //   'loadout/../../x'  anchored refuse   unanchored ACCEPT
  //
  // The guard was always correct; the test was not, and the gap was invisible
  // because the obvious traversal string happens to be caught twice over.
  assert.throws(() => s.write('a/../../evil', { x: 1 }), /name/i);
  assert.throws(() => s.read('loadout/../../x', {}), /name/i);
  assert.throws(() => s.write('ok/../x', { x: 1 }), /name/i);
  // Backslash too: this is Windows, and path.join treats both as separators.
  // Built from a char code rather than written literally -- a lone backslash
  // in a heredoc has silently eaten a level three times on this project, and
  // 'ok\..\x' is not a syntax error you can rely on catching it: here it
  // happened to be, but '\U' or '\r' would have parsed fine as the WRONG
  // string.
  const BS = String.fromCharCode(92);
  assert.throws(() => s.write(`ok${BS}..${BS}x`, { x: 1 }), /name/i);
});

test('exposes the path of a file for other processes to read', () => {
  // The hook helper reads loadout.json itself so items keep working with the
  // GUI closed, and it needs to be told where that is.
  const dir = tmp();
  const s = createStore({ dir });
  assert.strictEqual(s.pathOf('loadout'), path.join(dir, 'loadout.json'));
});

// --- readState: missing is not corrupt ---------------------------------------
//
// Dexter, PR #29 review, F1. `read(name, fallback)` returns the fallback for
// BOTH "no file" and "file exists and did not parse", which is right for every
// consumer this store had when it was written: cooldowns, seats, counters --
// all regenerable, all happy to start over.
//
// The bug vault is the first consumer holding records a user CANNOT
// reconstruct, and it used the absent/corrupt fallback as its "first run"
// signal: `read(KEY, null)` returning null meant seed, so a vault that failed
// to parse once was overwritten with defaults and the evidence was gone.
//
// `read` keeps its defaulting behaviour -- it is correct, and everything else
// depends on it. `readState` is the narrow addition for consumers that must
// fail CLOSED: it reports WHY there is no value, so "there is nothing here"
// and "something is here and I could not read it" stop being the same answer.

test('readState reports a missing file as missing, with no value', () => {
  const s = createStore({ dir: tmp() });
  const r = s.readState('cooldowns');
  assert.strictEqual(r.status, 'missing');
  assert.strictEqual(r.value, null);
});

test('readState reports a corrupt file as corrupt, NOT as missing', () => {
  // The whole point. These two were indistinguishable, and one of them means
  // "it is safe to write defaults over this".
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cooldowns.json'), '{ not json');
  const r = s.readState('cooldowns');
  assert.strictEqual(r.status, 'corrupt');
  assert.strictEqual(r.value, null);
});

test('readState returns the parsed value when the file is good', () => {
  const s = createStore({ dir: tmp() });
  s.write('cooldowns', { a: 1 });
  assert.deepStrictEqual(s.readState('cooldowns'), { status: 'ok', value: { a: 1 } });
});

test('readState reports a file it cannot open as unreadable, distinct from both', () => {
  // A directory where a file should be: not absent, not corrupt, not readable.
  // Whatever the platform's errno, the one thing it must NOT report is
  // "missing", because that is the status that authorises an overwrite.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(path.join(dir, 'cooldowns.json'), { recursive: true });
  const r = s.readState('cooldowns');
  assert.notStrictEqual(r.status, 'missing');
  assert.notStrictEqual(r.status, 'ok');
});

test('readState still refuses a traversing name rather than reporting it as missing', () => {
  // A path that escapes the store is a programming error and must surface.
  // Reporting it as "missing" would invite the caller to seed defaults into
  // whatever it names.
  const s = createStore({ dir: tmp() });
  assert.throws(() => s.readState('../escape'), /name/i);
});

test('read and readState cannot drift: read returns the fallback for every non-ok status', () => {
  // read() is expressed in terms of readState so there is ONE decision about
  // what counts as readable. This asserts the relationship, not a repeat of
  // the cases above.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });

  const sentinel = { sentinel: true };
  assert.deepStrictEqual(s.read('cooldowns', sentinel), sentinel, 'missing');

  fs.writeFileSync(path.join(dir, 'cooldowns.json'), 'garbage');
  assert.deepStrictEqual(s.read('cooldowns', sentinel), sentinel, 'corrupt');
  assert.strictEqual(s.readState('cooldowns').status, 'corrupt');

  s.write('cooldowns', { real: 1 });
  assert.deepStrictEqual(s.read('cooldowns', sentinel), { real: 1 }, 'ok');
});

// --- the traversal guard, pinned at the anchor --------------------------------
//
// Mortimer, PR #29 mutation gate, R4. Severity: High.
//
// Dropping the `$` from /^[A-Za-z0-9_-]+$/ leaves the guard matching a PREFIX,
// so `vault/../../secrets` is accepted and pathOf escapes the store directory
// entirely. The existing traversal test uses only '../escape' and
// '../../secrets' -- both start with a dot, which the character class rejects
// anchored or not, so it proves the guard refuses names that are OBVIOUSLY bad
// and says nothing about the anchor that makes it airtight.
//
// The same gap from the other side: mutating `!name || typeof name !== 'string'`
// to `&&`, or the typeof test to `false`, lets a non-string through, because
// `/.../.test(123)` coerces to "123" and matches.
//
// This is the second time this exact regex has been caught by mutation
// testing in this repo -- PR #30 found the identical unanchored hole in the
// same function. A guard that is right is not the same as a guard that is
// held right.

test('a name with a safe PREFIX and a traversal inside it is refused', () => {
  const s = createStore({ dir: tmp() });
  for (const bad of ['vault/../../secrets', 'vault/../escape', 'vault\..\escape',
                     'vault.json', 'vault/sub', 'a b', 'vault\u0000x']) {
    assert.throws(() => s.readState(bad), /name/i, `${JSON.stringify(bad)} must be refused`);
    assert.throws(() => s.write(bad, {}), /name/i, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a name that is not a string at all is refused, not coerced', () => {
  const s = createStore({ dir: tmp() });
  for (const bad of [123, {}, [], null, undefined, true]) {
    assert.throws(() => s.readState(bad), /name/i, `${JSON.stringify(bad)} must be refused`);
  }
});

test('createStore without a dir says so, rather than failing later in path.join', () => {
  // Mortimer: `if (!dir)` mutated away never throws, and the mistake then
  // surfaces deep inside path.join with a message that names the syntax
  // instead of the error.
  assert.throws(() => createStore({}), /dir/i);
  assert.throws(() => createStore({ dir: '' }), /dir/i);
});

// --- withLock, executed directly ---------------------------------------------
//
// Mortimer R3, store half. Deleting this function's entire body left 812 tests
// green, because no test in the suite wired a real store to the vault. These
// three are the direct coverage; test/bugvault.test.js closes the seam.

test('withLock runs the work holding a real lock file, and releases it', () => {
  const dir = tmp();
  const s = createStore({ dir });
  let heldDuring = null;
  const got = s.withLock('vault', () => {
    heldDuring = fs.existsSync(path.join(dir, 'vault.json.lock'));
    return 'value';
  });
  assert.strictEqual(got, 'value', 'the work must run and its value come back');
  assert.strictEqual(heldDuring, true, 'the lock must exist WHILE the work runs');
  assert.strictEqual(fs.existsSync(path.join(dir, 'vault.json.lock')), false, 'and be gone after');
});

test('withLock refuses a traversing name before touching disk', () => {
  assert.throws(() => createStore({ dir: tmp() }).withLock('../escape', () => {}), /name/i);
});

test('withLock creates the store directory, so the first ever write can take a lock', () => {
  // The lock lives beside the file, and on a first run neither exists yet.
  const dir = path.join(tmp(), 'not', 'yet');
  let ran = false;
  createStore({ dir }).withLock('vault', () => { ran = true; });
  assert.strictEqual(ran, true);
  assert.strictEqual(fs.existsSync(dir), true);
});

test('every file the store header names has a real producer', () => {
  // Dexter, PR #29 review, Finding 16. host/store.js's header listed FOUR
  // files -- loadout.json, vault.json, map.json, stats.json -- and not one of
  // them had ever been written. The only key this store actually uses,
  // 'cooldowns', was absent from the list. It was a roadmap written in the
  // present tense.
  //
  // The cost was not cosmetic. `map.json — files seen, per project` was cited
  // as PRECEDENT in a code review for how to scope a new feature's state;
  // there is no precedent, because nothing here is scoped by project. I then
  // repeated the claim in a comment whose whole job was to record what is and
  // is not scoped, and when I corrected it I fixed only the line I had been
  // told about and left the other three. Three readers, one stale list, two
  // passes to fix.
  //
  // This is the same instrument as test/control.test.js's allow-list scan: a
  // cross-file claim asserted against source rather than trusted. A header may
  // describe plans, but it must not describe them in the same voice as the
  // things that exist.
  const fs = require('fs');
  const path = require('path');
  const HOST = path.join(__dirname, '..', 'host');
  const APP = path.join(__dirname, '..', 'app');
  const src = fs.readFileSync(path.join(HOST, 'store.js'), 'utf8');
  const header = src.slice(0, src.indexOf('*/'));

  // Filenames the header presents as things this store contains.
  const named = [...header.matchAll(/\.harness\/state\/([A-Za-z0-9_-]+)\.json/g)]
    .map(m => m[1]);
  assert.ok(named.length > 0, 'the scan must find something for this check to mean anything');

  // A PRODUCER, NOT A MENTION. The first version of this test looked for the
  // quoted key anywhere under host/ or app/ -- and passed against a header full
  // of phantoms, because the very comment explaining that 'loadout', 'map' and
  // 'stats' have no references CONTAINS those quoted strings, inside store.js,
  // which the scan concatenated as code. The documentation of the bug satisfied
  // the detector for the bug. Verified: re-adding the loadout.json line to the
  // header left this test green.
  //
  // So strip comments, and require a real call shape rather than an appearance.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = (dir) => fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => strip(fs.readFileSync(path.join(dir, f), 'utf8')))
    .join('\n');
  const code = read(HOST) + '\n' + read(APP);

  const producer = (key) => new RegExp(
    `(?:STORE_KEY\\s*=\\s*|\\.(?:read|write|update|pathOf)\\s*\\(\\s*)['"]${key}['"]`).test(code);
  const phantom = named.filter(key => !producer(key));
  assert.deepStrictEqual(phantom, [],
    `the header names these state files and nothing reads or writes them: ${phantom.join(', ')}`);
});

test('every key the code uses is NAMED in the store header (the converse of the check above)', () => {
  // Miguel, PR #68, I1. The check above proves the header names nothing that is
  // not produced. Its converse was never asserted, and that is how the header
  // came to say "THAT IS THE WHOLE LIST" and "the other three still have no
  // producer" while vault, council and provider all had one. Derived from the
  // code by the same call shapes, not restated by hand.
  const fs = require('fs');
  const path = require('path');
  const dirs = [path.join(__dirname, '..', 'host'), path.join(__dirname, '..', 'app')];
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const code = dirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.js') && f !== 'store.js')
    .map(f => strip(fs.readFileSync(path.join(d, f), 'utf8')))).join('\n');
  const keys = new Set();
  for (const m of code.matchAll(/(?:STORE_KEY|UI_KEY)\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\bstore\.(?:read|readState|write|update|withLock)\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) keys.add(m[1]);
  assert.ok(keys.size >= 5, `the scan found only ${[...keys]} -- it is broken, not the code`);

  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'store.js'), 'utf8');
  const header = src.slice(0, src.indexOf('*/'));
  const unnamed = [...keys].filter(k => !header.includes(`'${k}'`) && !header.includes(`${k}.json`));
  assert.deepStrictEqual(unnamed, [], `the code uses these store keys and the header does not name them: ${unnamed.join(', ')}`);
  assert.ok(!/THAT IS THE WHOLE LIST/.test(header) || unnamed.length === 0);
});

test('a transient EPERM on the rename does NOT lose the write', () => {
  // MEASURED on this machine, 2026-09-18: a rename of a just-written temp
  // file failed with EPERM mid test run, nothing wrong with the file or the
  // permissions. On Windows any process holding a handle for a moment does
  // that, and the antivirus scan of the file we just wrote routinely does.
  // Unretried, a settings write simply threw.
  const dir = tmp();
  const s = createStore({ dir });
  const real = fs.renameSync;
  let failures = 2;
  const at = [];
  fs.renameSync = (from, to) => {
    at.push(Date.now());
    if (failures-- > 0) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
    return real(from, to);
  };
  try {
    s.write('loadout', { agents: { miguel: ['whetstone'] } });
  } finally {
    fs.renameSync = real;
  }
  assert.deepStrictEqual(createStore({ dir }).read('loadout', {}),
    { agents: { miguel: ['whetstone'] } }, 'the write must survive a transient EPERM');

  // Dexter, Finding 8: assert the retry actually RAN. This test worked only
  // because `rename = fs.renameSync` is a default parameter, re-evaluated per
  // call, so a patch applied after import is seen. Hoisting it to a
  // module-level const -- a change that looks like a micro-optimisation --
  // would make the real rename succeed first try and leave this test passing
  // while exercising nothing.
  assert.strictEqual(at.length, 3, 'the rename must have been retried, not merely succeeded');

  // Dexter, Finding 3: and that it used a REAL sleep. Change the default in
  // host/atomic-write.js from `sleep = sleepSync` to `sleep = () => {}` and
  // every other test in the suite still passes -- the six unit tests inject
  // their own sleep, and the happy-path tests never sleep at all. In
  // production the retry would collapse into five syscalls inside a
  // millisecond, far too fast to outlast the antivirus scan that produced the
  // measured EPERM. The bug would return with the gate green.
  //
  // 40ms, not 60: the first two waits are 20ms and 40ms, and asserting the
  // full 60 would make this sensitive to the schedule rather than to whether
  // any real waiting happened.
  assert.ok(at[2] - at[0] >= 40,
    `attempts 1 to 3 spanned only ${at[2] - at[0]}ms -- the production sleep is not real`);
});

test('a rename that never recovers still FAILS the write, loudly', () => {
  // Fails closed. A store write that reported success while the file on disk
  // was never replaced is worse than the throw it replaces -- the caller
  // would carry on believing the setting was saved.
  const s = createStore({ dir: tmp() });
  const real = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted, rename');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.throws(() => s.write('loadout', { agents: {} }), (err) => err.code === 'EPERM');
  } finally {
    fs.renameSync = real;
  }
});

test('a permanently failed write leaves no temp file behind', () => {
  // Dexter, Finding 9. Bounded here rather than unbounded -- the temp is
  // `${file}.tmp${pid}`, so a later write from the same process overwrites it
  // -- but a stale temp beside a settings file still reads as corruption to
  // anyone looking, and the cleanup is the same one line as in the vault.
  const dir = tmp();
  const s = createStore({ dir });
  const real = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM: fake'); e.code = 'EPERM'; throw e; };
  try {
    assert.throws(() => s.write('loadout', { agents: {} }), /EPERM/);
  } finally {
    fs.renameSync = real;
  }
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], `orphaned temp files: ${leftovers.join(', ')}`);
});

test('a name that is not a string at all is refused', () => {
  // Mortimer ST-B, 3 mutants on one guard. Every existing test passes a
  // string, so the `!name` and `typeof name !== 'string'` clauses were
  // load-bearing for nothing that is tested.
  //
  // MEASURED: with name = 123 the original guard throws, and all three
  // mutants let the write proceed against `123.json` -- the regex coerces the
  // number to '123', which matches. This module's own comment says names
  // "may come from feature code today and from config later", and a number
  // out of a JSON config is exactly that case.
  const s = createStore({ dir: tmp() });
  for (const bad of [123, null, undefined, {}, [], true, '']) {
    assert.throws(() => s.write(bad, { x: 1 }), /unsafe name/,
      `write(${JSON.stringify(bad)})`);
    assert.throws(() => s.read(bad, {}), /unsafe name/,
      `read(${JSON.stringify(bad)})`);
  }
});

test('createStore without a dir refuses immediately', () => {
  // Mortimer ST-C. Without the guard the failure becomes a TypeError out of
  // path.join(undefined, ...) later, in a different place, naming a different
  // cause.
  assert.throws(() => createStore({}), /dir is required/);
  assert.throws(() => createStore(), /dir is required/);
});
