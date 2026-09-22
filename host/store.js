'use strict';
/**
 * Persistent state for the harness features.
 *
 *   .harness/state/loadout.json    items equipped per agent
 *   .harness/state/vault.json      bug bestiary
 *   .harness/state/map.json        files seen, per project
 *   .harness/state/stats.json      counters, cooldowns, streaks
 *
 * ONE FILE PER CONCERN, not a single blob: a corrupt write then costs one
 * feature instead of all of them, and the diffs stay readable.
 *
 * The host owns every write. The GUI reads through the control protocol and
 * never writes. The hook helper reads `loadout.json` directly, which is what
 * lets equipped items keep working when the GUI is closed — the harness must
 * not become a requirement for a plain terminal session.
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
const path = require('path');
const { withFileLock } = require('./file-lock');

// Names are used as filenames. They may come from feature code today and from
// config later, so traversal is refused rather than sanitised.
function assertSafeName(name) {
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`store: unsafe name ${JSON.stringify(name)}`);
  }
}

function createStore({ dir }) {
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
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, file);
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
  function withLock(name, fn) {
    const file = pathOf(name);          // validates the name before touching disk
    fs.mkdirSync(dir, { recursive: true });
    return withFileLock(`${file}.lock`, fn);
  }

  return { read, readState, write, update, withLock, pathOf, dir };
}

module.exports = { createStore };
