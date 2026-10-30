'use strict';
/**
 * The chat view's history for a resumed session: a version-tolerant, best-effort read of the CLI's transcript
 * (BACKLOG #157, documentation/DESIGN_CHAT_VIEW.md "Build notes").
 *
 * The transcript JSONL is internal to the CLI ("can break on any release"), so this is the FALLBACK and the hooks are
 * the source (host/chat-feed.js). It keeps only what it recognises and skips the rest without throwing:
 *   - { type: 'user' } whose content is a string or text blocks -> the person's words (a tool_result block is not a prompt);
 *   - { type: 'assistant' } text blocks -> a reply (tool_use and thinking blocks are not);
 *   - isMeta lines, sidechains (a subagent's own talk) and slash-command plumbing (<command-...>) are skipped;
 *   - a turn keeps only its LAST reply, as the Stop hook's last_assistant_message does.
 * Only the file's last TAIL_BYTES are read, so a long session's transcript never loads whole.
 */

const fsp = require('fs/promises');

const TAIL_BYTES = 2 * 1024 * 1024;
const PLUMBING = /^\s*<(?:command-|local-command-)/;
// Lines that are the CLI's or another session's, whatever their marker says (an older CLI has no `origin`).
const NOT_THE_PERSON = /^\s*(?:<(?:task-notification|teammate-message|cross-session-message)\b|This session is being continued from a previous conversation)/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function textOf(content, wantUser) {
  if (typeof content === 'string') return wantUser ? content : '';
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n\n');
}

function parseTranscript(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  let pendingReply = null;
  const flush = () => { if (pendingReply !== null) { out.push({ role: 'assistant', text: pendingReply }); pendingReply = null; } };
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!isObj(o) || !isObj(o.message) || o.isMeta === true || o.isSidechain === true) continue;
    if (o.type === 'user') {
      // Only the person's own words: the CLI marks them `origin.kind: "human"` (a background task's notice is "task-notification"), and a
      // compact summary is `isVisibleInTranscriptOnly` / `isCompactSummary` with no isMeta (PR #226 Dexter 7).
      if (o.isVisibleInTranscriptOnly === true || o.isCompactSummary === true || (isObj(o.origin) && typeof o.origin.kind === 'string' && o.origin.kind !== 'human')) continue;
      const said = textOf(o.message.content, true);
      if (said.trim() === '' || PLUMBING.test(said) || NOT_THE_PERSON.test(said)) continue;
      flush();
      out.push({ role: 'user', text: said });
    } else if (o.type === 'assistant') {
      const said = textOf(o.message.content, false);
      if (said.trim() !== '') pendingReply = said;
    }
  }
  flush();
  return out;
}

const realFs = {
  stat: (f) => fsp.stat(f),
  async readTail(f, from) {
    const h = await fsp.open(f, 'r');
    try {
      const { size } = await h.stat();
      const buf = Buffer.alloc(Math.max(0, size - from));
      await h.read(buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally { await h.close(); }
  },
};

/** The parsed history of the transcript at `file`, or [] for anything that can't be read (absence is not an error here). */
async function readTranscript(file, fsImpl = realFs) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return [];
  try {
    const { size } = await fsImpl.stat(file);
    const from = Math.max(0, size - TAIL_BYTES);
    let body = await fsImpl.readTail(file, from);
    // A read that starts mid-file starts mid-line: that first line is cut and can't be trusted.
    if (from > 0) { const nl = body.indexOf('\n'); body = nl < 0 ? '' : body.slice(nl + 1); }
    return parseTranscript(body);
  } catch {
    return [];
  }
}

module.exports = { parseTranscript, readTranscript, TAIL_BYTES };
