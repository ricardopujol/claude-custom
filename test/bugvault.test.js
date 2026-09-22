'use strict';
/**
 * The bug vault: one record per distinct bug CLASS, structured so a recurring
 * defect category is a visible COUNT rather than a memory scattered across PR
 * comments and chat transcripts.
 *
 * See GAMIFICATION_DESIGN.md, section 4, for the spec this implements.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');

const {
  createRecord, groupByCategory, detectionBreakdown, createBugVault, applyVaultAction, SEED_BUGS,
} = require('../host/bugvault');

function memStore(initial) {
  let data = initial;
  return {
    // `readState` is what the vault reads through: it must distinguish "no
    // file yet" from "a file that would not parse", because only the first
    // authorises writing seed data over it. See store.js, Dexter F1.
    readState: () => (data === undefined
      ? { status: 'missing', value: null }
      : { status: 'ok', value: data }),
    read: (_name, fallback) => (data === undefined ? fallback : data),
    write: (_name, value) => { data = value; },
  };
}

// A store whose file is THERE but unusable. The distinction this whole
// section exists for: nothing may be written over it.
function brokenStore(status = 'corrupt') {
  const writes = [];
  return {
    writes,
    readState: () => ({ status, value: null }),
    read: (_name, fallback) => fallback,
    write: (_name, value) => { writes.push(value); },
  };
}

// A store whose writes always fail, for the attach-handshake case.
function throwingStore(initial) {
  let data = initial;
  return {
    readState: () => (data === undefined
      ? { status: 'missing', value: null }
      : { status: 'ok', value: data }),
    read: (_name, fallback) => (data === undefined ? fallback : data),
    write: () => { throw new Error('EACCES: permission denied'); },
  };
}

// --- createRecord ------------------------------------------------------------

test('a category and a summary are the only required fields', () => {
  const r = createRecord({ category: 'silent failure', summary: 'exit 0 masked a real failure' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.category, 'silent failure');
  assert.strictEqual(r.record.summary, 'exit 0 masked a real failure');
});

test('a missing category is refused, not silently dropped into "uncategorised"', () => {
  // A silent default here would be exactly the failure mode this feature exists
  // to retire: a bug filed nowhere in particular does not surface a pattern.
  const r = createRecord({ summary: 'something broke' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /category/i);
});

test('a blank category (whitespace only) is refused', () => {
  const r = createRecord({ category: '   ', summary: 'x' });
  assert.strictEqual(r.ok, false);
});

test('a missing summary is refused', () => {
  const r = createRecord({ category: 'silent failure' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /summary/i);
});

test('optional fields absent from the input are null, never invented text or a coerced zero', () => {
  const r = createRecord({ category: 'x', summary: 'y' });
  assert.strictEqual(r.record.whereFound, null);
  assert.strictEqual(r.record.detectedBy, null);
  assert.strictEqual(r.record.survived, null);
  assert.strictEqual(r.record.wouldHaveCaught, null);
});

test('a blank optional field normalizes to null rather than an empty string', () => {
  const r = createRecord({ category: 'x', summary: 'y', whereFound: '   ' });
  assert.strictEqual(r.record.whereFound, null);
});

test('every field is trimmed', () => {
  const r = createRecord({ category: '  x  ', summary: '  y  ', whereFound: '  z  ' });
  assert.strictEqual(r.record.category, 'x');
  assert.strictEqual(r.record.summary, 'y');
  assert.strictEqual(r.record.whereFound, 'z');
});

test('fixed defaults to false, and unfixed records carry no fixedAt', () => {
  const r = createRecord({ category: 'x', summary: 'y' });
  assert.strictEqual(r.record.fixed, false);
  assert.strictEqual(r.record.fixedAt, null);
});

test('fixed must be exactly `true` -- a truthy string must not flip it', () => {
  // `Number(null)` being `0` is the standing lesson in this codebase: a coercing
  // check turns absence into a confident value. The equivalent trap here is a
  // truthy-but-wrong `fixed` value (a checkbox's string "false", say) silently
  // marking a bug fixed.
  const r = createRecord({ category: 'x', summary: 'y', fixed: 'false' });
  assert.strictEqual(r.record.fixed, false);
});

test('a record created already fixed gets a fixedAt', () => {
  const r = createRecord({ category: 'x', summary: 'y', fixed: true }, { now: () => 1000 });
  assert.strictEqual(r.record.fixed, true);
  assert.strictEqual(typeof r.record.fixedAt, 'string');
});

test('foundAt defaults to now, as an ISO string', () => {
  const r = createRecord({ category: 'x', summary: 'y' }, { now: () => 1_700_000_000_000 });
  assert.strictEqual(r.record.foundAt, new Date(1_700_000_000_000).toISOString());
});

test('every record gets a unique id', () => {
  const a = createRecord({ category: 'x', summary: 'y' }, { now: () => 1 });
  const b = createRecord({ category: 'x', summary: 'y' }, { now: () => 1 });
  assert.notStrictEqual(a.record.id, b.record.id);
});

// --- groupByCategory -----------------------------------------------------------

test('groups records by category and counts fixed vs unfixed', () => {
  const bugs = [
    { category: 'silent failure', fixed: true },
    { category: 'silent failure', fixed: false },
    { category: 'rendering regression', fixed: true },
  ];
  const groups = groupByCategory(bugs);
  const silent = groups.find(g => g.category === 'silent failure');
  assert.strictEqual(silent.total, 2);
  assert.strictEqual(silent.fixed, 1);
  assert.strictEqual(silent.unfixed, 1);
});

test('the most frequent category comes first -- that is the whole point of grouping', () => {
  const bugs = [
    { category: 'a', fixed: false },
    { category: 'b', fixed: false },
    { category: 'b', fixed: false },
    { category: 'b', fixed: false },
  ];
  assert.strictEqual(groupByCategory(bugs)[0].category, 'b');
});

test('grouping an absent or malformed list yields no groups, not a thrown error', () => {
  assert.deepStrictEqual(groupByCategory(null), []);
  assert.deepStrictEqual(groupByCategory(undefined), []);
  assert.deepStrictEqual(groupByCategory([null, { notCategory: 1 }]), []);
});

// --- detectionBreakdown --------------------------------------------------------

test('counts bugs by how they were detected', () => {
  const bugs = [
    { detectedBy: 'measurement' }, { detectedBy: 'measurement' }, { detectedBy: 'reading the code' },
  ];
  const rows = detectionBreakdown(bugs);
  assert.deepStrictEqual(rows.find(r => r.detectedBy === 'measurement').count, 2);
  assert.deepStrictEqual(rows.find(r => r.detectedBy === 'reading the code').count, 1);
});

test('an unrecorded detection method is its own explicit bucket, never folded into a method that was actually used', () => {
  // Coercing a missing detectedBy into, say, "reading the code" would credit a
  // detection method for work it did not do -- absence reported as a value.
  const bugs = [{ detectedBy: 'measurement' }, { detectedBy: null }, { detectedBy: '  ' }];
  const rows = detectionBreakdown(bugs);
  const unknown = rows.find(r => r.detectedBy === null);
  assert.strictEqual(unknown.count, 2);
  assert.strictEqual(rows.find(r => r.detectedBy === 'measurement').count, 1);
});

test('the biggest detection method sorts first, so "found by measurement, never by reading" is legible at a glance', () => {
  const bugs = [
    { detectedBy: 'reading the code' },
    { detectedBy: 'measurement' }, { detectedBy: 'measurement' }, { detectedBy: 'measurement' },
  ];
  assert.strictEqual(detectionBreakdown(bugs)[0].detectedBy, 'measurement');
});

// --- createBugVault ------------------------------------------------------------

test('createBugVault requires a store', () => {
  assert.throws(() => createBugVault({}), /store/i);
});

test('the vault seeds itself from what this project has already earned, on first read', () => {
  const v = createBugVault({ store: memStore(undefined), now: () => 1 });
  const bugs = v.list();
  assert.strictEqual(bugs.length, SEED_BUGS.length);
});

test('the seed is written once -- an existing (even empty) vault file is never overwritten', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  assert.deepStrictEqual(v.list(), []);
});

test('add() persists a new record and returns it', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  const r = v.add({ category: 'x', summary: 'y' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(v.list().length, 1);
  assert.strictEqual(v.list()[0].id, r.record.id);
});

test('add() with a bad input persists nothing', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  const r = v.add({ summary: 'y' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(v.list().length, 0);
});

test('setFixed() flips a bug and stamps fixedAt', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 42 });
  const { record } = v.add({ category: 'x', summary: 'y' });
  const r = v.setFixed(record.id, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.fixed, true);
  assert.strictEqual(r.record.fixedAt, new Date(42).toISOString());
  assert.strictEqual(v.list()[0].fixed, true);
});

test('setFixed() back to unfixed clears fixedAt -- reopened, not "fixed forever ago"', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  const { record } = v.add({ category: 'x', summary: 'y' });
  v.setFixed(record.id, true);
  const r = v.setFixed(record.id, false);
  assert.strictEqual(r.record.fixed, false);
  assert.strictEqual(r.record.fixedAt, null);
});

test('setFixed() on an unknown id changes nothing and says so', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  v.add({ category: 'x', summary: 'y' });
  const r = v.setFixed('nope', true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(v.list()[0].fixed, false);
});

test('summary() reports the total, the category groups and the detection breakdown together', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  v.add({ category: 'a', summary: 'x', detectedBy: 'measurement' });
  v.add({ category: 'a', summary: 'y', detectedBy: 'measurement' });
  const s = v.summary();
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.byCategory[0].category, 'a');
  assert.strictEqual(s.byDetection[0].detectedBy, 'measurement');
});

test('every seed record is itself a valid record', () => {
  // The seed data is real history, entered through the same validator as
  // anything typed into the add form -- it does not get to skip the rules.
  for (const seed of SEED_BUGS) {
    const r = createRecord(seed, { now: () => 1 });
    assert.strictEqual(r.ok, true, JSON.stringify(seed));
  }
});

test('the seed data records category and detection method for every entry, since that is the whole point of a vault', () => {
  for (const seed of SEED_BUGS) {
    assert.ok(seed.category && seed.category.trim(), JSON.stringify(seed));
    assert.ok(seed.detectedBy && seed.detectedBy.trim(), JSON.stringify(seed));
  }
});

// --- applyVaultAction --------------------------------------------------------
//
// Dexter, PR #29 review, F4. The action routing used to live inline in
// host.js's `dispatchControl`, where `result` was initialised to `{ ok: true }`
// and only reassigned by the two branches that recognised the action. Anything
// else fell straight through to a broadcast carrying `error: null` -- a
// SUCCESS reply for work that never happened, inside the one function whose
// entire job is knowing which frames are ours.
//
// It moved here for the same reason every drawing decision moved out of
// renderer.js: a decision inline in host.js is a decision nothing can test
// without a live pty. The vault module is also where the question "what are
// this feature's actions?" actually belongs.

test('an unknown vault action is refused, not answered with success', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  const r = applyVaultAction(v, { action: 'delete', id: 'anything' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown/i);
});

test('the refusal names the action it refused, so the log says which frame was wrong', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  assert.match(applyVaultAction(v, { action: 'drop' }).error, /drop/);
});

test('a missing action is refused too -- absence is not a default action', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  assert.strictEqual(applyVaultAction(v, {}).ok, false);
  assert.strictEqual(applyVaultAction(v, null).ok, false);
});

test('an unknown action does not mutate the vault', () => {
  // The broadcast that followed the old fall-through carried the CURRENT
  // vault, so a client could not tell a no-op apart from a successful write.
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  v.add({ category: 'a', summary: 'x' });
  const before = JSON.stringify(v.list());
  applyVaultAction(v, { action: 'nonsense' });
  assert.strictEqual(JSON.stringify(v.list()), before);
});

test('the two real actions still route through', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  const added = applyVaultAction(v, { action: 'add', record: { category: 'a', summary: 'x' } });
  assert.strictEqual(added.ok, true);
  const done = applyVaultAction(v, { action: 'setFixed', id: added.record.id, fixed: true });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(v.list()[0].fixed, true);
});

test('a record that is not an object is refused by the validator, not coerced into one', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  assert.strictEqual(applyVaultAction(v, { action: 'add', record: 'category: a' }).ok, false);
  assert.strictEqual(applyVaultAction(v, { action: 'add' }).ok, false);
});

// --- setFixed and an absent flag ---------------------------------------------
//
// Dexter, PR #29 review, F5. `fixedAt: fixed === true ? now : null` fails
// CLOSED for the flag -- nothing truthy-but-not-true can mark a bug fixed,
// which was deliberate and is tested above. But the `null` on the other side
// is unconditional, so `setFixed(id)` with no second argument silently
// CLEARED a recorded fix date. It was reachable from the wire, because the
// host handler passed `msg.fixed === true` and turned every absent flag into
// an explicit false before the vault could see the difference.
//
// This is the project's own absence-is-not-zero rule pointed at a boolean:
// "reopen this bug" and "you forgot to say" must not be the same instruction,
// least of all in the one store holding records a user cannot retype.

test('setFixed refuses an absent flag instead of treating it as "reopen"', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1000 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  v.setFixed(id, true);
  const at = v.list()[0].fixedAt;
  assert.ok(at, 'precondition: the bug is fixed and carries a date');

  const r = v.setFixed(id);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /fixed/i);
  assert.strictEqual(v.list()[0].fixedAt, at, 'the recorded date must survive a malformed call');
  assert.strictEqual(v.list()[0].fixed, true);
});

test('setFixed refuses any non-boolean flag, not just undefined', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1000 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  for (const bad of [null, 0, 1, '', 'true', 'false', {}, []]) {
    const r = v.setFixed(id, bad);
    assert.strictEqual(r.ok, false, `setFixed(id, ${JSON.stringify(bad)}) must refuse`);
  }
  assert.strictEqual(v.list()[0].fixed, false);
});

test('an explicit false still reopens the bug and clears the date', () => {
  // The behaviour the unconditional null was WRITTEN for, which must survive
  // the fix: a reopened bug must not still claim a fix date from last round.
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1000 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  v.setFixed(id, true);
  const r = v.setFixed(id, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(v.list()[0].fixed, false);
  assert.strictEqual(v.list()[0].fixedAt, null);
});

test('a setFixed frame with no fixed field is refused end to end, not silently reopened', () => {
  // The wire path, which is how this was reachable at all.
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1000 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  v.setFixed(id, true);
  const r = applyVaultAction(v, { action: 'setFixed', id });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(v.list()[0].fixed, true, 'the bug must still be fixed');
});

test('an unknown id is still refused before the flag is even considered', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1000 });
  assert.strictEqual(v.setFixed('nope', true).ok, false);
});

// --- an unreadable vault is never overwritten --------------------------------
//
// Dexter, PR #29 review, F1, and the finding that made this PR's data
// different in kind from everything else in host/store.js.
//
// `load()` called `store.read(KEY, null)`, which returns null for BOTH "no
// file" and "file exists and did not parse", and treated null as first run:
// it wrote the six seed records over whatever was there. A vault damaged by a
// partial write, a permissions blip or a disk error was silently replaced with
// defaults, and the user was told nothing -- they saw a tidy list of six
// example bugs where their own records used to be.
//
// The comment above that branch enumerated both cases and chose to treat them
// alike, so this was a DECISION, not an oversight. The decision taken here is
// REFUSE TO SEED: write defaults only when the store is certain nothing is
// there, and surface the failure rather than papering over it. Seeding is the
// destructive branch, so it gets the narrow condition.

test('a vault that did not parse is NOT overwritten with seed data', () => {
  const store = brokenStore('corrupt');
  const v = createBugVault({ store, now: () => 1 });
  v.list();
  assert.deepStrictEqual(store.writes, [], 'nothing may be written over a corrupt vault');
});

test('a vault the OS would not hand over is NOT overwritten either', () => {
  const store = brokenStore('unreadable');
  const v = createBugVault({ store, now: () => 1 });
  v.list();
  assert.deepStrictEqual(store.writes, []);
});

test('an unreadable vault reports the failure instead of reporting zero bugs', () => {
  // Absence reported as zero, one panel over. An empty list here is a claim
  // that the user has recorded nothing, which is a different statement from
  // "the vault could not be read".
  const v = createBugVault({ store: brokenStore('corrupt'), now: () => 1 });
  const s = v.summary();
  assert.ok(s.error, 'the summary must carry the failure');
  assert.match(s.error, /corrupt/i);

  // Mortimer R6: the error was asserted and the PAYLOAD beside it was not, so
  // the panel could show fabricated bugs next to the warning. That is this
  // module's own absence-as-zero rule inverted -- presence reported where
  // there is none.
  assert.deepStrictEqual(v.list(), []);
  assert.strictEqual(s.total, 0);
  assert.deepStrictEqual(s.byCategory, []);
  assert.deepStrictEqual(s.byDetection, []);
});

test('adding to an unreadable vault is refused, not written over the damaged file', () => {
  // The sharpest edge: a single add against a corrupt vault would otherwise
  // persist a ONE-record file over whatever was there, completing the
  // destruction the seeding path was stopped from doing.
  const store = brokenStore('corrupt');
  const v = createBugVault({ store, now: () => 1 });
  const r = v.add({ category: 'a', summary: 'x' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(store.writes, []);
});

test('marking a bug fixed in an unreadable vault is refused too', () => {
  const store = brokenStore('corrupt');
  const v = createBugVault({ store, now: () => 1 });
  const r = v.setFixed('any-id', true);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(store.writes, []);

  // Mortimer R11: dropping the `data.error` guard still refuses and still
  // writes nothing -- a corrupt load yields an empty list, so nothing matches
  // and it falls through to "no bug with id". Both old assertions held. What
  // changed was only the REASON: the user is told the row is stale and invited
  // to retry, instead of being sent to look at a damaged file. This is not the
  // wording class; the CATEGORY of a refusal is the rule.
  assert.match(r.error, /corrupt|untouched/i,
    'it must refuse because the vault is unreadable, not because the id is unknown');
});

test('a file that parsed but is not a vault is left alone as well', () => {
  // `{"foo":1}` is valid JSON and is not a vault. It is still SOMEBODY'S file,
  // and "ok but the wrong shape" is not "nothing is there".
  //
  // Mortimer R5: this used to assert ONLY that nothing was written, so load()
  // could return `{ bugs: undefined }` or a list of phantom records and still
  // pass. Refusing to destroy the file is half the rule; reporting the right
  // reason is the other half, and only the first half was tested. With the
  // mutant, list() returned undefined and summary() threw on bugs.length --
  // surfacing to the user as "Cannot read properties of undefined" instead of
  // "the vault parsed but holds no bug list".
  const store = memStore({ foo: 1 });
  let written = null;
  const wrapped = { ...store, write: (n, v) => { written = v; return store.write(n, v); } };
  const v = createBugVault({ store: wrapped, now: () => 1 });

  assert.deepStrictEqual(v.list(), [], 'no phantom records from a file that is not a vault');
  assert.strictEqual(written, null, 'a parsed-but-wrong-shape file must not be seeded over');
  const s = v.summary();
  assert.match(s.error, /no bug list/i, 'the reason must be accurate, not generic');
  assert.strictEqual(s.total, 0);
});

test('a genuinely absent vault IS still seeded -- the feature has to work', () => {
  // The behaviour that must survive the fix. `missing` is the one status that
  // authorises a write, and it is still authorised.
  const store = memStore(undefined);
  const v = createBugVault({ store, now: () => 1 });
  assert.strictEqual(v.list().length, SEED_BUGS.length);
});

test('an emptied vault is never reseeded -- a valid empty list is a real answer', () => {
  // Pins the original intent: the user clearing the vault must not be
  // interpreted as first run on the next read.
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  assert.deepStrictEqual(v.list(), []);
});

// --- a failing write must not take the session down --------------------------
//
// Dexter, PR #29 review, F2. `vault: vaultPayload()` is built inside the
// `hello` frame in `wss.on('connection')` -- OUTSIDE `handleFrame`'s
// try/catch, which only wraps control-frame dispatch. `vaultPayload` calls
// `list()`, `list()` calls `load()`, and `load()` writes when it seeds. A
// throw from mkdir/write/rename there is an unhandled exception in the
// connection handler, and the host owns the pty, so it takes the running
// Claude session with it.
//
// Because it is on the ATTACH path, the shape of the failure is "every window
// you open kills the session" -- on a machine where the state directory has
// gone read-only, the harness becomes unusable rather than degraded.
//
// store.test.js already states the rule this breaks: "One feature's state must
// not be able to take the session down. Everything here is regenerable; none
// of it is worth an exception on a hot path."

test('a vault that cannot be created does not throw out of list()', () => {
  const v = createBugVault({ store: throwingStore(undefined), now: () => 1 });
  assert.doesNotThrow(() => v.list());
});

test('a vault that cannot be created reports empty WITH an error, not six phantom seeds', () => {
  // PR #30's secret vault shipped the opposite of this: it updated memory
  // before disk, so `list` served a secret that was not stored until a restart
  // took it away. Six seed records shown as recorded, when the write that
  // would have recorded them failed, is the same lie in a different panel.
  const v = createBugVault({ store: throwingStore(undefined), now: () => 1 });
  assert.deepStrictEqual(v.list(), []);
  assert.match(v.summary().error, /could not/i);
});

test('payload() is total: it answers even when everything underneath fails', () => {
  // What the attach handshake calls. It must be incapable of throwing,
  // because its caller is the one place in the host with no catch above it.
  const v = createBugVault({ store: throwingStore(undefined), now: () => 1 });
  let p;
  assert.doesNotThrow(() => { p = v.payload(); });
  assert.ok(Array.isArray(p.bugs));
  assert.ok(p.summary);
});

test('payload() survives a store that throws on READ as well as on write', () => {
  // readState is supposed to classify errors rather than raise them, but the
  // handshake must not depend on that promise being kept by every future
  // store implementation.
  const exploding = {
    readState: () => { throw new Error('boom'); },
    read: () => { throw new Error('boom'); },
    write: () => { throw new Error('boom'); },
  };
  const v = createBugVault({ store: exploding, now: () => 1 });
  let p;
  assert.doesNotThrow(() => { p = v.payload(); });
  assert.deepStrictEqual(p.bugs, []);
  assert.ok(p.summary.error, 'the failure must be reported, not swallowed into an empty vault');
  // Mortimer R12: the shape beside the error was unasserted, so the failure
  // payload could carry fabricated groups into the panel.
  assert.strictEqual(p.summary.total, 0);
  assert.deepStrictEqual(p.summary.byCategory, []);
  assert.deepStrictEqual(p.summary.byDetection, []);
});

test('payload() carries the real vault when everything is working', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  v.add({ category: 'a', summary: 'x', detectedBy: 'measurement' });
  const p = v.payload();
  assert.strictEqual(p.bugs.length, 1);
  assert.strictEqual(p.summary.total, 1);
  assert.strictEqual(p.summary.error, null);
});

test('a write that fails during add is reported as a failure, not as a success', () => {
  const v = createBugVault({ store: throwingStore({ bugs: [] }), now: () => 1 });
  const r = v.add({ category: 'a', summary: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /could not/i);
});

test('a write that fails during setFixed leaves the caller knowing it failed', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  const v2 = createBugVault({ store: throwingStore({ bugs: store.read('x', {}).bugs }), now: () => 1 });
  const r = v2.setFixed(id, true);
  assert.strictEqual(r.ok, false);
});

test('a lock that cannot be taken is a refusal, not an exception', () => {
  // The API must stay TOTAL. Dexter F2 established that, because payload() is
  // called from the attach handshake where nothing catches -- and a lock that
  // throws would walk straight back out through the same hole the F2 fix
  // closed. Found by the concurrent test, where children under parallel load
  // exceeded the lock deadline and crashed rather than reporting a failure.
  const store = {
    ...memStore({ bugs: [] }),
    withLock: () => { throw new Error('could not take the lock on vault.json.lock'); },
  };
  const v = createBugVault({ store, now: () => 1 });
  let r;
  assert.doesNotThrow(() => { r = v.add({ category: 'a', summary: 'x' }); });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /lock/i);
  assert.doesNotThrow(() => v.setFixed('id', true));
  assert.doesNotThrow(() => v.payload());
});

// --- the project a record came from ------------------------------------------
//
// Dexter, PR #29 review, after withdrawing his own per-project finding.
//
// The scope question resolved to INSTALL-WIDE, and it resolved on evidence
// neither review had looked at: four of the six seeds are from the forge
// project, two from this one. Under a per-project vault the feature would ship
// wrong out of the box, and the fix would be deleting two thirds of the seed
// data the author deliberately chose. The seeds are the spec stated in data --
// this tracks ONE ENGINEER'S recurring defect patterns across their work, not
// one codebase's.
//
// So the store stays install-wide. What gets added is attribution, now rather
// than later: install-wide with no project field is the one version of this
// that cannot be reversed without data loss, because once real records from
// several projects are mixed, nothing can tell them apart again. Later it is
// archaeology; today it is one field.

test('a record remembers which project it was filed from', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1, project: 'C:/work/thing' });
  const r = v.add({ category: 'a', summary: 'x' });
  assert.strictEqual(r.record.project, 'C:/work/thing');
});

test('no project configured records null, never a guess and never ""', () => {
  // Absence is not a value. A vault opened outside a project must not claim
  // the records belong to one -- the same rule as every optional field above.
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1 });
  assert.strictEqual(v.add({ category: 'a', summary: 'x' }).record.project, null);
});

test('a blank or whitespace project normalizes to null', () => {
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1, project: '   ' });
  assert.strictEqual(v.add({ category: 'a', summary: 'x' }).record.project, null);
});

test('the caller cannot spoof the project through the record body', () => {
  // `project` is stamped from where the host is RUNNING, not from the frame.
  // A client-supplied value would make the field a claim rather than a fact,
  // and the whole point of recording it is that it is not a claim.
  const v = createBugVault({ store: memStore({ bugs: [] }), now: () => 1, project: 'real' });
  const r = v.add({ category: 'a', summary: 'x', project: 'somewhere else' });
  assert.strictEqual(r.record.project, 'real');
});

test('the seed records carry a null project, because they predate attribution', () => {
  // They are real history from two different projects, recorded before this
  // field existed. Stamping them with whichever project happened to open the
  // vault first would be inventing data -- exactly what this codebase refuses
  // to do everywhere else. Null says "not recorded", which is the truth.
  const v = createBugVault({ store: memStore(undefined), now: () => 1, project: 'C:/work/thing' });
  for (const bug of v.list()) {
    assert.strictEqual(bug.project, null, JSON.stringify(bug.summary));
  }
});

test('marking a bug fixed does not rewrite where it came from', () => {
  const store = memStore({ bugs: [] });
  const v = createBugVault({ store, now: () => 1, project: 'A' });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  const v2 = createBugVault({ store, now: () => 1, project: 'B' });
  assert.strictEqual(v2.setFixed(id, true).record.project, 'A');
});

// --- the seam between the two modules ----------------------------------------
//
// Mortimer, PR #29 mutation gate, R3. Severity: Critical, and the one finding
// he said he would not merge without.
//
// Every test above builds the vault on an in-memory double, and those doubles
// have no `withLock` -- so `locked()` has run UNLOCKED in every single test in
// this file. Every test in test/file-lock.test.js exercises the lock with no
// vault attached. `store.withLock`, which is the entire F3B mechanism, was
// executed by nothing: deleting its whole body left 812 tests passing, and
// node's own coverage confirmed host/store.js:144-147 never ran.
//
// He found it by grepping: `createStore` appeared only in store.test.js,
// `createBugVault` only here, and no test file mentioned both. Two modules
// each tested carefully on their own, and the join between them tested by
// nothing -- which is exactly where the only thing that matters lives.
//
// `STORE_KEY = 'vault' -> ""` surviving is the same root cause from the other
// side: every double ignores the name it is given, so nothing noticed that the
// vault would address the wrong file.

const realDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-'));

test('the vault round-trips through a REAL store, under the real lock', () => {
  const dir = realDir();
  const v = createBugVault({ store: createStore({ dir }), now: () => 1 });
  assert.strictEqual(v.list().length, SEED_BUGS.length, 'seeded on first read');
  assert.strictEqual(v.add({ category: 'a', summary: 'x' }).ok, true);

  // By that NAME. A mutated STORE_KEY writes somewhere else and no double
  // would ever notice.
  assert.ok(fs.existsSync(path.join(dir, 'vault.json')), 'it must write vault.json');

  const reopened = createBugVault({ store: createStore({ dir }), now: () => 1 });
  assert.strictEqual(reopened.list().length, SEED_BUGS.length + 1,
    'and the record must survive a new store, as it would a new process');
  assert.ok(reopened.list().some(b => b.summary === 'x'));
});

test('a real vault leaves no lock file behind', () => {
  // A leaked lock is a vault that refuses every write for the whole stale
  // window, which reads to the user as the feature being broken.
  const dir = realDir();
  const v = createBugVault({ store: createStore({ dir }), now: () => 1 });
  v.add({ category: 'a', summary: 'x' });
  v.setFixed(v.list().find(b => b.summary === 'x').id, true);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.lock')), []);
});

test('marking fixed through a real store survives a reopen', () => {
  const dir = realDir();
  const v = createBugVault({ store: createStore({ dir }), now: () => 1000 });
  const id = v.add({ category: 'a', summary: 'x' }).record.id;
  assert.strictEqual(v.setFixed(id, true).ok, true);
  const reopened = createBugVault({ store: createStore({ dir }), now: () => 1000 });
  const row = reopened.list().find(b => b.id === id);
  assert.strictEqual(row.fixed, true);
  assert.ok(row.fixedAt, 'the recorded date must be on disk, not only in memory');
});

// --- the seed data, pinned to a literal --------------------------------------
//
// Mortimer R2. Severity: Critical (vacuous pass). `SEED_BUGS = []` and three
// tests stayed green: the seeding test asserted `list().length ===
// SEED_BUGS.length` (0 === 0), and two more looped over an empty array. Each
// imported the very constant it was checking, so both sides moved together --
// the tautological-constant trap.
//
// This is the feature's entire day-one content, and, per the scope decision
// recorded on this branch, the evidence that settles whether the vault is
// per-project or install-wide. It was pinned by nothing.

test('the vault ships the earned seed history, not an empty list', () => {
  // A LITERAL floor. It cannot move when the data moves, which is the whole
  // point -- the number is allowed to grow, never to vanish.
  assert.ok(SEED_BUGS.length >= 6, `expected the earned seeds, got ${SEED_BUGS.length}`);

  const v = createBugVault({ store: memStore(undefined), now: () => 1 });
  const bugs = v.list();
  assert.ok(bugs.length >= 6);
  assert.ok(bugs.every(b => b.category && b.summary), 'every seed must be a real record');

  // Recorded as FIXED. Four mutants flipped these to false and nothing
  // noticed: this is history that was already dealt with, and a vault opening
  // with six phantom OPEN bugs would misreport the project on day one.
  assert.ok(SEED_BUGS.every(s => s.fixed === true), 'the seeds are history, and history is fixed');
  assert.ok(bugs.every(b => b.fixed === true));
});

// --- detection breakdown: the phantom bucket and the ordering ----------------
//
// Mortimer R7/R8. Both invisible to the existing tests because they all use
// `rows.find(...)`, and a lookup cannot see an extra row or a wrong position.

test('a vault where every bug has a method gets NO "not recorded" row', () => {
  // R7. `if (unknown)` mutated to `true` always pushes the bucket, so every
  // vault gains a `{ detectedBy: null, count: 0 }` row -- which the display
  // renders as a "not recorded" line reading 0, on a vault where nothing is
  // unrecorded. The absence/zero distinction this feature is built around,
  // inverted: a zero drawn where there is nothing to draw.
  assert.deepStrictEqual(
    detectionBreakdown([{ detectedBy: 'measurement' }, { detectedBy: 'measurement' }]),
    [{ detectedBy: 'measurement', count: 2 }]);
});

test('the unrecorded bucket is always LAST, however many there are', () => {
  // R8. Emptying the `{ unknown++; continue; }` block lets the null key fall
  // into the map instead of the counter. The COUNT still comes out right, so
  // the existing test passes -- but the row is then sorted among the real
  // methods, and `a.detectedBy.localeCompare` throws on the null key whenever
  // two counts tie. The comment says "appended last"; nothing tested position.
  const rows = detectionBreakdown([
    { detectedBy: null }, { detectedBy: null }, { detectedBy: null },
    { detectedBy: 'measurement' },
  ]);
  assert.strictEqual(rows[rows.length - 1].detectedBy, null);
  assert.strictEqual(rows[0].detectedBy, 'measurement',
    'a real method outranks the unknown bucket even with fewer bugs');
});

test('methods with equal counts sort alphabetically, not by insertion order', () => {
  assert.deepStrictEqual(
    detectionBreakdown([{ detectedBy: 'reading' }, { detectedBy: 'measurement' }])
      .map(r => r.detectedBy), ['measurement', 'reading']);
});

test('detectionBreakdown tolerates a malformed list, like groupByCategory does', () => {
  assert.deepStrictEqual(detectionBreakdown(null), []);
  assert.deepStrictEqual(detectionBreakdown('nonsense'), []);
});

test('a non-string category is skipped rather than thrown on', () => {
  // A truthy non-string reaches localeCompare and throws mid-render.
  assert.deepStrictEqual(groupByCategory([{ category: 123 }, { category: {} }]), []);
});

// --- fields that were never asserted to survive the trip ---------------------

test('every recorded field is trimmed and round-trips, including the two nobody checked', () => {
  // Mortimer R9. createRecord could DROP `survived` and `wouldHaveCaught`
  // entirely and every test passed. Note which two survived: `whereFound` and
  // `detectedBy` are pinned by other tests, and precisely the two fields
  // nothing asserted are the two that were free to vanish. "What would have
  // caught it" is arguably the most valuable field in the feature.
  const r = createRecord({
    category: ' c ', summary: ' s ', whereFound: ' w ',
    detectedBy: ' d ', survived: ' v ', wouldHaveCaught: ' g ',
  });
  assert.deepStrictEqual(
    [r.record.category, r.record.summary, r.record.whereFound,
     r.record.detectedBy, r.record.survived, r.record.wouldHaveCaught],
    ['c', 's', 'w', 'd', 'v', 'g']);
});

test('a caller-supplied foundAt and fixedAt are honoured verbatim', () => {
  // Mortimer R10. Every test let both default, so the override path -- the
  // import and edit case -- was exercised by nothing.
  const r = createRecord({
    category: 'x', summary: 'y',
    foundAt: '2020-01-01T00:00:00.000Z',
    fixed: true, fixedAt: '2020-02-02T00:00:00.000Z',
  }, { now: () => 999 });
  assert.strictEqual(r.record.foundAt, '2020-01-01T00:00:00.000Z');
  assert.strictEqual(r.record.fixedAt, '2020-02-02T00:00:00.000Z');
});

test('a blank foundAt falls back to now rather than being stored as blank', () => {
  const r = createRecord({ category: 'x', summary: 'y', foundAt: '   ' }, { now: () => 0 });
  assert.strictEqual(r.record.foundAt, new Date(0).toISOString());
});

test('ids sort in creation order, which is what the comment promises', () => {
  // Mortimer: `seq++ -> seq--` keeps ids UNIQUE, so the uniqueness test passes
  // while "sorts roughly by creation order" quietly stops being true.
  const at = () => 1000;
  const ids = [createRecord({ category: 'a', summary: '1' }, { now: at }).record.id,
               createRecord({ category: 'a', summary: '2' }, { now: at }).record.id,
               createRecord({ category: 'a', summary: '3' }, { now: at }).record.id];
  assert.deepStrictEqual([...ids].sort(), ids, 'ids made at one instant must sort in creation order');
});

test('the seeded vault uses the injected clock, not the wall clock', () => {
  // Mortimer: `createRecord(s, { now })` -> `createRecord(s, {})` and nothing
  // noticed, so seed timestamps were untestable by construction.
  const v = createBugVault({ store: memStore(undefined), now: () => 0 });
  assert.ok(v.list().every(b => b.foundAt === new Date(0).toISOString()));
});
