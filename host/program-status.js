'use strict';
/**
 * The Program Status Protocol (OSC 7501): what the CLI says about itself, as data.
 * Spec: https://www.superlogical.com/rex/docs/build/program-status.md (Claude Code 2.1.295+).
 *
 *   parseReport(data)       the text after "7501;" -> { query: true } | { report } | {} (discarded whole)
 *   createProgramStatus()   the record store: apply / dropActive / reset / root / snapshot / live
 *   QUERY_REPLY             the capability answer to "OSC 7501 ; ? ST"
 *
 * Pure: no terminal, no socket, no clock. host/terminal-state.js hands it the OSC payloads, host/host.js writes the
 * reply and broadcasts the snapshot, host/attention.js turns the root record into the same cues the hooks raise.
 *
 * WHO ANSWERS DA1 (measured 2026-10-19, verify/probe-osc-7501.js and a bare node-pty experiment). The program sends
 * "OSC 7501 ; ? ST" and then a DA1 sentinel "CSI c"; if the DA1 answer reaches it BEFORE the 7501 answer, the protocol is
 * marked unsupported for the whole session.
 *   - Before this lane, on the OS's ConPTY: conhost answered DA1 ITSELF, 3 ms after the program wrote it, and dropped the
 *     host's OSC reply on the way in, so the program never saw a 7501 answer at all. The window's xterm answered DA1 too
 *     (twice per query in total). Nothing a host does can beat conhost, so the session runs on node-pty's bundled ConPTY
 *     (host/conpty-choice.js), which forwards "CSI c" to the host unanswered and delivers the host's reply.
 *   - Now: with a window attached, the WINDOW's xterm answers DA1 (renderer -> socket -> host -> pty). The host's headless
 *     xterm generates the same answer ("CSI ? 1 ; 2 c") but sends it on only when NO window is attached
 *     (host.js onResponse), straight from the parse, so it follows the 7501 answer in stream order. A detached host
 *     therefore answers the query and the sentinel both.
 * The ordering with a window is enforced, not hoped for: host/parse-gate.js holds a DA1-shaped input frame until the headless
 * parse has passed every byte the host had already received from the pty, and the OSC handler writes the 7501 answer to the
 * pty synchronously inside that parse. The query always precedes its sentinel in the byte stream, so by the time the
 * sentinel's answer can be released, the query has been parsed and answered (probe: 41 of 41 rounds, 7501 first).
 *
 * Limits (all from the spec): a report over 4096 bytes, with a missing or unknown state, failing base64 or invalid
 * UTF-8, or holding a control character is discarded whole. id <= 128 bytes, <= 32 per segment, <= 8 levels. app <= 32
 * bytes, title <= 192 decoded, msg <= 2048 decoded. 64 records held at least, 256 at most.
 *
 * Choices the spec leaves open, each deliberate: a token with no "=" or a key given twice discards the report whole
 * (fail closed, there is no right reading); an unknown KIND value discards it whole, while a kind on a state other
 * than blocked, or a progress on a state other than working/blocked, is dropped from the record and the rest kept;
 * a decoded title or msg is kept as sent (it is only ever shown as text, never as chrome).
 */

const STATES = ['idle', 'working', 'done', 'blocked', 'error'];
const KINDS = ['permission', 'question', 'auth'];
const MAX_REPORT_BYTES = 4096;
const MAX_ID_BYTES = 128;
const MAX_ID_SEGMENT_BYTES = 32;
const MAX_ID_LEVELS = 8;
const MAX_APP_BYTES = 32;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 2048;
const MIN_RECORDS = 64;
const MAX_RECORDS = 256;

const QUERY_REPLY = `\x1b]7501;?:states=${STATES.join(',')}:kinds=${KINDS.join(',')}\x1b\\`;

// C0, DEL and C1. A real ST or BEL never reaches here: the terminal's parser has already used it up.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const bytes = (s) => Buffer.byteLength(s, 'utf8');

const NONE = Object.freeze({});

// Strict base64 of UTF-8 text, at most `max` decoded bytes; null for anything else.
function decodeText(value, max) {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.length > max || buf.toString('base64') !== value) return null;     // the round trip refuses non-canonical padding bits
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return null; }
}

function validId(id) {
  if (id === '') return true;
  if (bytes(id) > MAX_ID_BYTES) return false;
  const segs = id.split('/');
  return segs.length <= MAX_ID_LEVELS && segs.every(s => s !== '' && bytes(s) <= MAX_ID_SEGMENT_BYTES);
}

function parseReport(data) {
  if (typeof data !== 'string') return NONE;
  if (data.startsWith('?')) return { query: true };
  if (bytes(data) > MAX_REPORT_BYTES || CONTROL.test(data)) return NONE;
  const fields = new Map();
  for (const token of data.split(':')) {
    const eq = token.indexOf('=');
    if (eq < 1) return NONE;                                  // no "=", or no key
    const key = token.slice(0, eq);
    if (fields.has(key)) return NONE;
    fields.set(key, token.slice(eq + 1));
  }
  const state = fields.get('state');
  if (!(state === 'clear' || STATES.includes(state))) return NONE;

  const id = fields.has('id') ? fields.get('id') : '';
  if (!validId(id)) return NONE;

  let kind = null;
  if (fields.has('kind')) {
    if (!KINDS.includes(fields.get('kind'))) return NONE;
    if (state === 'blocked') kind = fields.get('kind');
  }

  let progress = null;
  if (fields.has('progress')) {
    const p = fields.get('progress');
    if (!/^\d{1,3}$/.test(p) || Number(p) > 100) return NONE;
    if (state === 'working' || state === 'blocked') progress = Number(p);
  }

  let app = null;
  if (fields.has('app')) {
    app = fields.get('app');
    if (bytes(app) > MAX_APP_BYTES) return NONE;
  }

  let title = null;
  if (fields.has('title')) {
    title = decodeText(fields.get('title'), MAX_TITLE_BYTES);
    if (title === null) return NONE;
  }
  let msg = null;
  if (fields.has('msg')) {
    msg = decodeText(fields.get('msg'), MAX_MSG_BYTES);
    if (msg === null) return NONE;
  }

  return { report: { state, id, kind, progress, app, title, msg } };
}

const sameRecord = (a, b) => a.state === b.state && a.kind === b.kind && a.progress === b.progress &&
  a.app === b.app && a.title === b.title && a.msg === b.msg;

function createProgramStatus() {
  // id -> record, oldest report first (a replaced record moves to the end). The root is id ''.
  const records = new Map();
  let seen = false;

  const isActive = (r) => r.state === 'working' || r.state === 'blocked';

  function removeWhere(test) {
    let changed = false;
    for (const [id, r] of [...records]) if (test(id, r)) { records.delete(id); changed = true; }
    return changed;
  }

  function evictOne() {
    for (const id of records.keys()) if (id !== '') { records.delete(id); return; }
  }

  // true when the held records changed
  function apply(report) {
    seen = true;
    if (report.state === 'clear') {
      if (report.id === '') return removeWhere(() => true);
      return removeWhere((id) => id === report.id || id.startsWith(report.id + '/'));
    }
    const record = { id: report.id, state: report.state, kind: report.kind, progress: report.progress, app: report.app, title: report.title, msg: report.msg };
    const had = records.get(report.id);
    if (had && sameRecord(had, record)) return false;
    if (had) records.delete(report.id);
    else if (records.size >= MAX_RECORDS) evictOne();
    records.set(report.id, record);
    return true;
  }

  return {
    apply,
    // A new prompt (OSC 133 A) or the process exiting: what was in flight is not any more; done and error stay.
    dropActive: () => removeWhere((id, r) => isActive(r)),
    // RIS. The program still speaks the protocol afterwards, so live() does not reset.
    reset: () => removeWhere(() => true),
    live: () => seen,
    root: () => records.get('') || null,
    snapshot() {
      return {
        live: seen,
        root: records.get('') || null,
        children: [...records.values()].filter(r => r.id !== ''),
      };
    },
  };
}

// What goes to a window (PR #201 Miguel R4): the root, the newest FRAME_CHILDREN children, each message cut to FRAME_MSG, and the true count of
// children. The store itself holds up to 256 records of up to 2 KB; nothing reads more than this on the other side of the socket.
const FRAME_CHILDREN = 32;
const FRAME_MSG = 500;
function frameOf(snapshot) {
  const cut = (r) => (r === null ? null : { ...r, msg: typeof r.msg === 'string' ? r.msg.slice(0, FRAME_MSG) : r.msg });
  const kids = snapshot.children;
  return { live: snapshot.live, root: cut(snapshot.root), children: kids.slice(-FRAME_CHILDREN).map(cut), childCount: kids.length };
}

module.exports = {
  parseReport, createProgramStatus, frameOf, QUERY_REPLY, STATES, KINDS,
  MAX_REPORT_BYTES, MAX_RECORDS, MIN_RECORDS, FRAME_CHILDREN, FRAME_MSG,
};
