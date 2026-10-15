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
