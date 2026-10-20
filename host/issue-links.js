'use strict';
/**
 * Which GitHub issue a lane was started from, kept with the project's other state (BACKLOG #119 A6, PR #202 Dexter 5 + 6).
 *
 * The tab and the Git drawer used to derive the link only from the open-issue list (the newest 50), so it vanished after a
 * restart once the issue closed or fell off that list, while the lane's brief still named it. The window that makes the
 * lane knows the answer at Create time; this keeps it.
 *
 *   <project>\.claude-custom\issue-lanes.json   { version: 1, lanes: { "<branch>": { path, issue: { number, title, url }, at } } }
 *
 * Keyed on the BRANCH, and checked against the worktree path when both sides know one: a `git switch` in the worktree
 * leaves a different branch (no link), and a branch name reused in another worktree is not the same lane. Only three
 * fields of the issue are kept, strictly typed. A file that can't be read is "no links", never a throw; a write that
 * fails is an error answer, and the link is still served from memory for this run. With no file (the look folder is a
 * link elsewhere, see host/style.js) the links live in memory only.
 */

const fs = require('fs');
const path = require('path');
const { samePath } = require('./project-layout');
const { lookDirState, ensureLookDir } = require('./style');
const { writeFileAtomic } = require('./atomic-write');

const FILE_NAME = 'issue-lanes.json';
const TITLE_MAX = 300;
const MAX_LINKS = 500;

/** <stateRoot>\.claude-custom\issue-lanes.json, or null when .claude-custom is a link to somewhere else. */
function issueLinksFileFor(stateRoot, fsImpl = fs) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') return null;
  return path.join(ensureLookDir(stateRoot, fsImpl), FILE_NAME);
}

function httpsUrl(v) {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? u.href : null;
  } catch { return null; }
}

function cleanIssue(i) {
  if (!i || typeof i !== 'object' || Array.isArray(i)) return null;
  if (!Number.isSafeInteger(i.number) || i.number < 1) return null;
  return {
    number: i.number,
    title: typeof i.title === 'string' && i.title.trim() !== '' ? i.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : null,
    url: httpsUrl(i.url),
  };
}

function createIssueLinks({
  file = null, now = Date.now, max = MAX_LINKS,
  readText = (f) => fs.readFileSync(f, 'utf8'),
  writeText = (f, text) => writeFileAtomic(f, text),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
} = {}) {
  const memory = new Map();      // branch -> { path, issue, at }: what this run knows, written or not
  let disk = null;               // { stamp, lanes } the last file read

  // `{ lanes, error }`. Only a MISSING file (ENOENT) is an empty store. A read that failed any other way (EBUSY under an
  // antivirus scan, EPERM) or a file that isn't a JSON object is an UNKNOWN store: `get` serves nothing from it, and `set`
  // refuses to write, because writing over it would replace every other lane's link with just the newest one (PR #202 N1).
  function load() {
    if (!file) return { lanes: {}, error: null };
    let text;
    try { text = readText(file); } catch (err) {
      if (err && err.code === 'ENOENT') return { lanes: {}, error: null };
      return { lanes: {}, error: `can't read ${file}: ${(err && err.message) || String(err)}` };
    }
    if (disk && disk.text === text) return { lanes: disk.lanes, error: null };
    let raw;
    try { raw = JSON.parse(text); } catch { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { lanes: {}, error: `${file} isn't a lanes file; left alone` };
    const out = {};
    const lanes = raw.lanes && typeof raw.lanes === 'object' && !Array.isArray(raw.lanes) ? raw.lanes : {};
    for (const [branch, e] of Object.entries(lanes)) {
      const issue = e && typeof e === 'object' ? cleanIssue(e.issue) : null;
      if (!issue) continue;
      out[branch] = { path: typeof e.path === 'string' ? e.path : null, issue, at: Number.isFinite(e.at) ? e.at : 0 };
    }
    disk = { text, lanes: out };
    return { lanes: out, error: null };
  }

  /** The issue of the lane on `branch` (in `folder`, when given), or null. */
  function get(branch, folder = null) {
    if (typeof branch !== 'string' || branch === '') return null;
    let e = memory.get(branch) || null;
    if (!e) {
      const { lanes } = load();
      e = Object.prototype.hasOwnProperty.call(lanes, branch) ? lanes[branch] : null;
    }
    if (!e) return null;
    if (typeof folder === 'string' && folder !== '' && e.path && !samePath(folder, e.path)) return null;
    return { ...e.issue };
  }

  function set(record) {
    const { branch, path: folder, issue } = record && typeof record === 'object' ? record : {};
    const clean = cleanIssue(issue);
    if (typeof branch !== 'string' || branch === '' || !clean) return { ok: false, error: 'not a branch and an issue number' };
    const entry = { path: typeof folder === 'string' && folder !== '' ? folder : null, issue: clean, at: now() };
    memory.set(branch, entry);
    while (memory.size > max) {
      const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
      memory.delete(oldest);
    }
    if (!file) return { ok: true };
    try {
      const base = load();
      if (base.error) return { ok: false, error: base.error };
      const lanes = { ...base.lanes, [branch]: entry };
      const keep = Object.entries(lanes).sort((a, b) => b[1].at - a[1].at).slice(0, max);
      const body = JSON.stringify({ version: 1, lanes: Object.fromEntries(keep) }, null, 2) + '\n';
      mkdir(path.dirname(file));
      writeText(file, body);
      disk = null;
      for (const b of memory.keys()) if (!keep.some(([k]) => k === b)) memory.delete(b);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    return { ok: true };
  }

  return { get, set };
}

module.exports = { createIssueLinks, issueLinksFileFor, FILE_NAME };
