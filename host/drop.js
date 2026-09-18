'use strict';
/**
 * What happens when files are dropped on the window.
 *
 * Ricardo: "The possibility to drag and drop files and make them visible to
 * the session." Offered three strengths, he chose the strong one: type the
 * path AND grant the session read access to the file's folder, so Claude can
 * open it without a permission prompt.
 *
 * THAT MAKES THIS A SECURITY BOUNDARY, not a convenience. A drag gesture
 * widens what a session -- possibly running with permissions bypassed -- may
 * read from the disk, and a gesture is a poor consent surface: it is one
 * motion, easy to do by accident, with no dialog attached. So the granting is
 * deliberately the narrowest thing that satisfies the request:
 *
 *   - the CONTAINING folder of a dropped file, never a parent of it
 *   - the folder itself when a folder is dropped
 *   - nothing at all when the file is already inside the project
 *   - nothing at all for a drive root or the home directory, whatever is
 *     dropped from them
 *
 * A refusal still types the path. The drop is never silently useless: Claude
 * can ask for access the ordinary way, and the only thing the refusal removes
 * is the ability to read it with nobody noticing.
 *
 * The grant itself is issued as the CLI's own `/add-dir` slash command rather
 * than by editing settings behind the running process's back -- the same "wrap
 * the real CLI, never reimplement it" bet the rest of the harness rests on.
 * Verified present in the shipped binary before this was designed.
 */

const path = require('path');

// One drag can carry a whole folder's contents. Past a couple of dozen the
// prompt is unusable anyway, and a thousand paths typed into a pty is a way to
// wedge the session rather than a feature.
const MAX_DROP_FILES = 25;

// Compare paths the way the filesystem does on this platform: Windows is
// case-insensitive and accepts either separator, so `C:\TMP` and `C:/tmp` are
// one folder. Treating them as two issues a pointless second /add-dir and
// doubles the notice the user is supposed to be reading.
function canon(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(s)) s = s.toLowerCase();
  return s;
}

const isInside = (child, parent) => {
  const c = canon(child);
  const p = canon(parent);
  return !!p && (c === p || c.startsWith(p + '/'));
};

// A drive root (`C:/`, `/`) or a UNC share root. Granting one of these hands
// over everything mounted under it.
function isRootish(dir) {
  const s = canon(dir);
  if (!s) return true;
  if (/^[a-z]:$/.test(s)) return true;          // C:  (canon stripped the slash)
  if (s === '') return true;
  if (!s.includes('/')) return true;            // no separator left: a root
  if (/^\/\/[^/]+$/.test(s)) return true;       // //server
  return false;
}

// A path is quoted only when it needs to be. Quoting everything would be
// safer-looking and wrong: the prompt is read by a person, and unnecessary
// quotes are noise they then have to delete.
const quote = p => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

/**
 * Decide what a drop should do. PURE -- the caller supplies everything,
 * including whether each entry is a directory and which folders this session
 * has already granted.
 *
 * Returns:
 *   text        what to type into the prompt (trailing space, so whatever the
 *               user types next is not glued to the last path)
 *   dirsToAdd   folders to grant, already deduped and filtered
 *   refused     [{ dir, why }] -- grants deliberately NOT made, so the caller
 *               can say so rather than failing silently
 *   used        how many entries were typed
 *   truncated   how many were dropped on the floor by MAX_DROP_FILES
 */
function planDrop({ entries = [], cwd, alreadyGranted = [], home = null } = {}) {
  const usable = entries.filter(e => e && typeof e.path === 'string' && e.path.trim());
  const kept = usable.slice(0, MAX_DROP_FILES);

  const granted = new Set(alreadyGranted.map(canon));
  const dirsToAdd = [];
  const refused = [];

  for (const entry of kept) {
    // A dropped folder grants ITSELF. Granting its parent would widen the
    // permission well past what was dragged.
    const dir = entry.isDirectory ? entry.path : path.dirname(entry.path);

    if (isInside(dir, cwd)) continue;           // already readable; nothing to do
    if (granted.has(canon(dir))) continue;      // this session already granted it

    if (isRootish(dir)) {
      refused.push({ dir, why: 'a drive root is never granted' });
      continue;
    }
    if (home && canon(dir) === canon(home)) {
      refused.push({ dir, why: 'the home directory is never granted wholesale' });
      continue;
    }

    granted.add(canon(dir));
    dirsToAdd.push(dir);
  }

  const text = kept.length ? kept.map(e => quote(e.path)).join(' ') + ' ' : '';

  return {
    text,
    dirsToAdd,
    refused,
    used: kept.length,
    truncated: usable.length - kept.length,
  };
}

module.exports = { planDrop, MAX_DROP_FILES, canon, isInside, isRootish };
