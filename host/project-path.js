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
 * Windows semantics, because that is where this runs: separators are
 * interchangeable, a trailing separator means nothing, and case means nothing.
 */

// Absence is not a path. Returning null here rather than the string 'null' is
// the whole reason `samePath(null, null)` is false: a coercing compare makes
// two missing values agree, and the handshake would then attach to a host
// whose project it could not identify.
function normalizeProjectPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
  const x = normalizeProjectPath(a);
  const y = normalizeProjectPath(b);
  if (x === null || y === null) return false;
  return x === y;
}

module.exports = { samePath, normalizeProjectPath };
