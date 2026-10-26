'use strict';
/**
 * BACKLOG #103: panels start as rail tabs (unpinned) unless the user pinned them, and a rail peek shows only the hovered tab.
 * `defaultLayout` stays the all-pinned layout (many fixtures build on it); `startLayout` is what a person meets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../app/dock-tree');
const V = require('../app/dock-tree-display');
const { TABS } = require('../app/side-tabs');

const IDS = ['agents', 'vault', 'bugvault', 'fog', 'git', 'models', 'projects', 'style'];
const everywhere = l => [...T.groups(l).flatMap(g => g.tabs), ...l.floats.flatMap(f => f.tabs), ...l.rail, ...l.hidden];

test('the start layout has no docked panel: every module is a rail tab, the terminal fills the dock', () => {
  const l = T.startLayout(IDS);
  assert.deepEqual(T.groups(l), []);
  assert.deepEqual([...l.rail].sort(), [...IDS].sort());
  assert.deepEqual(l.hidden, []);
  assert.deepEqual(T.normalize(l, IDS), l);
});

test('the start layout keeps Claude\'s panel hidden until used', () => {
  const l = T.startLayout(['agents', 'canvas', 'git']);
  assert.deepEqual(l.hidden, ['canvas']);
  assert.deepEqual([...l.rail].sort(), ['agents', 'git']);
});

test('pinning a start-layout tab docks it on the right, and a second pin joins the first (one group, as before)', () => {
  let l = T.pin(T.startLayout(IDS), 'git');
  assert.deepEqual(T.groups(l).map(g => g.tabs), [['git']]);
  l = T.pin(l, 'vault');
  assert.deepEqual(T.groups(l).map(g => g.tabs.slice().sort()), [['git', 'vault']]);
  assert.deepEqual([...everywhere(l)].sort(), [...IDS].sort());
});

test('a start layout of no modules is just the terminal', () => {
  assert.deepEqual(T.startLayout([]), T.defaultLayout([]));
});

test('junk and unknown generations read as the start layout', () => {
  for (const raw of [null, 'x', 7, [], { version: 3 }, { zones: 'x' }]) {
    assert.deepEqual(T.readStored(raw, IDS), T.startLayout(IDS), JSON.stringify(raw));
  }
});

test('a layout saved before the rail existed (no rail key) has its docked panels unpinned once', () => {
  const { rail, ...old } = T.defaultLayout(IDS);
  const read = T.readStored(old, IDS);
  assert.deepEqual(T.groups(read), []);
  assert.deepEqual([...read.rail].sort(), [...IDS].sort());
});

test('a saved L1 layout opens with its panels on the rail, its hidden one still hidden', () => {
  const l1 = { version: 1, zones: { left: ['vault'], right: ['agents', 'fog'], top: [], bottom: ['git'] }, hidden: ['style'], size: {} };
  const read = T.readStored(l1, IDS);
  assert.deepEqual(T.groups(read), []);
  assert.deepEqual(read.hidden, ['style']);
  assert.deepEqual([...everywhere(read)].sort(), [...IDS].sort());
});

test('a layout that HAS a rail array keeps what the person pinned', () => {
  const pinned = T.pin(T.startLayout(IDS), 'vault');
  const read = T.readStored(JSON.parse(JSON.stringify(pinned)), IDS);
  assert.deepEqual(read, pinned);
  assert.deepEqual(T.groups(read).map(g => g.tabs), [['vault']]);
  // an explicit empty rail is a person who pinned everything: it stays pinned
  const all = T.readStored({ ...T.defaultLayout(IDS), rail: [] }, IDS);
  assert.equal(T.groups(all).length, 1);
});

test('a rail peek shows only the hovered tab, not the rail\'s whole list', () => {
  const ids = TABS.map(t => t.id);
  const layout = T.startLayout(ids);
  const p = V.treePlan(layout, {}, TABS, { width: 1200, height: 800 }, { faceSize: () => 77, peek: { module: 'vault' } });
  assert.ok(p.peek, 'the start layout has a rail to peek from');
  assert.deepEqual(p.peek.tabs.map(t => t.id), ['vault']);
  assert.equal(p.peek.tabs[0].on, true);
  assert.ok(p.shown.includes('vault'));
  assert.equal(p.peek.pin, true);
});

// --- PR #189 review fixes -------------------------------------------------------------------------------------------

// Which side of the terminal a docked module's group sits on (the split where the two paths part).
function sideOfTerm(l, id) {
  const path = (n, want, acc = []) => {
    if (want(n)) return acc;
    if (n.type !== 'split') return null;
    for (let i = 0; i < n.kids.length; i += 1) { const p = path(n.kids[i], want, [...acc, i]); if (p) return p; }
    return null;
  };
  const pt = path(l.root, n => n.type === 'term');
  const pg = path(l.root, n => n.type === 'group' && n.tabs.includes(id));
  assert.ok(pg, `${id} is docked`);
  let k = 0;
  while (pt[k] === pg[k]) k += 1;
  let n = l.root;
  for (let i = 0; i < k; i += 1) n = n.kids[pt[i]];
  if (pg[k] < pt[k]) return n.dir === 'row' ? 'left' : 'top';
  return n.dir === 'row' ? 'right' : 'bottom';
}

test('Dexter 1: a pre-rail group left of the terminal pins back on the left, not the right edge', () => {
  const old = { version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'group', id: 'left', tabs: ['vault', 'git'] }, { type: 'term' }], sizes: [180, 0] }, floats: [], hidden: [], seat: {} };
  const read = T.readStored(old, IDS);
  assert.equal(sideOfTerm(T.pin(read, 'vault'), 'vault'), 'left');
  assert.equal(sideOfTerm(T.pin(read, 'git'), 'git'), 'left');
  const both = T.pin(T.pin(read, 'git'), 'vault');
  assert.deepEqual(T.groups(both).map(g => g.tabs.slice().sort()), [['git', 'vault']], 'one group again');
});

test('Dexter 1: every L1 zone pins back on its own side of the terminal, in any pin order', () => {
  const l1 = { version: 1, zones: { left: ['vault'], right: ['agents', 'fog'], top: ['style'], bottom: ['git'] }, hidden: [], size: {} };
  const want = { vault: 'left', agents: 'right', fog: 'right', style: 'top', git: 'bottom' };
  const read = T.readStored(l1, IDS);
  const order = read.rail.filter(id => want[id]);
  for (const ids of [order, [...order].reverse()]) {
    const l = ids.reduce((acc, id) => T.pin(acc, id), read);
    for (const id of ids) assert.equal(sideOfTerm(l, id), want[id], `${id} after pinning ${ids.join(',')}`);
  }
});

test('Dexter 1: the seat\'s terminal side survives a normalize round trip and junk values are dropped', () => {
  const read = T.readStored({ version: 2, root: { type: 'split', dir: 'row', kids: [{ type: 'group', id: 'left', tabs: ['vault'] }, { type: 'term' }], sizes: [180, 0] }, floats: [], hidden: [], seat: {} }, IDS);
  assert.equal(T.normalize(JSON.parse(JSON.stringify(read)), IDS).seat.vault.edge, 'left');
  const bad = JSON.parse(JSON.stringify(read));
  bad.seat.vault.edge = 'sideways';
  assert.equal(T.normalize(bad, IDS).seat.vault.edge, undefined);
});

test('Dexter 2: a module new to a stored rail-era layout starts on the rail', () => {
  const stored = JSON.parse(JSON.stringify(T.startLayout(['git', 'vault'])));
  const read = T.readStored(stored, ['git', 'vault', 'games']);
  assert.deepEqual(T.groups(read), []);
  assert.deepEqual([...read.rail].sort(), ['games', 'git', 'vault']);
  const pinned = JSON.parse(JSON.stringify(T.pin(T.startLayout(['git', 'vault']), 'vault')));
  const read2 = T.readStored(pinned, ['git', 'vault', 'games']);
  assert.deepEqual(T.groups(read2).map(g => g.tabs), [['vault']], 'the person\'s pin is untouched');
  assert.ok(read2.rail.includes('games'));
});

test('Dexter 2: a module still hidden-until-used stays hidden when new to a stored layout', () => {
  const stored = JSON.parse(JSON.stringify(T.startLayout(['git'])));
  const read = T.readStored(stored, ['git', 'canvas']);
  assert.deepEqual(read.hidden, ['canvas']);
});

test('Dexter 5: the start layout is far under the save cap for today\'s modules, and a bound is stated', () => {
  const { MAX_LAYOUT_BYTES } = require('../app/layout-bridge');
  const size = ids => JSON.stringify(T.startLayout(ids)).length;
  assert.ok(size(TABS.map(t => t.id)) < MAX_LAYOUT_BYTES / 2, String(size(TABS.map(t => t.id))));
  const many = Array.from({ length: 24 }, (_, i) => `module${i}`);
  assert.ok(size(many) < MAX_LAYOUT_BYTES, 'a 24-module build still saves');
});

test('Miguel 4: an L1 layout keeps its geometry through the migration: sizes, panel order, zone stacking', () => {
  const l1 = {
    version: 1,
    zones: { left: [], right: ['vault', 'bugvault', 'fog'], top: [], bottom: ['agents'] },
    active: { right: 'vault', bottom: 'agents' }, hidden: [], size: { left: 180, right: 240, top: 160, bottom: 160 },
  };
  const l = T.fromV1(l1, ['vault', 'bugvault', 'fog', 'agents']);
  const gs = T.groups(l);
  assert.deepEqual(gs.map(g => [g.id, g.tabs]), [['right', ['vault', 'bugvault', 'fog']], ['bottom', ['agents']]]);
  const p = V.treePlan(l, { active: { right: 'vault', bottom: 'agents' } }, TABS, { width: 1200, height: 800 }, { faceSize: () => 77 });
  const right = p.boxes.find(b => b.kind === 'group' && b.id === 'right');
  const bottom = p.boxes.find(b => b.kind === 'group' && b.id === 'bottom');
  assert.equal(Math.round(right.rect.width), 240);
  assert.equal(Math.round(bottom.rect.height), 160);
  assert.ok(right.rect.y + right.rect.height <= bottom.rect.y + 1, 'right above bottom');
  // and the same layout read as the dock opens it keeps those sizes for the day a panel is pinned
  const read = T.readStored(l1, ['vault', 'bugvault', 'fog', 'agents']);
  assert.deepEqual(T.groups(read), []);
  assert.equal(sideOfTerm(T.pin(read, 'agents'), 'agents'), 'bottom');
});
