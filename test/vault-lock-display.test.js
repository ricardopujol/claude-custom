'use strict';
/**
 * What the vault lock panel draws. Four states, one of them destructive.
 *
 * The state that matters most is the one where the answer is not known yet: a
 * lock panel must never draw "open" while it is still asking, because that
 * offers to reveal a vault it knows nothing about.
 */
const test = require('node:test');
const assert = require('node:assert');

const { vaultLockDisplay } = require('../app/vault-lock-display');

test('a vault with no key says so, plainly', () => {
  const d = vaultLockDisplay({ hasKey: false, locked: false });
  assert.strictEqual(d.state, 'open-no-key');
  assert.strictEqual(d.canSetKey, true);
  assert.strictEqual(d.showList, true);
  assert.match(d.note, /anyone at this machine/i,
    'the default is not protection, and must not read like it is');
});

test('an unlocked vault with a key says it will relock on restart', () => {
  // Ricardo chose the real lock knowing it re-asks each launch. The panel has
  // to set that expectation, or the first restart reads as a bug.
  const d = vaultLockDisplay({ hasKey: true, locked: false });
  assert.strictEqual(d.state, 'open-with-key');
  assert.strictEqual(d.canLock, true);
  assert.strictEqual(d.canRemoveKey, true);
  assert.strictEqual(d.showList, true);
  assert.match(d.note, /restart/i);
});

test('a locked vault offers unlock and melt, and shows no list', () => {
  const d = vaultLockDisplay({ hasKey: true, locked: true });
  assert.strictEqual(d.state, 'locked');
  assert.strictEqual(d.canUnlock, true);
  assert.strictEqual(d.canMelt, true);
  assert.strictEqual(d.showList, false, 'a locked vault shows nothing, labels included');
  assert.notStrictEqual(d.canLock, true);
  assert.notStrictEqual(d.canRemoveKey, true,
    'the key cannot be destroyed from the locked side, or the lock is a formality');
});

test('AN UNKNOWN STATE IS LOCKED, never open', () => {
  // The fail-closed direction, and the reason this function takes the state
  // rather than deciding it. Before main answers, `lockState()` has not
  // returned; drawing "open" then would offer to reveal a vault whose status
  // is unknown. Absence is not permission.
  for (const unknown of [undefined, null, {}, 'nonsense', 42, { hasKey: undefined }]) {
    const d = vaultLockDisplay(unknown);
    assert.strictEqual(d.state, 'locked', `${JSON.stringify(unknown)} must read as locked`);
    assert.strictEqual(d.showList, false);
  }
});

test('melt asks for confirmation, and the confirmation states the cost', () => {
  // A single click beside a password field is not consent for something with no
  // recovery. This is the only action in the harness that destroys data
  // irreversibly.
  const plain = vaultLockDisplay({ hasKey: true, locked: true });
  assert.strictEqual(plain.state, 'locked');

  const asked = vaultLockDisplay({ hasKey: true, locked: true }, { confirmingMelt: true });
  assert.strictEqual(asked.state, 'confirm-melt');
  assert.match(asked.meltWarning, /permanently/i);
  assert.match(asked.meltWarning, /no backup and no recovery/i);
  assert.match(asked.meltWarning, /only if the key is lost/i);
});

test('the warning counts the secrets when it can, because a number is a decision', () => {
  // "lose 6 secrets" is a decision. "lose all secrets" is a slogan, and the
  // difference is whether the user pictures what they are about to destroy.
  const known = vaultLockDisplay({ hasKey: true, locked: true }, { entryCount: 6 });
  assert.match(known.meltWarning, /All 6 secrets/);

  // And never invents one. `Number(null)` is 0 -- an unknown count must not
  // render as "all 0 secrets", which reads as "this is safe".
  for (const bad of [null, undefined, NaN, 'six', -1, 0]) {
    const d = vaultLockDisplay({ hasKey: true, locked: true }, { entryCount: bad });
    assert.match(d.meltWarning, /Everything in it/,
      `entryCount ${JSON.stringify(bad)} must fall back to the unnumbered wording`);
    assert.strictEqual(/All .* secrets/.test(d.meltWarning), false);
  }
});

test('confirming melt is only reachable from the locked side', () => {
  // An open vault has no need of melt: the key can simply be destroyed, which
  // keeps the secrets. Offering melt there is offering data loss as a
  // convenience.
  const open = vaultLockDisplay({ hasKey: true, locked: false }, { confirmingMelt: true });
  assert.strictEqual(open.state, 'open-with-key');
  assert.notStrictEqual(open.canMelt, true);
});
