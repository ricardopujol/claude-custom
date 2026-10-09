'use strict';
/**
 * The artifact shelf of Claude's panel (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md call 8).
 *
 * The shelf is filled by claude-custom, never by Claude: the host sees each `Artifact` publish through the CLI's own PostToolUse
 * hook and appends `{ title, url, time }` to <state>/canvas/<session-id>/shelf.json. So it survives restarts, and the page in the
 * panel (which can only READ the shelf, through its bridge) cannot forge an entry. `Artifact` is in POST_TOOL_MATCHER
 * (host/settings-writer.js); host/host.js hands every such event here and does not forward it to the mood engine or the Running
 * panel.
 *
 * THE PAYLOAD. The structured result of a real publish, read from a session transcript (verify/probe-artifact-payload.js):
 *   { url: 'https://claude.ai/artifact/<id>', path, artifact_id, title, updated, icon, audience, seq, version, ... }
 * and the text the model sees: "Published <path> at https://claude.ai/artifact/<id> (Version 1, version id ...) ...". The hook's
 * `tool_response` of other tools (ScheduleWakeup's `scheduledFor`, host/bedtime-state.js) is the structured form, so that is read
 * first; the text and content-array forms are read too, because the success payload of this tool could not be captured offline
 * (it needs a signed-in session) and the cost of a miss is an empty shelf, never a wrong entry. Only a plain https address with no
 * credentials is ever kept.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const MAX_SHELF = 200;
const TITLE_MAX = 120;
// The text form is the narrowest reading: the platform's own host only. A tool message can quote any address, and the model chooses the
// path that comes before the one that counts (PR #125 Dexter #7 / Miguel M2).
const URL_IN_TEXT = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const isShelfEvent = (ev) => isObj(ev) && (ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure')
  && isObj(ev.payload) && ev.payload.tool_name === 'Artifact';

/** A plain https address with no credentials, as the platform parsed it; else null. */
function cleanUrl(raw) {
  if (!isStr(raw)) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u.href;
}

const oneLine = (v) => (isStr(v) ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim() : '');

function textsOf(resp) {
  if (isStr(resp)) return [resp];
  const out = [];
  const blocks = (v) => { if (Array.isArray(v)) for (const b of v) { if (isStr(b)) out.push(b); else if (isObj(b) && isStr(b.text)) out.push(b.text); } else if (isStr(v)) out.push(v); };
  if (Array.isArray(resp)) blocks(resp);
  else if (isObj(resp)) { blocks(resp.content); if (isStr(resp.result)) out.push(resp.result); if (isStr(resp.text)) out.push(resp.text); if (isStr(resp.message)) out.push(resp.message); }
  return out;
}

/** A result or payload that says it failed: never a publish, whatever address its message quotes. */
function failed(payload) {
  const resp = payload.tool_response;
  if (payload.is_error === true || payload.isError === true || payload.error !== undefined) return true;
  return isObj(resp) && (resp.is_error === true || resp.isError === true || resp.error !== undefined && resp.error !== null && resp.error !== false);
}

/** `{ title, url, time }` for a successful publish, else null. */
function artifactFromPayload(payload, now = new Date()) {
  if (!isObj(payload) || payload.tool_name !== 'Artifact' || failed(payload)) return null;
  const resp = payload.tool_response;
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  let url = isObj(resp) ? cleanUrl(resp.url) : null;
  if (!url) { for (const t of textsOf(resp)) { const m = URL_IN_TEXT.exec(t); if (m) { url = cleanUrl(m[0]); if (url) break; } } }
  if (!url) return null;
  const file = isStr(input.file_path) ? input.file_path.split(/[\\/]/).pop() : '';
  const title = oneLine(isObj(resp) ? resp.title : '') || oneLine(input.title) || oneLine(input.description) || oneLine(file) || 'Artifact';
  return { title, url, time: now.toISOString() };
}

/**
 * THE shelf validator, for every trust boundary (PR #125 Miguel M4: it existed three times with three behaviours). An entry needs a non-empty
 * string title, a string time and a plain https address with no credentials; the title is one line of at most 120 characters, the
 * address is the platform's normalised form, and at most MAX_SHELF entries are kept. app/canvas-views.js (main) uses this function itself;
 * app/canvas-display.js is a plain script in the page and carries a copy that test/shelf-validators.test.js holds to the same fixtures.
 */
function cleanShelfList(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!isObj(it) || !isStr(it.title) || !it.title || !isStr(it.time)) continue;
    const url = cleanUrl(it.url);
    if (url) out.push({ title: oneLine(it.title) || 'Artifact', url, time: it.time });
    if (out.length >= MAX_SHELF) break;
  }
  return out;
}

/** The shelf on disk, newest first. Missing, corrupt or the wrong shape is an empty shelf; a bad entry is dropped. */
function readShelf(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'shelf.json'), 'utf8'));
    if (!isObj(raw) || !Array.isArray(raw.items)) return [];
    return cleanShelfList(raw.items);
  } catch { return []; }
}

/** Put an entry at the top (the same url is updated in place, not duplicated), cap the shelf, write it atomically. */
function addToShelf(dir, item) {
  const next = [item, ...readShelf(dir).filter(i => i.url !== item.url)].slice(0, MAX_SHELF);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'shelf.json');
  writeFileAtomic(file, JSON.stringify({ version: 1, items: next }, null, 2));
  return next;
}

module.exports = { isShelfEvent, artifactFromPayload, readShelf, addToShelf, cleanShelfList, MAX_SHELF };
