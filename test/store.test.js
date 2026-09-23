'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));

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
