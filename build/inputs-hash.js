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

// The Markdown bundle (BACKLOG #119 A9) is made of three libraries and everything they pull in.
const MARKDOWN_ROOTS = Object.freeze(['marked', 'dompurify', 'mermaid']);

// ['@codemirror/state@6.7.6', ...], sorted. With `roots`: those packages and their whole dependency closure
// (every version of each name the lockfile holds), instead of the CodeMirror name pattern.
function bundledVersions(lock, roots) {
  const out = [];
  const pk = lock && typeof lock === 'object' && lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  const entries = [];
  for (const [key, val] of Object.entries(pk)) {
    const m = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (m && val && typeof val.version === 'string') entries.push({ name: m[1], val });
  }
  let wanted = (name) => BUNDLED.test(name);
  if (Array.isArray(roots)) {
    const names = new Set(roots);
    for (let grew = true; grew;) {
      grew = false;
      for (const { name, val } of entries) {
        if (!names.has(name)) continue;
        for (const field of ['dependencies', 'optionalDependencies']) {
          for (const dep of Object.keys((val && val[field]) || {})) if (!names.has(dep)) { names.add(dep); grew = true; }
        }
      }
    }
    wanted = (name) => names.has(name);
  }
  for (const { name, val } of entries) if (wanted(name)) out.push(`${name}@${val.version}`);
  return out.sort();
}

const lf = (s) => String(s).replace(/\r\n/g, '\n');

function inputsHash({ entry, builder, lock, roots } = {}) {
  const h = crypto.createHash('sha256');
  h.update('entry\n'); h.update(lf(entry));
  h.update('\nbuilder\n'); h.update(lf(builder));
  h.update('\nversions\n'); h.update(bundledVersions(lock, roots).join('\n'));
  return h.digest('hex');
}

module.exports = { inputsHash, bundledVersions, MARKDOWN_ROOTS };
