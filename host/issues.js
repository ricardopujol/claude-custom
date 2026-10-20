'use strict';
/**
 * Start a lane from a GitHub issue (BACKLOG #119 A6). Everything about an issue that is decidable without a
 * window lives here:
 *
 *   parseIssues(text)         `gh issue list --json` -> [{ number, title, labels, assignees, updatedAt, url }] | null
 *   slugify / prefixFor / branchFor    an issue -> `feat/<n>-<slug>` (`fix/` for a `bug` label)
 *   matchesFilter             the picker's search box
 *   issueNumberOfBranch / issueForBranch    a branch the + form made -> its issue, when the list has it
 *   buildBrief                the lane brief a new worktree starts with (a pure function of the issue)
 *   createIssueService        gh, run with an argv ARRAY, cached 60 s per folder
 *
 * THE RULES THAT COST SOMETHING (each has a test):
 *   - gh is never run through a shell and its argument vectors carry no issue text: the title only ever reaches
 *     a branch name (`slugify` keeps [a-z0-9-]) and a file's content, never a command.
 *   - A list that can't be read is NOT "no issues". `parseIssues` answers null for anything that isn't a JSON
 *     list, and the service reports a failure instead of an empty picker (the absence-as-zero trap).
 *   - A failure is never cached, so a gh that comes back (or a login) shows on the next open.
 *   - The issue body is somebody else's text. It goes into the brief QUOTED, every line behind `>`, so a line
 *     like `## What to build` can't open a section of its own, and it's cut at BODY_MAX with a link to the rest.
 */

const { execFile } = require('child_process');
const { readSeams } = require('./probe-seams');

const CACHE_MS = 60 * 1000;
const FAIL_MS = 30 * 1000;     // a failed read is remembered this long, so a polling caller doesn't re-run a hung or missing gh
const LIST_LIMIT = 50;
const RUN_TIMEOUT_MS = 15 * 1000;
const SLUG_MAX = 40;
const BODY_MAX = 4000;
const SIGN_IN_TEXT = 'Sign in to gh to pick an issue';
const FAIL_LINE_MAX = 120;

const GH_LIST_ARGS = Object.freeze(['issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT),
  '--json', 'number,title,labels,assignees,updatedAt,url']);

/** The argv for one issue's body, or null for a number that isn't a positive integer. */
function ghViewArgs(number) {
  if (!Number.isInteger(number) || number < 1) return null;
  return ['issue', 'view', String(number), '--json', 'number,title,body,labels,url'];
}

const str = (v) => (typeof v === 'string' ? v : null);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** An https URL with no credentials, else null: it ends up in a brief and (later) in the browser. */
function safeUrl(v) {
  const s = str(v);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  return u.href;      // the parsed form: a tab or newline inside the string is gone, so it can't reach a brief's line
}

const namesOf = (list, key) => (Array.isArray(list) ? list : [])
  .map(x => (x && typeof x === 'object' ? str(x[key]) : null))
  .filter(n => n !== null && n.trim() !== '')
  .map(oneLine);

function oneIssue(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!Number.isInteger(r.number) || r.number < 1) return null;
  const title = str(r.title) === null ? '' : oneLine(r.title);
  if (title === '') return null;
  return {
    number: r.number,
    title,
    labels: namesOf(r.labels, 'name'),
    assignees: namesOf(r.assignees, 'login'),
    updatedAt: str(r.updatedAt),
    url: safeUrl(r.url),
  };
}

/** gh's JSON -> the issues it holds (bad rows dropped, order kept), or null when it isn't a JSON list. */
function parseIssues(text) {
  if (typeof text !== 'string') return null;
  let list;
  try { list = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(list)) return null;
  return list.map(oneIssue).filter(i => i !== null);
}

// --- names --------------------------------------------------------------------------------------

/** lower-case, runs of anything but a-z0-9 become one dash, at most SLUG_MAX, never starting or ending in a dash. */
function slugify(title) {
  const s = (typeof title === 'string' ? title : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return s === '' ? 'issue' : s;
}

/** `fix` when the issue carries the label `bug` (any case), else `feat`. */
function prefixFor(labels) {
  return (Array.isArray(labels) ? labels : []).some(l => typeof l === 'string' && l.toLowerCase() === 'bug') ? 'fix' : 'feat';
}

const branchFor = (issue) => `${prefixFor(issue.labels)}/${issue.number}-${slugify(issue.title)}`;

const BRANCH_ISSUE = /^(?:feat|fix)\/([1-9]\d{0,8})-/;

/** The issue number in a branch the + form makes (`feat/12-x`, `fix/7-y`), else null. */
function issueNumberOfBranch(branch) {
  const m = typeof branch === 'string' ? BRANCH_ISSUE.exec(branch) : null;
  return m ? Number(m[1]) : null;
}

/**
 * The listed issue a branch was made from, or null: a branch that merely looks like one is no issue. The number alone
 * isn't enough (`feat/2-step-login` typed by hand is not issue #2 "Dark mode"): the branch must start with what the
 * picker would have made, `feat/<n>-<slug>` or `fix/<n>-<slug>` (a label may have changed), and may go on from there.
 */
function issueForBranch(branch, issues) {
  const n = issueNumberOfBranch(branch);
  if (n === null || !Array.isArray(issues)) return null;
  const i = issues.find(x => x && x.number === n);
  if (!i) return null;
  const stem = `${n}-${slugify(i.title)}`;
  // A boundary after the slug (end, or a dash): feat/1-add is not feat/1-address-book. A slug cut at SLUG_MAX was cut
  // mid-word, so a branch may go on from it with any character.
  const cut = slugify(i.title).length >= SLUG_MAX;
  const goesOn = (prefix) => branch.startsWith(prefix)
    && (cut || branch.length === prefix.length || branch[prefix.length] === '-');
  return goesOn(`feat/${stem}`) || goesOn(`fix/${stem}`) ? i : null;
}

/** The picker's search: every word must hit the number (a prefix), the title or a label. `#12` hits only the number. */
function matchesFilter(issue, query) {
  const words = String(query === undefined || query === null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
  const num = String(issue.number);
  const title = String(issue.title || '').toLowerCase();
  const labels = (Array.isArray(issue.labels) ? issue.labels : []).map(l => String(l).toLowerCase());
  return words.every((w) => {
    if (w === '#') return true;       // the start of "#12": narrows nothing yet
    if (w.startsWith('#')) return num.startsWith(w.slice(1));
    return num.startsWith(w) || title.includes(w) || labels.some(l => l.includes(w));
  });
}

/**
 * What the picker draws: the issues matching `query`, each with the branch picking it would fill in, and the size of
 * the whole list. The strip page does no matching and no naming of its own: every rule is here.
 */
function issueRows(issues, query) {
  const list = Array.isArray(issues) ? issues : [];
  return {
    rows: list.filter(i => matchesFilter(i, query))
      .map(i => ({ number: i.number, title: i.title, labels: [...i.labels], branch: branchFor(i) })),
    total: list.length,
  };
}

const QUERY_MAX = 200;

/** The strip's `{ query, refresh }`, read strictly: anything else is the plain request (all issues, cached). */
function readRequest(req) {
  const r = req && typeof req === 'object' && !Array.isArray(req) ? req : {};
  return { query: typeof r.query === 'string' ? r.query.slice(0, QUERY_MAX) : '', refresh: r.refresh === true };
}

/** What main answers the strip's `strip:issues`: `{ ok: true, rows, total }` | `{ ok: false, text }`. Never rejects. */
async function answerIssuesRequest(service, cwd, req) {
  const { query, refresh } = readRequest(req);
  try {
    const got = await service.list(cwd, { refresh });
    if (!got || got.ok !== true) return { ok: false, text: (got && got.text) || "Couldn't read issues" };
    return { ok: true, ...issueRows(got.issues, query) };
  } catch (err) {
    return { ok: false, text: `Couldn't read issues: ${(err && err.message) || String(err)}` };
  }
}

/**
 * The page of a tab's issue: the link the tab already has, else the one gh gives, else null (no browser opens). The
 * caller still passes it through app/external-link.js, the one gate a link leaves the app by.
 */
async function resolveIssueUrl(service, cwd, issue) {
  if (!issue || typeof issue !== 'object' || !Number.isSafeInteger(issue.number) || issue.number < 1) return null;
  if (typeof issue.url === 'string' && issue.url !== '') return issue.url;
  try {
    const got = await service.view(cwd, issue.number);
    return got && got.ok === true && got.issue && typeof got.issue.url === 'string' ? got.issue.url : null;
  } catch {
    return null;
  }
}

/** An issue number from the strip: a positive safe integer, else undefined (an ordinary branch). */
const issueArg = (n) => (Number.isSafeInteger(n) && n >= 1 ? n : undefined);

// --- the brief ----------------------------------------------------------------------------------

/** The body as quote lines, and whether it was cut. Counted in code points, so a cut never splits a character. */
function quoted(body) {
  const text = typeof body === 'string' ? body.replace(/\r\n?/g, '\n').trim() : '';
  if (text === '') return { lines: ['> (the issue has no description)'], cut: false };
  const chars = Array.from(text);
  const cut = chars.length > BODY_MAX;
  const shown = cut ? chars.slice(0, BODY_MAX).join('') : text;
  return { lines: shown.split('\n').map(l => (l === '' ? '>' : `> ${l}`)), cut };
}

/**
 * The text of `documentation/handoffs/CURRENT-<branch>.md` for a lane started from `issue`. Pure: the same
 * input is the same text. `body` is the issue's description (quoted, cut at BODY_MAX); `now` a Date.
 */
function buildBrief({ branch, worktree, issue, body, bodyUnavailable = null, now }) {
  const day = (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()).toISOString().slice(0, 10);
  // A body gh didn't give is NOT an empty one: say so, with the reason, and point at the link.
  const missed = typeof bodyUnavailable === 'string' && bodyUnavailable.trim() !== '' ? oneLine(bodyUnavailable) : null;
  const look = issue.url ? 'open the link' : 'open the issue on GitHub';
  const { lines: quote, cut } = missed
    ? { lines: [`> (the description couldn't be fetched: ${missed}; ${issue.url ? 'open the link above' : look})`], cut: false }
    : quoted(body);
  if (cut) quote.push(issue.url ? `> (cut here: the rest is at ${issue.url})` : '> (cut here: the rest is on the issue)');
  const labels = (issue.labels || []).length ? issue.labels.join(', ') : 'none';
  return [
    `# CURRENT — ${branch} · issue #${issue.number} · ${day}`,
    '',
    `**Step:** ${issue.title}`,
    `**Branch:** \`${branch}\`   **Worktree:** \`${worktree}\``,
    `**Source:** GitHub issue #${issue.number}${issue.url ? ` ${issue.url}` : ''}${missed ? ` (body not fetched: ${missed}; ${look})` : ''}`,
    `**Labels:** ${labels}`,
    '**Builder:** unassigned',
    '',
    '## The issue',
    ...quote,
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
  ].join('\n');
}

// --- gh -----------------------------------------------------------------------------------------

/**
 * What to execute for `gh`. `seam` is the probe's stand-in (host/probe-seams.js `gh`, read in that one place; used by
 * verify/probe-issue-intake.js): a `.js` file stands in for gh and runs under this node (as plain Node, hence
 * ELECTRON_RUN_AS_NODE), any other value is the executable itself. Null in real use.
 */
function ghCommand(seam, nodePath = process.execPath) {
  const own = typeof seam === 'string' ? seam : '';
  if (own === '') return { file: 'gh', prefix: [], env: null };
  if (/\.js$/i.test(own)) return { file: nodePath, prefix: [own], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { file: own, prefix: [], env: null };
}

const SIGN_IN_STDERR = /gh auth login|not logged in|authentication|bad credentials|HTTP 401|no git remotes|none of the git remotes|not a git repository|could not determine (?:base )?repo/i;

/** A run that failed -> the one dim line the form shows. Never a dialog. */
function classifyFailure(err) {
  const e = err && typeof err === 'object' ? err : {};
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  if (e.code === 'ENOENT' || SIGN_IN_STDERR.test(stderr)) return { text: SIGN_IN_TEXT };
  if (e.killed === true) return { text: "Couldn't read issues: gh took too long" };
  const first = stderr.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  return { text: first ? `Couldn't read issues: ${first.slice(0, FAIL_LINE_MAX)}` : "Couldn't read issues" };
}

function defaultRun(args, cwd, { seam = readSeams(process.env).gh } = {}) {
  const c = ghCommand(seam);
  return new Promise((resolve, reject) => {
    execFile(c.file, [...c.prefix, ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      env: c.env ? { ...process.env, ...c.env } : process.env,
    }, (err, out, stderr) => {
      if (!err) return resolve(out);
      if (typeof stderr === 'string') err.stderr = stderr;
      reject(err);
    });
  });
}

/**
 * The service: `list(cwd, { refresh })` -> { ok: true, issues } | { ok: false, text }, cached CACHE_MS per folder
 * (a failure never); `cached(cwd)` the last good list at any age or null (no gh run); `view(cwd, number)` ->
 * { ok: true, issue, body } | { ok: false, text }. Never rejects.
 */
function createIssueService({ run = defaultRun, now = Date.now, ttlMs = CACHE_MS, failMs = FAIL_MS } = {}) {
  const lists = new Map();      // cwd -> { at, issues }
  const failed = new Map();     // cwd -> { at, text }: the last failed read
  const inFlight = new Map();   // cwd -> Promise

  async function fetchList(cwd) {
    let out;
    const fail = (text) => { failed.set(cwd, { at: now(), text }); return { ok: false, text }; };
    try { out = await run([...GH_LIST_ARGS], cwd); } catch (err) { return fail(classifyFailure(err).text); }
    const issues = parseIssues(out);
    if (issues === null) return fail("Couldn't read issues: gh answered something else");
    lists.set(cwd, { at: now(), issues });
    failed.delete(cwd);
    return { ok: true, issues };
  }

  function list(cwd, { refresh = false } = {}) {
    const hit = lists.get(cwd);
    if (!refresh && hit && now() - hit.at < ttlMs) return Promise.resolve({ ok: true, issues: hit.issues });
    // A failure is remembered briefly (not for a form opening, which refreshes): the Git panel asks every 30 s, and a
    // gh that hangs costs 15 s a run.
    const bad = failed.get(cwd);
    if (!refresh && bad && now() - bad.at < failMs) return Promise.resolve({ ok: false, text: bad.text });
    if (!inFlight.has(cwd)) {
      inFlight.set(cwd, fetchList(cwd).finally(() => { inFlight.delete(cwd); }));
    }
    return inFlight.get(cwd);
  }

  const cached = (cwd) => (lists.has(cwd) ? lists.get(cwd).issues : null);

  async function view(cwd, number) {
    const args = ghViewArgs(number);
    if (args === null) return { ok: false, text: "Couldn't read that issue: not an issue number" };
    let out;
    try { out = await run(args, cwd); } catch (err) { return { ok: false, text: classifyFailure(err).text }; }
    let raw;
    try { raw = JSON.parse(out); } catch { raw = null; }
    const issue = oneIssue(raw);
    if (!issue) return { ok: false, text: "Couldn't read that issue: gh answered something else" };
    return { ok: true, issue, body: typeof raw.body === 'string' ? raw.body : '' };
  }

  return { list, cached, view };
}

module.exports = {
  parseIssues, slugify, prefixFor, branchFor, matchesFilter, issueNumberOfBranch, issueForBranch, issueRows,
  answerIssuesRequest, resolveIssueUrl, issueArg, buildBrief, ghCommand, ghViewArgs, classifyFailure, createIssueService, defaultRun,
  GH_LIST_ARGS, CACHE_MS, SLUG_MAX, BODY_MAX, SIGN_IN_TEXT,
};
