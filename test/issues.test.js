'use strict';
/**
 * host/issues.js (BACKLOG #119 A6): `gh issue list` output -> issues, an issue -> a branch name, an issue ->
 * a lane brief, and the 60 s cache. Everything but the cache is pure.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const {
  parseIssues, slugify, prefixFor, branchFor, matchesFilter, issueNumberOfBranch, issueForBranch,
  buildBrief, BODY_MAX, SLUG_MAX, ghCommand, GH_LIST_ARGS, ghViewArgs, classifyFailure, createIssueService,
} = require('../host/issues');

const gh = (rows) => JSON.stringify(rows);
const row = (over = {}) => ({
  number: 12, title: 'Fix the thing', labels: [{ name: 'bug' }], assignees: [{ login: 'ricardo' }],
  updatedAt: '2026-10-18T10:00:00Z', url: 'https://github.com/o/r/issues/12', ...over,
});

// --- parsing ------------------------------------------------------------------------------------

test('parseIssues reads gh issue list JSON into plain issues', () => {
  const out = parseIssues(gh([row()]));
  assert.deepStrictEqual(out, [{
    number: 12, title: 'Fix the thing', labels: ['bug'], assignees: ['ricardo'],
    updatedAt: '2026-10-18T10:00:00Z', url: 'https://github.com/o/r/issues/12',
  }]);
});

test('parseIssues: text that is not a JSON list is null (unknown), never an empty list', () => {
  for (const bad of [undefined, null, 5, '', 'not json', '{}', '"x"', 'null']) assert.strictEqual(parseIssues(bad), null, String(bad));
  assert.deepStrictEqual(parseIssues('[]'), []);
});

test('parseIssues drops an issue with no title or a number that is not a positive integer', () => {
  const out = parseIssues(gh([
    row({ number: 1 }), row({ number: 2, title: '' }), row({ number: 3, title: '   ' }), row({ number: 4, title: 7 }),
    row({ number: '5' }), row({ number: 6.5 }), row({ number: 0 }), row({ number: -2 }), row({ number: null }), null, 'x', row({ number: 9 }),
  ]));
  assert.deepStrictEqual(out.map(i => i.number), [1, 9]);
});

test('parseIssues is strict about the optional fields: a wrong type is absent, not coerced', () => {
  const [i] = parseIssues(gh([row({ labels: 'bug', assignees: null, updatedAt: 5, url: 7 })]));
  assert.deepStrictEqual(i.labels, []);
  assert.deepStrictEqual(i.assignees, []);
  assert.strictEqual(i.updatedAt, null);
  assert.strictEqual(i.url, null);
  const [j] = parseIssues(gh([row({ labels: [{ name: 'a' }, { name: 3 }, null, { name: '' }, 'b'], assignees: [{ login: 'x' }, {}, null] })]));
  assert.deepStrictEqual(j.labels, ['a']);
  assert.deepStrictEqual(j.assignees, ['x']);
});

test('parseIssues returns the normalised href, so a newline or tab inside the string cannot reach the brief', () => {
  assert.strictEqual(parseIssues(gh([row({ url: 'https://github.com/o/r/is\nsues/1\t2' })]))[0].url, 'https://github.com/o/r/issues/12');
});

test('parseIssues keeps only an https url; anything else is no link', () => {
  const urls = ['http://github.com/o/r/issues/1', 'javascript:alert(1)', 'file:///c:/x', 'https://user:pw@github.com/o/r/issues/1', '', 'github.com/o/r/issues/1'];
  for (const url of urls) assert.strictEqual(parseIssues(gh([row({ url })]))[0].url, null, url);
  assert.strictEqual(parseIssues(gh([row({ url: 'https://github.com/o/r/issues/12' })]))[0].url, 'https://github.com/o/r/issues/12');
});

test('parseIssues trims the title and keeps the list order', () => {
  const out = parseIssues(gh([row({ number: 7, title: '  Spaced  ' }), row({ number: 3, title: 'Second' })]));
  assert.deepStrictEqual(out.map(i => [i.number, i.title]), [[7, 'Spaced'], [3, 'Second']]);
});

// --- slug and branch ----------------------------------------------------------------------------

test('slugify: lower-case, non-alphanumerics to a dash, collapsed, no trailing dash', () => {
  assert.strictEqual(slugify('Fix the  Thing!!'), 'fix-the-thing');
  assert.strictEqual(slugify('  --Leading & trailing--  '), 'leading-trailing');
  assert.strictEqual(slugify('Crash on C:\\path\\file.txt (v2)'), 'crash-on-c-path-file-txt-v2');
});

test('slugify caps at 40 characters and never ends in a dash after the cut', () => {
  const s = slugify('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbb ccc');   // the cut lands right after the space's dash
  assert.ok(s.length <= SLUG_MAX);
  assert.ok(!s.endsWith('-'));
  assert.strictEqual(slugify('x'.repeat(100)).length, SLUG_MAX);
  assert.strictEqual(slugify(`${'a'.repeat(39)} b`), 'a'.repeat(39), 'the dash at position 40 is dropped, not kept');
});

test('slugify: a title with nothing alphanumeric still gives a usable slug', () => {
  for (const t of ['!!!', '日本語', '---', '  ', '🙂']) assert.strictEqual(slugify(t), 'issue', t);
  assert.strictEqual(slugify(null), 'issue');
  assert.strictEqual(slugify(undefined), 'issue');
});

test('property: a slug is always a valid git ref component, at most 40 characters, never empty', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (title) => {
    const s = slugify(title);
    assert.ok(s.length >= 1 && s.length <= SLUG_MAX, JSON.stringify(s));
    assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }), { numRuns: 500 });
});

test('property: slugify is idempotent on its own output', () => {
  fc.assert(fc.property(fc.string({ maxLength: 120 }), (title) => {
    const s = slugify(title);
    assert.strictEqual(slugify(s), s);
  }), { numRuns: 300 });
});

test('prefixFor: a bug label (any case) gives fix, everything else feat', () => {
  assert.strictEqual(prefixFor(['bug']), 'fix');
  assert.strictEqual(prefixFor(['Enhancement', 'BUG']), 'fix');
  assert.strictEqual(prefixFor(['bugfix', 'debug', 'bug-report']), 'feat', 'only the label "bug" itself');
  assert.strictEqual(prefixFor([]), 'feat');
  assert.strictEqual(prefixFor(undefined), 'feat');
  assert.strictEqual(prefixFor(['enhancement']), 'feat');
});

test('branchFor: <prefix>/<number>-<slug>', () => {
  assert.strictEqual(branchFor({ number: 42, title: 'Add the Widget', labels: [] }), 'feat/42-add-the-widget');
  assert.strictEqual(branchFor({ number: 7, title: 'Crash on start', labels: ['bug'] }), 'fix/7-crash-on-start');
});

test('property: a branch from an issue is accepted by the + form and is a valid ref', () => {
  const { checkBranch } = require('../host/worktree-ops');
  const { isValidBranchName } = require('../host/git-branch');
  fc.assert(fc.property(fc.integer({ min: 1, max: 999999 }), fc.string({ unit: 'binary', maxLength: 150 }), fc.boolean(),
    (number, title, bug) => {
      const b = branchFor({ number, title, labels: bug ? ['bug'] : [] });
      assert.strictEqual(checkBranch(b), null, b);
      assert.ok(isValidBranchName(b), b);
      assert.strictEqual(issueNumberOfBranch(b), number);
    }), { numRuns: 400 });
});

// --- branch -> issue ----------------------------------------------------------------------------

test('issueNumberOfBranch reads only the shape the + form makes', () => {
  assert.strictEqual(issueNumberOfBranch('feat/12-fix-it'), 12);
  assert.strictEqual(issueNumberOfBranch('fix/7-x'), 7);
  for (const b of ['feat/fix-it', 'chore/12-x', 'feat/12', 'feat/-12-x', 'develop', 'feat/0-x', 'feat/012-x', '', null, 5, 'feat/12x-y']) {
    assert.strictEqual(issueNumberOfBranch(b), null, String(b));
  }
});

test('issueForBranch needs the number AND the prefix and slug the picker would have made', () => {
  const dark = [{ number: 2, title: 'Dark mode', labels: [], assignees: [], updatedAt: null, url: null }];
  assert.strictEqual(issueForBranch('feat/2-step-login', dark), null, 'a hand-typed branch that starts with a number is no issue');
  assert.strictEqual(issueForBranch('fix/2-dark-mode', dark), dark[0], 'feat or fix: a label may have changed');
  assert.strictEqual(issueForBranch('feat/2-dark-mode', dark), dark[0]);
  assert.strictEqual(issueForBranch('feat/2-dark-mode-v2', dark), dark[0], 'a slug the person extended is still that issue');
  assert.strictEqual(issueForBranch('chore/2-dark-mode', dark), null);
  assert.strictEqual(issueForBranch('feat/2-dark', dark), null, 'a shorter slug is not what the picker made');
});

test('property: the branch the picker makes always finds its own issue again', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 999999 }), fc.string({ unit: 'binary', maxLength: 120 }), fc.boolean(), (number, title, bug) => {
    const i = { number, title: title.trim() === '' ? 'x' : title, labels: bug ? ['bug'] : [], assignees: [], updatedAt: null, url: null };
    assert.strictEqual(issueForBranch(branchFor(i), [i]), i);
  }), { numRuns: 300 });
});

test('issueForBranch needs the number in the list: a branch that merely looks like one is no issue', () => {
  const list = [{ number: 12, title: 'T', labels: [], assignees: [], updatedAt: null, url: null }];
  assert.strictEqual(issueForBranch('feat/12-t', list), list[0]);
  assert.strictEqual(issueForBranch('feat/13-t', list), null);
  assert.strictEqual(issueForBranch('feat/12-t', null), null);
  assert.strictEqual(issueForBranch('feat/12-t', []), null);
});

// --- filter -------------------------------------------------------------------------------------

test('matchesFilter: number, title and label, every word must hit, case-insensitive', () => {
  const i = { number: 120, title: 'Pick a Branch from an Issue', labels: ['enhancement', 'Good First'], assignees: [] };
  assert.ok(matchesFilter(i, ''));
  assert.ok(matchesFilter(i, '   '));
  assert.ok(matchesFilter(i, '120'));
  assert.ok(matchesFilter(i, '#120'));
  assert.ok(matchesFilter(i, 'branch ISSUE'));
  assert.ok(matchesFilter(i, 'enhance'));
  assert.ok(matchesFilter(i, 'first'));
  assert.ok(!matchesFilter(i, '12 0'));
  assert.ok(!matchesFilter(i, 'branch nothing'));
  assert.ok(!matchesFilter(i, '#1200'));
});

test('matchesFilter: a number matches as a prefix of the number, not inside it', () => {
  const i = { number: 120, title: 'x', labels: [], assignees: [] };
  assert.ok(matchesFilter(i, '12'));
  assert.ok(!matchesFilter(i, '20'));
});

// --- the brief ----------------------------------------------------------------------------------

const ISSUE = {
  number: 119, title: 'Start a lane from an issue', labels: ['enhancement', 'ui'], assignees: ['ricardo'],
  updatedAt: '2026-10-18T10:00:00Z', url: 'https://github.com/o/r/issues/119',
};
const WHEN = new Date('2026-10-20T09:30:00Z');

test('buildBrief: the standard sections, filled from the issue (snapshot)', () => {
  const text = buildBrief({
    branch: 'feat/119-start-a-lane-from-an-issue', worktree: 'C:\\p\\feat-119-start-a-lane-from-an-issue',
    issue: ISSUE, body: 'Line one.\n\nLine two.', now: WHEN,
  });
  assert.strictEqual(text, [
    '# CURRENT — feat/119-start-a-lane-from-an-issue · issue #119 · 2026-10-20',
    '',
    '**Step:** Start a lane from an issue',
    '**Branch:** `feat/119-start-a-lane-from-an-issue`   **Worktree:** `C:\\p\\feat-119-start-a-lane-from-an-issue`',
    '**Source:** GitHub issue #119 https://github.com/o/r/issues/119',
    '**Labels:** enhancement, ui',
    '**Builder:** unassigned',
    '',
    '## The issue',
    '> Line one.',
    '>',
    '> Line two.',
    '',
    '## What to build',
    '(from the issue)',
    '',
    '## Rules',
    '- Work only in this worktree.',
    '- Tests first; Conventional Commits; a PR to `develop`.',
    '',
    '## Read first',
    '',
    '',
    '## Verify with',
    'tests green',
    '',
    '## Open questions',
    '',
    '',
  ].join('\n'));
});

test('buildBrief: a body that could not be fetched is said so, with the reason and the link, never "no description"', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: '', bodyUnavailable: 'gh took too long', now: WHEN });
  assert.ok(text.includes('**Source:** GitHub issue #119 https://github.com/o/r/issues/119 (body not fetched: gh took too long; open the link)\n'));
  assert.ok(text.includes("> (the description couldn't be fetched: gh took too long; open the link above)"));
  assert.ok(!text.includes('has no description'));
  const noUrl = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: { ...ISSUE, url: null }, body: '', bodyUnavailable: 'x', now: WHEN });
  assert.ok(noUrl.includes('**Source:** GitHub issue #119 (body not fetched: x; open the issue on GitHub)\n'));
});

test('buildBrief: a reason is one line (a newline in it cannot add a line to the brief)', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: '', bodyUnavailable: 'a\n## What to build\nb', now: WHEN });
  assert.strictEqual(text.split('\n').filter(l => l === '## What to build').length, 1);
});

test('buildBrief is a pure function of its input', () => {
  const a = { branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: 'x', now: WHEN };
  assert.strictEqual(buildBrief(a), buildBrief({ ...a }));
});

test('buildBrief: a body over the cap is cut and the rest is a link', () => {
  const body = 'a'.repeat(BODY_MAX + 500);
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body, now: WHEN });
  assert.ok(text.includes(`> ${'a'.repeat(BODY_MAX)}\n`), 'exactly BODY_MAX characters are quoted');
  assert.ok(!text.includes('a'.repeat(BODY_MAX + 1)));
  assert.ok(text.includes('> (cut here: the rest is at https://github.com/o/r/issues/119)'));
});

test('buildBrief: a body at the cap is whole, with no cut line', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: 'a'.repeat(BODY_MAX), now: WHEN });
  assert.ok(!text.includes('(cut here'));
});

test('buildBrief: an empty body says so, and no link means no link text', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: { ...ISSUE, url: null, labels: [] }, body: '  \n ', now: WHEN });
  assert.ok(text.includes('> (the issue has no description)'));
  assert.ok(text.includes('**Source:** GitHub issue #119\n'));
  assert.ok(text.includes('**Labels:** none\n'));
});

test('buildBrief: every quoted line starts with ">", whatever the body holds (CRLF, headings, fences)', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: '# Heading\r\n```js\r\nx\r\n```\r\n- item', now: WHEN });
  const inside = text.split('\n').slice(text.split('\n').indexOf('## The issue') + 1, text.split('\n').indexOf('## What to build') - 1);
  assert.ok(inside.length >= 5);
  for (const l of inside) assert.ok(l.startsWith('>'), l);
  assert.ok(!text.includes('\r'));
});

test('buildBrief: a body line that looks like a section heading cannot start a new section', () => {
  const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body: '## What to build\nsurprise', now: WHEN });
  assert.strictEqual(text.split('\n').filter(l => l === '## What to build').length, 1);
});

test('property: the brief quotes at most BODY_MAX characters of the body and keeps one of each section', () => {
  fc.assert(fc.property(fc.string({ maxLength: BODY_MAX + 800 }), (body) => {
    const text = buildBrief({ branch: 'feat/1-a', worktree: 'C:\\w', issue: ISSUE, body, now: WHEN });
    for (const h of ['## The issue', '## What to build', '## Rules', '## Read first', '## Verify with', '## Open questions']) {
      assert.strictEqual(text.split('\n').filter(l => l === h).length, 1, h);
    }
    assert.ok(!text.includes('\r'));
  }), { numRuns: 200 });
});

// --- gh -----------------------------------------------------------------------------------------

test('the list and view argument vectors are fixed and carry no user text', () => {
  assert.deepStrictEqual(GH_LIST_ARGS, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,labels,assignees,updatedAt,url']);
  assert.deepStrictEqual(ghViewArgs(12), ['issue', 'view', '12', '--json', 'number,title,body,labels,url']);
});

test('ghViewArgs refuses a number that is not a positive integer', () => {
  for (const n of [0, -1, 1.5, '12', null, NaN, '12; calc']) assert.strictEqual(ghViewArgs(n), null, String(n));
});

test('ghCommand: gh itself by default; a .js stand-in runs under the current node (the probe seam)', () => {
  assert.deepStrictEqual(ghCommand(null), { file: 'gh', prefix: [], env: null });
  assert.deepStrictEqual(ghCommand(undefined), { file: 'gh', prefix: [], env: null });
  assert.deepStrictEqual(ghCommand(''), { file: 'gh', prefix: [], env: null });
  const c = ghCommand('C:\\x\\fake-gh.js', 'C:\\node.exe');
  assert.strictEqual(c.file, 'C:\\node.exe');
  assert.deepStrictEqual(c.prefix, ['C:\\x\\fake-gh.js']);
  assert.deepStrictEqual(c.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.strictEqual(ghCommand('C:\\x\\gh.exe').file, 'C:\\x\\gh.exe');
});

test('classifyFailure: no gh / not signed in / no repo are one dim line, anything else says what gh said', () => {
  const SIGN_IN = 'Sign in to gh to pick an issue';
  assert.strictEqual(classifyFailure({ code: 'ENOENT' }).text, SIGN_IN);
  assert.strictEqual(classifyFailure({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).text, SIGN_IN);
  assert.strictEqual(classifyFailure({ stderr: 'HTTP 401: Bad credentials' }).text, SIGN_IN);
  assert.strictEqual(classifyFailure({ stderr: 'no git remotes found' }).text, SIGN_IN);
  assert.strictEqual(classifyFailure({ stderr: 'none of the git remotes configured for this repository point to a known GitHub host.' }).text, SIGN_IN);
  assert.strictEqual(classifyFailure({ stderr: 'could not resolve host\nsecond line' }).text, "Couldn't read issues: could not resolve host");
  assert.strictEqual(classifyFailure({ killed: true }).text, "Couldn't read issues: gh took too long");
  assert.strictEqual(classifyFailure({}).text, "Couldn't read issues");
  assert.ok(classifyFailure({ stderr: 'x'.repeat(500) }).text.length <= 160);
});

// --- the service and its cache ------------------------------------------------------------------

function fakeService(answers, extra = {}) {
  const calls = [];
  let clock = 1000;
  const svc = createIssueService({
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      const a = typeof answers === 'function' ? answers(args, calls.length) : answers;
      if (a instanceof Error) throw a;
      return a;
    },
    now: () => clock,
    ...extra,
  });
  return { svc, calls, tick: (ms) => { clock += ms; } };
}

test('service.list: parses, and a second list inside 60 s is served from the cache', async () => {
  const { svc, calls, tick } = fakeService(gh([row()]));
  const a = await svc.list('C:\\p');
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.issues.length, 1);
  tick(59_999);
  const b = await svc.list('C:\\p');
  assert.strictEqual(b.ok, true);
  assert.strictEqual(calls.length, 1, 'no second gh');
  tick(2);
  await svc.list('C:\\p');
  assert.strictEqual(calls.length, 2, 'past 60 s it asks again');
});

test('service.list({refresh}) skips the cache (the form refreshes on open)', async () => {
  const { svc, calls } = fakeService(gh([row()]));
  await svc.list('C:\\p');
  await svc.list('C:\\p', { refresh: true });
  assert.strictEqual(calls.length, 2);
});

test('service.list: the cache is per folder', async () => {
  const { svc, calls } = fakeService(gh([row()]));
  await svc.list('C:\\a');
  await svc.list('C:\\b');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map(c => c.cwd), ['C:\\a', 'C:\\b']);
});

test('service.list: a failure is one dim line, remembered for 30 s, and an explicit refresh asks again', async () => {
  let n = 0;
  const { svc, calls, tick } = fakeService((args) => (++n === 1 ? Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) : gh([row()])));
  const bad = await svc.list('C:\\p');
  assert.deepStrictEqual(bad, { ok: false, text: 'Sign in to gh to pick an issue' });
  tick(29_999);
  assert.deepStrictEqual(await svc.list('C:\\p'), bad, 'inside 30 s the failure is served: a hung or missing gh is not re-run on every poll');
  assert.strictEqual(calls.length, 1);
  const good = await svc.list('C:\\p', { refresh: true });
  assert.strictEqual(good.ok, true, 'the form opening (refresh) bypasses it, so a login shows at once');
  assert.strictEqual(calls.length, 2);
});

test('service.list: past 30 s a failure is tried again, and a good list replaces the remembered failure', async () => {
  let n = 0;
  const { svc, calls, tick } = fakeService(() => (++n <= 2 ? Object.assign(new Error('x'), { code: 'ENOENT' }) : gh([row()])));
  assert.strictEqual((await svc.list('C:\\p')).ok, false);
  tick(30_001);
  assert.strictEqual((await svc.list('C:\\p')).ok, false);
  assert.strictEqual(calls.length, 2);
  tick(30_001);
  assert.strictEqual((await svc.list('C:\\p')).ok, true);
  assert.strictEqual((await svc.list('C:\\p')).ok, true);
  assert.strictEqual(calls.length, 3, 'the good answer is cached');
});

test('service.list: the negative cache is per folder', async () => {
  const { svc, calls } = fakeService(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
  await svc.list('C:\\a');
  await svc.list('C:\\b');
  assert.strictEqual(calls.length, 2);
});

test('service.list: output that is not an issue list is a failure, not "no issues"', async () => {
  const { svc } = fakeService('this is not json');
  const r = await svc.list('C:\\p');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /^Couldn't read issues/);
});

test('service.list: two asks at once share one gh run', async () => {
  const { svc, calls } = fakeService(gh([row()]));
  const [a, b] = await Promise.all([svc.list('C:\\p'), svc.list('C:\\p')]);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(a, b);
});

test('service.cached: the last list for a folder at any age, else null (no gh run)', async () => {
  const { svc, calls, tick } = fakeService(gh([row()]));
  assert.strictEqual(svc.cached('C:\\p'), null);
  await svc.list('C:\\p');
  tick(10 * 60_000);
  assert.strictEqual(svc.cached('C:\\p').length, 1);
  assert.strictEqual(calls.length, 1);
});

test('service.view: the body of one issue, with the same parse rules', async () => {
  const { svc, calls } = fakeService(JSON.stringify({ ...row({ number: 12 }), body: 'The body' }));
  const r = await svc.view('C:\\p', 12);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.issue.number, 12);
  assert.strictEqual(r.body, 'The body');
  assert.deepStrictEqual(calls[0].args, ['issue', 'view', '12', '--json', 'number,title,body,labels,url']);
});

test('service.view: a bad number never reaches gh; a body that is not text is empty; a failure is a failure', async () => {
  const { svc, calls } = fakeService(JSON.stringify({ ...row(), body: 7 }));
  assert.strictEqual((await svc.view('C:\\p', '12; calc')).ok, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await svc.view('C:\\p', 12)).body, '');
  const bad = fakeService(new Error('boom'));
  assert.strictEqual((await bad.svc.view('C:\\p', 12)).ok, false);
});

// --- the picker's rows --------------------------------------------------------------------------

test('issueRows: every issue becomes a row with its branch, filtered by the query, list order kept', () => {
  const { issueRows } = require('../host/issues');
  const list = [
    { number: 12, title: 'Crash on start', labels: ['bug'], assignees: [], updatedAt: null, url: null },
    { number: 7, title: 'Add the widget', labels: ['enhancement', 'ui'], assignees: ['x'], updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/o/r/issues/7' },
  ];
  const all = issueRows(list, '');
  assert.deepStrictEqual(all.rows, [
    { number: 12, title: 'Crash on start', labels: ['bug'], branch: 'fix/12-crash-on-start' },
    { number: 7, title: 'Add the widget', labels: ['enhancement', 'ui'], branch: 'feat/7-add-the-widget' },
  ]);
  assert.strictEqual(all.total, 2);
  const some = issueRows(list, 'widget');
  assert.deepStrictEqual(some.rows.map(r => r.number), [7]);
  assert.strictEqual(some.total, 2, 'total is the list, not the match');
  assert.deepStrictEqual(issueRows(list, 'nothing at all').rows, []);
});

test('issueRows: a list that is not a list is no rows', () => {
  const { issueRows } = require('../host/issues');
  for (const bad of [null, undefined, 'x', {}]) assert.deepStrictEqual(issueRows(bad, ''), { rows: [], total: 0 });
});

// --- the strip's request ------------------------------------------------------------------------

test('answerIssuesRequest: the rows for a query, or the dim line', async () => {
  const { answerIssuesRequest } = require('../host/issues');
  const list = parseIssues(gh([row(), row({ number: 7, title: 'Add the widget', labels: [] })]));
  const asked = [];
  const service = {
    list: async (cwd, o) => { asked.push([cwd, o]); return { ok: true, issues: list }; },
  };
  const a = await answerIssuesRequest(service, 'C:\p', { query: 'widget', refresh: true });
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.rows.map(r => r.number), [7]);
  assert.strictEqual(a.total, 2);
  assert.deepStrictEqual(asked, [['C:\p', { refresh: true }]]);
  const failing = { list: async () => ({ ok: false, text: 'Sign in to gh to pick an issue' }) };
  assert.deepStrictEqual(await answerIssuesRequest(failing, 'C:\p', {}), { ok: false, text: 'Sign in to gh to pick an issue' });
});

test('answerIssuesRequest: a request of the wrong shape is read as the plain one, and never throws', async () => {
  const { answerIssuesRequest } = require('../host/issues');
  const seen = [];
  const service = { list: async (cwd, o) => { seen.push(o); return { ok: true, issues: [] }; } };
  for (const bad of [undefined, null, 5, 'x', [], { query: 5, refresh: 'yes' }, { query: 'x'.repeat(500) }]) {
    const r = await answerIssuesRequest(service, 'C:\p', bad);
    assert.strictEqual(r.ok, true, JSON.stringify(bad));
  }
  assert.ok(seen.every(o => o.refresh === false), 'only a literal true refreshes');
  const boom = { list: async () => { throw new Error('boom'); } };
  assert.deepStrictEqual(await answerIssuesRequest(boom, 'C:\p', {}), { ok: false, text: "Couldn't read issues: boom" });
});

test('issueArg: a positive safe integer, else undefined (what main passes on from the strip)', () => {
  const { issueArg } = require('../host/issues');
  assert.strictEqual(issueArg(12), 12);
  for (const bad of [0, -1, 1.5, '12', null, undefined, NaN, Infinity, 2 ** 53, [], {}]) assert.strictEqual(issueArg(bad), undefined, String(bad));
});

test('resolveIssueUrl: the link the tab already has; else gh is asked; else null', async () => {
  const { resolveIssueUrl } = require('../host/issues');
  const asked = [];
  const service = { view: async (cwd, n) => { asked.push([cwd, n]); return { ok: true, issue: { url: 'https://github.com/o/r/issues/9' }, body: '' }; } };
  assert.strictEqual(await resolveIssueUrl(service, 'C:\p', { number: 9, url: 'https://github.com/o/r/issues/9' }), 'https://github.com/o/r/issues/9');
  assert.deepStrictEqual(asked, [], 'no gh run when the tab has the link');
  assert.strictEqual(await resolveIssueUrl(service, 'C:\p', { number: 9, url: null }), 'https://github.com/o/r/issues/9');
  assert.deepStrictEqual(asked, [['C:\p', 9]]);
  const failing = { view: async () => ({ ok: false, text: 'Sign in to gh to pick an issue' }) };
  assert.strictEqual(await resolveIssueUrl(failing, 'C:\p', { number: 9, url: null }), null);
  const linkless = { view: async () => ({ ok: true, issue: { url: null }, body: '' }) };
  assert.strictEqual(await resolveIssueUrl(linkless, 'C:\p', { number: 9, url: null }), null);
  const boom = { view: async () => { throw new Error('boom'); } };
  assert.strictEqual(await resolveIssueUrl(boom, 'C:\p', { number: 9, url: null }), null);
  for (const bad of [null, undefined, {}, { number: 'x' }]) assert.strictEqual(await resolveIssueUrl(service, 'C:\p', bad), null);
});

test('matchesFilter: a lone "#" (the start of "#12") narrows nothing yet', () => {
  const i = { number: 120, title: 'x', labels: [], assignees: [] };
  assert.ok(matchesFilter(i, '#'));
  assert.ok(matchesFilter(i, '# '));
  assert.ok(!matchesFilter(i, '# nothing'));
});

test('N2: the slug needs a boundary after it: feat/1-add is not feat/1-address-book', () => {
  const add = [{ number: 1, title: 'Add', labels: [], assignees: [], updatedAt: null, url: null }];
  assert.strictEqual(issueForBranch('feat/1-address-book', add), null);
  assert.strictEqual(issueForBranch('fix/1-addendum', add), null);
  assert.strictEqual(issueForBranch('feat/1-add', add), add[0]);
  assert.strictEqual(issueForBranch('feat/1-add-more', add), add[0], 'a dash continues the slug');
  assert.strictEqual(issueForBranch('feat/1-add/sub', add), null, 'a path part is another branch');
  const long = [{ number: 2, title: 'x'.repeat(60), labels: [], assignees: [], updatedAt: null, url: null }];
  assert.strictEqual(issueForBranch(branchFor(long[0]), long), long[0], 'a slug cut at 40 characters finds its issue');
  assert.strictEqual(issueForBranch(`${branchFor(long[0])}y`, long), long[0], 'and may be extended mid-word, because it was cut mid-word');
});
