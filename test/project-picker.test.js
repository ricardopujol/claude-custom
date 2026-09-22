'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { pickerPayload, createProjectsReader, PICKER_LIMIT } = require('../host/project-picker');

const recent = (p, over = {}) => ({
  path: p, name: p.split('/').pop(), approximate: false,
  lastUsed: 1, tokens: 0, sessions: 1, ...over,
});

test('the project you are in is marked, however it is spelled', () => {
  // recent.js reads the cwd out of a transcript; the host knows its own from an
  // environment variable. Nothing guarantees the two agree on slashes or case,
  // and an unmarked current project means the picker offers to open the window
  // you are already looking at.
  const out = pickerPayload({
    recents: [recent('C:/a/thing'), recent('C:/b/other')],
    current: 'c:\\a\\thing\\',
  });
  assert.deepStrictEqual(out.projects.map(p => p.current), [true, false]);
});

test('a long history is capped, keeping the most recent', () => {
  // recent.js returns everything under ~/.claude/projects, which on this
  // machine is already dozens. A sidebar panel that scrolls forever is a worse
  // way to find a project than the file explorer it replaces.
  const many = [];
  for (let i = 0; i < 40; i++) many.push(recent(`C:/p/${i}`, { lastUsed: 1000 - i }));
  // `current` is one of the listed projects, so nothing is prepended and the
  // ordering assertion is about the history alone. Writing this with an
  // unlisted current tested two rules at once and could not distinguish which
  // one had broken.
  const out = pickerPayload({ recents: many, current: 'C:/p/0' });
  assert.strictEqual(out.projects.length, PICKER_LIMIT);
  assert.strictEqual(out.projects[0].path, 'C:/p/0', 'most recent first');
});

test('an empty history still shows the project you are in, and reports WHY it is empty', () => {
  // Two different silences that an empty array cannot tell apart, and this
  // codebase has paid for conflating them before: a fresh machine with no
  // ~/.claude/projects, versus a read that failed. `ok` carries the difference
  // so the panel can say which.
  //
  // Either way the current project is listed: a picker showing nothing at all,
  // while you are demonstrably inside a project, reads as broken.
  const fresh = pickerPayload({ recents: [], current: 'C:/a' });
  assert.strictEqual(fresh.ok, true);
  assert.deepStrictEqual(fresh.projects.map(p => p.path), ['C:/a']);

  const failed = pickerPayload({ recents: null, current: 'C:/a' });
  assert.strictEqual(failed.ok, false, 'a failed read is NOT an empty history');
  assert.deepStrictEqual(failed.projects.map(p => p.path), ['C:/a']);
});

test('the current project is always offered, even if it has no transcript yet', () => {
  // You can open a brand new folder. It has no history, so recent.js cannot
  // know about it, and the panel would show every project EXCEPT the one you
  // are in -- which reads as the picker being broken.
  const out = pickerPayload({ recents: [recent('C:/a/thing')], current: 'C:/brand/new' });
  const current = out.projects.filter(p => p.current);
  assert.strictEqual(current.length, 1);
  assert.strictEqual(current[0].path, 'C:/brand/new');
});

test('the synthesized current project claims NO usage, rather than zero usage', () => {
  // FOUND BY RENDERING. The panel drew "0 tokens" under a brand new project,
  // and that is a claim -- it says this project has been worked on for nothing,
  // when the truth is that it has no transcripts to read yet. I wrote a test in
  // projects-display.test.js against exactly this and then introduced it here,
  // in the row that module is handed, which is the more interesting half of the
  // lesson: the absence rule has to hold at the SOURCE, not only at the drawing.
  const out = pickerPayload({ recents: [], current: 'C:/brand/new' });
  assert.strictEqual(out.projects[0].tokens, null);
  assert.strictEqual(out.projects[0].sessions, null);

  // Mortimer Survivor 9: and it must not claim to be APPROXIMATE. The current
  // project's path came from the environment and is exact; marked approximate
  // it gains the "recovered from the folder name" tooltip, which would be a
  // false statement shown to the user -- and would make the row unopenable
  // under Dexter's Finding 6 fix.
  assert.strictEqual(out.projects[0].approximate, false);
});

test('the reader keeps ONE cache across calls, and asks for the limit it draws', () => {
  // MEASURED, and the reason this test exists at all: host/recent.js takes a
  // `cache` keyed on mtime+size precisely because a full read is expensive --
  // its own header records 3s across 71 projects and calls that "far too slow
  // for a launcher". The first version of the picker called it with no
  // arguments, so every panel open re-read every transcript:
  //
  //   no cache   2052ms, 3036ms, 3934ms   (and growing, as transcripts grow)
  //   one cache  1699ms, 8ms, 7ms, 6ms
  //
  // That read is SYNCHRONOUS, and the host's event loop is what delivers hook
  // events -- the same reason host/renderer.js asks for the fog on demand and
  // frets about 175ms. Two seconds of it is a different order of problem.
  // MIGUEL, PR #31: the previous version of this test asserted only that the
  // same OBJECT was passed twice, using a stub that never read or wrote the
  // cache -- so everything the measurements above promise was unverified by
  // the assertions below them. That is the overclaim, and it is mine.
  //
  // This stub now behaves like host/recent.js does: it reads the cache, and
  // writes to it on a miss. The assertion is then about CACHING rather than
  // about argument identity, and it fails if the cache is not honoured.
  const seen = [];
  let reads = 0;
  const read = (opts) => {
    seen.push(opts);
    const key = 'transcript|1|2';
    if (opts.cache && opts.cache[key]) return opts.cache[key];
    reads++;                                  // a MISS: the expensive path
    const rows = [{ path: 'C:/a', name: 'a' }];
    if (opts.cache) opts.cache[key] = rows;
    return rows;
  };
  const reader = createProjectsReader({ read });

  const first = reader();
  const second = reader();
  assert.strictEqual(seen.length, 2, 'both calls reach the reader');
  assert.strictEqual(reads, 1, 'the SECOND call must be served from the cache, not re-read');
  assert.deepStrictEqual(second, first, 'and must return the same rows');
  assert.strictEqual(seen[0].cache, seen[1].cache, 'one cache, held across calls');
  assert.strictEqual(seen[0].limit, PICKER_LIMIT, 'reading more rows than are drawn is wasted work');

  // The cache must be a PLAIN OBJECT, not a Map. host/recent.js indexes it with
  // bracket syntax (`cache[key]`), and a Map accepts expando properties -- so a
  // Map works while `map.size` stays 0 and `map.get(key)` is undefined. It
  // functions entirely by accident, and the day someone tidies recent.js to
  // .get()/.set() every lookup becomes a miss, silently restoring a 3.9s
  // SYNCHRONOUS stall on the event loop that owes the hook helper 80ms.
  assert.strictEqual(seen[0].cache instanceof Map, false,
    'a Map here works only by accident; the two modules must agree on the type');
});

test('a picker with NO current project renders instead of throwing', () => {
  // Mortimer Survivor 7. `typeof current === 'string'` -> `true` survived
  // because every test here passes a current string -- and with the type guard
  // gone, `current.trim()` on undefined throws. Not hypothetical: handshake.js's
  // own header says main.js reads this from an environment variable and that
  // "unset is an ordinary input, not a programming error". The sibling module
  // treats absence as routine while this one was untested against it.
  const out = pickerPayload({ recents: [recent('C:/a')] });      // no `current`
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.projects.map(x => x.path), ['C:/a']);
  assert.strictEqual(out.projects.some(x => x.current), false);
  assert.deepStrictEqual(pickerPayload().projects, [], 'and no payload at all is not a crash');
});

test('the synthesized current row is named after its folder', () => {
  // Mortimer Survivor 8, 8 mutants on one line: nothing anywhere read
  // projects[].name, so the row's visible label could have been the boolean
  // `true` and the suite would have been silent.
  const B = String.fromCharCode(92);
  const name = (current) => pickerPayload({ recents: [], current }).projects[0].name;
  assert.strictEqual(name('C:/brand/new'), 'new');
  assert.strictEqual(name(`C:${B}brand${B}new${B}${B}`), 'new', 'trailing separators are not the name');
  // NOT 'C:/' -- Mortimer's prescribed assertion said it would be, and it is
  // not. Stripping the trailing separator leaves 'C:', which is truthy, so the
  // `|| current` fallback never fires. 'C:' is a reasonable label for a drive
  // root, so this pins the real behaviour rather than bending the code to a
  // prescription. His kills are reasoned, not executed, and he said as much.
  assert.strictEqual(name('C:/'), 'C:', 'a drive root is named for the drive');

  // Survivor 8's other half: a whitespace-only current must not be prepended
  // as a project whose path is '   '.
  assert.deepStrictEqual(
    pickerPayload({ recents: [recent('C:/a')], current: '   ' }).projects.map(x => x.path),
    ['C:/a'], 'a blank cwd is not a project');
});

test('PICKER_LIMIT is pinned to a literal, not to itself', () => {
  // Same trap as PORT_SPAN, same reason (Mortimer). The cap test above asserts
  // `projects.length === PICKER_LIMIT` with the constant on both sides, so it
  // cannot fail when the constant moves -- and Stryker generates no mutant for
  // a numeric literal, so nothing else was watching it either.
  assert.strictEqual(PICKER_LIMIT, 12, 'changing how many projects are shown needs a reason');
});
