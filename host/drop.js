'use strict';
/**
 * What happens when files are dropped on the window.
 *
 * Ricardo: "The possibility to drag and drop files and make them visible to
 * the session." Offered three strengths, he chose the strong one: type the
 * path AND grant the session read access to the file's folder, so Claude can
 * open it without a permission prompt.
 *
 * THIS IS A SECURITY BOUNDARY -- but be precise about WHICH one, or the guards
 * below get mistaken for something they are not.
 *
 * `host/host.js` already accepts `{type:'input'}` and writes it to the pty
 * unvalidated, so an authenticated socket client already owns the session
 * completely; nothing here changes that, and `host/gatekeeper.js` is what
 * stands between a web page and the pty. The actor THIS module defends against
 * is narrower: **a filename on disk**, and the human hand that drags it. An
 * archive, a cloned repo or a network share can carry a name containing a
 * newline; a misaimed drag can come from `C:\Users`, or from a junction that
 * points at the drive root. Accidents and hostile artifacts -- which is exactly
 * what these refusals are sized for.
 *
 * EVERY REFUSAL HERE WAS ADDED AFTER IT WAS BYPASSED. Dexter and Miguel,
 * merge-gate review 2026-09-17, against the first version of this file. All of
 * these were reproduced, not theorised:
 *
 *   - `C:\Users\ricar\Desktop\..\..\..` was GRANTED with no refusal reported,
 *     because every predicate was computed over the STRING rather than the path
 *     it denotes. `/add-dir` resolves it to `C:\` -- the whole drive.
 *   - `\\nas\public` (a share root) and `\\?\C:\` were granted, though the
 *     comment claimed both were refused. The UNC regex matched only `//server`,
 *     which is not a path anyone can drop from -- a dead branch standing in for
 *     a guard.
 *   - `C:\Users` was granted: every profile, including the home directory the
 *     module promised never to grant. Home was refused by EQUALITY, so all of
 *     its ancestors walked past.
 *   - `.ssh`, `.aws`, `.gnupg`, `.claude` and `AppData` were all grantable --
 *     "you blocked the room and left the drawers and the corridor."
 *   - A path containing `\r` was QUOTED and typed. A pty has no quoting layer,
 *     only keystrokes: the CR is Enter. It submitted the prompt and typed the
 *     remainder as a second command.
 *   - With no `cwd`, every drop granted. This repo's own `gatekeeper.js` says
 *     it plainly: "a misconfigured host that accepted everything would be worse
 *     than the bug."
 *
 * So: resolve first, judge the resolved path, refuse rather than sanitise, and
 * fail closed. `planDrop` stays PURE -- the caller injects `cwd`, `home` and
 * whether each entry is a directory -- but it no longer TRUSTS its input to be
 * normalised.
 *
 * ONE THING IT STILL CANNOT SEE: a symlink or junction. `mklink /J` needs no
 * elevation on Windows, and a junction named like a file defeats every check
 * here because the string is innocent and the target is not. The CALLER must
 * hand over real paths (`fs.realpathSync`); `handleDrop` in host/host.js does.
 */

const path = require('path');

// One drag can carry a whole folder. Past a couple of dozen the prompt is
// unusable anyway, and a thousand paths typed into a pty wedges the session.
const MAX_DROP_FILES = 25;

// Anything a terminal treats as input rather than text. REFUSED, never escaped:
// a pty has no quoting layer, so `\r` is Enter whatever it sits between -- and
// a path we had to rewrite is no longer the path that was dropped, which makes
// refusing the honest answer as well as the safe one.
const TERMINAL_UNSAFE = /[\u0000-\u001f\u007f]/;

// Never granted, whatever route the drag takes to them. Matched against the
// path's own segments, so `C:\Users\r\.ssh` and `/home/r/.ssh` are both caught.
const SENSITIVE_SEGMENTS = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.gpg', '.config', '.claude', '.azure', '.kube',
  '.docker', 'appdata', '.password-store',
]);

// Absolute locations never granted regardless of where home is.
const SENSITIVE_ROOTS = Object.freeze([
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata',
  '/etc', '/var', '/usr', '/bin', '/sbin', '/system', '/library',
]);

const BACKSLASH = String.fromCharCode(92);
const LONG_PREFIX_UNC = new RegExp('^' + BACKSLASH.repeat(4) + '\\?' + BACKSLASH.repeat(2) + 'UNC' + BACKSLASH.repeat(2), 'i');
const LONG_PREFIX = new RegExp('^' + BACKSLASH.repeat(4) + '\\?' + BACKSLASH.repeat(2));
const ALL_BACKSLASHES = new RegExp(BACKSLASH.repeat(2), 'g');

// The Windows extended-length prefix is stripped so the path underneath is the
// thing judged: `\\?\C:\x` is `C:\x`, `\\?\UNC\srv\share` is `\\srv\share`.
function stripLongPrefix(p) {
  return String(p == null ? '' : p).trim()
    .replace(LONG_PREFIX_UNC, BACKSLASH + BACKSLASH)
    .replace(LONG_PREFIX, '');
}

// Judge a path in ITS OWN dialect, not the host's. A POSIX path run through
// path.win32.resolve acquires a drive letter ("/home" becomes "C:/home"), which
// silently changes what every predicate below is looking at.
function flavourFor(p) {
  const s = String(p == null ? '' : p);
  if (/^[a-zA-Z]:/.test(s) || s.startsWith(BACKSLASH + BACKSLASH)) return path.win32;
  if (s.startsWith('/')) return path.posix;
  return path.win32.isAbsolute(s) ? path.win32 : path;
}

/**
 * The COMPARISON KEY for a path: slash-normalised, trailing-slash-stripped,
 * lowercased. Never the string typed into the pty, which must keep its real
 * case. Windows is case-insensitive and so, by default, is macOS -- the first
 * version folded case only for win32, so `/Users/r/Docs` and `/Users/r/docs`
 * were two different folders on a Mac.
 */
function normSlashes(p) {
  const s = stripLongPrefix(p).replace(ALL_BACKSLASHES, '/').replace(/(.)\/+$/, '$1');
  return s.toLowerCase();
}

/**
 * The resolved absolute path, in its own dialect and ORIGINAL CASE. This is
 * what gets granted and typed.
 *
 * Returns '' for anything not absolute: a relative path has no single meaning
 * here, and resolving it against whatever cwd the host happens to have would
 * invent one.
 */
function canon(p) {
  const stripped = stripLongPrefix(p);
  if (!stripped) return '';
  const flavour = flavourFor(stripped);
  if (!flavour.isAbsolute(stripped)) return '';
  // resolve() collapses `..` and `.` without touching the filesystem.
  return flavour.resolve(stripped);
}

const isInside = (child, parent) => {
  const c = normSlashes(child);
  const p = normSlashes(parent);
  return !!p && !!c && (c === p || c.startsWith(p + '/'));
};

/**
 * A drive root, a filesystem root, or a UNC SHARE root.
 *
 * The share root is the case the first version missed: its regex matched only
 * `//server`, while `//server/share` -- the thing that exists and mounts an
 * entire share -- sailed through.
 */
function isRootish(dir) {
  const s = normSlashes(dir);
  if (!s) return true;                                   // '' or '/'
  if (/^[a-z]:$/.test(s)) return true;                   // c:
  if (s.startsWith('//')) {                              // UNC
    const segs = s.slice(2).split('/').filter(Boolean);
    return segs.length <= 2;                             // //server, //server/share
  }
  if (!s.includes('/')) return true;
  return false;
}

// Why this directory may not be granted, or null if it may. Every comparison is
// on the normalised key, never on the display path.
function refusalFor(dir, { home }) {
  if (!dir) return 'the path is not absolute, so there is nothing safe to grant';
  const key = normSlashes(dir);
  if (isRootish(key)) return 'a drive, share or filesystem root is never granted';

  const homeKey = home ? normSlashes(home) : '';
  if (homeKey) {
    if (key === homeKey) return 'the home directory is never granted wholesale';
    // ANCESTORS too: equality alone let `C:\Users` through, which contains home
    // and every other profile on the machine.
    if (isInside(homeKey, key)) return 'this directory contains the home directory';
  }

  for (const seg of key.split('/')) {
    if (SENSITIVE_SEGMENTS.includes(seg)) return '"' + seg + '" holds credentials and is never granted';
  }
  for (const root of SENSITIVE_ROOTS) {
    if (key === root || key.startsWith(root + '/')) return 'a system directory is never granted';
  }
  return null;
}

// Quoted only when it needs to be -- the prompt is read by a person, and
// unnecessary quotes are noise they have to delete. Control characters are
// never quoted, because quoting cannot contain them: such entries are refused
// before they reach here.
const quote = p => (/[\s"]/.test(p) ? '"' + p.replace(/"/g, BACKSLASH + '"') + '"' : p);

/**
 * Decide what a drop should do. PURE: the caller supplies everything.
 *
 * Returns:
 *   text        what to type (trailing space, so the next thing typed is not
 *               glued to the last path)
 *   dirsToAdd   folders to grant: resolved, deduped, filtered
 *   refused     [{ dir, why }] -- grants deliberately NOT made, so the caller
 *               can say so rather than failing silently
 *   used        entries whose paths were typed
 *   truncated   entries dropped by MAX_DROP_FILES
 *   unusable    entries with no usable or terminal-safe path
 */
function planDrop({ entries = [], cwd, home = null, alreadyGranted = [] } = {}) {
  const all = Array.isArray(entries) ? entries : [];

  const safe = [];
  const refused = [];
  let unusable = 0;

  for (const e of all) {
    const raw = e && typeof e.path === 'string' ? e.path.trim() : '';
    if (!raw) { unusable++; continue; }
    if (TERMINAL_UNSAFE.test(raw)) {
      // Refused, not sanitised, and SAID OUT LOUD -- a file whose name carries
      // a carriage return is the one case where silence would be worst.
      unusable++;
      refused.push({ dir: null, why: 'the file name contains a character a terminal reads as input' });
      continue;
    }
    safe.push({ path: raw, isDirectory: !!(e && e.isDirectory) });
  }

  const kept = safe.slice(0, MAX_DROP_FILES);

  // FAIL CLOSED. Without a project root we cannot tell what is already
  // readable, so nothing is granted -- but the paths are still typed, so the
  // drop is not silently useless and Claude can ask the ordinary way.
  const haveCwd = !!(cwd && String(cwd).trim());
  if (!haveCwd && kept.length) {
    refused.push({ dir: null, why: 'no project root supplied, so nothing can be granted safely' });
  }

  const granted = new Set(alreadyGranted.map(normSlashes).filter(Boolean));
  const dirsToAdd = [];

  if (haveCwd) {
    for (const entry of kept) {
      const resolved = canon(entry.path);
      // A dropped folder grants ITSELF; granting its parent would widen the
      // permission well past what was dragged.
      const dir = entry.isDirectory
        ? resolved
        : (resolved ? flavourFor(resolved).dirname(resolved) : '');

      if (isInside(dir, cwd)) continue;            // already readable

      // The refusal is decided BEFORE the dedupe. The other order let an
      // already-granted root `continue` past the checks, so the notice the
      // whole design leans on silently disappeared.
      const why = refusalFor(dir, { home });
      if (why) { refused.push({ dir: dir || entry.path, why }); continue; }

      const key = normSlashes(dir);
      if (granted.has(key)) continue;
      granted.add(key);
      dirsToAdd.push(dir);
    }
  }

  const text = kept.length ? kept.map(e => quote(e.path)).join(' ') + ' ' : '';

  return {
    text,
    dirsToAdd,
    refused,
    used: kept.length,
    truncated: safe.length - kept.length,
    unusable,
  };
}

module.exports = {
  planDrop, MAX_DROP_FILES, canon, normSlashes, isInside, isRootish, quote,
  TERMINAL_UNSAFE, SENSITIVE_SEGMENTS, SENSITIVE_ROOTS,
};
