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

// Every source file the Markdown bundle is made of besides the libraries (the hash covers them all).
const MARKDOWN_ENTRY_FILES = Object.freeze([
  ['build', 'markdown-entry.mjs'], ['build', 'markdown-render.mjs'], ['app', 'markdown-links.js'], ['app', 'external-link.js'], ['build', 'markdown-elk-stub.mjs'],
]);
const markdownEntryText = (read) => MARKDOWN_ENTRY_FILES.map((f) => read(...f)).join('\n--\n');

// What the Markdown bundle's notices must list (PR #204 Miguel Y3): the roots' dependency closure, less what is not
// shipped: elkjs is aliased out of the bundle (EPL-2.0, see build/markdown-elk-stub.mjs) and @types/* are type-only.
// Returns [{ name, version, key }] sorted, `key` the lockfile path (where the package's files are).
const NOT_SHIPPED = (name) => name === 'elkjs' || name.startsWith('@types/');
function noticePackages(lock) {
  const wanted = new Set(bundledVersions(lock, MARKDOWN_ROOTS).map((x) => x.replace(/@[^@]*$/, '')));
  const out = [];
  const pk = lock && lock.packages ? lock.packages : {};
  for (const [key, val] of Object.entries(pk)) {
    const m = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (m && wanted.has(m[1]) && !NOT_SHIPPED(m[1]) && val && typeof val.version === 'string') out.push({ name: m[1], version: val.version, key });
  }
  return out.sort((a, b) => (a.name + a.version + a.key).localeCompare(b.name + b.version + b.key));
}

module.exports = { inputsHash, bundledVersions, MARKDOWN_ROOTS, MARKDOWN_ENTRY_FILES, markdownEntryText, noticePackages };
