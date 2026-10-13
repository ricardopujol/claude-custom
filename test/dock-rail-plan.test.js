'use strict';
/**
 * What the page draws for the dock's rail (BACKLOG #85): the rail's tabs, the open panel's Pin button (a railed panel can be
 * pinned), a docked panel's Pinned button (it can be unpinned), and which side the panel slides in from.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../app/dock-tree');
const V = require('../app/dock-tree-display');
const { TABS } = require('../app/side-tabs');

const IDS = TABS.map(t => t.id);
const VP = { width: 1000, height: 600 };
const base = () => T.defaultLayout(IDS);

test('the rail box carries its tabs by name and an id of its own', () => {
  const plan = V.treePlan(T.unpin(T.unpin(base(), 'git'), 'vault'), null, TABS, VP, {});
  const rail = plan.boxes.find(b => b.kind === 'rail');
  assert.equal(rail.id, 'dock');
  assert.deepEqual(rail.tabs.map(t => t.id), ['git', 'vault']);
  assert.ok(rail.tabs.every(t => typeof t.label === 'string' && t.label));
});

test('the panel opened from the dock rail can be pinned; its tabs are the rail\'s; it slides in from the right', () => {
  const plan = V.treePlan(T.unpin(T.unpin(base(), 'git'), 'vault'), null, TABS, VP, { peek: { module: 'git' } });
  assert.equal(plan.peek.pin, true);
  assert.equal(plan.peek.from, 'right');
  assert.deepEqual(plan.peek.tabs.map(t => t.id), ['git', 'vault']);
  assert.deepEqual(plan.shown.includes('git'), true);
});

test('a panel opened from a folded group\'s rail has no Pin button (it was never unpinned)', () => {
  const l = base();
  const gid = T.groups(l)[0].id;
  const sel = T.toggleCollapse(null, l, gid);
  const plan = V.treePlan(l, sel, TABS, VP, { peek: { module: 'git' } });
  assert.ok(plan.peek);
  assert.equal(plan.peek.pin, false);
});

test('a peek on a module that is not on any rail draws nothing', () => {
  const plan = V.treePlan(base(), null, TABS, VP, { peek: { module: 'git' } });
  assert.equal(plan.peek, null);
});

test('the menu lists a railed panel as shown, and a hidden one as not', () => {
  const l = T.hide(T.unpin(base(), 'git'), 'vault');
  const rows = V.menuRows(l, TABS);
  assert.equal(rows.find(r => r.id === 'git').shown, true);
  assert.equal(rows.find(r => r.id === 'git').railed, true);
  assert.equal(rows.find(r => r.id === 'vault').shown, false);
  assert.equal(rows.find(r => r.id === 'agents').railed, false);
});
