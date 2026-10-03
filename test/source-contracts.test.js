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

test('the B2(a) cleartext limit is FIXED, and the vault module says so', () => {
  // Miguel B2(a), and this is the inverse of what this test used to assert.
  // The lock protected VALUES; labels and notes were cleartext, so the
  // inventory was readable from secrets.enc by exactly the person the feature
  // exists to stop. FIXED on the FORMAT 2 branch (VAULT_HARDENING_FOLLOWUP.md
  // items 4/5): label and note are wrapped under the session key exactly like
  // `secret`. The old limit paragraph must be GONE, not merely superseded --
  // a paragraph naming a limit that no longer exists is the failure mode this
  // whole file is about, one layer up from source code: a claim the disk no
  // longer backs.
  const vault = read('app/secret-vault.js');
  assert.doesNotMatch(vault, /A SECOND LIMIT, AND THE LOCK DOES NOT CLOSE IT/,
    'the cleartext-inventory limit is fixed and must not still be claimed');
  assert.doesNotMatch(vault, /hides your secrets, not your list/,
    'the old one-line summary is the exact sentence the fix makes false');
  assert.match(vault, /the lock hides the list too/i,
    'and the module must say what replaced it');
});

test('host.js wires the tool belt: the hook, the handshake and both control types (BACKLOG #17)', () => {
  // host.js is not unit-testable, so the wiring is pinned as text: a belt whose
  // hook is never registered, or whose hello never carries `loadout`, is a
  // feature that draws a UI and does nothing to the spawn.
  const host = read('host/host.js');
  assert.match(host, /loadoutHook:\s*\{/, 'writeHarnessSettings must be given the loadout hook');
  assert.match(host, /loadout-hook\.js/);
  assert.match(host, /loadout:\s*loadoutControl\.payload\(\)/, 'hello must carry the loadout');
  assert.match(host, /watchLoadout\(\{[\s\S]{0,200}loadoutControl\.changed\(\)[\s\S]{0,80}broadcastControl\(frame\)/,
    'another host\'s change must reach this host\'s windows (Dexter F1)');
  assert.match(host, /msg\.type === 'loadout-equip' \|\| msg\.type === 'loadout-unequip'/);
  assert.match(host, /broadcastControl\(loadoutControl\.handle\(msg\)\)/,
    'the answer must reach every window, and must not be reduced to a per-client reply');
});

test('renderer.js wires the tool belt: hello seeds it, loadout frames update it, only <button>s act (BACKLOG #17)', () => {
  const r = read('app/renderer.js');
  assert.match(r, /loadoutState = loadoutDisplay\.reduce\(loadoutState, msg\);\s*hooksOn = msg\.hooks;\s*renderAgentStats/,
    'hello must seed the belts before the first roster paint');
  assert.match(r, /msg\.type === 'loadout'\)\s*\{\s*loadoutState = loadoutDisplay\.reduce/);
  assert.match(r, /closest\('button\[data-loadout-toggle\], button\[data-loadout-act\]'\)/,
    'only real <button>s act -- a control inside a card must never open the card');
  assert.match(r, /beltHtml\(row\.agent, \{ resolved: entry \? entry\.resolved : undefined \}\)/,
    'an Inactive label row (resolved:false) must be handed to the belt as such (Dexter F2)');
  assert.match(r, /hooksOn = msg\.hooks;/, 'hello.hooks must reach the belt (Dexter F3)');
  assert.match(r, /loadoutState = loadoutDisplay\.ask\(loadoutState, action\);\s*try \{ ws\.send/,
    'a window remembers what it asked before sending (Dexter F6)');
  // The belt rides in the ONE delegated card-click handler (the #66 contract),
  // asked after hide/unhide and before the log: a belt click is handled and
  // stops there. Its own listener registered first would also shadow the
  // handler the #63/#66 wiring tests read.
  const at = r.indexOf("agentsEl.addEventListener('click'");
  const card = r.slice(at, r.indexOf('\n});', at));
  const roster = card.indexOf('rosterActionFromClick(e.target)');
  const belt = card.indexOf('if (beltClick(e.target)) return;');
  const log = card.indexOf('cardClickAgent(e.target)');
  assert.ok(roster !== -1 && belt > roster && log > belt,
    'the card-click handler asks hide/unhide, then the belt, then the log');
  assert.strictEqual((r.match(/beltHtml\(/g) || []).length, 3, 'defined once, drawn on both the Active and Inactive card');
  assert.ok(read('app/renderer.html').includes('<script src="./loadout-display.js"></script>'));
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

// Dexter, notify F4 (Low): attention.js raises only the notification types it
// names, so a NEW type that needs you would go silent. The hook log names the
// type, so that is visible in host.log instead of invisible.
test('host.js logs every Notification hook with its notification_type', () => {
  const host = read('host/host.js');
  const at = host.indexOf("console.log(`[hook] ${ev.event}");
  assert.ok(at !== -1, 'the [hook] log line exists');
  const before = host.slice(Math.max(0, at - 400), at);
  assert.match(before, /notification_type/);
});

// Dexter, notify round 2 F1 (High): a settle timer fired "finished" into a
// working session, because the host never sees UserPromptSubmit and hooks only
// Agent/Task/Bash. Ricardo chose idle_prompt only (2026-10-01): no timers here.
test('attention.js arms no timer: only Claude Code knows when the session is quiet', () => {
  const src = read('host/attention.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(src, /setTimeout|setInterval/);
});

// --- the tab strip (moved here in PR 3 so app/tab-strip.js can be mutated) --------

test('the tab strip never uses innerHTML: a branch name is text, not markup', () => {
  const src = read('app/tab-strip.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('tab-strip.html loads only its own script', () => {
  const html = read('app/tab-strip.html');
  assert.deepStrictEqual([...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]), ['./tab-strip.js']);
});

// PR #93 Miguel I5 (here, not in probe-seams.test.js: that file is in the mutation command, and reading a
// mutated module as text aborts Stryker's dry run).

test('the git-panel probe seams are read in ONE place: no other host or app file reads their variables directly', () => {
  const { SEAMS } = require('../host/probe-seams');
  const root = path.join(__dirname, '..');
  for (const dir of ['host', 'app']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter(n => n.endsWith('.js') && n !== 'probe-seams.js')) {
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      for (const k of SEAMS) assert.ok(!src.includes(k), `${dir}/${f} reads ${k}: go through host/probe-seams.js`);
    }
  }
});
