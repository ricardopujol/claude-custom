'use strict';
/**
 * Where Claude's panel lives on disk (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md call 1).
 *
 *   <state>/canvas/<cli-session-id>/index.html   the page Claude wrote (at most 1 MB)
 *   <state>/canvas/<cli-session-id>/hosts.json   the hosts the person approved / denied for THIS panel
 *   <state>/canvas/<cli-session-id>/shelf.json   the artifact shelf (host/canvas-shelf.js)
 *
 * Keyed by the CLI's session id, so `--resume` brings the panel back and a new session starts empty. The id comes from a
 * hook payload and goes into a path, so it is checked first: a plain token, never a separator or a dot-segment.
 *
 * `index.html` is written by Claude's MCP tool (host/canvas-mcp.js, atomically) and read here with a size cap: a page over
 * 1 MB is REPORTED (its size, never its content) and the panel says so. A missing file is "empty", not an error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry } = require('./atomic-write');
const { hostOrigin } = require('../app/canvas-csp');

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_HOSTS = 100;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const validSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

/** `<root>/canvas/<id>`, or null when the id is not a plain token. */
function panelDir(root, id) {
  if (typeof root !== 'string' || !root || !validSessionId(id)) return null;
  return path.join(root, 'canvas', id);
}

/**
 * The page on disk: `{ status: 'empty'|'ok'|'toobig'|'unreadable', html?, bytes, signature }`. `signature` changes whenever
 * the page does, so a watcher that fires for any reason can tell "nothing changed" from "Claude wrote something".
 */
function readPage(dir, { fsImpl = fs } = {}) {
  const file = path.join(dir, 'index.html');
  let st;
  try { st = fsImpl.statSync(file); } catch (err) {
    return err && err.code === 'ENOENT' ? { status: 'empty', bytes: 0, signature: 'empty' } : { status: 'unreadable', bytes: 0, signature: 'unreadable' };
  }
  if (!st.isFile()) return { status: 'unreadable', bytes: 0, signature: 'unreadable' };
  if (st.size > MAX_HTML_BYTES) return { status: 'toobig', bytes: st.size, signature: `${st.size}:big:${Math.floor(st.mtimeMs)}` };
  let buf;
  try { buf = fsImpl.readFileSync(file); } catch { return { status: 'unreadable', bytes: 0, signature: 'unreadable' }; }
  if (buf.length > MAX_HTML_BYTES) return { status: 'toobig', bytes: buf.length, signature: `${buf.length}:big:${Math.floor(st.mtimeMs)}` };
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  return { status: 'ok', html: buf.toString('utf8'), bytes: buf.length, signature: `${buf.length}:${hash}` };
}

const origins = (list) => [...new Set((Array.isArray(list) ? list : []).map(hostOrigin).filter(Boolean))].slice(0, MAX_HOSTS);

/** The panel's host lists. Missing, corrupt or the wrong shape is "no hosts yet": the person is asked again, never a crash. */
function readHosts(dir, { fsImpl = fs } = {}) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, 'hosts.json'), 'utf8'));
    if (raw === null || typeof raw !== 'object') return { approved: [], denied: [] };
    return { approved: origins(raw.approved), denied: origins(raw.denied) };
  } catch { return { approved: [], denied: [] }; }
}

function writeHosts(dir, hosts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hosts.json');
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, approved: hosts.approved, denied: hosts.denied }, null, 2));
  renameWithRetry(temp, file);
}

/**
 * Allow, deny or remove one host for this panel. Returns the new lists, or null when nothing was changed (a bad origin or
 * action, or a list that is full: past the cap a page cannot add questions).
 */
function setHostDecision(dir, origin, action) {
  const o = hostOrigin(origin);
  if (!o || !['allow', 'deny', 'remove'].includes(action)) return null;
  const cur = readHosts(dir);
  const approved = cur.approved.filter(h => h !== o);
  const denied = cur.denied.filter(h => h !== o);
  if (action === 'allow') approved.push(o);
  if (action === 'deny') denied.push(o);
  if (approved.length > MAX_HOSTS || denied.length > MAX_HOSTS) return null;
  const next = { approved, denied };
  writeHosts(dir, next);
  return next;
}

module.exports = { validSessionId, panelDir, readPage, readHosts, setHostDecision, MAX_HTML_BYTES, MAX_HOSTS };
