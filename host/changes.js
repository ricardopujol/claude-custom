'use strict';
/**
 * The Changes panel's host side (BACKLOG #119 A3): the worktree's changeset, read from git and never written to it.
 *
 *   PURE
 *   parseNameStatusZ(text)   -> [{ status: 'M'|'A'|'D'|'R'|'U', path, oldPath? }]     `git diff --name-status -z -M`
 *   parseNumstatZ(text)      -> [{ path, oldPath?, add, del, binary }]                 `git diff --numstat -z -M`; a binary file's
 *                                                                                       counts are null, never 0
 *   parseNulList(text)       -> string[]                                                `git ls-files -z`
 *   buildChangeset({ nameStatus, numstat, untracked }) -> files (sorted by path)
 *   capFiles(files, cap)     -> { files, total, more }
 *   summarize(files)         -> { files, add, del, unknown }     `unknown`: files whose counts git could not give
 *   summaryLine(summary)     -> '12 files · +340 −58'
 *   countLines(text)         -> number | null                    null for a text with a NUL (binary)
 *   resolveScope(asked, dirty) -> 'working' | 'branch'           `auto` is the working tree when it is dirty, else the branch
 *
 * The service that runs git and answers the page is host/changes-service.js (split off so this file stays pure and mutation-testable).
 *
 * The WORKING TREE scope is the tree against HEAD: staged and unstaged edits together, plus untracked files (as adds). The BRANCH
 * scope is the tree against the merge-base with `develop` (else `main`, else `master`): everything this lane did, committed or not.
 */
const MAX_FILES = 500;
// An untracked file is read for its line count only up to this size; a bigger one shows `?` (PR #199 Miguel Y3: every refresh re-reads them all)
const MAX_COUNT_BYTES = 256 * 1024;
// A file over this is not compared (the reader would draw a wall); the page says "too large to compare".
const MAX_COMPARE_BYTES = 1024 * 1024;
const SCOPES = Object.freeze(['working', 'branch']);

const isStr = (v) => typeof v === 'string';

function parseNulList(text) {
  if (!isStr(text) || text === '') return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const STATUS_OF = { M: 'M', T: 'M', A: 'A', C: 'A', D: 'D', R: 'R', U: 'U' };

function parseNameStatusZ(text) {
  const t = parseNulList(text);
  const out = [];
  for (let i = 0; i < t.length;) {
    const code = t[i];
    const m = /^([A-Z])\d*$/.exec(code);
    if (!m) { i += 1; continue; }              // not a status token: resynchronise on the next
    const letter = m[1];
    const twoPaths = letter === 'R' || letter === 'C';
    const need = twoPaths ? 2 : 1;
    if (i + need > t.length - 1) break;                  // a truncated record
    const status = STATUS_OF[letter];
    if (twoPaths) {
      const oldPath = t[i + 1];
      const path = t[i + 2];
      if (status) out.push(letter === 'R' ? { status, path, oldPath } : { status, path });
      i += 3;
    } else {
      if (status) out.push({ status, path: t[i + 1] });
      i += 2;
    }
  }
  return out;
}

const COUNT = /^(\d+|-)$/;
const countOf = (s) => (s === '-' ? null : Number(s));

function parseNumstatZ(text) {
  const t = parseNulList(text);
  const out = [];
  for (let i = 0; i < t.length;) {
    const rec = t[i];
    const a = rec.indexOf('\t');
    const b = a === -1 ? -1 : rec.indexOf('\t', a + 1);
    if (b === -1) { i += 1; continue; }
    const addS = rec.slice(0, a);
    const delS = rec.slice(a + 1, b);
    const rest = rec.slice(b + 1);
    if (!COUNT.test(addS) || !COUNT.test(delS)) { i += 1; continue; }
    const add = countOf(addS);
    const del = countOf(delS);
    const binary = add === null || del === null;
    if (rest === '') {                                  // a rename or copy: the old and the new path are the next two fields
      if (i + 2 >= t.length) break;
      out.push({ path: t[i + 2], oldPath: t[i + 1], add, del, binary });
      i += 3;
    } else {
      out.push({ path: rest, add, del, binary });
      i += 1;
    }
  }
  return out;
}

const byPath = (a, b) => {
  const x = a.path.toLowerCase();
  const y = b.path.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

function buildChangeset({ nameStatus = [], numstat = [], untracked = [] } = {}) {
  const counts = new Map(numstat.map(n => [n.path, n]));
  const files = [];
  const seen = new Set();
  for (const s of nameStatus) {
    const n = counts.get(s.path);
    const f = { path: s.path, ...(s.oldPath ? { oldPath: s.oldPath } : {}), status: s.status, add: n ? n.add : null, del: n ? n.del : null, binary: n ? n.binary === true : false };
    files.push(f);
    seen.add(s.path);
  }
  for (const u of untracked) {
    if (seen.has(u.path)) continue;
    seen.add(u.path);
    const add = typeof u.add === 'number' ? u.add : null;
    files.push({ path: u.path, status: 'A', add, del: add === null ? null : 0, binary: u.binary === true, untracked: true });
  }
  return files.sort(byPath);
}

function capFiles(files, cap = MAX_FILES) {
  const list = Array.isArray(files) ? files : [];
  const n = Math.max(0, Math.floor(cap));
  return { files: list.slice(0, n), total: list.length, more: Math.max(0, list.length - n) };
}

function summarize(files) {
  const s = { files: 0, add: 0, del: 0, unknown: 0 };
  for (const f of Array.isArray(files) ? files : []) {
    s.files += 1;
    if (typeof f.add === 'number') s.add += f.add; else s.unknown += 1;
    if (typeof f.del === 'number') s.del += f.del;
  }
  return s;
}

function summaryLine(s) {
  if (!s || s.files === 0) return 'no changes';
  return `${s.files} file${s.files === 1 ? '' : 's'} · +${s.add} −${s.del}${s.unknown > 0 ? ' (+ binary or unread)' : ''}`;
}

function countLines(text) {
  if (!isStr(text)) return null;
  if (text.includes('\0')) return null;
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

// A blob as the Compare shows it, made the way host/repo-read.js makes the NOW side (a UTF-8 BOM dropped, CRLF folded to LF), so a line
// is marked changed only when it is (PR #199 Dexter 4). UTF-16 is refused as its own reason, not called binary.
//   -> { ok: true, text } | { ok: false, why: 'binary' | 'encoding' }
function decodeBase(buf) {
  if (!Buffer.isBuffer(buf)) return { ok: false, why: 'unreadable' };
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return { ok: false, why: 'encoding' };
  if (buf.includes(0)) return { ok: false, why: 'binary' };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, text: text.replace(/\r\n/g, '\n') };
}

function resolveScope(asked, dirty) {
  if (asked === 'working' || asked === 'branch') return asked;
  if (asked === 'auto' || asked === undefined) return dirty ? 'working' : 'branch';
  return dirty ? 'working' : 'branch';
}

module.exports = {
  parseNameStatusZ, parseNumstatZ, parseNulList, buildChangeset, capFiles, summarize, summaryLine, countLines, resolveScope, decodeBase,
  MAX_FILES, MAX_COMPARE_BYTES, MAX_COUNT_BYTES, SCOPES,
};
