'use strict';
/**
 * Token spend for the current session and for the whole project.
 *
 * Read straight from Claude Code's own transcripts rather than tracked
 * independently — they are the authoritative record, they already exist, and
 * they cover sessions this harness never hosted.
 *
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * "Project total" is the sum across every session file in that folder, which is
 * what makes it a per-folder lifetime figure rather than a per-window one.
 *
 * ASYNCHRONOUS, INCREMENTAL, AND YIELDING — all three for the same reason.
 * Measured on this project: 23 transcripts, 64.4MB, 331-375ms of fully
 * synchronous work, on a 5-second timer. The host's event loop is what accepts
 * the hook helper's named-pipe connection and that helper gives up after 80ms,
 * so every tick was a window in which hook events are dropped. That is not a
 * hypothetical: it is the incident that cost 31 of 35 events and made fog.js
 * yield.
 *
 * An mtime cache alone would not have fixed it. Of that 331ms, 237ms is ONE
 * file — the active session, 52.8MB of the 64.4MB — and it changes every turn,
 * so it invalidates on every tick. The saving has to come from not re-parsing
 * the 52.8MB that did not change, which transcripts allow because they are
 * append-only: this reads only the appended bytes.
 *
 * The one new way that can go wrong is silent, so it is worth naming. A read
 * routinely lands mid-line, because the file is being appended to while it is
 * read. Resuming from the previous BYTE COUNT would start the next read inside
 * that line; the completed line would never parse and its tokens would be lost
 * permanently — an undercount no later read can heal, in the number the whole
 * milestone ladder is built on. So the resume point is the last NEWLINE, never
 * the size.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { projectDirName } = require('./project-dir');
const { transcriptFiles } = require('./transcripts');

const EMPTY = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, sessions: 0 };

// Bytes per read, and lines parsed between yields. Both exist to bound a single
// synchronous span: a whole-file read would convert 52MB to a string in one go,
// which blocks the loop for longer than the helper's 80ms connect timeout even
// though the read itself is awaited.
const READ_CHUNK = 1 << 20;
const PARSE_BATCH = 500;

const NL = 10;   // '\n'

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

// Claude Code encodes the cwd by replacing every path separator and colon with
// a dash: C:\Users\x\proj -> C--Users-x-proj
function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function addUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return;
  // NOTE: usage.iterations repeats these same numbers per API iteration.
  // Summing both inflates every figure silently, so only the top level counts.
  acc.input += num(usage.input_tokens);
  acc.output += num(usage.output_tokens);
  acc.cacheWrite += num(usage.cache_creation_input_tokens);
  acc.cacheRead += num(usage.cache_read_input_tokens);
}

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addInto = (target, acc) => {
  target.input += acc.input;
  target.output += acc.output;
  target.cacheWrite += acc.cacheWrite;
  target.cacheRead += acc.cacheRead;
};

// Parsed totals, keyed by ABSOLUTE path — `s1.jsonl` exists in every project
// folder, so a basename key would report one project's spend as another's.
// Each entry records where the last COMPLETE line ended, so a resumed read
// starts on a line boundary rather than inside a half-written line.
const defaultCache = new Map();

async function parseLines(text, acc) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      try {
        const obj = JSON.parse(trimmed);
        addUsage(acc, obj && obj.message && obj.message.usage);
      } catch {
        // A line that is complete but unparseable is not a partial write; it is
        // simply not ours. Either way it contributes nothing.
      }
    }
    if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
  }
}

/**
 * The tokens in one transcript, reusing whatever of it was already parsed.
 * Returns null when the file could not be read at all — which is ABSENCE, not
 * a file worth zero, and the caller reports it rather than quietly understating
 * the project.
 */
async function readFileUsage(file, cache) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = cache.get(file);

  // Untouched since the last read. This covers every historical session, which
  // is most of the files and none of the cost.
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.acc };
  }

  // Resume ONLY when the file grew. A file that shrank, or that changed at the
  // same length, is not the file we cached — append-only is an assumption about
  // someone else's writer, not a guarantee, and trusting it blindly would leave
  // a stale total that never recovers.
  const grown = cached && stat.size > cached.size;
  let pos = grown ? cached.offset : 0;
  const acc = grown ? { ...cached.acc } : zero();

  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    return null;
  }

  try {
    // Bytes read past the last newline: they belong to a line that is still
    // being written, so they are re-read next time rather than parsed now.
    let carry = null;
    while (pos < stat.size) {
      const want = Math.min(READ_CHUNK, stat.size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;

      let chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
      if (carry) chunk = Buffer.concat([carry, chunk]);

      // Split on the newline BYTE. 0x0A cannot occur inside a multi-byte UTF-8
      // sequence, so this boundary is always a safe place to decode — which a
      // character-offset resume would not be, and the corruption would only
      // show up on transcripts containing non-ASCII, i.e. most real ones.
      const end = chunk.lastIndexOf(NL);
      if (end === -1) { carry = chunk; continue; }

      await parseLines(chunk.subarray(0, end + 1).toString('utf8'), acc);
      carry = end + 1 < chunk.length ? Buffer.from(chunk.subarray(end + 1)) : null;
      await yieldToLoop();
    }

    const offset = pos - (carry ? carry.length : 0);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, offset, acc: { ...acc } });
    return { ...acc };
  } catch {
    return null;
  } finally {
    try { await fh.close(); } catch { /* already gone */ }
  }
}

const withTotal = (acc, sessions) => ({
  ...acc,
  total: acc.input + acc.output + acc.cacheWrite + acc.cacheRead,
  sessions,
});

async function readUsage({ cwd, sessionId, projectsDir, cache = defaultCache } = {}) {
  const root = projectsDir || defaultProjectsDir();
  const dir = path.join(root, projectDirName(cwd));

  // Top-level sessions AND their subagents -- see host/transcripts.js. Reusing
  // that enumeration rather than repeating it here is the whole point of the
  // module: the version this replaced walked only the top level, so every
  // subagent's spend was missing from a figure the milestone ladder is built on.
  const files = await transcriptFiles(dir);
  if (files === null) {
    // `ok: false` -- ABSENCE, not zero. A readdir failure (EBUSY or EPERM from
    // an indexer or AV touching this folder is ordinary on Windows) used to be
    // indistinguishable from "this project has spent no tokens", so a caller
    // that seeded state from it recorded the failure as a fact. The milestone
    // announcer seeds from the first reading, and a failed first reading made
    // it announce the entire ladder on the next good tick.
    return { ok: false, unreadable: 0, session: { ...EMPTY }, project: { ...EMPTY } };
  }

  const project = zero();
  const session = zero();
  let matchedSession = false;
  let unreadable = 0;
  let sessions = 0;
  const live = new Set();

  for (const entry of files) {
    live.add(entry.file);
    if (!entry.subagent) sessions++;
    const acc = await readFileUsage(entry.file, cache);
    if (!acc) { unreadable++; continue; }
    addInto(project, acc);
    // A subagent's spend belongs to the session that SPAWNED it -- it was spent
    // on that session's behalf, and filing it anywhere else makes the session
    // and project figures disagree about the same work.
    if (sessionId && entry.session === sessionId) {
      addInto(session, acc);
      matchedSession = true;
    }
  }

  // Forget transcripts that are gone, so a long-lived host does not hold the
  // parsed totals of every session it has ever seen.
  for (const key of cache.keys()) {
    if (key.startsWith(dir + path.sep) && !live.has(key)) cache.delete(key);
  }

  return {
    // Complete AND trustworthy, which is what every caller actually asks. A
    // transcript that could not be read is not one worth zero: reporting a
    // confident lower total is exactly what seeds a false baseline and throws a
    // party for work done weeks ago.
    ok: unreadable === 0,
    unreadable,
    // `sessions: 0` when no session file matched. The old identity test
    // `session === EMPTY` could never be true, because `session` is a fresh
    // object literal above -- so this always reported 1, including before the
    // SessionStart hook has told us which session we are.
    session: withTotal(session, matchedSession ? 1 : 0),
    // Sessions, not transcripts: a session with four subagents is one session,
    // and counting its five files would make the header say so.
    project: withTotal(project, sessions),
  };
}

module.exports = { readUsage, projectDirName, defaultProjectsDir, EMPTY, READ_CHUNK, PARSE_BATCH };
