'use strict';
/**
 * host/issue-lane.js (BACKLOG #119 A6): the brief a lane started from an issue begins with. The pieces it joins
 * (the issue service, the brief's path, the template) have their own tests; these pin the joins: what is written,
 * where, when it is NOT written, and what a failure says.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createLaneBriefWriter } = require('../host/issue-lane');

const ISSUE = { number: 12, title: 'Fix the thing', labels: ['bug'], assignees: [], updatedAt: null, url: 'https://github.com/o/r/issues/12' };
const BRIEF = 'C:\\proj\\dev\\documentation\\handoffs\\CURRENT-fix-12-fix-the-thing.md';

function rig(over = {}) {
  const calls = { view: [], briefPath: [], mkdir: [], write: [] };
  const files = new Set(over.existing || []);
  const deps = {
    cwd: 'C:\\proj\\feat-12',
    service: {
      view: async (cwd, n) => { calls.view.push([cwd, n]); return over.view || { ok: true, issue: ISSUE, body: 'The body' }; },
      cached: () => over.cached || null,
    },
    ops: { briefPath: async (a) => { calls.briefPath.push(a); return over.briefPath || { ok: true, path: BRIEF }; } },
    exists: (p) => files.has(p),
    mkdir: (p) => { calls.mkdir.push(p); },
    write: (p, text) => { if (over.writeThrows) throw new Error(over.writeThrows); calls.write.push([p, text]); files.add(p); },
    now: () => new Date('2026-10-20T09:30:00Z'),
  };
  return { write: createLaneBriefWriter(deps), calls, files };
}

const lane = { number: 12, branch: 'fix/12-fix-the-thing', worktree: 'C:\\proj\\fix-12-fix-the-thing' };

test('writes the brief at the path brief-path.ps1 gave, from the issue and its body', async () => {
  const { write, calls } = rig();
  const r = await write(lane);
  assert.deepStrictEqual(r, { ok: true, issue: ISSUE, brief: BRIEF, existed: false });
  assert.deepStrictEqual(calls.view, [['C:\\proj\\feat-12', 12]]);
  assert.deepStrictEqual(calls.briefPath, [{ path: lane.worktree }]);
  assert.deepStrictEqual(calls.mkdir, [path.dirname(BRIEF)]);
  assert.strictEqual(calls.write.length, 1);
  assert.strictEqual(calls.write[0][0], BRIEF);
  const text = calls.write[0][1];
  assert.match(text, /\*\*Source:\*\* GitHub issue #12 https:\/\/github\.com\/o\/r\/issues\/12/);
  assert.match(text, /\*\*Branch:\*\* `fix\/12-fix-the-thing`   \*\*Worktree:\*\* `C:\\proj\\fix-12-fix-the-thing`/);
  assert.match(text, /> The body/);
});

test('an existing brief is never overwritten: the lane keeps what it has', async () => {
  const { write, calls } = rig({ existing: [BRIEF] });
  const r = await write(lane);
  assert.deepStrictEqual(r, { ok: true, issue: ISSUE, brief: BRIEF, existed: true });
  assert.strictEqual(calls.write.length, 0);
});

test('gh cannot give the issue but the list has it: the brief is written from the list entry, with no body', async () => {
  const { write, calls } = rig({ view: { ok: false, text: 'Sign in to gh to pick an issue' }, cached: [ISSUE] });
  const r = await write(lane);
  assert.strictEqual(r.ok, true);
  assert.match(calls.write[0][1], /> \(the issue has no description\)/);
});

test('gh cannot give the issue and the list does not have it: nothing is written, and the error says why', async () => {
  const { write, calls } = rig({ view: { ok: false, text: 'Sign in to gh to pick an issue' }, cached: [] });
  const r = await write(lane);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Sign in to gh to pick an issue/);
  assert.strictEqual(r.issue, null);
  assert.strictEqual(calls.write.length, 0);
});

test('no brief path: nothing is written, the error is the script\'s, and the issue is still returned for the tab', async () => {
  const { write, calls } = rig({ briefPath: { ok: false, error: 'brief-path.ps1 isn\'t installed (looked in D:\\x).' } });
  const r = await write(lane);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /brief-path\.ps1 isn't installed/);
  assert.deepStrictEqual(r.issue, ISSUE);
  assert.strictEqual(calls.write.length, 0);
});

test('a write that throws is an error with the reason, never a throw', async () => {
  const { write } = rig({ writeThrows: 'EPERM: operation not permitted' });
  const r = await write(lane);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /EPERM/);
  assert.deepStrictEqual(r.issue, ISSUE);
});

test('a lane with no usable issue number or worktree is refused before anything runs', async () => {
  const { write, calls } = rig();
  for (const bad of [{ ...lane, number: 0 }, { ...lane, number: '12' }, { ...lane, worktree: '' }, { ...lane, branch: '' }, null, undefined]) {
    const r = await write(bad);
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(calls.view.length, 0);
  assert.strictEqual(calls.briefPath.length, 0);
});
