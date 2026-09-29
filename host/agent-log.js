'use strict';
/**
 * BACKLOG #10, the pure half: what a subagent is doing, read out of the
 * transcript Claude Code already writes for it.
 *
 * NOTHING HERE IS INVENTED. Every entry comes from one line of a transcript and
 * carries only what that line says. There is no "working..." line, no progress
 * estimate, no inferred idle: an agent that has written nothing yet has an
 * empty log, and the caller is told so (see host/agent-log-session.js), because
 * an empty list that reads as "idle" is the absence-reported-as-zero bug this
 * repo keeps catching.
 *
 * TWO JOBS:
 *
 *   parseLine  one transcript line -> zero or more entries
 *              `{ ts, kind, name, summary }`, kind in
 *              tool_use | tool_result | text | unknown
 *   readMore   a TAIL reader keyed by byte offset. It hands out COMPLETE lines
 *              only: the offset advances past a line's newline and never before
 *              it, so a line the CLI is halfway through writing is simply read
 *              again next time, whole.
 *
 * UNKNOWN IS AN ENTRY, NOT A DROP. A line type this module has not heard of, a
 * complete line that is not JSON, a thinking block (whose text the CLI does not
 * keep), an `attachment` -- each becomes a `kind: 'unknown'` entry named for
 * what it was, and is counted in `state.unknown`. A transcript format that
 * grows a new line type therefore shows up as a visible run of unknowns rather
 * than a log that quietly stops explaining itself. Only a BLANK line is
 * nothing: it holds no data to lose.
 *
 * ONE LINE MAY BE SEVERAL ENTRIES. Claude Code writes each content block on its
 * own line today, but a message may carry several, and one entry per block is
 * the only reading that loses none of them.
 *
 * MEASURED SHAPES (real subagent transcripts, 2026-09-29):
 *   user       content: string (the prompt)  |  [ {type:'tool_result',
 *              tool_use_id, content, is_error} ]
 *   assistant  content: [ {type:'thinking'|'text'|'tool_use', ...} ]
 *   attachment no `message` at all; `attachment.type` says what it is
 * Every line carries an ISO `timestamp`.
 */

const fsp = require('fs/promises');

// One log line is a line, not a paragraph. A tool result can be a whole file.
const SUMMARY_MAX = 300;
// tool_use id -> tool name, so a result can say WHICH tool it answers. Bounded,
// oldest out: a result arrives right after its call, so only recent ids matter.
const NAMES_MAX = 500;
const DEFAULT_MAX_ENTRIES = 500;
const WINDOW_BYTES = 4 * 1024 * 1024;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One line of text, bounded, with an ellipsis when it was cut. */
function clip(value) {
  if (typeof value !== 'string') return '';
  // Cut BEFORE collapsing: a 20 MB tool result must not be regexed whole.
  let s = value.slice(0, SUMMARY_MAX * 4).replace(/\s+/g, ' ').trim();
  if (s.length <= SUMMARY_MAX && value.length <= SUMMARY_MAX * 4) return s;
  s = s.slice(0, SUMMARY_MAX - 1);
  // Never end on half a surrogate pair.
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
  return s + '…';
}

/** A timestamp in ms, or `null`. Strict: `Date.parse(null)` is NaN, but `Number(null)` is 0. */
function stampOf(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// The field that says what a tool call is ABOUT, most telling first.
const INPUT_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt'];

function summarizeInput(input) {
  if (!isObject(input)) return '';
  for (const key of INPUT_KEYS) {
    if (typeof input[key] === 'string' && input[key]) return clip(input[key]);
  }
  // Nothing recognisable: show the input itself, never an empty line.
  let json;
  try { json = JSON.stringify(input); } catch { json = ''; }
  return clip(json);
}

function textOf(content) {
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (isObject(b) && typeof b.text === 'string') parts.push(b.text);
  }
  return clip(parts.join(' '));
}

function remember(names, id, name) {
  names.delete(id);            // refresh: a re-used id counts as recent
  names.set(id, name);
  if (names.size > NAMES_MAX) names.delete(names.keys().next().value);
}

function unknownEntry(ts, name, summary) {
  return { ts, kind: 'unknown', name, summary: clip(summary) };
}

function blockEntries(block, role, ts, names) {
  if (typeof block === 'string') return [{ ts, kind: 'text', name: role, summary: clip(block) }];
  if (!isObject(block)) return [unknownEntry(ts, 'block', '')];
  if (block.type === 'text') return [{ ts, kind: 'text', name: role, summary: clip(block.text) }];
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' && block.name ? block.name : 'tool_use';
    const entry = { ts, kind: 'tool_use', name, summary: summarizeInput(block.input) };
    if (typeof block.id === 'string' && block.id) {
      entry.id = block.id;
      remember(names, block.id, name);
    }
    return [entry];
  }
  if (block.type === 'tool_result') {
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
    const entry = {
      ts, kind: 'tool_result',
      name: (id && names.get(id)) || 'tool_result',
      summary: textOf(block.content),
    };
    if (id) entry.id = id;
    entry.error = block.is_error === true;
    return [entry];
  }
  // thinking (its text is not kept by the CLI), or a block type from the future.
  const type = typeof block.type === 'string' && block.type ? block.type : 'block';
  return [unknownEntry(ts, type, typeof block.thinking === 'string' ? block.thinking : '')];
}

/**
 * One transcript line -> `{ entries }`.
 *
 * @param text   the line, without its newline (a trailing `\r` is tolerated)
 * @param names  Map(tool_use id -> tool name), updated in place; pass the same
 *               Map for every line of one transcript so results find their tool
 */
function parseLine(text, names = new Map()) {
  if (typeof text !== 'string' || text.trim() === '') return { entries: [] };
  let obj;
  try { obj = JSON.parse(text); } catch { obj = undefined; }
  if (!isObject(obj)) return { entries: [unknownEntry(null, 'unparseable', text)] };

  const ts = stampOf(obj.timestamp);
  const type = typeof obj.type === 'string' && obj.type ? obj.type : 'unknown';

  if (type === 'user' || type === 'assistant') {
    const content = isObject(obj.message) ? obj.message.content : undefined;
    if (typeof content === 'string') return { entries: [{ ts, kind: 'text', name: type, summary: clip(content) }] };
    if (Array.isArray(content) && content.length > 0) {
      const entries = [];
      for (const block of content) entries.push(...blockEntries(block, type, ts, names));
      return { entries };
    }
    return { entries: [unknownEntry(ts, type, 'message without content')] };
  }

  const detail = isObject(obj.attachment) && typeof obj.attachment.type === 'string' ? obj.attachment.type : '';
  return { entries: [unknownEntry(ts, type, detail)] };
}

/** A fresh tail over `file`, positioned at byte 0. */
function createTail(file) {
  return { file, offset: 0, names: new Map(), unknown: 0, skippedBytes: 0 };
}

// How much of a transcript's END is read when a log is first opened. The window
// keeps 1000 entries; a finished agent's transcript can be tens of megabytes,
// and streaming all of it to keep the last 1000 rows is hundreds of frames and
// a redraw for each (Miguel M1, PR #63).
const TAIL_BYTES = 512 * 1024;

/**
 * A tail over `file` for a log being OPENED: positioned at the first complete
 * line of the last `tailBytes`, with the bytes before it counted in
 * `state.skippedBytes` so the window can say the earlier part was not shown.
 * A file no bigger than `tailBytes` starts at byte 0 and skips nothing.
 *
 * Never lands mid-line: it snaps forward to just past a newline. A window with
 * no newline at all (one line longer than `tailBytes`) reads from the top
 * instead -- rare, and the frame cap per poll bounds the cost.
 */
async function openTail(file, { tailBytes = TAIL_BYTES } = {}) {
  const state = createTail(file);
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= tailBytes) return state;
    const from = size - tailBytes;
    const buf = await readAt(fh, from, tailBytes);
    const nl = buf.indexOf(10);
    // No newline, or only the newline that ENDS a line which began before the
    // window: no complete line lies inside it, and skipping to the end would
    // hide the newest line altogether.
    if (nl === -1 || from + nl + 1 >= size) return state;
    state.offset = from + nl + 1;
    state.skippedBytes = state.offset;
    return state;
  } finally {
    await fh.close();
  }
}

async function readAt(fh, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
    if (bytesRead === 0) break;         // the file shrank under us; use what arrived
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Read what has been appended since `state`, complete lines only.
 *
 * Returns `{ entries, state, more, reset }`:
 *   state  to pass to the next call. `offset` sits just past the last newline
 *          consumed, so a partial trailing line is re-read next time, whole.
 *   more   true when complete lines may still be waiting (the cap stopped us);
 *          call again at once. False means caught up.
 *   reset  true when the file was SHORTER than the offset -- it was replaced or
 *          truncated -- and reading restarted from the top. The caller must
 *          discard what it holds.
 *
 * Rejects on any fs error, ENOENT included: "the file is gone" is a fact the
 * caller must say, not an empty read.
 *
 * `maxEntries` caps LINES consumed per call, so a huge transcript is handed
 * over in steps rather than as one enormous frame.
 */
async function readMore(state, { maxEntries = DEFAULT_MAX_ENTRIES, windowBytes = WINDOW_BYTES } = {}) {
  const fh = await fsp.open(state.file, 'r');
  try {
    const { size, ino } = await fh.stat();
    let offset = state.offset;
    let names = new Map(state.names);
    let unknown = state.unknown;
    let skipped = state.skippedBytes || 0;
    let reset = false;
    // A REPLACED file is a different file, however large it has grown: shorter
    // than the offset, or a different inode/file id (Dexter F7 / Miguel S3, PR
    // #63 -- a rename-over that ends up longer than the old offset used to be
    // read from the middle of a line). What is NOT detected: the SAME file
    // truncated in place and re-grown past the offset between two ticks.
    // Transcripts are append-only, so that is an accepted premise, not a case.
    const replaced = state.ino !== undefined && state.ino !== ino;
    if (size < offset || replaced) {
      offset = 0; names = new Map(); unknown = 0; reset = true; skipped = 0;
    }

    const entries = [];
    let consumed = 0;
    let more = false;
    const want = size - offset;
    if (want > 0) {
      // A window, grown until it holds a whole line or the whole remainder.
      let win = Math.min(want, windowBytes);
      let buf = await readAt(fh, offset, win);
      while (buf.indexOf(10) === -1 && win < want) {
        win = Math.min(want, win * 2);
        buf = await readAt(fh, offset, win);
      }
      let lines = 0;
      while (lines < maxEntries) {
        const nl = buf.indexOf(10, consumed);
        if (nl === -1) break;
        const text = buf.toString('utf8', consumed, nl);
        consumed = nl + 1;
        lines++;
        for (const e of parseLine(text, names).entries) {
          if (e.kind === 'unknown') unknown++;
          entries.push(e);
        }
      }
      // Caught up means nothing complete is left UNREAD -- not "nothing complete
      // is left in this window". A window that ended before EOF may end
      // mid-line, with the rest of the file (and its newlines) beyond it. The
      // old test only counted the line cap, so a 4 MB window holding 41 of 50
      // 100 KB lines reported caught-up and the session called it "finished"
      // (Dexter F2 / Miguel M2, PR #63).
      more = buf.indexOf(10, consumed) !== -1 || win < want;
    }
    return {
      entries,
      more,
      reset,
      state: { file: state.file, offset: offset + consumed, names, unknown, ino, skippedBytes: skipped },
    };
  } finally {
    await fh.close();
  }
}

module.exports = {
  parseLine, createTail, openTail, readMore, TAIL_BYTES,
  SUMMARY_MAX, NAMES_MAX, DEFAULT_MAX_ENTRIES,
};
