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
 * never writes.
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
 *   STATE CROSSES PROJECTS. `map.json` is documented as per-project and is
 *   keyed accordingly, but `loadout.json`, `vault.json` and `stats.json` carry
 *   no project key. Equipping an item in project A changes it in project B,
 *   and the streaks and bestiary shown as A's include B's. The hook helper
 *   reads `loadout.json` directly, so it picks up whichever host wrote last.
 *
 * DELIBERATELY NOT FIXED in the multi-project change, and recorded here rather
 * than deferred quietly. Both are real; neither is silent corruption of
 * anything durable -- this module's own framing is that all of it is
 * regenerable convenience state -- and the fix is a design decision about what
 * these numbers MEAN across projects (is a streak per-project or per-user?),
 * which is not a decision to make at 3am inside an unrelated PR. The scoping
 * question belongs to whoever owns the feature, not to the change that made it
 * visible. The hook helper reads `loadout.json` directly, which is what
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

  function read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(pathOf(name), 'utf8'));
    } catch (err) {
      // A traversal attempt is a programming error and must surface; a missing
      // or corrupt file is normal and must not.
      if (/unsafe name/.test(err.message)) throw err;
      return fallback;
    }
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

  return { read, write, update, pathOf, dir };
}

module.exports = { createStore };
