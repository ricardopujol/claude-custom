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
  // Kills: `(r && r.failed) || []` -> `[]`, and -> `r`. Dexter F3: these are
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
  const svc = svcWith({ removeKey: () => ({ ok: 'yes', failed: [] }) });
  assert.strictEqual(svcWith({ removeKey: () => ({ ok: 'yes' }) }).removeKey().ok, true);
  assert.strictEqual(svc.removeKey().ok, true);
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
