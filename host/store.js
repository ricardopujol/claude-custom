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
 */

const fs = require('fs');
const path = require('path');

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

  return { read, readState, write, update, pathOf, dir };
}

module.exports = { createStore };
