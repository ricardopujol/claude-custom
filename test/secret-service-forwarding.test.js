'use strict';
/**
 * What the service does with what the vault hands back.
 *
 * WHY THIS FILE EXISTS: `app/secret-service.js` came out of PR #42's mutation
 * run at 51.9% -- 100 surviving mutants of 208, the worst file in scope by a
 * wide margin, against 14 of 19 files at 100%. Every survivor sat on the
 * defensive forwarding the lock added: `(r && r.failed) || []` and friends.
 *
 * Nothing there was WRONG. It was unobserved. The existing fake in
 * `secret-ipc.test.js` always returns a well-formed `r`, so the `r &&` guard,
 * the `|| []` fallback and the `!!` coercion are never the branch that runs --
 * and a mutant that deletes them changes nothing any test can see. Deleting the
 * whole guard leaves the suite green.
 *
 * That matters more here than in most files, because this is the IPC boundary.
 * The service's stated job is "to be the one place that catches a throw and
 * turns it into something the renderer can render, because an unhandled
 * rejection across the bridge shows the user nothing at all." A guard that
 * silently stops guarding does not fail loudly; the window just goes blank.
 *
 * So the fakes below return what a well-formed vault never does: `undefined`,
 * `{}`, a truthy non-boolean, an `ok: false` that still carries data the user
 * needs. Each test names the mutant it kills, because a test written against a
 * survivor and not a behaviour is how you get 208 mutants and no assertions.
 *
 * THE TWO CLASSES THE FORWARDING PROTECTS, both from Dexter's PR #42 rounds:
 *   - `failed` / `leftovers` -- secrets that survived an operation but did not
 *     move, and copies melt could not delete. Only the user can act on them, so
 *     dropping the array is worse than throwing.
 *   - `preserved` -- the damaged vault moved aside. "A copy nobody can find is
 *     the same as no copy."
 */
const test = require('node:test');
const assert = require('node:assert');

const { createSecretService } = require('../app/secret-service');

// A vault that answers exactly what a test tells it to, and nothing else.
// Deliberately NOT the rich fake in secret-ipc.test.js: that one is well-formed
// by construction, which is precisely the property that hid these mutants.
function svcWith(vaultOverrides = {}) {
  const vault = {
    available: () => true,
    list: () => [],
    add: () => ({ id: 'id0', label: 'k', note: '', createdAt: 0 }),
    get: () => null,
    remove: () => true,
    lockState: () => ({ hasKey: false, locked: false, count: 0 }),
    setKey: () => ({ ok: true, failed: [] }),
    unlock: () => ({ ok: true }),
    lock: () => true,
    removeKey: () => ({ ok: true, failed: [] }),
    melt: () => ({ ok: true, leftovers: [], preserved: null }),
    ...vaultOverrides,
  };
  return createSecretService({
    project: 'C:/work/test-project',
    vault,
    clipboard: { writeText: () => {}, readText: () => '', clear: () => {} },
  });
}

// --- setKey -----------------------------------------------------------------
// Survivors at app/secret-service.js:78 -- `{ ok: true, failed: (r && r.failed) || [] }`

test('setKey FORWARDS the entries a rekey could not carry', () => {
  // Kills any mutant that replaces `(r && r.failed) || []` with a constant `[]`,
  // and any that forwards `r` itself instead of `r.failed`. Dexter F3: these are
  // secrets that survived but did not move, and the user is the only one who
  // can decide what to do about them. An empty array here is a lie that loses
  // them silently -- the rekey reports total success and some entries are now
  // wrapped under the old key with nothing saying so.
  const svc = svcWith({ setKey: () => ({ ok: true, failed: [{ id: 'a', label: 'stripe' }] }) });
  const res = svc.setKey('pw');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.failed, [{ id: 'a', label: 'stripe' }]);
});

test('setKey survives a vault that returns NOTHING', () => {
  // Kills: `r && r.failed` -> `r.failed` (TypeError on undefined), and the
  // `r &&` guard's removal generally. The service must not throw across the
  // bridge no matter what the vault hands it.
  const svc = svcWith({ setKey: () => undefined });
  const res = svc.setKey('pw');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.failed, []);
});

test('setKey defaults `failed` to an ARRAY, never undefined', () => {
  // Kills: removal of `|| []`. The renderer iterates this; `undefined.length`
  // is a blank panel, not an error message.
  const svc = svcWith({ setKey: () => ({ ok: true }) });
  assert.deepStrictEqual(svc.setKey('pw').failed, []);
  assert.ok(Array.isArray(svc.setKey('pw').failed));
});

test('setKey reports a throw as an error, not as success', () => {
  // Kills: `ok: true` -> `ok: false` in the happy path is killed above; this
  // kills the catch arm's `ok: false` -> `ok: true` and drops of `err.message`.
  const svc = svcWith({ setKey: () => { throw new Error('scrypt refused'); } });
  const res = svc.setKey('pw');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'scrypt refused');
});

// --- removeKey --------------------------------------------------------------
// Survivors at app/secret-service.js:104 -- `{ ok: !!(r && r.ok), failed: (r && r.failed) || [] }`

test('removeKey carries `failed` EVEN WHEN it reports failure', () => {
  // Kills: any mutant that ties `failed` to `ok`, and `(r && r.failed) || []`
  // -> `[]`. This is the combination the shape exists for: the operation did
  // not fully succeed AND there are entries the user must be told about. A
  // failure that also drops the list leaves them with neither outcome nor
  // remedy.
  const svc = svcWith({ removeKey: () => ({ ok: false, failed: [{ id: 'b' }] }) });
  const res = svc.removeKey();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.failed, [{ id: 'b' }]);
});

test('removeKey COERCES a truthy non-boolean to true', () => {
  // Kills: removal of `!!`. Without it `ok` is whatever the vault put there,
  // and the renderer's `res.ok === true` then reads false for a string that
  // means yes -- an operation that worked, reported as failed.
  // Both shapes, because `failed` being present or absent must not change how
  // `ok` is read -- the two fields are forwarded independently.
  assert.strictEqual(svcWith({ removeKey: () => ({ ok: 'yes', failed: [] }) }).removeKey().ok, true);
  assert.strictEqual(svcWith({ removeKey: () => ({ ok: 'yes' }) }).removeKey().ok, true);
});

test('removeKey FAILS CLOSED on a vault that returns nothing', () => {
  // Kills: `!!(r && r.ok)` -> `!!(r || r.ok)` / -> `true`. An unknown outcome
  // must not render as "the key is gone", which is the one thing that would
  // stop the user retrying.
  const svc = svcWith({ removeKey: () => undefined });
  const res = svc.removeKey();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.failed, []);
});

// --- melt -------------------------------------------------------------------
// Survivors at app/secret-service.js:118-120 -- the three-way forward.

test('melt FORWARDS leftovers and preserved together', () => {
  // Kills: `(r && r.leftovers) || []` -> `[]`, `(r && r.preserved) || null`
  // -> `null`. Both are the branch's whole point (Dexter F2 and H2): the vault
  // IS gone so melt succeeded, but the promise the user was shown -- no backup,
  // no recovery -- is not true until the leftovers are gone too, and the
  // preserved copy is unreachable unless its path reaches the window.
  const svc = svcWith({
    melt: () => ({ ok: true, leftovers: [{ path: 'C:/v/tmp-1', why: 'EBUSY' }],
                   preserved: 'C:/v/secrets.enc.damaged-1700000000000' }),
  });
  const res = svc.melt();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.leftovers, [{ path: 'C:/v/tmp-1', why: 'EBUSY' }]);
  assert.strictEqual(res.preserved, 'C:/v/secrets.enc.damaged-1700000000000');
});

test('melt distinguishes a REPORTED failure from a thrown one', () => {
  // Kills: `r.ok === false` -> `r.ok !== false`, and the whole `if` line's
  // removal. A vault that says `{ok: false, error}` has not melted anything;
  // routing it into the success arm would tell the user their secrets are
  // destroyed when they are not.
  const svc = svcWith({ melt: () => ({ ok: false, error: 'could not move the damaged vault aside' }) });
  const res = svc.melt();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'could not move the damaged vault aside');
});

test('melt uses `=== false`, so a FALSY-BUT-NOT-FALSE ok is not the error arm', () => {
  // Kills: `r.ok === false` -> `!r.ok`. `{ok: undefined}` is an unknown
  // outcome, not a reported failure, and must fall through to the fail-closed
  // arm below rather than fabricate an `error` the vault never gave.
  const svc = svcWith({ melt: () => ({ ok: undefined, leftovers: [], preserved: null }) });
  const res = svc.melt();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, undefined);
  assert.deepStrictEqual(res.leftovers, []);
});

test('melt defaults leftovers to [] and preserved to NULL, not to each other', () => {
  // Kills: `|| null` -> `|| []` and `|| []` -> `|| null`. The renderer counts
  // leftovers and path-checks preserved; swapping the empty values makes one of
  // them silently untestable at the other end.
  const svc = svcWith({ melt: () => ({ ok: true }) });
  const res = svc.melt();
  assert.deepStrictEqual(res.leftovers, []);
  assert.strictEqual(res.preserved, null);
});

test('melt survives a vault that returns NOTHING, and fails closed', () => {
  // Kills: every `r &&` guard in the three-way forward at once.
  const svc = svcWith({ melt: () => undefined });
  const res = svc.melt();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.leftovers, []);
  assert.strictEqual(res.preserved, null);
});

// --- unlock -----------------------------------------------------------------
// THREE outcomes, not two (Dexter F1).

test('unlock reports a DAMAGED header as damaged, never as a wrong key', () => {
  // Kills: removal of the `r.damaged` line, and its reorder below the
  // wrongKey return. This is F1 and it is the most consequential mutant in the
  // file: the panel's only other offer is melt, and melting a vault whose
  // header is damaged destroys secrets still wrapped under a key the user may
  // well have. "Wrong key" is the message that makes them press it.
  const svc = svcWith({ unlock: () => ({ ok: false, damaged: true, error: 'lock header unreadable' }) });
  const res = svc.unlock('pw');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.damaged, true);
  assert.strictEqual(res.error, 'lock header unreadable');
  assert.notStrictEqual(res.wrongKey, true);
});

test('unlock reports a wrong key as wrongKey, and NOT as damaged', () => {
  // Kills: `damaged: true` leaking into the third arm, and `wrongKey` drops.
  const svc = svcWith({ unlock: () => ({ ok: false, wrongKey: true }) });
  const res = svc.unlock('nope');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.wrongKey, true);
  assert.notStrictEqual(res.damaged, true);
});

test('unlock takes the OK arm first, even when the vault sets both flags', () => {
  // Kills: reordering the `r.ok` and `r.damaged` checks. A vault that answers
  // `{ok: true, damaged: true}` has opened -- the damage is a note about the
  // file, not a refusal -- so an order swap would lock out a user holding the
  // right key.
  const svc = svcWith({ unlock: () => ({ ok: true, damaged: true }) });
  const res = svc.unlock('right');
  assert.strictEqual(res.ok, true);
  assert.notStrictEqual(res.damaged, true);
});

test('unlock FAILS CLOSED on a vault that returns nothing', () => {
  // Kills: `r && r.ok` -> `r.ok` (TypeError) and -> `true`. An unknown outcome
  // must never open the panel.
  const svc = svcWith({ unlock: () => undefined });
  const res = svc.unlock('pw');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.wrongKey, true);
});

test('unlock turns a throw into an error, with no wrongKey claim', () => {
  // Kills: the catch arm. A crash is not evidence about the key, and telling
  // the user their password was wrong when the file was unreadable sends them
  // to melt for the second time in this file.
  const svc = svcWith({ unlock: () => { throw new Error('EACCES'); } });
  const res = svc.unlock('pw');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'EACCES');
  assert.notStrictEqual(res.wrongKey, true);
});

// --- lock -------------------------------------------------------------------

test('lock requires a LITERAL true from the vault', () => {
  // Kills: `vault.lock() === true` -> truthiness. The vault's contract is a
  // boolean; anything else is a vault that did something else, and reporting
  // "locked" for it leaves secrets readable behind a panel that says they are
  // not. Fail-closed applies in this direction too.
  assert.strictEqual(svcWith({ lock: () => true }).lock().ok, true);
  assert.strictEqual(svcWith({ lock: () => 'true' }).lock().ok, false);
  assert.strictEqual(svcWith({ lock: () => 1 }).lock().ok, false);
  assert.strictEqual(svcWith({ lock: () => undefined }).lock().ok, false);
});

test('lock reports a throw as an error', () => {
  const svc = svcWith({ lock: () => { throw new Error('vault busy'); } });
  const res = svc.lock();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'vault busy');
});

// --- lockState --------------------------------------------------------------

test('lockState FAILS CLOSED with count NULL, not zero', () => {
  // Kills: each of the three literals in the catch arm independently.
  //
  // `count: null` is load-bearing and is this repo's named trap: `Number(null)`
  // is `0`, so a coercing display turns "we could not determine the state" into
  // a confident "this vault holds 0 secrets". The catch must say "unknown", and
  // `hasKey: true, locked: true` is the LEAST permissive of the four states --
  // the permissive default here once rendered `open-no-key` plus the note
  // "anyone at this machine can read the vault", about a vault whose state had
  // just failed to be determined (Dexter F6 / Miguel A2, found independently).
  const svc = svcWith({ lockState: () => { throw new Error('read failed'); } });
  const res = svc.lockState();
  assert.strictEqual(res.hasKey, true);
  assert.strictEqual(res.locked, true);
  assert.strictEqual(res.count, null);
  assert.notStrictEqual(res.count, 0);
});

test('lockState passes a healthy state through UNCHANGED', () => {
  // Kills: a catch arm that swallows the success path, and any rewriting of the
  // vault's own answer on the way out.
  const state = { hasKey: true, locked: false, count: 7 };
  assert.deepStrictEqual(svcWith({ lockState: () => state }).lockState(), state);
});

// --- available --------------------------------------------------------------

test('available coerces and fails closed', () => {
  // Kills: removal of `!!` and of the catch. `available()` gates the whole
  // panel; an exception here must read as "no vault", not crash the bridge.
  assert.strictEqual(svcWith({ available: () => 1 }).available(), true);
  assert.strictEqual(svcWith({ available: () => undefined }).available(), false);
  assert.strictEqual(svcWith({ available: () => { throw new Error('x'); } }).available(), false);
});

// --- remove -----------------------------------------------------------------

test('remove coerces the vault answer and reports a throw', () => {
  // Kills: removal of `!!` in `{ ok: !!vault.remove(...) }`, and the catch arm.
  assert.strictEqual(svcWith({ remove: () => 'deleted' }).remove('id0').ok, true);
  assert.strictEqual(svcWith({ remove: () => false }).remove('id0').ok, false);
  const thrown = svcWith({ remove: () => { throw new Error('locked file'); } }).remove('id0');
  assert.strictEqual(thrown.ok, false);
  assert.strictEqual(thrown.error, 'locked file');
});

// --- list -------------------------------------------------------------------

test('list returns an ARRAY when the vault throws', () => {
  // Kills: the catch arm's `[]`. The renderer maps this; a non-array is a
  // blank panel with no error, which is the failure mode this whole file is
  // about.
  const svc = svcWith({ list: () => { throw new Error('unreadable'); } });
  const res = svc.list();
  assert.ok(Array.isArray(res));
  assert.deepStrictEqual(res, []);
});

// =============================================================================
// KILLS FOR MUTATION SURVIVORS (Mortimer, PR #73).
//
// The first two survivor clusters above were forwarding guards; these are the
// rest of the file, which the forwarding pass never reached: the constructor's
// refusals, removeKey/melt's catch arms, list()'s query handling, add/reveal/copy
// results, and the clipboard timer's bookkeeping. The mutants left alive on
// purpose, and why, are in the build log.
// =============================================================================

const GOOD_CLIPBOARD = { writeText: () => {}, readText: () => '', clear: () => {} };

// --- the constructor refuses to exist half-built -------------------------------

test('the constructor refuses a missing vault, and says which thing is missing', () => {
  // Kills `!vault` -> false and its message literal. The message is matched by
  // its distinguishing words (not verbatim) so the guard that fired is proven
  // without pinning the punctuation.
  assert.throws(() => createSecretService({ clipboard: GOOD_CLIPBOARD, project: 'p' }),
    /vault is required/);
  assert.throws(() => createSecretService({ vault: null, clipboard: GOOD_CLIPBOARD, project: 'p' }),
    /vault is required/);
});

test('the constructor refuses a missing clipboard', () => {
  // Kills `!clipboard` -> false and its message literal.
  assert.throws(() => createSecretService({ vault: {}, project: 'p' }), /clipboard is required/);
});

test('the constructor refuses a missing, blank or non-string project', () => {
  // Dexter, PR #40, Finding 1: a default project is a silent grant. Kills
  // `typeof project !== 'string' || !project.trim()` -> false, `||` -> `&&`
  // (blank strings and numbers would sail through, or throw a TypeError instead
  // of the refusal), `project.trim()` -> `project` (whitespace would count as a
  // project), each half on its own, the emptied throw block, and the message.
  for (const bad of [undefined, null, '', '   ', '\t\n', 42, {}, ['p'], true]) {
    assert.throws(
      () => createSecretService({ vault: {}, clipboard: GOOD_CLIPBOARD, project: bad }),
      /project is required/,
      `project ${JSON.stringify(bad)} must be refused with the project message`);
  }
  assert.throws(() => createSecretService({ vault: {}, clipboard: GOOD_CLIPBOARD }), /project is required/);
  assert.throws(() => createSecretService(), /vault is required/);
});

test('a well-formed construction does not throw', () => {
  // The other side of every refusal above: a guard mutated to always fire.
  assert.doesNotThrow(() => createSecretService({ vault: {}, clipboard: GOOD_CLIPBOARD, project: ' p ' }));
});

// --- removeKey and melt report a throw -----------------------------------------

test('removeKey reports a throw as an error, not as success', () => {
  // Kills removeKey's catch arm: emptied block, `{}` for the object, and
  // `ok: false` -> `ok: true`. setKey/unlock/lock/remove each had this pinned;
  // removeKey never did, and it is the operation that DELETES the user's key.
  const svc = svcWith({ removeKey: () => { throw new Error('key file locked'); } });
  // ok and error only: extra fields (failed, leftovers) are harmless and the
  // renderer already reads them (Dexter, PR #73 F5).
  const r = svc.removeKey();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'key file locked');
});

test('melt reports a throw as an error, not as success', () => {
  // Kills melt's catch arm the same three ways. A melt that throws has not
  // destroyed the vault; saying `ok: true` here tells the user it is gone.
  const svc = svcWith({ melt: () => { throw new Error('vault busy'); } });
  const r = svc.melt();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'vault busy');
});

// --- list(): the query ---------------------------------------------------------

const ENTRIES = [
  { id: '1', label: 'GitHub Token', note: 'Deploy Key for CI' },
  { id: '2', label: 'stripe', note: '' },
  { id: '3', label: 'npm' },                     // no note at all
  { id: '4', note: 'orphan note' },              // no label at all
];
const ids = (svc, q) => svc.list(q).map(e => e.id);

test('list with no query returns every entry, with or without an options object', () => {
  // Kills `String(query || '')`'s '' literal -> "Stryker was here!": an absent
  // query would be searched for as that text and return nothing at all.
  const svc = svcWith({ list: () => ENTRIES });
  assert.deepStrictEqual(ids(svc), ['1', '2', '3', '4']);
  assert.deepStrictEqual(ids(svc, {}), ['1', '2', '3', '4']);
  assert.deepStrictEqual(ids(svc, { query: '' }), ['1', '2', '3', '4']);
  assert.deepStrictEqual(ids(svc, { query: '   ' }), ['1', '2', '3', '4']);
});

test('a query is trimmed before it is matched', () => {
  // Kills `.trim()` removal: padding from a paste or a stray space would
  // otherwise match nothing.
  const svc = svcWith({ list: () => ENTRIES });
  assert.deepStrictEqual(ids(svc, { query: '  github  ' }), ['1']);
});

test('a query matches the NOTE, case-insensitively', () => {
  // Kills `String(e.note || '').toLowerCase()` -> toUpperCase (a mixed-case note
  // could never match a lower-cased query), and `e.note || ''` -> true / false /
  // `e.note && ''` (each of which stops the note from ever being searched).
  const svc = svcWith({ list: () => ENTRIES });
  assert.deepStrictEqual(ids(svc, { query: 'deploy key' }), ['1']);
  assert.deepStrictEqual(ids(svc, { query: 'DEPLOY' }), ['1']);
  assert.deepStrictEqual(ids(svc, { query: 'orphan' }), ['4']);
});

test('a missing label or note is empty text, not the word "undefined" or a placeholder', () => {
  // Kills both `''` fallbacks -> "Stryker was here!", and `e.note && ''`, which
  // stringifies an absent note to "undefined". Entries 3 and 4 each lack one
  // field; none of these queries may match them through the missing field.
  const svc = svcWith({ list: () => ENTRIES });
  assert.deepStrictEqual(ids(svc, { query: 'undefined' }), []);
  assert.deepStrictEqual(ids(svc, { query: 'stryker' }), []);
  assert.deepStrictEqual(ids(svc, { query: 'was here' }), []);
  assert.deepStrictEqual(ids(svc, { query: 'false' }), []);
  assert.deepStrictEqual(ids(svc, { query: 'true' }), []);
});

// --- add / reveal / copy results -----------------------------------------------

test('add reports ok:true and hands back the vault entry untouched', () => {
  // Kills `ok: true` -> false in add's success arm. Every existing add test read
  // `.entry` and never looked at `.ok`, so the panel's success/failure switch
  // was unobserved.
  const entry = { id: 'x1', label: 'k', note: 'n', createdAt: 5 };
  const svc = svcWith({ add: () => entry });
  const res = svc.add({ label: 'k', secret: 's' });
  assert.strictEqual(res.ok, true);
  // Its content, not its identity: a hardening that returns a safe copy of the
  // entry is not a behaviour change (Dexter, PR #73 F4).
  assert.deepStrictEqual(res.entry, entry);
});

test('reveal of something the vault does not have is a failure, not an ok with no secret', () => {
  // Kills `secret == null` -> false (returns ok:true with secret:null, which the
  // window renders as a successfully revealed empty value), the `{}` object, the
  // `ok: false` flip, and the message literal. `undefined` counts as absent too.
  for (const missing of [null, undefined]) {
    const svc = svcWith({ get: () => missing });
    const r = svc.reveal('nope');
    assert.strictEqual(r.ok, false);
    assert.ok(!('secret' in r) || r.secret == null, 'no secret rides along with a failure');
    // Matched by phrase, not verbatim: a copy edit is not a failure (Dexter, PR #73 F6).
    assert.match(r.error, /not found/);
  }
});

test('reveal of a found secret is exactly { ok: true, secret }', () => {
  // Kills the success arm's `ok: true` -> false.
  const svc = svcWith({ get: () => 'sk-live-123' });
  assert.deepStrictEqual(svc.reveal('id0'), { ok: true, secret: 'sk-live-123' });
});

test('copy of something the vault does not have says why, and touches nothing', () => {
  // Kills copy's message literal. Also pins that a miss neither writes to the
  // clipboard nor schedules a wipe.
  const calls = [];
  const svc = createSecretService({
    project: 'p',
    vault: { get: () => null },
    clipboard: { writeText: () => calls.push('write'), readText: () => '', clear: () => calls.push('clear') },
    setTimer: () => { calls.push('timer'); return 1; },
  });
  const r = svc.copy('nope');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/);
  assert.deepStrictEqual(calls, []);
});

// --- the clipboard timer -------------------------------------------------------

// A service whose timer and clipboard are fully observable.
function copySvc({ handleFor } = {}) {
  const log = { cleared: [], scheduled: [], cbClear: 0, unref: [] };
  const clip = { value: '' };
  const svc = createSecretService({
    project: 'p',
    vault: { get: (id) => (id === 'none' ? null : 'secret-' + id) },
    clipboard: {
      writeText: (t) => { clip.value = t; },
      readText: () => clip.value,
      clear: () => { log.cbClear += 1; clip.value = ''; },
    },
    setTimer: (fn, ms) => {
      const n = log.scheduled.length + 1;
      log.scheduled.push({ fn, ms, n });
      return handleFor ? handleFor(n, log) : n;
    },
    clearTimer: (h) => log.cleared.push(h),
    clearAfterMs: 1234,
  });
  return { svc, log, clip };
}

test('the FIRST copy cancels nothing; the second cancels exactly the first timer', () => {
  // Kills `if (pendingClear !== null)` -> true (clearTimer(null) on the first
  // copy) and `!==` -> `===` (the first copy cancels null and the second cancels
  // nothing, so the first timer wipes the second secret early). The existing
  // test only asserted `cleared.length >= 1`, which both mutants satisfy.
  const { svc, log } = copySvc();
  svc.copy('a');
  assert.deepStrictEqual(log.cleared, [], 'nothing to cancel on the first copy');
  svc.copy('b');
  assert.deepStrictEqual(log.cleared, [1], 'the second copy cancels the first timer, and only it');
  svc.copy('c');
  assert.deepStrictEqual(log.cleared, [1, 2]);
});

test('once a timer has fired, the next copy has nothing left to cancel', () => {
  // Pins `pendingClear = null` in the timer callback: cancelling a handle that
  // already fired is harmless in Node but is a stale reference kept alive.
  const { svc, log } = copySvc();
  svc.copy('a');
  log.scheduled[0].fn();
  svc.copy('b');
  assert.deepStrictEqual(log.cleared, []);
});

test('the timer is scheduled for the configured delay, and reported back', () => {
  const { svc, log } = copySvc();
  assert.deepStrictEqual(svc.copy('a'), { ok: true, clearsInMs: 1234 });
  assert.strictEqual(log.scheduled[0].ms, 1234);
});

test('the wipe timer is unref\'d, so it cannot keep the app alive', () => {
  // Kills every mutant on the unref guard: `handle && typeof handle.unref ===
  // 'function'` -> false, `===` -> `!==`, the 'function' literal, and deleting
  // `handle.unref()`. Before this they were only ever caught as timeouts; this
  // pins the behaviour itself: the handle is unref'd exactly once.
  const unrefd = [];
  const { svc } = copySvc({ handleFor: (n) => ({ n, unref() { unrefd.push(n); return this; } }) });
  svc.copy('a');
  assert.deepStrictEqual(unrefd, [1], 'the handle must be unref\'d exactly once');
});

test('a timer handle with no unref (a browser number, or nothing) does not break copy', () => {
  // The guard's other half: `typeof handle.unref === 'function'` must be checked,
  // not assumed. Kills `!==` (it would call `1.unref()`) and dropping the guard.
  for (const handle of [7, null, undefined, {}, { unref: 'no' }]) {
    const { svc } = copySvc({ handleFor: () => handle });
    assert.deepStrictEqual(svc.copy('a'), { ok: true, clearsInMs: 1234 });
  }
});

test('the wipe clears what we copied, and leaves anything the user copied since', () => {
  const { svc, log, clip } = copySvc();
  svc.copy('a');
  log.scheduled[0].fn();
  assert.strictEqual(log.cbClear, 1);
  assert.strictEqual(clip.value, '');

  svc.copy('b');
  clip.value = 'the user copied this meanwhile';
  log.scheduled[1].fn();
  assert.strictEqual(log.cbClear, 1, 'must not clear someone else\'s clipboard');
  assert.strictEqual(clip.value, 'the user copied this meanwhile');
});

// --- visibility scopes (worktree tabs, PR 2) ---------------------------------
// A tab window's secrets are ADDED under the state root but SEEN from the state
// root AND the project root, where entries saved before the 2026-09-28 layout
// move are scoped. `project` stays the single add-scope.

function scopedService(extra) {
  const seen = { list: [], add: [], get: [], remove: [] };
  const vault = {
    available: () => true,
    list: (o) => { seen.list.push(o); return []; },
    add: (e) => { seen.add.push(e); return { id: 'a', label: 'l', note: '', createdAt: 0 }; },
    get: (id, o) => { seen.get.push(o); return 's'; },
    remove: (id, o) => { seen.remove.push(o); return true; },
  };
  const svc = createSecretService({
    project: 'C:/p/dev', vault, ...extra,
    clipboard: { writeText: () => {}, readText: () => '', clear: () => {} },
  });
  return { svc, seen };
}

test('with scopes, list/get/remove see project AND every scope, but add uses ONE path', () => {
  const { svc, seen } = scopedService({ scopes: ['C:/p'] });
  svc.list();
  svc.reveal('x');
  svc.copy('x');
  svc.remove('x');
  svc.add({ label: 'k', secret: 's' });
  assert.deepStrictEqual(seen.list, [{ project: ['C:/p/dev', 'C:/p'] }]);
  assert.deepStrictEqual(seen.get, [{ project: ['C:/p/dev', 'C:/p'] }, { project: ['C:/p/dev', 'C:/p'] }]);
  assert.deepStrictEqual(seen.remove, [{ project: ['C:/p/dev', 'C:/p'] }]);
  assert.strictEqual(seen.add[0].project, 'C:/p/dev', 'add must receive exactly one path');
});

test('without scopes (or with none usable) the service behaves exactly as before: one path', () => {
  for (const scopes of [undefined, [], ['', '   ', 7, null]]) {
    const { svc, seen } = scopedService({ scopes });
    svc.list();
    svc.reveal('x');
    svc.remove('x');
    assert.deepStrictEqual(seen.list, [{ project: 'C:/p/dev' }], JSON.stringify(scopes));
    assert.deepStrictEqual(seen.get, [{ project: 'C:/p/dev' }], JSON.stringify(scopes));
    assert.deepStrictEqual(seen.remove, [{ project: 'C:/p/dev' }], JSON.stringify(scopes));
  }
});

test('PROPERTY: an entry scoped to root or dev is visible to every tab of its project and to no other project', () => {
  const fc = require('fast-check');
  const path = require('path');
  const { createVault } = require('../app/secret-vault');
  const dir = require('./tmp-dir').tmpDir('cc-scope-prop-');
  try {
    const crypto = { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8') };
    const seg = fc.stringMatching(/^[a-z]{1,6}$/);
    fc.assert(fc.property(seg, seg, seg, (a, b, c) => {
      fc.pre(a !== b);
      const rootA = `C:/${a}/${c}`; const devA = `${rootA}/dev`;
      const rootB = `C:/${b}/${c}`; const devB = `${rootB}/dev`;
      const vault = createVault({ file: path.join(dir, `v-${a}-${b}-${c}.enc`), crypto });
      const mk = (project) => createSecretService({
        project, scopes: [project === devA ? rootA : rootB], vault,
        clipboard: { writeText: () => {}, readText: () => '', clear: () => {} },
      });
      // Saved under the OLD layout (scoped to the container root) and the new (dev).
      vault.add({ label: 'old', secret: 'x', project: rootA });
      vault.add({ label: 'new', secret: 'y', project: devA });
      const inA = mk(devA).list().map(e => e.label).sort();
      const inB = mk(devB).list().map(e => e.label);
      return JSON.stringify(inA) === JSON.stringify(['new', 'old']) && inB.length === 0;
    }), { numRuns: 25 });
  } finally {
    require('./tmp-dir').cleanup();
  }
});
