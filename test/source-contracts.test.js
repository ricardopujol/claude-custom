'use strict';
/**
 * Assertions about the SOURCE TEXT of product modules, kept apart on purpose.
 *
 * WHY THIS FILE EXISTS. Mortimer, PR #42, second run: a test of mine read
 * `app/secret-vault.js` as text and asserted on its CODE SHAPE. Stryker's
 * instrumentation rewrites that text — a `${file}.lock` template becomes
 * `stryMutAct_9fa48("933") ? `` : (stryCov_9fa48("933"), `${file}.lock`)` — so the
 * assertion was red on the UNMUTATED BASELINE inside the sandbox and **aborted the
 * entire dry run**. 574 of 575 passing, one failure, and no mutation number at all.
 *
 * That is this project's documented worst gate failure: it does not fail loudly,
 * it simply never produces a number, and a branch can reach merge with the
 * mutation item nominally satisfied and actually unmeasured. CLAUDE.md records two
 * earlier instances; this is the third, and the first caused by a test written to
 * close a review finding.
 *
 * THE RULE, and it is finer than "don't read source in a test":
 *
 *   - An assertion on **comment text** survives instrumentation, because Stryker
 *     preserves comments. Four tests in the mutation command do this today and
 *     pass. They are fragile rather than wrong — nothing guarantees comments are
 *     preserved — and they belong here eventually.
 *   - An assertion on **code shape** does NOT survive, because code is exactly
 *     what gets rewritten. That one aborts the run.
 *
 * So source-text assertions live in a file the mutation command excludes, beside
 * the shared-scope allow-list and the control-character guard, for the same
 * reason: their subject is the REPOSITORY rather than a function. They kill no
 * mutant — there is no expression a mutator can reach through them — so excluding
 * them costs nothing and including them costs the whole run.
 *
 * Registered in `REPO_SCANNING` in test/stryker-config.test.js, which asserts this
 * file exists and is NOT in the command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('J1: a sweep failure cannot reach the ok flag that melt returns', () => {
  // Dexter, PR #42, J1, and a defect in my own H5 fix. `withFileLock` throws if it
  // cannot acquire, and that throw escaped `melt()` AFTER the vault was replaced
  // and `state`/`sessionKey` reassigned — so the service reported `{ok:false}`,
  // telling the user their melt failed when it had succeeded, and losing
  // `preserved` with it, so a damaged vault's owner was not told where their
  // possibly-recoverable file went. The retry was a dead end: `sessionKey` is
  // `undefined` by then, so a second melt throws "melt is for a forgotten key".
  //
  // WHY THIS IS A SOURCE ASSERTION rather than a behavioural one, stated plainly
  // because a weak test pretending to be strong is worse than one admitting it:
  //
  // I tried to force the interleaving and could not, and failing narrowed the
  // finding. `persist` and the sweep take the SAME lockfile, sequentially, so
  // blocking it blocks persist FIRST — melt then fails with "nothing was written",
  // which is correct and is not J1. `sweepTemps` cannot throw on its own (its
  // readdir and unlink are both already caught), so the lock is the only throw
  // source, and the second acquisition cannot be failed without failing the first.
  //
  // J1 therefore needs the lockfile contended in the instant BETWEEN the two
  // acquisitions — real, and documented by host/file-lock.js as what an antivirus
  // does on Windows, but narrower than "any melt under contention". The single
  // `withFileLock` around melt's three operations, on the follow-up branch,
  // removes the gap rather than making it testable.
  const src = read('app/secret-vault.js');

  const at = src.indexOf('let leftovers;');
  assert.ok(at > 0, 'melt must collect leftovers in a reassignable binding');
  const region = src.slice(at, at + 900);

  assert.match(region, /try\s*\{[\s\S]*withFileLock/,
    'the lock acquisition for the sweep must be inside a try');
  assert.match(region, /catch\s*\([\s\S]*leftovers\s*=/,
    'and its failure must be folded INTO leftovers, never rethrown');

  // The rule the code comment states, pinned so the next reader cannot narrow it
  // back to "unlink failures only" — which is exactly the narrowing that caused
  // J1, since I wrote that comment for an unlink and never folded in a lock.
  assert.match(src, /must not make melt look like it failed/,
    'the rule must stay written down beside the code that honours it');
});

test('the two fail-open path gaps stay named in the module that owns them', () => {
  // Dexter F4 / Miguel's placement note: what changed when PR #40 landed was the
  // CONSEQUENCE of those gaps — the same predicate that routed a window handshake
  // now decides who can read a credential — so the acceptance belongs beside the
  // gap list rather than only downstream in the consumer.
  //
  // Moved here from test/project-path.test.js, which IS in the mutation command.
  // It passes there today only because Stryker preserves comments, which nothing
  // guarantees. Same class as J1, one instrumentation change away from the same
  // abort.
  const header = read('host/project-path.js');
  assert.match(header, /FAILS? OPEN/,
    'the two fail-open cases must be named as such where the gap list lives');
  assert.match(header, /credential|secret/i,
    'and the header must say the consequence changed, since that is what PR #40 changed');
});

test('the B2(a) cleartext limit stays written down in the vault module', () => {
  // Miguel B2(a). The lock protects VALUES; labels and notes are cleartext, so the
  // inventory is readable from secrets.enc by exactly the person the feature exists
  // to stop. Not fixed on this branch — it changes the on-disk format of every
  // entry — so the honest statement has to stay in the module, and this is what
  // stops it being quietly deleted before the migration lands.
  const vault = read('app/secret-vault.js');
  assert.match(vault, /A SECOND LIMIT, AND THE LOCK DOES NOT CLOSE IT/,
    'the cleartext-inventory limit must stay named in the module header');
  assert.match(vault, /hides your secrets, not your list/,
    'including the one-line statement a reader will actually remember');
});

test('host.js wires the tool belt: the hook, the handshake and both control types (BACKLOG #17)', () => {
  // host.js is not unit-testable, so the wiring is pinned as text: a belt whose
  // hook is never registered, or whose hello never carries `loadout`, is a
  // feature that draws a UI and does nothing to the spawn.
  const host = read('host/host.js');
  assert.match(host, /loadoutHook:\s*\{/, 'writeHarnessSettings must be given the loadout hook');
  assert.match(host, /loadout-hook\.js/);
  assert.match(host, /loadout:\s*loadoutControl\.payload\(\)/, 'hello must carry the loadout');
  assert.match(host, /msg\.type === 'loadout-equip' \|\| msg\.type === 'loadout-unequip'/);
  assert.match(host, /broadcastControl\(loadoutControl\.handle\(msg\)\)/,
    'the answer must reach every window, and must not be reduced to a per-client reply');
});

test('the tool belt hook stays cheap to start: it requires only the loadout core and the payload contract', () => {
  // Node startup is paid per Agent spawn (~55 ms measured). This pins the
  // require graph so a future import of the store or the host does not quietly
  // add to it. Source text, hence here rather than in test/loadout-hook.test.js
  // (a code-shape assertion aborts the Stryker dry run).
  const src = read('host/loadout-hook.js');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(requires, ['./loadout', './payload-contract', 'fs', 'path']);
});

test('main.js still depends on createVault never throwing, and says so', () => {
  // The invariant G3 moved: `createVault` constructs for ANY bytes on disk,
  // because main.js does not wrap it and a throw there means no window opens.
  // Pinned as behaviour in test/vault-damaged-path.test.js over 18 byte shapes;
  // pinned as a STATED dependency here, so the next person to add a throw to
  // `load()` finds the reason rather than the crash.
  const main = read('app/main.js');
  assert.match(main, /CONSTRUCTS FOR ANY BYTES ON DISK/,
    'the call site must name the invariant it depends on');
  assert.ok(!/try\s*\{[\s\S]{0,200}createVault\(/.test(main),
    'and must NOT wrap it — a caught throw gives a window with a silently dead '
    + 'vault panel, which is the class this repo has paid for four times');
});
