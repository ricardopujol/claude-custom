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
const { normPath } = require('./project-layout');

const FILE_NAME = 'tab-strip.json';
const VERSION = 1;
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
    // Reopen finds a lane by `key` and un-closes it by `path`; a pair that disagrees would leave it closed for good (PR #227 Dexter 7).
    if (normPath(p) !== key) continue;
    out.push({ key, path: p, branch: text(c.branch) });
  }
  return out.slice(0, MAX_CLOSED);
}

/** The clean `{ order, closed }` of a file's text; throws when the text isn't a JSON object. */
function parseLayout(body) {
  const raw = JSON.parse(body);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  // A file of a later version is the person's data in a shape this code doesn't know: an unknown store, never read as v1 and rewritten.
  if (raw.version !== undefined && raw.version !== VERSION) throw new Error('unknown version');
  return { order: cleanOrder(raw.order), closed: cleanClosed(raw.closed) };
}

function createStripLayout({
  file = null,
  readText = (f) => fs.readFileSync(f, 'utf8'),
  writeText = (f, body) => writeFileAtomic(f, body),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
} = {}) {
  let unknown = null;     // why the file can't be written over, once load has seen it
  let last = { order: [], closed: [] };   // what THIS window last loaded or saved: the base a save is merged against

  /** `{ order, closed, error }`: read from disk each time it's asked (the shell asks once, at its start). */
  function load() {
    unknown = null;
    last = { order: [], closed: [] };
    if (!file) return { order: [], closed: [], error: null };
    let body;
    try { body = readText(file); } catch (err) {
      if (err && err.code === 'ENOENT') return { order: [], closed: [], error: null };
      unknown = `can't read ${file}: ${(err && err.message) || String(err)}`;
      return { order: [], closed: [], error: unknown };
    }
    try {
      const l = parseLayout(body);
      last = { order: l.order, closed: l.closed };
      return { ...l, error: null };
    } catch {
      unknown = `${file} isn't a tab strip file; left alone`;
      return { order: [], closed: [], error: unknown };
    }
  }

  /** Save `{ order, closed }`. `{ ok: true }`, or `{ ok: false, error }`; never a throw. */
  function save(layout) {
    if (unknown) return { ok: false, error: unknown };
    const src = layout && typeof layout === 'object' ? layout : {};
    const mine = { order: cleanOrder(src.order), closed: cleanClosed(src.closed) };
    if (!file) return { ok: true };
    try {
      // Other windows of this project write the same file, each from its own memory: merge into what is on disk instead of
      // replacing it (PR #227 Dexter 2). A lane THIS window reopened (it was closed when it loaded or last saved) is removed;
      // a lane another window closed stays closed; the order is this window's only if this window changed it.
      let onDisk = { order: [], closed: [] };
      try { onDisk = parseLayout(readText(file)); } catch (err) {
        if (!(err && err.code === 'ENOENT')) {
          // not sticky: a scan holding the file now may let go by the next save
          return { ok: false, error: `can't merge into ${file}: ${(err && err.message) || String(err)}` };
        }
      }
      const reopened = new Set(last.closed.filter(c => !mine.closed.some(m => m.key === c.key)).map(c => c.key));
      const closed = cleanClosed([...mine.closed, ...onDisk.closed.filter(c => !reopened.has(c.key))]);
      const orderChanged = JSON.stringify(mine.order) !== JSON.stringify(last.order);
      const merged = { order: orderChanged ? mine.order : onDisk.order, closed };
      mkdir(path.dirname(file));
      writeText(file, JSON.stringify({ version: VERSION, ...merged }, null, 2) + '\n');
      last = mine;
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    return { ok: true };
  }

  return { load, save };
}

module.exports = { createStripLayout, stripLayoutFileFor, parseLayout, FILE_NAME };
