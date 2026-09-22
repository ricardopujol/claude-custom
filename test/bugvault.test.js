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

const {
  createRecord, groupByCategory, detectionBreakdown, createBugVault, applyVaultAction, SEED_BUGS,
} = require('../host/bugvault');

function memStore(initial) {
  let data = initial;
  return {
    read: (_name, fallback) => (data === undefined ? fallback : data),
    write: (_name, value) => { data = value; },
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
