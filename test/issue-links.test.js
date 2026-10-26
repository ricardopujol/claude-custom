'use strict';
/**
 * host/issue-links.js (PR #202 Dexter 5 + 6): the issue a lane was started from, kept beside the project's other
 * state, so the tab and the Git drawer still show it after a restart, after the issue closes, and after it falls off
 * the newest-50 open list. Keyed on the branch, and on the worktree path when both are known.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createIssueLinks, issueLinksFileFor } = require('../host/issue-links');

const ISSUE = { number: 12, title: 'Fix login', url: 'https://github.com/o/r/issues/12' };

function memory(initial) {
  const files = new Map(initial ? [['F', initial]] : []);
  return {
    files,
    links: createIssueLinks({
      file: 'F',
      readText: (f) => { if (!files.has(f)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(f); },
      writeText: (f, t) => { files.set(f, t); },
      mkdir: () => {},
    }),
  };
}

test('set then get: the issue comes back for the same branch and worktree', () => {
  const { links } = memory();
  assert.deepStrictEqual(links.set({ branch: 'fix/12-fix-login', path: 'C:\\p\\fix-12', issue: ISSUE }), { ok: true });
  assert.deepStrictEqual(links.get('fix/12-fix-login', 'C:\\p\\fix-12'), ISSUE);
  assert.deepStrictEqual(links.get('fix/12-fix-login', 'c:/p/fix-12/'), ISSUE, 'the same folder spelled another way');
});

test('a different branch, or the same branch in another worktree, has no link (a git switch drops it)', () => {
  const { links } = memory();
  links.set({ branch: 'fix/12-fix-login', path: 'C:\\p\\fix-12', issue: ISSUE });
  assert.strictEqual(links.get('feat/other', 'C:\\p\\fix-12'), null);
  assert.strictEqual(links.get('fix/12-fix-login', 'C:\\p\\elsewhere'), null);
  assert.deepStrictEqual(links.get('fix/12-fix-login', null), ISSUE, 'no folder known (a merged lane in the drawer): the branch decides');
});

test('it survives a new reader of the same file (a restart)', () => {
  const m = memory();
  m.links.set({ branch: 'fix/12-fix-login', path: 'C:\\p\\fix-12', issue: ISSUE });
  const again = createIssueLinks({ file: 'F', readText: (f) => m.files.get(f), writeText: () => assert.fail('a read writes nothing'), mkdir: () => {} });
  assert.deepStrictEqual(again.get('fix/12-fix-login', 'C:\\p\\fix-12'), ISSUE);
});

test('a second lane does not overwrite the first, and the same branch is replaced', () => {
  const { links } = memory();
  links.set({ branch: 'fix/12-a', path: 'C:\\p\\a', issue: ISSUE });
  links.set({ branch: 'feat/7-b', path: 'C:\\p\\b', issue: { number: 7, title: 'B', url: null } });
  assert.strictEqual(links.get('fix/12-a', 'C:\\p\\a').number, 12);
  assert.strictEqual(links.get('feat/7-b', 'C:\\p\\b').number, 7);
  links.set({ branch: 'fix/12-a', path: 'C:\\p\\a', issue: { number: 13, title: 'C', url: null } });
  assert.strictEqual(links.get('fix/12-a', 'C:\\p\\a').number, 13);
});

test('an unreadable, missing or foreign file is "no links", never a throw', () => {
  for (const text of [undefined, '', 'not json', '[]', '{"lanes":5}', '{"lanes":{"x":null}}', '{"lanes":{"x":{"issue":{"number":"1"}}}}']) {
    const { links } = memory(text);
    assert.strictEqual(links.get('x', null), null, String(text));
  }
});

test('only the three fields, strictly typed, are kept: a title too long is cut, a bad url is dropped', () => {
  const { links, files } = memory();
  links.set({ branch: 'b', path: 'C:\\p', issue: { number: 3, title: 'x'.repeat(1000), url: 'http://evil', body: 'secret', labels: ['a'] } });
  const got = links.get('b', 'C:\\p');
  assert.deepStrictEqual(Object.keys(got).sort(), ['number', 'title', 'url']);
  assert.ok(got.title.length <= 300);
  assert.strictEqual(got.url, null);
  assert.ok(!files.get('F').includes('secret'));
});

test('set refuses a record without a branch or a positive integer number, and writes nothing', () => {
  const { links, files } = memory();
  for (const bad of [{ branch: '', path: 'C:\\p', issue: ISSUE }, { branch: 'b', path: 'C:\\p', issue: { number: 0 } }, { branch: 'b', path: 'C:\\p', issue: { number: '1' } },
    { branch: 'b', path: 'C:\\p', issue: null }, null, undefined]) {
    assert.strictEqual(links.set(bad).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(files.size, 0);
});

test('a write that fails is an error answer, and the memory still serves the link this run', () => {
  const links = createIssueLinks({ file: 'F', readText: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, writeText: () => { throw new Error('disk full'); }, mkdir: () => {} });
  const r = links.set({ branch: 'b', path: 'C:\\p', issue: ISSUE });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /disk full/);
  assert.deepStrictEqual(links.get('b', 'C:\\p'), ISSUE);
});

test('no file (a look folder that is a link elsewhere) keeps links in memory only', () => {
  const links = createIssueLinks({ file: null });
  assert.deepStrictEqual(links.set({ branch: 'b', path: 'C:\\p', issue: ISSUE }), { ok: true });
  assert.deepStrictEqual(links.get('b', 'C:\\p'), ISSUE);
});

test('the list is capped: the oldest links go first', () => {
  const { links } = memory();
  let t = 0;
  const timed = createIssueLinks({ file: null, now: () => ++t, max: 3 });
  for (let n = 1; n <= 5; n++) timed.set({ branch: `b${n}`, path: `C:\\p${n}`, issue: { number: n, title: null, url: null } });
  assert.strictEqual(timed.get('b1', null), null);
  assert.strictEqual(timed.get('b2', null), null);
  assert.strictEqual(timed.get('b5', null).number, 5);
  assert.ok(links);
});

test('issueLinksFileFor: beside the other project state, or null when the look folder is a link elsewhere', () => {
  const made = [];
  const fsFake = { lstatSync: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, mkdirSync: (p) => made.push(p), writeFileSync: () => {}, existsSync: () => false };
  const f = issueLinksFileFor('C:\\p\\dev', fsFake);
  assert.ok(f === null || path.basename(f) === 'issue-lanes.json', String(f));
});

// --- PR #202 Dexter round 2, N1 -------------------------------------------------------------------

test('N1: a read that fails for any reason but "no file" makes set refuse and leaves the file alone', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO']) {
    const writes = [];
    const links = createIssueLinks({
      file: 'F', readText: () => { const e = new Error(`${code}: busy`); e.code = code; throw e; },
      writeText: (f, t) => writes.push(t), mkdir: () => {},
    });
    const r = links.set({ branch: 'b', path: 'C:\p', issue: ISSUE });
    assert.strictEqual(r.ok, false, code);
    assert.match(r.error, new RegExp(code));
    assert.deepStrictEqual(writes, [], `${code}: the store is not rewritten from an empty base`);
    assert.deepStrictEqual(links.get('b', 'C:\p'), ISSUE, 'but this run still serves the link from memory');
  }
});

test('N1: a file that is not JSON (or not an object) is not an empty base either', () => {
  for (const text of ['not json', '[]', '"x"', 'null']) {
    const writes = [];
    const links = createIssueLinks({ file: 'F', readText: () => text, writeText: (f, t) => writes.push(t), mkdir: () => {} });
    assert.strictEqual(links.set({ branch: 'b', path: 'C:\p', issue: ISSUE }).ok, false, text);
    assert.deepStrictEqual(writes, [], text);
  }
});

test('N1: only a missing file (ENOENT) is an empty base, and the other lanes survive a set', () => {
  const m = memory();
  assert.strictEqual(m.links.set({ branch: 'a', path: 'C:\a', issue: ISSUE }).ok, true);
  assert.strictEqual(m.links.set({ branch: 'b', path: 'C:\b', issue: { number: 7, title: null, url: null } }).ok, true);
  const again = createIssueLinks({ file: 'F', readText: (f) => m.files.get(f), writeText: (f, t) => m.files.set(f, t), mkdir: () => {} });
  again.set({ branch: 'c', path: 'C:\c', issue: { number: 8, title: null, url: null } });
  assert.deepStrictEqual(Object.keys(JSON.parse(m.files.get('F')).lanes).sort(), ['a', 'b', 'c']);
});
