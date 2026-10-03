'use strict';
/**
 * A hash of everything the CodeMirror bundle is built from (PR #95 Miguel M3): the entry, the build script and
 * the lockfile's resolved versions of the packages that end up in it. build/build-reader.mjs writes it into the
 * bundle's header; test/bundle-fresh.test.js recomputes it, so a bumped dependency or an edited entry with no
 * rebuild fails a test instead of shipping a bundle that no longer matches its source.
 *
 * Line endings are normalised (a Windows checkout is CRLF, the repository LF), and only packages that are part
 * of the bundle count: an unrelated dependency bump must not invalidate it.
 */
const crypto = require('crypto');

const BUNDLED = /^(@codemirror\/|@lezer\/|@marijn\/)|^(esbuild|style-mod|crelt|w3c-keyname)$/;

// ['@codemirror/state@6.7.6', ...], sorted
function bundledVersions(lock) {
  const out = [];
  const pk = lock && typeof lock === 'object' && lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  for (const [key, val] of Object.entries(pk)) {
    const m = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (m && BUNDLED.test(m[1]) && val && typeof val.version === 'string') out.push(`${m[1]}@${val.version}`);
  }
  return out.sort();
}

const lf = (s) => String(s).replace(/\r\n/g, '\n');

function inputsHash({ entry, builder, lock } = {}) {
  const h = crypto.createHash('sha256');
  h.update('entry\n'); h.update(lf(entry));
  h.update('\nbuilder\n'); h.update(lf(builder));
  h.update('\nversions\n'); h.update(bundledVersions(lock).join('\n'));
  return h.digest('hex');
}

module.exports = { inputsHash, bundledVersions };
