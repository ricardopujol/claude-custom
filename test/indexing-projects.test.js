'use strict';
/**
 * Which projects the indexing field's chip offers (host/indexing-projects.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md
 * pick 2: the selected tab's project, and a click on the chip switches project): this window's project first, then the
 * recent projects that have a backlog to file into, each once, by project root.
 */
const test = require('node:test');
const assert = require('node:assert');

const { projectChoices, MAX_CHOICES } = require('../host/indexing-projects');

const projectOf = (p) => {
  const m = /^(C:\\code\\[a-z-]+)/i.exec(p);
  return m ? { root: m[1], dev: m[1] + '\\dev' } : null;
};
const labelOf = (root) => root.split('\\').pop();

test('this window\'s project first, then recent projects with a backlog, by root, each once', () => {
  const out = projectChoices({
    current: 'C:\\code\\alpha',
    recents: [
      { path: 'C:\\code\\beta\\dev' }, { path: 'C:\\code\\beta\\feat-x' }, { path: 'C:\\code\\alpha\\dev' },
      { path: 'C:\\code\\gamma' }, { path: 'C:\\code\\nodocs' }, { path: 'D:\\elsewhere' },
    ],
    projectOf, labelOf, hasBacklog: (p) => p.root !== 'C:\\code\\nodocs',
  });
  assert.deepStrictEqual(out, [
    { root: 'C:\\code\\alpha', label: 'alpha', current: true },
    { root: 'C:\\code\\beta', label: 'beta', current: false },
    { root: 'C:\\code\\gamma', label: 'gamma', current: false },
  ]);
});

test('the window\'s own project is offered even without a backlog (it says why it waits)', () => {
  const out = projectChoices({ current: 'C:\\code\\nodocs', recents: [], projectOf, labelOf, hasBacklog: () => false });
  assert.deepStrictEqual(out, [{ root: 'C:\\code\\nodocs', label: 'nodocs', current: true }]);
});

test('approximate recents (a guessed path) are skipped; a recent read that failed is no recents', () => {
  const out = projectChoices({ current: 'C:\\code\\alpha', recents: [{ path: 'C:\\code\\beta', approximate: true }], projectOf, labelOf, hasBacklog: () => true });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(projectChoices({ current: 'C:\\code\\alpha', recents: null, projectOf, labelOf, hasBacklog: () => true }).length, 1);
});

test('path spelling is one project (case, slashes, a trailing separator)', () => {
  const out = projectChoices({
    current: 'C:\\code\\alpha',
    recents: [{ path: 'c:/code/ALPHA/dev/' }],
    projectOf: (p) => ({ root: p.replace(/[\\/]dev[\\/]?$/i, ''), dev: p }), labelOf, hasBacklog: () => true,
  });
  assert.strictEqual(out.length, 1);
});

test('at most MAX_CHOICES', () => {
  const recents = Array.from({ length: 30 }, (_, i) => ({ path: `C:\\code\\p${String.fromCharCode(97 + (i % 26))}${i}` }));
  const out = projectChoices({ current: 'C:\\code\\alpha', recents, projectOf: (p) => ({ root: p, dev: p }), labelOf, hasBacklog: () => true });
  assert.strictEqual(out.length, MAX_CHOICES);
});

test('a projectOf or hasBacklog that throws skips that one entry', () => {
  const out = projectChoices({
    current: 'C:\\code\\alpha',
    recents: [{ path: 'C:\\code\\boom' }, { path: 'C:\\code\\beta' }],
    projectOf: (p) => { if (p.includes('boom')) throw new Error('x'); return projectOf(p); },
    labelOf, hasBacklog: () => true,
  });
  assert.deepStrictEqual(out.map(o => o.label), ['alpha', 'beta']);
});
