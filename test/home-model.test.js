'use strict';
/**
 * The Home window's card list (documentation/DESIGN_PROJECT_HUB.md §3, §4.1; plan documentation/PLAN_PROJECT_HUB.md H-PR1).
 * Pure: projectOf, exists, keyOf and labelOf are fakes here, so no test touches the disk.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { homeCards, filterCards } = require('../app/home-model');

// Fake paths are backslash paths. `<x>\dev` and `<x>\feat-*` (and anything inside them) fold to `<x>` (a container); a path in
// `C:\flat` folds to the flat repo `C:\flat`; anything else is a flat repo at its own path; a path under `C:\none\` is a folder
// projectOf cannot place (null).
const keyOf = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').toLowerCase() : null);
const labelOf = (root) => String(root).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const projectOf = (p) => {
  if (typeof p !== 'string' || !p) return null;
  if (/^c:\\none\\/i.test(p)) return null;
  if (/^c:\\flat(\\|$)/i.test(p)) return { kind: 'flat', root: p.slice(0, 'C:\\flat'.length), dev: p.slice(0, 'C:\\flat'.length) };
  const m = /^(.*?)\\(dev|feat-[^\\]+)(\\.*)?$/i.exec(p);
  return m ? { kind: 'container', root: m[1], dev: `${m[1]}\\dev` } : { kind: 'flat', root: p, dev: p };
};
const deps = (over = {}) => ({ projectOf, exists: () => true, keyOf, labelOf, ...over });
const EMPTY_RECORD = { projects: [], pins: [], removed: [] };
const run = (over = {}) => homeCards({ record: EMPTY_RECORD, recents: [], windows: [], windowless: [], filter: '', ...deps(), ...over });

test('no record, no recents, nothing live: no cards, and every count is zero', () => {
  assert.deepStrictEqual(run(), { cards: [], summary: { open: 0, needs: 0, total: 0, shown: 0 } });
});

const rec = (path, lastUsed, extra = {}) => ({ path, name: labelOf(path), approximate: false, lastUsed, tokens: 0, sessions: 1, ...extra });
const keys = (r) => r.cards.map((c) => c.key);

test('two lanes of one container are ONE card: the root, its label, both lanes, the later time', () => {
  const r = run({ recents: [rec('C:\\p\\feat-a', 2000), rec('C:\\p\\dev', 1000)] });
  assert.strictEqual(r.cards.length, 1);
  const c = r.cards[0];
  assert.strictEqual(c.root, 'C:\\p');
  assert.strictEqual(c.key, 'c:\\p');
  assert.strictEqual(c.label, 'p');
  assert.strictEqual(c.lastUsed, 2000);
  assert.deepStrictEqual(c.lanes.map((l) => l.label), ['feat-a', 'dev']);
  assert.deepStrictEqual(c.lanes.map((l) => l.path), ['C:\\p\\feat-a', 'C:\\p\\dev']);
  assert.deepStrictEqual(r.summary, { open: 0, needs: 0, total: 1, shown: 1 });
});

test('a flat repo is its own root and lists no lane for itself', () => {
  const [c] = run({ recents: [rec('C:\\flat', 5)] }).cards;
  assert.strictEqual(c.root, 'C:\\flat');
  assert.deepStrictEqual(c.lanes, []);
});

test('one lane seen twice (two spellings) is listed once', () => {
  const [c] = run({ recents: [rec('C:\\p\\dev', 5), rec('c:\\P\\DEV\\', 4)] }).cards;
  assert.deepStrictEqual(c.lanes.map((l) => l.path), ['C:\\p\\dev']);
});

test('a recent that projectOf cannot place is its own root; a throwing projectOf is the same', () => {
  assert.deepStrictEqual(keys(run({ recents: [rec('C:\\none\\notes', 1)] })), ['c:\\none\\notes']);
  const r = run({ recents: [rec('C:\\x', 1)], projectOf: () => { throw new Error('disk'); } });
  assert.deepStrictEqual(keys(r), ['c:\\x']);
});

test('an approximate recent (its path guessed from the folder name) and a row with no path are skipped', () => {
  const r = run({ recents: [rec('C--guess', 9, { approximate: true }), { lastUsed: 3 }, null, rec('C:\\real', 1)] });
  assert.deepStrictEqual(keys(r), ['c:\\real']);
});

test('the record and the recents merge by project: the later of lastOpened and lastUsed, the record root as spelled', () => {
  const record = { projects: [{ root: 'C:\\p', lastOpened: 7000 }], pins: [], removed: [] };
  const r = run({ record, recents: [rec('C:\\P\\dev', 3000)] });
  assert.strictEqual(r.cards.length, 1);
  assert.strictEqual(r.cards[0].lastUsed, 7000);
  assert.strictEqual(r.cards[0].root, 'C:\\p');
});

test('a time that is not a strict positive number is no time (Number(null) is 0): lastUsed is null, never 0', () => {
  for (const bad of [null, undefined, '5', NaN, 0, -1, Infinity, {}]) {
    const record = { projects: [{ root: 'C:\\t', lastOpened: bad }], pins: [], removed: [] };
    const [c] = run({ record, recents: [rec('C:\\t', bad)] }).cards;
    assert.strictEqual(c.lastUsed, null, `for ${String(bad)}`);
  }
});

const win = (root, { tabs = 1, needs = 0, lanes = [] } = {}) => ({ root, label: labelOf(root), tabs, needs, lanes });
const lane = (path, needs = false) => ({ key: keyOf(path), label: labelOf(path), path, needs });
const one = (r, key) => r.cards.find((c) => c.key === key);

test('a project with a window here is open: its tabs, its needs, its window lanes, Go to and Close, no Remove', () => {
  const r = run({
    windows: [win('C:\\p', { tabs: 3, needs: 1, lanes: [lane('C:\\p\\dev'), lane('C:\\p\\feat-b', true)] })],
    recents: [rec('C:\\p\\feat-old', 10)],
  });
  const c = one(r, 'c:\\p');
  assert.strictEqual(c.state, 'open');
  assert.strictEqual(c.tabs, 3);
  assert.strictEqual(c.needs, 1);
  assert.strictEqual(c.sessions, null);
  assert.deepStrictEqual(c.lanes.map((l) => [l.label, l.needs]), [['dev', false], ['feat-b', true]]);
  assert.deepStrictEqual(c.actions, ['go-to', 'close-window', 'pin', 'show-in-explorer', 'new-lane']);
  assert.deepStrictEqual(r.summary, { open: 1, needs: 1, total: 1, shown: 1 });
});

test('a project with sessions and no window: windowless, its session count, Open and Stop, no Remove', () => {
  const r = run({ windowless: [{ cwd: 'C:\\v\\dev' }, { cwd: 'C:\\v\\feat-x' }, { cwd: null }, null] });
  const c = one(r, 'c:\\v');
  assert.strictEqual(c.state, 'windowless');
  assert.strictEqual(c.sessions, 2);
  assert.strictEqual(c.tabs, null);
  assert.strictEqual(c.needs, 0);
  assert.deepStrictEqual(c.actions, ['open', 'stop-sessions', 'pin', 'show-in-explorer', 'new-lane']);
  assert.strictEqual(r.summary.open, 0);
});

test('a window wins over windowless sessions of the same project', () => {
  const c = one(run({ windows: [win('C:\\v')], windowless: [{ cwd: 'C:\\v\\dev' }] }), 'c:\\v');
  assert.strictEqual(c.state, 'open');
  assert.strictEqual(c.sessions, null);
});

test('a closed project: Open and Remove; a pinned one offers Unpin', () => {
  const record = { projects: [{ root: 'C:\\a', lastOpened: 5 }, { root: 'C:\\b', lastOpened: 4 }], pins: ['C:\\B'], removed: [] };
  const r = run({ record });
  const a = one(r, 'c:\\a');
  assert.strictEqual(a.state, 'closed');
  assert.strictEqual(a.pinned, false);
  assert.deepStrictEqual(a.actions, ['open', 'pin', 'show-in-explorer', 'new-lane', 'remove']);
  const b = one(r, 'c:\\b');
  assert.strictEqual(b.pinned, true);
  assert.deepStrictEqual(b.actions, ['open', 'unpin', 'show-in-explorer', 'new-lane', 'remove']);
});

test('a count that is not a strict count is no count: tabs null, needs 0 (never NaN)', () => {
  const c = one(run({ windows: [{ root: 'C:\\w', tabs: '2', needs: null, lanes: 'x' }] }), 'c:\\w');
  assert.strictEqual(c.tabs, null);
  assert.strictEqual(c.needs, 0);
  assert.deepStrictEqual(c.lanes, []);
});

test('a root whose folder is gone is left out, unless it is live (a window or sessions)', () => {
  const exists = (p) => !/gone/.test(p);
  const record = { projects: [{ root: 'C:\\gone1', lastOpened: 1 }, { root: 'C:\\here', lastOpened: 1 }], pins: [], removed: [] };
  const r = run({ record, exists, windows: [win('C:\\gone2')], windowless: [{ cwd: 'C:\\gone3' }] });
  assert.deepStrictEqual(keys(r).sort(), ['c:\\gone2', 'c:\\gone3', 'c:\\here']);
});

test('an exists that throws is a gone folder', () => {
  const r = run({ recents: [rec('C:\\q', 1)], exists: () => { throw new Error('EPERM'); } });
  assert.deepStrictEqual(keys(r), []);
});

test('a removed root is left out (pinned or not), unless it is live', () => {
  const record = {
    projects: [{ root: 'C:\\r1', lastOpened: 1 }, { root: 'C:\\r2', lastOpened: 1 }, { root: 'C:\\r3', lastOpened: 1 }],
    pins: ['C:\\r2'], removed: ['c:\\R1', 'C:\\r2', 'C:\\r3', 'C:\\r4'],
  };
  const r = run({ record, recents: [rec('C:\\r4\\dev', 3)], windowless: [{ cwd: 'C:\\r3' }] });
  assert.deepStrictEqual(keys(r), ['c:\\r3']);
});

test('order: pinned first, then the most recent, no time last, a tie by key', () => {
  const record = {
    projects: [
      { root: 'C:\\old', lastOpened: 10 }, { root: 'C:\\new', lastOpened: 90 }, { root: 'C:\\pinold', lastOpened: 5 },
      { root: 'C:\\pinnew', lastOpened: 50 }, { root: 'C:\\never', lastOpened: null }, { root: 'C:\\tieb', lastOpened: 30 },
      { root: 'C:\\tiea', lastOpened: 30 },
    ],
    pins: ['C:\\pinold', 'C:\\pinnew'], removed: [],
  };
  assert.deepStrictEqual(keys(run({ record })),
    ['c:\\pinnew', 'c:\\pinold', 'c:\\new', 'c:\\tiea', 'c:\\tieb', 'c:\\old', 'c:\\never']);
});

test('a card that needs you does not move: the order is the same with and without the cue', () => {
  const record = { projects: [{ root: 'C:\\a', lastOpened: 20 }, { root: 'C:\\b', lastOpened: 10 }], pins: [], removed: [] };
  const calm = run({ record, windows: [win('C:\\a'), win('C:\\b')] });
  const cue = run({ record, windows: [win('C:\\a'), win('C:\\b', { needs: 2, lanes: [lane('C:\\b\\dev', true)] })] });
  assert.deepStrictEqual(keys(calm), ['c:\\a', 'c:\\b']);
  assert.deepStrictEqual(keys(cue), ['c:\\a', 'c:\\b']);
});

test('the filter keeps the cards whose label or root holds the text, any case; the summary counts before it', () => {
  const record = {
    projects: [{ root: 'C:\\work\\Viral', lastOpened: 3 }, { root: 'C:\\play\\music', lastOpened: 2 }, { root: 'C:\\x', lastOpened: 1 }],
    pins: [], removed: [],
  };
  const byLabel = run({ record, filter: 'VIR', windows: [win('C:\\x', { needs: 1 })] });
  assert.deepStrictEqual(keys(byLabel), ['c:\\work\\viral']);
  assert.deepStrictEqual(byLabel.summary, { open: 1, needs: 1, total: 3, shown: 1 });
  assert.deepStrictEqual(keys(run({ record, filter: '  play\\ ' })), ['c:\\play\\music']);
  assert.strictEqual(run({ record, filter: '' }).summary.shown, 3);
});

// --- PR #262 review fixes -------------------------------------------------------------------------------------------------------

test('Dexter 1: a pin is a card source: a pinned root with no record entry and no recent still shows, recents read or not', () => {
  const record = { projects: [], pins: ['C:\\x'], removed: [] };
  for (const recents of [[], null]) {
    const r = run({ record, recents });
    assert.deepStrictEqual(keys(r), ['c:\\x'], `recents ${JSON.stringify(recents)}`);
    assert.strictEqual(r.cards[0].pinned, true);
    assert.strictEqual(r.cards[0].state, 'closed');
    assert.strictEqual(r.cards[0].lastUsed, null);
  }
});

test('Dexter 1: a pinned root whose folder is gone stays out, as any closed root does', () => {
  const r = run({ record: { projects: [], pins: ['C:\\gone'], removed: [] }, exists: (p) => !/gone/.test(p) });
  assert.deepStrictEqual(keys(r), []);
});

test('Dexter 2: a recent in a subfolder of a worktree is that worktree\'s lane, never a lane of its own', () => {
  const [c] = run({ recents: [rec('C:\\p\\dev', 2), rec('C:\\p\\dev\\src', 1), rec('C:\\p\\feat-a\\x\\y', 3)] }).cards;
  assert.deepStrictEqual(c.lanes.map((l) => [l.label, l.path]), [['dev', 'C:\\p\\dev'], ['feat-a', 'C:\\p\\feat-a']]);
});

test('Dexter 2: a recent in a subfolder of a flat repo makes no lane', () => {
  const [c] = run({ recents: [rec('C:\\flat\\sub', 2)] }).cards;
  assert.strictEqual(c.root, 'C:\\flat');
  assert.deepStrictEqual(c.lanes, []);
});

test('Dexter 2: a lane whose folder is gone does not show (its project still does)', () => {
  const exists = (p) => !/feat-gone/.test(p);
  const [c] = run({ exists, recents: [rec('C:\\p\\feat-gone\\old-sub', 3), rec('C:\\p\\dev', 1)] }).cards;
  assert.deepStrictEqual(c.lanes.map((l) => l.label), ['dev']);
});

test('Miguel Y2: the record\'s roots are folded too: a record entry in a lane and a recent in another lane are ONE card', () => {
  const record = { projects: [{ root: 'C:\\p\\dev', lastOpened: 9 }], pins: [], removed: [] };
  const r = run({ record, recents: [rec('C:\\p\\feat-a', 3)] });
  assert.deepStrictEqual(keys(r), ['c:\\p']);
  assert.strictEqual(r.cards[0].lastUsed, 9);
});

test('Miguel G1: pins and the removed set are folded by rootOf: a lane path pins and removes its project', () => {
  const pinned = run({ record: { projects: [{ root: 'C:\\p', lastOpened: 1 }], pins: ['C:\\p\\feat-a'], removed: [] } });
  assert.deepStrictEqual(pinned.cards.map((c) => [c.key, c.pinned]), [['c:\\p', true]]);
  const removed = run({ record: { projects: [{ root: 'C:\\p', lastOpened: 1 }], pins: [], removed: ['C:\\p\\dev'] } });
  assert.deepStrictEqual(keys(removed), []);
});

test('Dexter 6 / Miguel G3: the filter matches every spelling the sources gave the root, so a window opening never changes the match', () => {
  const record = { projects: [{ root: 'C:\\Users\\Ricardo Pujol\\VibeCode\\viral', lastOpened: 5 }], pins: [], removed: [] };
  // the junction: one folder, two spellings, one key (the real keyOf is normPath, which follows the junction)
  const junctionKey = (p) => (typeof p === 'string' && p ? keyOf(p.replace(/\\ricar\\/i, '\\Ricardo Pujol\\')) : null);
  const closed = run({ record, keyOf: junctionKey, filter: 'pujol' });
  const open = run({ record, keyOf: junctionKey, filter: 'pujol', windows: [win('C:\\Users\\ricar\\VibeCode\\viral')] });
  assert.strictEqual(closed.cards.length, 1);
  assert.strictEqual(open.cards.length, 1);
  assert.strictEqual(open.cards[0].root, 'C:\\Users\\ricar\\VibeCode\\viral');
  assert.strictEqual(run({ record, keyOf: junctionKey, filter: 'ricar\\', windows: [win('C:\\Users\\ricar\\VibeCode\\viral')] }).cards.length, 1);
});

test('Miguel G3: filterCards is pure and runs on a built list: same order, a card kept when its label or any root spelling holds the text', () => {
  const cards = [
    { key: 'k1', label: 'viral', root: 'C:\\a\\viral', roots: ['C:\\a\\viral', 'C:\\b\\viral'] },
    { key: 'k2', label: 'music', root: 'C:\\b\\music', roots: ['C:\\b\\music'] },
    { key: 'k3', label: 'Notes', root: 'C:\\c\\notes', roots: ['C:\\c\\notes'] },
  ];
  assert.deepStrictEqual(filterCards(cards, ' b\\ ').map((c) => c.key), ['k1', 'k2']);
  assert.deepStrictEqual(filterCards(cards, 'NOTES').map((c) => c.key), ['k3']);
  assert.deepStrictEqual(filterCards(cards, '').map((c) => c.key), ['k1', 'k2', 'k3']);
  assert.deepStrictEqual(filterCards(cards, null).map((c) => c.key), ['k1', 'k2', 'k3']);
  assert.deepStrictEqual(filterCards(null, 'x'), []);
});

// --- properties (design §4.1) ---------------------------------------------------------------------------------------------------
// A small alphabet of roots so collisions happen: each is spelled in either case, with or without a trailing separator, and as a
// lane (dev / feat-x) of a container or as itself. `C:\none\…` cannot be placed by projectOf.
const ROOTS = ['C:\\a', 'C:\\b', 'C:\\c', 'C:\\gone', 'C:\\none\\n'];
const spell = fc.tuple(fc.constantFrom(...ROOTS), fc.constantFrom('', '\\dev', '\\feat-x'), fc.boolean(), fc.boolean())
  .map(([r, sub, upper, slash]) => { const p = r + sub; return (upper ? p.toUpperCase() : p) + (slash ? '\\' : ''); });
const time = fc.oneof(fc.integer({ min: 1, max: 1e6 }), fc.constantFrom(null, 0, -3, NaN, '7', undefined));
const arbInput = fc.record({
  record: fc.record({
    projects: fc.array(fc.record({ root: spell, lastOpened: time }), { maxLength: 8 }),
    pins: fc.array(spell, { maxLength: 4 }),
    removed: fc.array(spell, { maxLength: 4 }),
  }),
  recents: fc.array(fc.record({ path: spell, approximate: fc.boolean(), lastUsed: time }), { maxLength: 8 }),
  windows: fc.uniqueArray(fc.constantFrom(...ROOTS), { maxLength: 3 }).chain((roots) => fc.tuple(...roots.map((root) => fc.record({
    root: fc.constant(root), tabs: fc.integer({ min: 0, max: 5 }), needs: fc.integer({ min: 0, max: 3 }),
    lanes: fc.array(fc.record({ path: fc.constant(`${root}\\dev`), needs: fc.boolean() }), { maxLength: 2 }),
  })))),
  windowless: fc.array(fc.record({ cwd: spell }), { maxLength: 4 }),
});
const exists = (p) => !/gone/i.test(p);
const homeOf = (input, over = {}) => homeCards({ filter: '', ...input, ...deps({ exists }), ...over });
const rootKey = (p) => { const pr = projectOf(p); return keyOf(pr ? pr.root : p); };

test('property: whatever the inputs, a root shows at most once', () => {
  fc.assert(fc.property(arbInput, (input) => {
    const ks = keys(homeOf(input));
    assert.strictEqual(new Set(ks).size, ks.length);
  }));
});

test('property: no unpinned card comes before a pinned one', () => {
  fc.assert(fc.property(arbInput, (input) => {
    const flags = homeOf(input).cards.map((c) => c.pinned);
    assert.ok(flags.indexOf(false) === -1 || flags.lastIndexOf(true) < flags.indexOf(false), JSON.stringify(flags));
  }));
});

test('property: the order never depends on cue state (needs on a window or a lane)', () => {
  fc.assert(fc.property(arbInput, fc.infiniteStream(fc.integer({ min: 0, max: 4 })), (input, needs) => {
    const it = needs[Symbol.iterator]();
    const next = () => it.next().value;
    const cued = { ...input, windows: input.windows.map((w) => ({ ...w, needs: next(), lanes: w.lanes.map((l) => ({ ...l, needs: next() % 2 === 0 })) })) };
    assert.deepStrictEqual(keys(homeOf(cued)), keys(homeOf(input)));
  }));
});

test('property: sessions coming and going never reorder the cards both lists hold', () => {
  fc.assert(fc.property(arbInput, fc.array(fc.record({ cwd: spell }), { maxLength: 4 }), (input, other) => {
    const a = keys(homeOf(input));
    const b = keys(homeOf({ ...input, windowless: other }));
    const both = (ks, ref) => ks.filter((k) => ref.includes(k));
    assert.deepStrictEqual(both(a, b), both(b, a));
  }));
});

test('property: every live project has a card; no closed removed or gone root has one', () => {
  fc.assert(fc.property(arbInput, (input) => {
    const r = homeOf(input);
    const shown = new Set(keys(r));
    const live = new Set([...input.windows.map((w) => keyOf(w.root)), ...input.windowless.map((s) => rootKey(s.cwd))]);
    for (const k of live) assert.ok(shown.has(k), `live ${k} has no card`);
    const removed = new Set(input.record.removed.map(rootKey));
    for (const c of r.cards) {
      if (live.has(c.key)) continue;
      assert.strictEqual(c.state, 'closed');
      assert.ok(!removed.has(c.key), `removed ${c.key} shows`);
      assert.ok(exists(c.root), `gone ${c.root} shows`);
    }
  }));
});

test('property: every number on a card is a strict number or null, never NaN, and the summary adds up', () => {
  const strict = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  fc.assert(fc.property(arbInput, (input) => {
    const r = homeOf(input);
    for (const c of r.cards) {
      for (const v of [c.tabs, c.needs, c.sessions, c.lastUsed]) assert.ok(strict(v), `${c.key}: ${v}`);
      assert.ok(c.lastUsed === null || c.lastUsed > 0);
    }
    assert.strictEqual(r.summary.total, r.cards.length);
    assert.strictEqual(r.summary.shown, r.cards.length);
    assert.strictEqual(r.summary.open, r.cards.filter((c) => c.state === 'open').length);
    assert.strictEqual(r.summary.needs, r.cards.reduce((n, c) => n + c.needs, 0));
  }));
});

test('property (Dexter 1): every pinned root whose folder exists and that is not removed shows exactly once', () => {
  fc.assert(fc.property(arbInput, (input) => {
    const ks = keys(homeOf(input));
    const removed = new Set(input.record.removed.map(rootKey));
    for (const p of input.record.pins) {
      const k = rootKey(p);
      const pr = projectOf(p);
      if (removed.has(k) || !exists(pr ? pr.root : p)) continue;
      assert.strictEqual(ks.filter((x) => x === k).length, 1, `pin ${p}`);
    }
  }));
});

test('property (Miguel Y2): every card key is the folded root of some input path', () => {
  fc.assert(fc.property(arbInput, (input) => {
    const from = new Set([
      ...input.windows.map((w) => keyOf(w.root)), ...input.record.projects.map((p) => rootKey(p.root)),
      ...input.record.pins.map(rootKey), ...input.windowless.map((s) => rootKey(s.cwd)),
      ...input.recents.filter((r) => r.approximate !== true).map((r) => rootKey(r.path)),
    ]);
    for (const c of homeOf(input).cards) assert.ok(from.has(c.key), `${c.key} has no source`);
  }));
});

test('property: a filter keeps a subsequence of the unfiltered cards, in the same order', () => {
  fc.assert(fc.property(arbInput, fc.constantFrom('a', 'B', 'dev', 'none', 'zzz', ' c '), (input, filter) => {
    const all = keys(homeOf(input));
    const some = keys(homeOf(input, { filter }));
    assert.deepStrictEqual(all.filter((k) => some.includes(k)), some);
  }));
});

test('a missing or broken input is read as empty, never a throw', () => {
  const r = homeCards({ record: null, recents: null, windows: 'x', windowless: undefined, filter: 5, ...deps() });
  assert.deepStrictEqual(r, { cards: [], summary: { open: 0, needs: 0, total: 0, shown: 0 } });
});
