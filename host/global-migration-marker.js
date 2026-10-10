'use strict';
/**
 * The one-shot marker for the default-picture migration (host/global-portrait-store.js).
 *
 * It lives in the user-wide root, NEXT to `_global\` and not inside it, so "Reset to none" (which
 * removes `_global\default.*`) can't remove it. Without it a Reset would empty the folder and the
 * next host start would adopt the old per-install picture straight back (PR #151 D1 / Miguel B1).
 * Written once the user-wide default has been decided: adopted, set, reset, or found already there.
 */

const fs = require('fs');
const path = require('path');

const MARKER_NAME = '.default-picture-migrated';

function markerPath(userDir) {
  return path.join(userDir, MARKER_NAME);
}

function isMarked(userDir) {
  try { return fs.statSync(markerPath(userDir)).isFile(); } catch { return false; }
}

// Best effort: a marker that can't be written must never fail the action it follows.
function writeMarker(userDir, { mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {}) {
  if (!userDir) return false;
  try {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(markerPath(userDir), `${new Date().toISOString()}\n`);
    return true;
  } catch { return false; }
}

module.exports = { MARKER_NAME, markerPath, isMarked, writeMarker };
