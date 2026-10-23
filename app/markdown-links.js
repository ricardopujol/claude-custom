'use strict';
/**
 * Which href in a rendered Markdown page opens where (BACKLOG #119 A9). Pure; the reader's Markdown bundle
 * (build/markdown-entry.mjs) includes this file, and the tests require it directly.
 *
 *   classifyHref(href, { fromFile }) -> { kind, target, fragment? }
 *     file    { target: 'documentation/x.md', fragment }  a path inside the worktree, worktree-relative with forward
 *                     slashes. `fromFile` is the worktree-relative path of the file being read; a relative href
 *                     resolves against its folder. The reader opens it (and refuses what it can't show).
 *     http    { target: 'https://...' }  http(s) only, no credentials: app/external-link.js is the rule. The click
 *                     goes through the harness to the person's browser.
 *     anchor  { target: 'the heading' }  scrolls inside the page.
 *     inert   { target: null }  everything else: mailto:, javascript:, file:, data:, ms-settings:..., a rooted,
 *                     drive or UNC path, a path that climbs out of the worktree, alternate data streams, names
 *                     Windows would rewrite (a trailing dot or space), a folder, and any href with a control
 *                     character in it (a browser strips tabs and newlines inside a scheme, so `java\tscript:` is a
 *                     javascript: link to it). Shown dim; does nothing.
 *
 * A file target never has `..`, a drive, a colon or a backslash in it, whatever the href held (test/markdown-links
 * .test.js states that as a property): percent-escapes are decoded BEFORE the dots are resolved, so `%2e%2e` climbs
 * no better than `..`.
 */
const { externalUrl } = require('./external-link');

const INERT = Object.freeze({ kind: 'inert', target: null });
const MAX_HREF = 8192;
// C0 and C1 controls, zero-width and bidi marks, line/paragraph separators, BOM
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

function classifyHref(href, { fromFile } = {}) {
  if (typeof href !== 'string') return INERT;
  const h = href.trim();
  if (h === '' || h.length > MAX_HREF || HIDDEN.test(h)) return INERT;

  if (h.startsWith('#')) {
    const frag = decode(h.slice(1));
    if (frag === null || frag === '' || HIDDEN.test(frag)) return INERT;
    return { kind: 'anchor', target: frag };
  }

  if (SCHEME.test(h)) {                                        // includes `C:\x`: a one-letter scheme is no web link either
    const url = /^https?:/i.test(h) ? externalUrl(h) : null;
    return url ? { kind: 'http', target: url } : INERT;
  }
  if (/^[\\/]/.test(h)) return INERT;                          // rooted, UNC and protocol-relative

  if (typeof fromFile !== 'string' || fromFile === '') return INERT;
  const hashAt = h.indexOf('#');
  const rawFrag = hashAt === -1 ? '' : h.slice(hashAt + 1);
  let rawPath = hashAt === -1 ? h : h.slice(0, hashAt);
  const q = rawPath.indexOf('?');
  if (q !== -1) rawPath = rawPath.slice(0, q);
  const decoded = decode(rawPath);
  const fragment = decode(rawFrag);
  if (decoded === null || fragment === null || HIDDEN.test(decoded) || HIDDEN.test(fragment)) return INERT;
  const rel = decoded.replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('/') || rel.endsWith('/') || rel.includes(':')) return INERT;

  const base = fromFile.replace(/\\/g, '/').split('/');
  base.pop();                                                  // the folder of the file being read
  const out = base.filter((s) => s !== '');
  const segs = rel.split('/');
  if (segs[segs.length - 1] === '.' || segs[segs.length - 1] === '..') return INERT;   // names a folder
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length === 0) return INERT; out.pop(); continue; }
    if (/[. ]$/.test(seg)) return INERT;                       // Windows strips a trailing dot or space: two names for one file
    out.push(seg);
  }
  if (out.length === 0) return INERT;
  return { kind: 'file', target: out.join('/'), fragment };
}

module.exports = { classifyHref, MAX_HREF };
