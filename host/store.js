'use strict';
/**
 * Persistent state for the harness features.
 *
 * WHAT THIS STORE ACTUALLY CONTAINS TODAY:
 *
 *   .harness/state/cooldowns.json  the only file this store writes.
 *                                  host/cooldowns.js, STORE_KEY 'cooldowns'.
 *
 * THAT IS THE WHOLE LIST. The four entries that used to stand here --
 * loadout.json, vault.json, map.json and stats.json -- named files that have
 * NEVER BEEN WRITTEN. Verified by grepping for each store key across host/ and
 * app/: 'loadout' 0 references, 'map' 0, 'stats' 0. The one real key,
 * 'cooldowns', was not in the list at all, so the header named four files that
 * do not exist and omitted the one that does.
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
 * justification -- the most persuasive form a false comment can take.)
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
