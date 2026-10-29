'use strict';
/**
 * What the tab strip keeps between runs, with the project's other state (BACKLOG #141; documentation/DESIGN_TAB_STRIP.md):
 * the order the person dragged the lanes into, and the lanes they closed by hand, so a closed tab stays closed after a restart
 * (it is a row in the Lanes menu until they reopen it).
 *
 *   <project>\.claude-custom\tab-strip.json   { version: 1, order: [laneKey], closed: [{ key, path, branch }] }
 *
 * A key is the shell's own (app/tab-shell.js keyOf: the lower-cased worktree path), so it is only compared, never parsed.
 * `closed` is most recent first. Parsing is strict and drops what it doesn't understand one entry at a time; a FILE that
 * can't be read (any error but "missing") or isn't an object is an unknown store: load reports an error, and save refuses to
 * write over it (the person's data, in a state this code doesn't understand; the same rule as host/issue-links.js). With no
 * file (the look folder is a link elsewhere, host/style.js) the layout lives in memory for this run.
 */

const fs = require('fs');
const path = require('path');
const { lookDirState, ensureLookDir } = require('./style');
const { writeFileAtomic } = require('./atomic-write');

const FILE_NAME = 'tab-strip.json';
const MAX_ORDER = 500;
const MAX_CLOSED = 100;

const text = (s) => (typeof s === 'string' && s !== '' ? s : null);

/** <stateRoot>\.claude-custom\tab-strip.json, or null when .claude-custom is a link to somewhere else. */
function stripLayoutFileFor(stateRoot, fsImpl = fs) {
  if (lookDirState(stateRoot, fsImpl) === 'foreign') return null;
  return path.join(ensureLookDir(stateRoot, fsImpl), FILE_NAME);
}

function cleanOrder(list) {
  const out = [];
  for (const k of Array.isArray(list) ? list : []) if (text(k) && !out.includes(k)) out.push(k);
  return out.slice(0, MAX_ORDER);
}

function cleanClosed(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const key = text(c.key);
    const p = text(c.path);
    if (!key || !p || out.some(x => x.key === key)) continue;
    out.push({ key, path: p, branch: text(c.branch) });
  }
  return out.slice(0, MAX_CLOSED);
}

/** The clean `{ order, closed }` of a file's text; throws when the text isn't a JSON object. */
function parseLayout(body) {
  const raw = JSON.parse(body);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  return { order: cleanOrder(raw.order), closed: cleanClosed(raw.closed) };
}

function createStripLayout({
  file = null,
  readText = (f) => fs.readFileSync(f, 'utf8'),
  writeText = (f, body) => writeFileAtomic(f, body),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
} = {}) {
  let unknown = null;     // why the file can't be written over, once load has seen it

  /** `{ order, closed, error }`: read from disk each time it's asked (the shell asks once, at its start). */
  function load() {
    unknown = null;
    if (!file) return { order: [], closed: [], error: null };
    let body;
    try { body = readText(file); } catch (err) {
      if (err && err.code === 'ENOENT') return { order: [], closed: [], error: null };
      unknown = `can't read ${file}: ${(err && err.message) || String(err)}`;
      return { order: [], closed: [], error: unknown };
    }
    try {
      return { ...parseLayout(body), error: null };
    } catch {
      unknown = `${file} isn't a tab strip file; left alone`;
      return { order: [], closed: [], error: unknown };
    }
  }

  /** Save `{ order, closed }`. `{ ok: true }`, or `{ ok: false, error }`; never a throw. */
  function save(layout) {
    if (unknown) return { ok: false, error: unknown };
    const src = layout && typeof layout === 'object' ? layout : {};
    const clean = { order: cleanOrder(src.order), closed: cleanClosed(src.closed) };
    if (!file) return { ok: true };
    try {
      mkdir(path.dirname(file));
      writeText(file, JSON.stringify({ version: 1, ...clean }, null, 2) + '\n');
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    return { ok: true };
  }

  return { load, save };
}

module.exports = { createStripLayout, stripLayoutFileFor, parseLayout, FILE_NAME };
