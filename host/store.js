'use strict';
/**
 * Persistent state for the harness features.
 *
 * WHAT THIS STORE ACTUALLY CONTAINS TODAY:
 *
 *   .harness/state/cooldowns.json  host/cooldowns.js, STORE_KEY 'cooldowns'.
 *   .harness/state/loadout.json    host/loadout-control.js, STORE_KEY 'loadout'
 *                                  (BACKLOG #17, the tool belt). Install-wide,
 *                                  keyed by agent type. The host writes it; the
 *                                  Node hook host/loadout-hook.js READS it with
 *                                  a plain fs read on every Agent spawn.
 *
 *   .harness/state/wand.json       host/wand-control.js, STORE_KEY 'wand' (BACKLOG
 *                                  #51, the wand: favourite skills as emoji
 *                                  buttons). Install-wide, one global set. The
 *                                  user types these by hand, so it opts in to
 *                                  withLock and readState: a file it could not
 *                                  read is never written over.
 *
 *   .harness/state/medals.json     host/medals.js, STORE_KEY 'medals' (BACKLOG #80: the medals
 *                                  Ricardo gives agents). Install-wide, keyed by agent name. Given
 *                                  by hand, so like the wand it opts in to withLock and readState.
 *   .harness/state/usage-counters.json  host/usage-counters.js, STORE_KEY 'usage-counters' (audit move 2: how often
 *                                  each feature is used; keys and timestamps only). Install-wide, never shown in the UI;
 *                                  it opts in to withLock and readState, and an unreadable file is never written over.
 *   .harness/state/ask-counts.json host/ask-counts.js, STORE_KEY 'ask-counts' (BACKLOG #33 gamification: the Ask
 *                                  explainer's questions answered and places opened). Install-wide, one explainer per
 *                                  person. A count can't be recomputed, so like the medals it opts in to withLock and
 *                                  readState: a file it could not read is never written over.
 *   .harness/state/bubbles.json    host/bubbles.js, STORE_KEY 'bubbles' (BACKLOG #80: the speech
 *                                  bubbles' on/off switch). Install-wide, regenerable.
 *
 *   .harness/state/vault.json      host/bugvault.js, STORE_KEY 'vault' (the bug
 *                                  vault; irreplaceable, so it opts in to
 *                                  withLock and readState).
 *   .harness/state/council.json    host/host.js reads and writes 'council' (the
 *                                  seated models).
 *   .harness/state/provider.json   host/host.js READS 'provider'. Nothing in
 *                                  this repo writes it; a missing file is the
 *                                  default, 'claude-max'.
 *   'wait-games'                   written by Electron MAIN, app/main.js (the games' score store, host/game-scores.js,
 *                                  BACKLOG #41): the best of each wait game, install-wide. It opts in to withLock for a
 *                                  raise, since another window may be raising the same file.
 *   'look-global'                  written by Electron MAIN, app/main.js UI_KEY,
 *                                  not by the host (see below).
 *
 * The list above was re-derived by grepping host/ and app/ for every store key
 * (STORE_KEY / UI_KEY constants and store.read/write/update calls), and
 * test/store.test.js now does that grep on every run and fails if a key in use
 * is not named here. This header used to say "THAT IS THE WHOLE LIST" while
 * naming two files; before that it named four -- loadout.json, vault.json,
 * map.json and stats.json -- that had NEVER BEEN WRITTEN, and omitted the one
 * real key, 'cooldowns'. Of those four, loadout.json and vault.json have since
 * been built; 'map' and 'stats' still have zero references anywhere.
 *
 * It was a roadmap written in the present tense, and it cost real time:
 *
 *   - `map.json`'s "files seen, per project" was cited as PRECEDENT for how to
 *     scope a new feature, in a review, by someone reasoning carefully. There
 *     is no precedent; nothing in this store is scoped by project.
 *   - I repeated that claim in the paragraph below, which exists specifically
 *     to record what is and is not scoped, having trusted this header instead
 *     of grepping for a caller.
 *   - Correcting it, I fixed only the one line I had been told about and left
 *     the other three standing. Dexter re-grepped and found them.
 *
 * Three readers misled by one stale list, and the correction needed two
 * passes. If you add a file here, add it when you write the code, not when you
 * plan it -- and if you are about to cite a line in this block as evidence of
 * how something works, grep for its key first.
 *
 * ONE FILE PER CONCERN, not a single blob: a corrupt write then costs one
 * feature instead of all of them, and the diffs stay readable.
 *
 * The host owns every write. The GUI reads through the control protocol and
 * never writes. ONE EXCEPTION (Miguel, feat/project-look #2): Electron MAIN
 * writes the 'look-global' key -- the install-wide unfocused-window dim, and
 * lean mode's list of dismissed /bedtime nights (#62, `leanDismissed`) --
 * because focus is a fact only main knows and no host is involved. Its own
 * key, regenerable, last-writer-wins by design: two windows moving the same
 * slider should end on whichever moved last.
 *
 * NO LONGER ONE HOST, AND THIS FILE HAS NOT CAUGHT UP. Dexter F3 / Miguel,
 * PR #31. Until multi-project, one host at a time was the practical reality
 * and "the host owns every write" was true. Two hosts is now the advertised
 * feature, and `.harness/state` is install-wide, so:
 *
 *   LOST UPDATES. `update()` below is read-modify-write, which is not atomic
 *   ACROSS PROCESSES. Two hosts each incrementing a counter both read 5 and
 *   both write 6: two events occurred, the counter says one. The
 *   write-and-rename in `write()` defends against a TORN file, which is a
 *   different property, and the comment there may read as though it covers
 *   this. It does not.
 *
 *   STATE CROSSES PROJECTS. Nothing this store holds is scoped per project.
 *   `cooldowns.json` is install-wide, so a cooldown started in project A is
 *   still ticking in project B. Any future state added here inherits that
 *   unless it is given a project key deliberately.
 *
 *   An earlier version of this paragraph cited `map.json` as per-project
 *   evidence. See the file list above for what that was worth.
 *
 * DELIBERATELY NOT FIXED in the multi-project change, and recorded here rather
 * than deferred quietly. Both are real; neither is silent corruption of
 * anything durable -- this module's own framing is that all of it is
 * regenerable convenience state -- and the fix is a design decision about what
 * these numbers MEAN across projects (is a streak per-project or per-user?),
 * which is not a decision to make at 3am inside an unrelated PR. The scoping
 * question belongs to whoever owns the feature, not to the change that made it
 * visible.
 *
 * (The sentence that used to end this paragraph claimed the hook helper reads
 * `loadout.json` directly, "which is what lets equipped items keep working
 * when the GUI is closed". Grep helper/: zero references. It described the
 * mechanism of a feature that was never built, in the present tense, as a
 * justification -- the most persuasive form a false comment can take. The
 * native helper still does not read it, by design: it is transport-only and
 * must never block. The Node hook host/loadout-hook.js does, and that one is
 * real and tested.)
 *
 * Every read defaults rather than throwing. All of this is regenerable
 * convenience state; none of it is worth an exception on a hot path, and a
 * feature silently resetting beats a session going down.
 *
 * -- AND THE BUG VAULT BREAKS THAT PREMISE. It is the first consumer here
 * whose records a user cannot reconstruct, which is why this module grew two
 * things it did not need before:
 *
 *   `readState()`  says WHY there is no value. `read()` returns the fallback
 *                  for both "no file" and "corrupt file", and the vault used
 *                  that as its first-run signal -- so a vault that failed to
 *                  parse once was overwritten with defaults. Only `missing`
 *                  authorises writing over a file. (Dexter, PR #29, F1.)
 *
 *   `withLock()`   a cross-process mutex (host/file-lock.js). `update()` is
 *                  read-modify-write, which is not atomic across processes:
 *                  two hosts both read N, both write N+1, one event vanishes.
 *                  `.harness/state` is install-wide, so that is every pair of
 *                  open windows, not two windows on one project. Consumers
 *                  holding irreplaceable data opt in; `update()` itself does
 *                  not, for the reason given on withLock below.
 *                  (Dexter, PR #29, F3B.)
 *
 * NOTE: the file list at the top of this header is wrong -- three of the four
 * names have never been written and the one real key is missing. It is
 * corrected on feat/multi-project (#31) and is deliberately NOT re-fixed here,
 * to keep the two branches from conflicting over the same comment.
 */

const fs = require('fs');
const { renameWithRetry } = require('./atomic-write');
const path = require('path');
const { withFileLock } = require('./file-lock');

// Names are used as filenames. They may come from feature code today and from
// config later, so traversal is refused rather than sanitised.
function assertSafeName(name) {
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`store: unsafe name ${JSON.stringify(name)}`);
  }
}

// `= {}` so that `createStore()` reaches the guard below and says what is
// wrong, rather than dying on the destructure with "Cannot destructure
// property 'dir' of 'undefined'" -- a message that names the syntax instead of
// the mistake. Found by writing Mortimer's ST-C kill.
function createStore({ dir } = {}) {
  if (!dir) throw new Error('createStore: dir is required');

  const pathOf = (name) => {
    assertSafeName(name);
    return path.join(dir, `${name}.json`);
  };

  /**
   * WHY there is no value, for the consumers that must fail closed.
   *
   * Dexter, PR #29 review, F1. `read` below answers "give me a value or a
   * default", which is exactly right for everything this store was built for:
   * cooldowns, counters, seats -- all regenerable, all happy to start over.
   * The bug vault is the first consumer holding records a user CANNOT
   * reconstruct, and it read a null as "first run, safe to seed". A vault that
   * failed to parse once was therefore overwritten with defaults.
   *
   * Four statuses, and only ONE of them authorises writing over the file:
   *
   *   missing     nothing is there. Seeding is safe.
   *   corrupt     something is there and it is not JSON. Do not overwrite it.
   *   unreadable  something is there and the OS would not hand it over.
   *   ok          the parsed value.
   *
   * `missing` is deliberately the narrow case -- ENOENT and nothing else --
   * because it is the status that grants permission to destroy a file. Any
   * errno nobody anticipated lands in `unreadable` and is refused.
   */
  function readState(name) {
    const file = pathOf(name);          // throws on a traversing name, as it must
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing', value: null };
      return { status: 'unreadable', value: null, error: err };
    }
    try {
      return { status: 'ok', value: JSON.parse(text) };
    } catch (err) {
      return { status: 'corrupt', value: null, error: err };
    }
  }

  // Expressed in terms of readState so there is ONE decision about what counts
  // as readable and the two cannot drift apart later. Behaviour is unchanged:
  // a traversal still surfaces, anything else still defaults.
  function read(name, fallback) {
    const state = readState(name);
    return state.status === 'ok' ? state.value : fallback;
  }

  function write(name, value) {
    const file = pathOf(name);
    fs.mkdirSync(dir, { recursive: true });

    // Write-and-rename. A hard exit part-way through a plain write leaves a
    // truncated file that reads as corrupt and silently resets the feature --
    // observed in this project when app.exit() zeroed a PNG immediately after a
    // synchronous write. Rename is atomic, so a reader sees old or new, never
    // half.
    const temp = `${file}.tmp${process.pid}`;
    // The write is inside the try with the rename: wrapping only the rename
    // left a failed writeFileSync abandoning a partial temp (Miguel).
    try {
      fs.writeFileSync(temp, JSON.stringify(value, null, 2));
      // Retried, because on Windows the rename is the fragile half: EPERM /
      // EACCES / EBUSY whenever anything holds a handle for a moment, and the
      // antivirus scan of the file we just wrote routinely does. MEASURED here
      // 2026-09-18. It still THROWS if the rename never succeeds -- a write
      // reported as done while the file was never replaced would be worse than
      // the failure it hides. See host/atomic-write.js.
      renameWithRetry(temp, file);
    } catch (err) {
      // Dexter, Finding 9. Bounded -- one temp per (pid, name), overwritten by
      // the next write from this process -- but a stale .tmp beside a settings
      // file reads as corruption to whoever finds it.
      //
      // BEST EFFORT: if the rename failed because something holds a handle,
      // the unlink can fail for the same reason. A failed cleanup never
      // replaces the error the caller needs to see.
      try { fs.unlinkSync(temp); } catch { /* nothing more we can do about it */ }
      throw err;
    }
    return value;
  }

  function update(name, fallback, fn) {
    return write(name, fn(read(name, fallback)));
  }

  /**
   * Run `fn` holding a cross-process lock on one file. Dexter, PR #29, F3B.
   *
   * OPT-IN, DELIBERATELY. `update()` above is still unlocked: routing it
   * through here would turn a silent lost update into a THROWN ERROR on a hot
   * path for cooldowns and every other consumer, which contradicts this
   * module's own closing rule -- one feature's state must never take the
   * session down. That trade is right for regenerable state and wrong for the
   * bug vault, the first consumer here holding records a user cannot retype.
   * So the vault opts in, and everything else keeps the old, documented,
   * accepted risk.
   */
  function withLock(name, fn, opts) {
    const file = pathOf(name);          // validates the name before touching disk
    fs.mkdirSync(dir, { recursive: true });
    return withFileLock(`${file}.lock`, fn, opts);
  }

  return { read, readState, write, update, withLock, pathOf, dir };
}

module.exports = { createStore };
