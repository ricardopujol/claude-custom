'use strict';
/**
 * PROPERTIES of the Files tab's rows (#45).
 *   F1  the "Only what Claude touched" filter keeps EXACTLY the touched files: never drops one, never keeps
 *       an untouched one, each once.
 *   F2  ...whatever the listing and the expanded set are (the filter ignores both).
 *   F3  the folders drawn under the filter are exactly the folders above a touched file.
 *   F4  with the whole repo listed and open, a folder's badge number is the sum of the file badges beneath it
 *       (the roll-up from host/repo-overlay.js, drawn).
 *   F5  every row's depth is the number of slashes in its path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { rows } = require('../app/repo-tree-display');
const { rollUp } = require('../host/repo-overlay');
const { buildIndex } = require('../host/repo-index');

const seg = fc.constantFrom('a', 'b', 'src', 'lib', '__proto__', 'constructor', 'x.js', 'y.md', 'Z');
const pathArb = fc.array(seg, { minLength: 1, maxLength: 4 }).map(p => p.join('/'))
  // a name can't be both a file and a folder: keep the generated set a real tree
  ;
const treeArb = fc.uniqueArray(pathArb, { maxLength: 25 }).map((paths) => {
  const files = new Set();
  const dirs = new Set();
  for (const p of paths.sort((a, b) => a.length - b.length)) {
    const parts = p.split('/');
    let ok = !files.has(p) && !dirs.has(p);
    for (let i = 1; i < parts.length && ok; i++) if (files.has(parts.slice(0, i).join('/'))) ok = false;
    if (!ok) continue;
    files.add(p);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...files].filter(f => !dirs.has(f));
});
const touchedArb = (files) => fc.subarray(files).chain(sub => fc.array(fc.tuple(fc.constantFrom('edited', 'read'), fc.integer({ min: 1, max: 6 })), { minLength: sub.length, maxLength: sub.length })
  .map(meta => sub.map((path, i) => ({ path, tier: meta[i][0], edits: meta[i][0] === 'edited' ? meta[i][1] : 0 }))));

function childrenOf(files) {
  const ix = buildIndex(files);
  const m = new Map();
  const walk = (d) => { const c = ix.children(d); if (!c) return; m.set(d, c); for (const e of c) if (e.kind === 'dir') walk(e.path); };
  walk('');
  return m;
}
const allDirs = (children) => new Set([...children.keys()].filter(k => k !== ''));

test('F1 + F2: the filter keeps exactly the touched files, whatever is listed or expanded', () => {
  fc.assert(fc.property(treeArb.chain(files => fc.tuple(fc.constant(files), touchedArb(files), fc.boolean())), ([files, touched, openAll]) => {
    const children = childrenOf(files);
    const out = rows({ children, expanded: openAll ? allDirs(children) : new Set(), overlay: rollUp(touched), onlyTouched: true });
    const got = out.filter(r => r.kind === 'file').map(r => r.path);
    const want = touched.map(t => t.path);
    return got.length === new Set(got).size && got.length === want.length && want.every(p => got.includes(p));
  }), { numRuns: 800 });
});

test('F3: under the filter, the folders drawn are exactly the folders above touched files', () => {
  fc.assert(fc.property(treeArb.chain(files => touchedArb(files)), (touched) => {
    const out = rows({ children: new Map(), expanded: new Set(), overlay: rollUp(touched), onlyTouched: true });
    const want = new Set();
    for (const t of touched) { const parts = t.path.split('/'); for (let i = 1; i < parts.length; i++) want.add(parts.slice(0, i).join('/')); }
    const got = out.filter(r => r.kind === 'dir').map(r => r.path);
    return got.length === want.size && got.every(g => want.has(g));
  }), { numRuns: 800 });
});

test('F4: with everything listed and open, a folder\'s badge is the sum of the badges beneath it', () => {
  const n = (badge) => (badge ? Number(badge.slice(1)) : 0);
  fc.assert(fc.property(treeArb.chain(files => fc.tuple(fc.constant(files), touchedArb(files))), ([files, touched]) => {
    const children = childrenOf(files);
    const out = rows({ children, expanded: allDirs(children), overlay: rollUp(touched) });
    return out.filter(r => r.kind === 'dir').every((d) => {
      const sum = out.filter(r => r.kind === 'file' && r.path.startsWith(d.path + '/')).reduce((acc, r) => acc + n(r.badge), 0);
      return n(d.badge) === sum;
    });
  }), { numRuns: 800 });
});

test('F5: every row\'s depth is the number of slashes in its path', () => {
  fc.assert(fc.property(treeArb.chain(files => fc.tuple(fc.constant(files), touchedArb(files), fc.boolean())), ([files, touched, only]) => {
    const children = childrenOf(files);
    const out = rows({ children, expanded: allDirs(children), overlay: rollUp(touched), onlyTouched: only });
    return out.filter(r => r.kind === 'file' || r.kind === 'dir').every(r => r.depth === r.path.split('/').length - 1);
  }), { numRuns: 800 });
});
