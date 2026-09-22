// @ts-nocheck
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
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
const fs = require('fs');
const {
  renameWithRetry
} = require('./atomic-write');
const path = require('path');

// Names are used as filenames. They may come from feature code today and from
// config later, so traversal is refused rather than sanitised.
function assertSafeName(name) {
  if (stryMutAct_9fa48("731")) {
    {}
  } else {
    stryCov_9fa48("731");
    if (stryMutAct_9fa48("734") ? (!name || typeof name !== 'string') && !/^[A-Za-z0-9_-]+$/.test(name) : stryMutAct_9fa48("733") ? false : stryMutAct_9fa48("732") ? true : (stryCov_9fa48("732", "733", "734"), (stryMutAct_9fa48("736") ? !name && typeof name !== 'string' : stryMutAct_9fa48("735") ? false : (stryCov_9fa48("735", "736"), (stryMutAct_9fa48("737") ? name : (stryCov_9fa48("737"), !name)) || (stryMutAct_9fa48("739") ? typeof name === 'string' : stryMutAct_9fa48("738") ? false : (stryCov_9fa48("738", "739"), typeof name !== (stryMutAct_9fa48("740") ? "" : (stryCov_9fa48("740"), 'string')))))) || (stryMutAct_9fa48("741") ? /^[A-Za-z0-9_-]+$/.test(name) : (stryCov_9fa48("741"), !(stryMutAct_9fa48("745") ? /^[^A-Za-z0-9_-]+$/ : stryMutAct_9fa48("744") ? /^[A-Za-z0-9_-]$/ : stryMutAct_9fa48("743") ? /^[A-Za-z0-9_-]+/ : stryMutAct_9fa48("742") ? /[A-Za-z0-9_-]+$/ : (stryCov_9fa48("742", "743", "744", "745"), /^[A-Za-z0-9_-]+$/)).test(name))))) {
      if (stryMutAct_9fa48("746")) {
        {}
      } else {
        stryCov_9fa48("746");
        throw new Error(stryMutAct_9fa48("748") ? `` : (stryCov_9fa48("748"), `store: unsafe name ${JSON.stringify(name)}`));
      }
    }
  }
}
function createStore({
  dir
}) {
  if (stryMutAct_9fa48("749")) {
    {}
  } else {
    stryCov_9fa48("749");
    if (stryMutAct_9fa48("752") ? false : stryMutAct_9fa48("751") ? true : stryMutAct_9fa48("750") ? dir : (stryCov_9fa48("750", "751", "752"), !dir)) throw new Error(stryMutAct_9fa48("754") ? "" : (stryCov_9fa48("754"), 'createStore: dir is required'));
    const pathOf = name => {
      if (stryMutAct_9fa48("755")) {
        {}
      } else {
        stryCov_9fa48("755");
        if (stryMutAct_9fa48("756")) {
          ;
        } else {
          stryCov_9fa48("756");
          assertSafeName(name);
        }
        return path.join(dir, stryMutAct_9fa48("757") ? `` : (stryCov_9fa48("757"), `${name}.json`));
      }
    };
    function read(name, fallback) {
      if (stryMutAct_9fa48("758")) {
        {}
      } else {
        stryCov_9fa48("758");
        try {
          if (stryMutAct_9fa48("759")) {
            {}
          } else {
            stryCov_9fa48("759");
            return JSON.parse(fs.readFileSync(pathOf(name), stryMutAct_9fa48("760") ? "" : (stryCov_9fa48("760"), 'utf8')));
          }
        } catch (err) {
          if (stryMutAct_9fa48("761")) {
            {}
          } else {
            stryCov_9fa48("761");
            // A traversal attempt is a programming error and must surface; a missing
            // or corrupt file is normal and must not.
            if (stryMutAct_9fa48("763") ? false : stryMutAct_9fa48("762") ? true : (stryCov_9fa48("762", "763"), /unsafe name/.test(err.message))) throw err;
            return fallback;
          }
        }
      }
    }
    function write(name, value) {
      if (stryMutAct_9fa48("764")) {
        {}
      } else {
        stryCov_9fa48("764");
        const file = pathOf(name);
        fs.mkdirSync(dir, stryMutAct_9fa48("766") ? {} : (stryCov_9fa48("766"), {
          recursive: stryMutAct_9fa48("767") ? false : (stryCov_9fa48("767"), true)
        }));

        // Write-and-rename. A hard exit part-way through a plain write leaves a
        // truncated file that reads as corrupt and silently resets the feature --
        // observed in this project when app.exit() zeroed a PNG immediately after a
        // synchronous write. Rename is atomic, so a reader sees old or new, never
        // half.
        const temp = stryMutAct_9fa48("768") ? `` : (stryCov_9fa48("768"), `${file}.tmp${process.pid}`);
        // The write is inside the try with the rename: wrapping only the rename
        // left a failed writeFileSync abandoning a partial temp (Miguel).
        try {
          if (stryMutAct_9fa48("769")) {
            {}
          } else {
            stryCov_9fa48("769");
            if (stryMutAct_9fa48("770")) {
              ;
            } else {
              stryCov_9fa48("770");
              fs.writeFileSync(temp, JSON.stringify(value, null, 2));
            } // Retried, because on Windows the rename is the fragile half: EPERM /
            // EACCES / EBUSY whenever anything holds a handle for a moment, and the
            // antivirus scan of the file we just wrote routinely does. MEASURED here
            // 2026-09-18. It still THROWS if the rename never succeeds -- a write
            // reported as done while the file was never replaced would be worse than
            // the failure it hides. See host/atomic-write.js.
            if (stryMutAct_9fa48("771")) {
              ;
            } else {
              stryCov_9fa48("771");
              renameWithRetry(temp, file);
            }
          }
        } catch (err) {
          if (stryMutAct_9fa48("772")) {
            {}
          } else {
            stryCov_9fa48("772");
            // Dexter, Finding 9. Bounded -- one temp per (pid, name), overwritten by
            // the next write from this process -- but a stale .tmp beside a settings
            // file reads as corruption to whoever finds it.
            //
            // BEST EFFORT: if the rename failed because something holds a handle,
            // the unlink can fail for the same reason. A failed cleanup never
            // replaces the error the caller needs to see.
            try {
              if (stryMutAct_9fa48("773")) {
                {}
              } else {
                stryCov_9fa48("773");
                if (stryMutAct_9fa48("774")) {
                  ;
                } else {
                  stryCov_9fa48("774");
                  fs.unlinkSync(temp);
                }
              }
            } catch {/* nothing more we can do about it */}
            throw err;
          }
        }
        return value;
      }
    }
    function update(name, fallback, fn) {
      if (stryMutAct_9fa48("775")) {
        {}
      } else {
        stryCov_9fa48("775");
        return write(name, fn(read(name, fallback)));
      }
    }
    return stryMutAct_9fa48("776") ? {} : (stryCov_9fa48("776"), {
      read,
      write,
      update,
      pathOf,
      dir
    });
  }
}
module.exports = stryMutAct_9fa48("777") ? {} : (stryCov_9fa48("777"), {
  createStore
});