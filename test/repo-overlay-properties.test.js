'use strict';
/**
 * PROPERTIES of the overlay roll-up (#45).
 *   R1  a folder's edits / edited / read counts are EXACTLY the sums over the files under it.
 *   R2  every ancestor of a touched file has a row, and no other folder does.
 *   R3  the root's edits equal the total over all files.
 *   R4  the order of the input changes nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { rollUp } = require('../host/repo-overlay');

const seg = fc.constantFrom('a', 'b', 'src', 'lib', '__proto__', 'constructor', 'x.js', 'y.md');
const pathArb = fc.array(seg, { minLength: 1, maxLength: 4 }).map(p => p.join('/'));
const entry = fc.record({ path: pathArb, tier: fc.constantFrom('edited', 'read'), edits: fc.integer({ min: 1, max: 9 }) });
const entries = fc.array(entry, { maxLength: 30 });

// the de-duplication the module promises: one row per path, edited beats read, counts add
function expected(list) {
  const m = new Map();
  for (const e of list) {
    const cur = m.get(e.path);
    const edits = e.tier === 'edited' ? e.edits : 0;
    if (!cur) m.set(e.path, { tier: e.tier, edits });
    else { cur.edits += edits; if (e.tier === 'edited') cur.tier = 'edited'; }
  }
  return m;
}
const under = (d, p) => d === '' || p.startsWith(d + '/');

test('R1: every folder is the exact sum of the files under it', () => {
  fc.assert(fc.property(entries, (list) => {
    const o = rollUp(list);
    const files = expected(list);
    return o.dirs.every((d) => {
      let edits = 0, edited = 0, read = 0;
      for (const [p, v] of files) {
        if (!under(d.path, p)) continue;
        edits += v.edits;
        if (v.tier === 'edited') edited++; else read++;
      }
      return d.edits === edits && d.edited === edited && d.read === read;
    });
  }), { numRuns: 1500 });
});

test('R2: a folder has a row exactly when a touched file is somewhere under it', () => {
  fc.assert(fc.property(entries, (list) => {
    const o = rollUp(list);
    const files = [...expected(list).keys()];
    const want = new Set(['']);
    for (const p of files) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) want.add(parts.slice(0, i).join('/')); }
    const got = o.dirs.map(d => d.path);
    return got.length === new Set(got).size && got.length === (files.length ? want.size : 0) && got.every(g => want.has(g));
  }), { numRuns: 1500 });
});

test('R3: the root carries the grand total', () => {
  fc.assert(fc.property(entries, (list) => {
    const o = rollUp(list);
    const total = [...expected(list).values()].reduce((n, v) => n + v.edits, 0);
    const root = o.dirs.find(d => d.path === '');
    return list.length === 0 ? o.dirs.length === 0 : root.edits === total;
  }), { numRuns: 1000 });
});

test('R4: the order of the input changes nothing', () => {
  fc.assert(fc.property(entries, fc.integer(), (list, k) => {
    const rot = list.length ? Math.abs(k) % list.length : 0;
    const shuffled = [...list.slice(rot), ...list.slice(0, rot)].reverse();
    const norm = (o) => JSON.stringify({
      f: [...o.files].sort((a, b) => a.path.localeCompare(b.path)),
      d: [...o.dirs].sort((a, b) => a.path.localeCompare(b.path)),
    });
    return norm(rollUp(list)) === norm(rollUp(shuffled));
  }), { numRuns: 800 });
});
