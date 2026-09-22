'use strict';
/**
 * The project list the picker panel shows.
 *
 * `host/recent.js` already does the reading -- it walks ~/.claude/projects and
 * pulls the authoritative cwd out of each transcript. This shapes that for the
 * panel, and it exists as its own module because every decision in it is one
 * the panel would otherwise make in untestable renderer code.
 */

const { samePath } = require('./project-path');
const { listRecentProjects } = require('./recent');

// Enough to cover what anyone actually switches between. recent.js returns
// everything under ~/.claude/projects, which is already dozens on a machine
// that has been used; a sidebar that scrolls forever is a worse way to find a
// project than the explorer it replaces.
const PICKER_LIMIT = 12;

/**
 * `recents` is `listRecentProjects()`, or NULL when that read failed.
 *
 * Those two are kept apart deliberately. An empty history ("you have not opened
 * anything yet") and a failed read ("we could not tell") look identical as an
 * empty array, and this codebase has paid for that conflation before -- so the
 * caller is told which it got, and the panel can say so.
 */
function pickerPayload({ recents, current } = {}) {
  const ok = Array.isArray(recents);
  const list = (ok ? recents : []).slice(0, PICKER_LIMIT)
    .map(r => ({ ...r, current: samePath(r.path, current) }));

  // A brand new folder has no transcript, so recent.js cannot know about it.
  // Without this the panel shows every project EXCEPT the one you are looking
  // at, which reads as the picker being broken rather than as the folder being
  // new. Prepended, because it is by definition the most recently used.
  if (!list.some(p => p.current) && typeof current === 'string' && current.trim()) {
    list.unshift({
      path: current,
      name: current.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || current,
      approximate: false,
      lastUsed: Date.now(),
      // NULL, not 0. There are no transcripts for this project yet, so we have
      // no usage to report -- and "0 tokens" would say the project has been
      // worked on for nothing, which is a claim about the project rather than
      // about our knowledge of it. Caught by rendering the real panel, which
      // drew exactly that under a brand new folder.
      tokens: null,
      sessions: null,
      current: true,
    });
    list.length = Math.min(list.length, PICKER_LIMIT);
  }

  return { ok, projects: list };
}

/**
 * A reader that holds its cache.
 *
 * `listRecentProjects` takes a `cache` keyed on mtime+size for a reason its own
 * header states: a full read measured 3s across 71 projects, which it calls
 * "far too slow for a launcher". The first version of this feature called it
 * with no arguments at all, so every open of the panel re-read every transcript
 * on the machine -- measured at 2.0s, then 3.0s, then 3.9s as the files grew.
 * With one cache held across calls: 1699ms once, then 8ms.
 *
 * That read is SYNCHRONOUS, and the host's event loop is what delivers hook
 * events. This is the same worry that makes the fog read on-demand at 175ms;
 * two seconds is a different order of it.
 */
function createProjectsReader({ read = listRecentProjects } = {}) {
  // A PLAIN OBJECT, not a Map. host/recent.js indexes this with bracket syntax
  // (`cache[key]`), and a Map instance happily accepts expando properties -- so
  // the Map this used to be worked while `map.size` stayed 0 and
  // `map.get(key)` returned undefined. Nothing was ever IN the Map. It measured
  // correctly and was correct by accident (Miguel, Dexter F13), and the day
  // someone tidied recent.js to .get()/.set() every lookup would have become a
  // miss -- silently restoring a 3.9s SYNCHRONOUS stall on the event loop that
  // owes the hook helper a connection inside 80ms, with no test failing.
  //
  // Object.create(null) rather than {}: the keys are file paths, and a path
  // named `__proto__` or `constructor` must be a cache entry, not a collision
  // with Object.prototype.
  const cache = Object.create(null);
  return () => read({ cache, limit: PICKER_LIMIT });
}

module.exports = { pickerPayload, createProjectsReader, PICKER_LIMIT };
