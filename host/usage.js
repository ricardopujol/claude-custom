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
const { claudeProjectsDir } = require('./claude-config-dir');
const { projectDirName } = require('./project-dir');
const { transcriptFiles } = require('./transcripts');

const EMPTY = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, sessions: 0 };

// Bytes per read, and lines parsed between yields. Both exist to bound a single
// synchronous span: a whole-file read would convert 52MB to a string in one go,
// which blocks the loop for longer than the helper's 80ms connect timeout even
// though the read itself is awaited.
const READ_CHUNK = 1 << 20;
const PARSE_BATCH = 500;

// Bytes kept from just before the resume point, to prove the cached prefix is
// still this file's prefix. Content-based on purpose: birthtime and inode are
// not populated reliably on Windows.
const FINGERPRINT_BYTES = 64;

// A ceiling on the unterminated tail we are willing to hold. Past this it
// cannot be a real JSONL record, and `carry` grows by Buffer.concat on every
// chunk -- quadratic synchronous memcpy. Measured shape of the hazard: a 60MB
// file with no newline in it (a corrupted transcript, a binary that got the
// extension) copies ~1.8GB in spans reaching 60MB, which is the exact thing the
// chunked read exists to prevent.
const MAX_CARRY = 4 * READ_CHUNK;

const NL = 10;   // '\n'

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

// Claude Code encodes the cwd by replacing every path separator and colon with
// a dash: C:\Users\x\proj -> C--Users-x-proj
function defaultProjectsDir() {
  return claudeProjectsDir();
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
const plus = (a, b) => (b ? {
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
} : { ...a });

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

async function parseLines(text, acc, seen) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      try {
        const obj = JSON.parse(trimmed);
        const message = obj && obj.message;
        // ONE MESSAGE IS ONE API CALL WITH ONE USAGE FIGURE. Claude Code writes
        // each content block of a message on its own line and repeats the
        // identical usage on every one, so a turn with a thinking block and a
        // tool call appears twice carrying the same numbers both times.
        //
        // Measured before the fix: 2,178 of 4,648 usage-bearing lines in this
        // project were repeats, inflating the total by 44.3% -- 1.60B reported
        // against a true 892M. Ricardo caught it by eye; no test did.
        //
        // An entry with NO id is always counted. Dropping those would trade a
        // known 44% overcount for an unknown undercount.
        const id = message && message.id;
        if (id && seen) {
          if (!seen.has(id)) {
            seen.add(id);
            addUsage(acc, message.usage);
          }
        } else {
          addUsage(acc, message && message.usage);
        }
      } catch {
        // A line that is complete but unparseable is not a partial write; it is
        // simply not ours. Either way it contributes nothing.
      }
    }
    if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
  }
}

// The bytes immediately before `offset`, or null when there are none. Read back
// from the file rather than carried out of the parse loop: one small extra
// read, and it cannot drift from what is actually on disk.
async function readFingerprint(fh, offset) {
  const len = Math.min(FINGERPRINT_BYTES, offset);
  if (len <= 0) return null;
  const buf = Buffer.allocUnsafe(len);
  // WRAPS THE OPERATION THAT CAN FAIL, not the function body. Miguel and
  // Dexter, PR #32, independently: a bare `catch {` around the whole body
  // cannot tell EBUSY from a ReferenceError, so a programming error anywhere
  // in here is converted into a file-level I/O outcome and reported as normal
  // operation.
  //
  // MEASURED, with a throw injected at this read: the module goes from 138
  // bytes to 276,138 -- a 2000x full re-read, the exact per-tick regression
  // this module exists to remove -- with ok:true, stale:0, absent:0. Not one
  // signal moves. Worse, this one is PERMANENT: the failure stores
  // `fingerprint: null`, and from the next tick `!cached.fingerprint` forces a
  // full re-read forever, while every total stays exactly correct.
  //
  // Fail-closed on real I/O is unchanged: EBUSY, EPERM and EBADF arrive as
  // SystemError and are still swallowed into `null`, which means re-read.
  let bytesRead;
  try {
    ({ bytesRead } = await fh.read(buf, 0, len, offset - len));
  } catch {
    return null;
  }
  return bytesRead === len ? buf : null;
}

// Is the cached prefix still this file's prefix? Fails CLOSED: a missing or
// unreadable fingerprint means re-read, never "assume it is fine". Being wrong
// that way costs one full parse; being wrong the other way is a permanently
// wrong total.
async function prefixIntact(fh, cached) {
  if (!cached.fingerprint) return cached.offset === 0;
  const len = cached.fingerprint.length;
  const buf = Buffer.allocUnsafe(len);
  // Same narrowing as readFingerprint, same reason. This one is LOUD rather
  // than silent when it breaks -- a throw here forces a full re-read on the
  // same tick, so a byte assertion catches it -- but it misdiagnoses: the
  // failure reads as "the fast path was lost" and sends the reader into the
  // resume logic when the fault is in their own code.
  let bytesRead;
  try {
    ({ bytesRead } = await fh.read(buf, 0, len, cached.offset - len));
  } catch {
    return false;
  }
  return bytesRead === len && buf.equals(cached.fingerprint);
}

/**
 * The tokens in one transcript, reusing whatever of it was already parsed.
 *
 * Returns `{ acc, state }`:
 *
 *   fresh   read this tick.
 *   stale   could not be opened, but we have read it before, so its last known
 *           total stands in. An undercount at worst, never an overcount, and
 *           `crossed` never celebrates downward, so the cost is announcing
 *           LATE, which is the safe direction.
 *   absent  could not be read and has NEVER been read. The true total may be
 *           higher than what we report, so this is the one file-level condition
 *           that must not be trusted as a baseline.
 *   gone    vanished between the listing and the read, or is not a file. It
 *           contributes nothing, and that is the CORRECT total.
 *
 * AMENDMENT, and it is spec drift introduced deliberately (Dexter, PR #32):
 * `stale` above is described as "could not be OPENED" -- a lock, and the whole
 * fresh/stale/absent design rests on that meaning, because a lock CLEARS. Since
 * the read helpers now rethrow TypeError and ReferenceError instead of
 * swallowing them, `stale` ALSO covers a programming error rethrown from a read
 * helper. That does not clear: it lights `stale` on every tick, forever.
 *
 * Written down because the alternative is the next person reading a
 * permanently-stale file as an antivirus lock and looking in the wrong place --
 * which is exactly the hunt that produced this change.
 *
 * The gone/absent split is the whole point, and stat() succeeding is exactly
 * the evidence that separates them: a lock cannot make a file disappear from
 * stat, and a deletion cannot be mistaken for one. Substituting for a vanished
 * file would over-report, and an over-report can announce a rung early, after
 * which `highest` suppresses the genuine crossing forever.
 */
async function readFileUsage(file, cache, openFile) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    cache.delete(file);
    return { acc: null, state: 'gone' };
  }
  if (!stat.isFile()) {
    cache.delete(file);
    return { acc: null, state: 'gone' };
  }

  const cached = cache.get(file);

  // Untouched since the last read. This covers every historical session, which
  // is most of the files and none of the cost.
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // acc AND tail: an unterminated final record lives only in `tail`, and this
    // path is the one a finished file takes forever after.
    return { acc: plus(cached.acc, cached.tail), state: 'fresh' };
  }

  let fh;
  try {
    fh = await openFile(file, 'r');
  } catch {
    // stat() succeeded, so the file is there and we could not open it -- a lock.
    // Stand in the last known total if we have one; otherwise this is absence.
    return cached
      ? { acc: plus(cached.acc, cached.tail), state: 'stale' }
      : { acc: null, state: 'absent' };
  }

  try {
    // Resume only when the file grew AND the bytes before the resume point are
    // still the bytes we parsed. Growth alone is not evidence of an append: it
    // is equally consistent with a rewrite that happens to be longer, and
    // resuming onto the stale accumulator poisons the total permanently.
    const grown = cached && stat.size > cached.size;
    const resume = grown && await prefixIntact(fh, cached);
    let pos = resume ? cached.offset : 0;
    const acc = resume ? { ...cached.acc } : zero();
    // Which messages this file has already contributed. Cached alongside `acc`,
    // because a resumed read starts mid-file and would otherwise treat the
    // second block of an already-counted message as a fresh one. Reset on a
    // full re-read, since `acc` is too.
    const seen = new Set(resume && cached.seen ? cached.seen : []);

    // Bytes read past the last newline. They may be a line still being written,
    // or a complete record the writer never terminated -- see the tentative
    // parse below.
    let carry = null;
    let overlong = false;
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
      if (end === -1) {
        // Abandon a line that cannot be one. Advancing past it keeps the read
        // bounded and keeps the file readable again later; the file is reported
        // as unreadable rather than silently half-parsed.
        if (chunk.length > MAX_CARRY) { carry = null; overlong = true; continue; }
        carry = chunk;
        continue;
      }

      await parseLines(chunk.subarray(0, end + 1).toString('utf8'), acc, seen);
      carry = end + 1 < chunk.length ? Buffer.from(chunk.subarray(end + 1)) : null;
      await yieldToLoop();
    }

    // Absence, not a zero-token file: something is there and we declined to
    // buffer it, so we cannot claim it holds nothing.
    if (overlong) {
      return cached
        ? { acc: plus(cached.acc, cached.tail), state: 'stale' }
        : { acc: null, state: 'absent' };
    }

    // The unterminated tail, parsed TENTATIVELY. A record whose newline never
    // arrives (a killed process, a writer that does not terminate the last one)
    // is otherwise lost permanently: the file's mtime and size never change
    // again, so the fast path returns the cached total forever.
    //
    // Reported, never cached, and never a resume base. That is what makes it
    // safe: a genuinely partial line fails JSON.parse and contributes nothing,
    // and a complete-but-unterminated one is re-read and counted once when the
    // writer eventually appends.
    const tail = zero();
    // A COPY of the set: the tail is reported but never cached, so marking its
    // ids as counted would make that message vanish when its line completes and
    // is read for real.
    if (carry && carry.length) await parseLines(carry.toString('utf8'), tail, new Set(seen));

    const offset = pos - (carry ? carry.length : 0);
    // `pos`, not `stat.size`. The loop can exit early on a zero-byte read below
    // EOF, and recording stat.size would claim `acc` describes the whole file
    // when it describes less -- the next growth past stat.size would then resume
    // at `offset` and silently skip everything in between. Recording what was
    // actually consumed makes that region look like ordinary growth instead.
    cache.set(file, {
      mtimeMs: stat.mtimeMs, size: pos, offset, acc: { ...acc }, tail: { ...tail },
      seen: [...seen],
      fingerprint: await readFingerprint(fh, offset),
    });
    return { acc: plus(acc, tail), state: 'fresh' };
  } catch {
    return cached
      ? { acc: plus(cached.acc, cached.tail), state: 'stale' }
      : { acc: null, state: 'absent' };
  } finally {
    try { await fh.close(); } catch { /* already gone */ }
  }
}

const withTotal = (acc, sessions) => ({
  ...acc,
  total: acc.input + acc.output + acc.cacheWrite + acc.cacheRead,
  sessions,
});

async function readUsage({
  cwd, sessionId, projectsDir, cache = defaultCache,
  // Injectable because a locked file is not reproducible portably, and leaving
  // the stale/absent split untested would put the most load-bearing logic here
  // in a region nothing measures.
  openFile = (f, flags) => fsp.open(f, flags),
} = {}) {
  const root = projectsDir || defaultProjectsDir();
  const dir = path.join(root, projectDirName(cwd));

  // Top-level sessions AND their subagents -- see host/transcripts.js. Reusing
  // that enumeration rather than repeating it here is the whole point of the
  // module: the version this replaced walked only the top level, so every
  // subagent's spend was missing from a figure the milestone ladder is built on.
  const { files, errors: enumErrors } = await transcriptFiles(dir);
  if (files === null) {
    // `ok: false` -- ABSENCE, not zero. A readdir failure (EBUSY or EPERM from
    // an indexer or AV touching this folder is ordinary on Windows) used to be
    // indistinguishable from "this project has spent no tokens", so a caller
    // that seeded state from it recorded the failure as a fact. The milestone
    // announcer seeds from the first reading, and a failed first reading made
    // it announce the entire ladder on the next good tick.
    return {
      ok: false, absent: 0, stale: 0, unreadable: 0,
      session: { ...EMPTY }, project: { ...EMPTY },
    };
  }

  const project = zero();
  const session = zero();
  let matchedSession = false;
  // Enumeration failures are absence too: a subagents directory we could not
  // READ may hold transcripts, and dropping them silently is how a 7.4%
  // undercount gets reported as complete.
  let absent = enumErrors;
  let stale = 0;
  let sessions = 0;
  const live = new Set();

  for (const entry of files) {
    live.add(entry.file);
    if (!entry.subagent) sessions++;
    const { acc, state } = await readFileUsage(entry.file, cache, openFile);
    if (state === 'stale') stale++;
    if (state === 'absent') absent++;
    if (!acc) continue;                 // absent or gone: nothing to add
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
    // "Could the true total be higher than this?" -- which is the only question
    // the milestone announcer is asking when it decides whether to seed. A
    // STALE figure can be used: it is the last thing we actually read, it can
    // only lag, and `crossed` never celebrates downward, so the worst case is
    // announcing late. ABSENT cannot: we have never read that file and have no
    // idea what is in it.
    ok: absent === 0,
    absent,
    // Surfaced rather than absorbed, because substitution trades a visible drop
    // for a frozen number -- and a frozen number with no signal is the worse of
    // the two.
    stale,
    // Kept for callers that only care that something went wrong.
    unreadable: absent + stale,
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

// FINGERPRINT_BYTES is exported for the same reason READ_CHUNK and PARSE_BATCH
// are: so a test can assert the exact cost of a resumed read rather than
// hardcoding 128 beside a comment that will drift from it.
module.exports = {
  readUsage, projectDirName, defaultProjectsDir, EMPTY,
  READ_CHUNK, PARSE_BATCH, FINGERPRINT_BYTES,
  // shared with host/branch-ledger.js, which resumes transcripts the same way: one copy of the
  // prefix check, not two that can drift (host/transcripts.js, same reason)
  readFingerprint, prefixIntact,
};
