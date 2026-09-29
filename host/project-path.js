'use strict';
/**
 * Is this the same project folder?
 *
 * Two private normalizers already exist in this codebase and neither is
 * exported: `host/themes.js` lowercases (it matches registry keys), and
 * `host/fog.js` does not (it must preserve case to build relative paths for
 * display). They differ deliberately, so this is a third primitive rather than
 * a refactor of either -- the handshake needs one specific question answered,
 * `are these the same folder`, and needs it to fail closed.
 *
 * Windows semantics, because that is where this runs: the path is RESOLVED,
 * then separators are made interchangeable, a trailing separator means
 * nothing, and case means nothing.
 *
 * WHAT THIS STILL DOES NOT HANDLE, named so the header is not read as a
 * completeness claim (Dexter, PR #31 Finding 5): trailing dots and spaces,
 * which Win32 strips and Node does not; 8.3 short names (VIBECO~1); UNC versus
 * a mapped drive letter; and the \\?\ prefix. In the other direction, JS
 * `toLowerCase` is Unicode folding rather than the NTFS upcase table, so
 * U+0130 can fold two genuinely distinct directories together, as can a
 * directory flagged case-sensitive.
 *
 * The honest fix for all of those is a device+file-id comparison
 * (`fs.statSync().dev` / `.ino`), the only thing that gets junctions, 8.3 and
 * UNC-vs-mapped right in one move -- but it needs BOTH paths to exist, and
 * this is called on paths that may not. That is a design change rather than a
 * patch, and it is left as a follow-up instead of guessed at.
 *
 * ===========================================================================
 * TWO OF THOSE GAPS FAIL OPEN, AND THE COST CHANGED UNDER THEM. Dexter, PR #40,
 * Finding 4. This paragraph is the acceptance; read it before trusting the list
 * above, because the list was calibrated for a different blast radius.
 *
 * This header was written for `decideAttach`, where a wrong answer misroutes a
 * PORT. PR #40 made `samePath` decide **who can read a credential**
 * (app/secret-vault.js, `visibleFrom`). Every gap named above still fails
 * CLOSED in that role -- trailing dots and spaces, 8.3 names, UNC versus mapped
 * drive and the \\?\ prefix all make two spellings of ONE folder compare
 * UNEQUAL, so the user loses sight of their own secret. Annoying, and safe.
 *
 * These two do not. They make two DIFFERENT folders compare EQUAL, so project B
 * can list, reveal and copy project A's secrets:
 *
 *   1. UNICODE FOLDING. `C:\work\İstanbul` (U+0130) and `C:\work\i̇stanbul`
 *      (ASCII i + U+0307) are distinct NTFS directories -- the upcase table does
 *      not equate them -- and `toLowerCase` collapses both to one string.
 *      PINNED by a running test in test/project-path.test.js, asserting the
 *      wrong-and-current answer, so closing the gap turns that test red.
 *
 *   2. A CASE-SENSITIVE-FLAGGED DIRECTORY. `C:\work\Proj` and `C:\work\proj`
 *      are two folders under the Windows per-directory case-sensitivity flag --
 *      i.e. any WSL-created tree, which is ordinary on a developer machine.
 *      **This one cannot be pinned by any string-level test, and not because
 *      nobody wrote it:** `samePath('C:/work/Proj', 'C:/work/proj') === true` is
 *      CORRECT on an ordinary directory and WRONG under the flag. The predicate
 *      is not incorrect, it is missing information it cannot get without
 *      touching disk. It is also the MORE REACHABLE of the two.
 *
 * WHY THE CHEAP FIX IS REFUSED. Folding only ASCII closes (1), but it makes
 * every non-ASCII comparison case-SENSITIVE -- and this predicate still routes
 * window attach, where a false negative means `decideAttach` says
 * "other-project", `resolvePort` steps, and a second permission-bypassed
 * `claude` starts in a folder that already has one (see the note above on what
 * a false negative costs there). That trades a near-unreachable credential leak
 * for a reachable double-session, and it does not even close (2).
 *
 * So the choice is accept, or do the device+file-id change properly with its own
 * tests for the path-does-not-exist case. Accepted here, deliberately, and
 * recorded downstream in app/secret-vault.js as well -- but this is the
 * load-bearing copy, because this is the module that owns the gap.
 * ===========================================================================
 */

const path = require('path');

// Absence is not a path. Returning null here rather than the string 'null' is
// the whole reason `samePath(null, null)` is false: a coercing compare makes
// two missing values agree, and the handshake would then attach to a host
// whose project it could not identify.
function normalizeProjectPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;

  // RESOLVE FIRST. Without it the three transforms below miss everything
  // structural -- an unresolved `..`, a `.` segment, doubled separators
  // mid-path -- and each miss made `decideAttach` answer 'other-project',
  // which made `resolvePort` step, which started a SECOND host and a second
  // permission-bypassed claude in a folder that already had one.
  //
  // `path.resolve` is pure string arithmetic and never touches the disk, so
  // this stays safe on paths that do not exist, which samePath must support.
  let resolved;
  try {
    resolved = path.resolve(p);
  } catch {
    return null;                        // a path resolve refuses is not a path
  }

  const out = resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  // A path that normalizes away to nothing is ABSENT, not the empty string
  // (Finding 14). Callers test `=== null`, so '' would be a value that is
  // neither absent nor a path -- and portForCwd('') would hash it to a real
  // port quite happily.
  return out === '' ? null : out;
}

function samePath(a, b) {
  const x = normalizeProjectPath(a);
  const y = normalizeProjectPath(b);
  if (x === null || y === null) return false;
  return x === y;
}

/**
 * What to call a window showing this project. FF3.
 *
 * The window was titled `claude-custom — spike/terminal-fidelity`, hardcoded,
 * and still naming a spike branch. Once multi-project means two windows can be
 * open at once, the title is the ONLY thing distinguishing them in the taskbar,
 * in alt-tab, and in a thumbnail.
 *
 * Pure, and here rather than in main.js, because every interesting case is a
 * path edge case and none of them are reachable from a test inside main.js.
 * `path.basename` returns '' for a drive root and for a bare separator, and an
 * empty title is a window with no identity at all — worse than the long form
 * it replaces.
 */
function projectLabel(p) {
  if (typeof p !== 'string' || !p.trim()) return 'claude-custom';
  const trimmed = p.trim();
  // `win32` explicitly, not the ambient `path`. Miguel, PR #33, A10: on a
  // POSIX runner `path.basename('C:\\Users\\x\\proj')` returns the whole string, so
  // both this function and its five tests silently depended on which
  // machine ran them. win32.basename treats / and \\ alike, so it is
  // strictly the more permissive of the two and correct for a harness
  // whose own header says Windows is where it runs.
  //
  // No trailing-separator strip: A9, measured -- basename already does it,
  // and the class that was here (`[\\/]`) held only a forward slash, so it
  // would not have stripped a backslash even if it had been needed. Dead
  // code that read as load-bearing, credited in the doc comment above.
  const base = path.win32.basename(trimmed);
  if (base) return base;
  // A drive root, a bare separator, or anything else basename cannot name.
  return trimmed;
}

module.exports = { samePath, normalizeProjectPath, projectLabel };
