'use strict';
/**
 * PROPERTIES of the repo browser's path guard (#45).
 *
 *   P1  NO PATH OUTSIDE THE ROOT EVER PASSES. Whatever mix of `..`, `.`, forward and back slashes, case,
 *       drive letters and UNC prefixes is generated, if an independent segment-wise oracle says the path
 *       resolves outside the root, the guard refuses it.
 *   P2  ...and the converse for plain paths: a path the oracle puts inside, made only of ordinary names,
 *       is accepted (the guard isn't just refusing everything).
 *   P3  A path through a symlink or junction that leads out is refused, however it is spelled; a path that
 *       doesn't go through it is untouched. (realpath is modelled, so thousands of cases run at once.)
 *   P4  The rel the guard answers is forward-slashed, has no `..` segment, and joins back to the abs.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fc = require('fast-check');

const { lexical, guardPath } = require('../host/repo-guard');

const ROOT = 'C:\\proj\\feat-x';
const OUTSIDE = 'C:\\elsewhere';

const name = fc.constantFrom('a', 'src', 'lib', 'B.js', 'node_modules', 'feat-x', 'feat-x-other', 'proj', 'caf\u00e9', '..a', 'a..b');
const seg = fc.oneof({ weight: 5, arbitrary: name }, { weight: 3, arbitrary: fc.constant('..') }, { weight: 1, arbitrary: fc.constant('.') });
const sep = fc.constantFrom('/', '\\', '//', '\\/');
const prefix = fc.constantFrom('', '', '', ROOT + '\\', ROOT.toLowerCase() + '\\', ROOT.toUpperCase() + '/', 'C:\\proj\\', 'C:\\',
  'D:\\proj\\feat-x\\', '\\\\srv\\share\\', '\\\\?\\C:\\proj\\feat-x\\', '/', 'C:');
const input = fc.tuple(prefix, fc.array(fc.tuple(seg, sep), { minLength: 0, maxLength: 7 })).map(
  ([p, parts]) => p + parts.map(([s, x]) => s + x).join('').replace(/[\\/]+$/, ''));

// An oracle that shares no code with the guard: segment lists, lowercased, with .. applied by hand.
function oracleInside(raw) {
  let s = String(raw);
  let base;
  if (/^[A-Za-z]:[\\/]/.test(s)) { base = [s.slice(0, 2).toLowerCase()]; s = s.slice(3); }
  else if (/^[\\/]|^[A-Za-z]:/.test(s)) return false;              // rooted, UNC, device, drive-relative
  else base = ['c:', 'proj', 'feat-x'];
  const stack = [...base];
  for (const part of s.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (stack.length > 1) stack.pop(); continue; }
    stack.push(part.toLowerCase());
  }
  return stack.length >= 3 && stack[0] === 'c:' && stack[1] === 'proj' && stack[2] === 'feat-x';
}

test('P1: a path the oracle puts outside the root never passes lexically', () => {
  fc.assert(fc.property(input, (p) => {
    const r = lexical(ROOT, p);
    if (!oracleInside(p)) return r.ok === false;
    return true;
  }), { numRuns: 4000 });
});

test('P2: an ordinary path the oracle puts inside is accepted, and lands where the oracle says', () => {
  const plain = fc.array(fc.constantFrom('a', 'src', 'lib', 'B.js', 'caf\u00e9'), { minLength: 1, maxLength: 5 });
  fc.assert(fc.property(plain, sep, (parts, x) => {
    const p = parts.join(x);
    const r = lexical(ROOT, p);
    return r.ok === true && r.rel === parts.join('/') && oracleInside(p);
  }), { numRuns: 1000 });
});

test('P3: through a link that leads out is refused however it is spelled; elsewhere is untouched', async () => {
  // C:\proj\feat-x\link -> C:\elsewhere ; everything under the link really lives outside
  const realpath = async (p) => {
    const n = path.win32.normalize(p);
    const low = n.toLowerCase();
    const link = (ROOT + '\\link').toLowerCase();
    if (low === link || low.startsWith(link + '\\')) return OUTSIDE + n.slice(link.length);
    return n;
  };
  const inner = fc.array(fc.constantFrom('a', 'src', 'x.txt'), { minLength: 0, maxLength: 3 });
  const spell = fc.constantFrom('link', 'LINK', 'Link', 'src/../link', './link', 'link/.');
  await fc.assert(fc.asyncProperty(spell, inner, sep, async (l, rest, x) => {
    const p = [l, ...rest].join(x);
    const r = await guardPath(ROOT, p, { realpath });
    return r.ok === false;
  }), { numRuns: 500 });
  await fc.assert(fc.asyncProperty(inner, fc.constantFrom('src', 'lib'), async (rest, top) => {
    const r = await guardPath(ROOT, [top, ...rest].join('/'), { realpath });
    return r.ok === true;
  }), { numRuns: 300 });
});

test('P4: a successful answer is forward-slashed, has no .. and joins back to its abs', () => {
  fc.assert(fc.property(input, (p) => {
    const r = lexical(ROOT, p);
    if (!r.ok) return true;
    if (r.rel.includes('\\') || r.rel.split('/').includes('..')) return false;
    const joined = r.rel === '' ? ROOT : path.win32.join(ROOT, ...r.rel.split('/'));
    return joined.toLowerCase() === r.abs.toLowerCase();
  }), { numRuns: 3000 });
});
