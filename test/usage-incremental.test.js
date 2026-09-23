'use strict';
/**
 * readUsage, made cheap enough to run on a 5-second timer.
 *
 * MEASURED, on this project's own transcripts: 23 files, 64.4MB, 331-375ms of
 * FULLY SYNCHRONOUS work per tick. The host's event loop is what accepts the
 * hook helper's named-pipe connection and that helper gives up after 80ms, so
 * every tick was a window in which hook events are dropped -- the same incident
 * that cost 31 of 35 events before fog.js was made to yield.
 *
 * THE MTIME CACHE ALONE IS NOT ENOUGH, and this is the measurement that decides
 * the design: of that 331ms, 237ms is ONE file -- the active session, 52.8MB of
 * the 64.4MB. It changes every single turn, so it invalidates on every tick and
 * a cache keyed on mtime never covers the only file that costs anything. The
 * saving has to come from not re-parsing the 52.8MB that did not change.
 *
 * So: transcripts are APPEND-ONLY, and this reads only the appended bytes.
 *
 * Which introduces exactly one new way to be wrong, and it is silent: the read
 * lands mid-line (the file is being appended to as we read it), and a naive
 * "resume from the previous size" starts the next read in the middle of that
 * line. The line then never parses, and its tokens are lost FOREVER -- an
 * undercount that no later read can heal, in the number the whole milestone
 * ladder is built on. Hence `test/usage-incremental.test.js` exists mostly to
 * pin that one property.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readUsage, projectDirName , FINGERPRINT_BYTES } = require('../host/usage');

const fsp = require('fs/promises');

// --- counting the bytes a read actually consumes ------------------------------
//
// Through `openFile`, which host/usage.js ALREADY accepts and already documents
// as existing so tests can reach this code. Miguel, PR #32: my first version
// added an `onRead` callback threaded through four functions to obtain exactly
// this, and he measured the two approaches as byte-identical --
// `coldBytes 2760064, warmBytes 266, calls [64,138,64]` either way. Five
// parameters of production code for a measurement the existing injection point
// already provided, in a project whose founding bet is to drive the mechanism
// that exists rather than add one.
//
// A Proxy rather than `{ read, close }`: a hand-rolled object breaks confusingly
// the day readFileUsage calls any other method on the handle, and the Proxy
// costs the same line.
function countingOpen(bytes) {
  return async (file, flags) => {
    const fh = await fsp.open(file, flags);
    return new Proxy(fh, {
      get(target, prop) {
        if (prop === 'read') {
          return async (...args) => {
            const r = await target.read(...args);
            bytes.push(r.bytesRead);
            return r;
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
}

// Consume and total. Named, because `bytes.splice(0).reduce(...)` inline reads
// as arithmetic and is actually a side effect.
const drain = (bytes) => bytes.splice(0).reduce((a, b) => a + b, 0);

const NL = String.fromCharCode(10);

function project(cwd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-inc-'));
  const dir = path.join(root, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const U = (input, output, cw = 0, cr = 0) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});
const line = usage => JSON.stringify({ type: 'assistant', message: { usage } }) + NL;

const CWD = 'C:/w/proj';

// --- the append-only fast path ------------------------------------------------

test('tokens appended after the first read are counted', async () => {
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(10, 20)));

  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 30);

  fs.appendFileSync(f, line(U(1, 2)));
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 33);
});

test('an unchanged file gives the same answer on the second read', async () => {
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'), line(U(10, 20)) + line(U(5, 5)));
  const a = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  const b = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.deepStrictEqual(b.session, a.session);
  assert.deepStrictEqual(b.project, a.project);
});

test('an incremental read agrees with a cold read, over many appends', async () => {
  // The property that makes the optimisation safe to have at all: whatever the
  // chunking, the answer is the answer a single full parse would give.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, '');

  let expected = 0;
  for (let i = 1; i <= 40; i++) {
    fs.appendFileSync(f, line(U(i, i * 2, i * 3, i * 4)));
    expected += i * 10;
    const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
    assert.strictEqual(r.session.total, expected, `after append ${i}`);
  }

  // And a reader with no cache at all sees the same number.
  const cold = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache: new Map() });
  assert.strictEqual(cold.session.total, expected);
});

// --- the silent-undercount trap ----------------------------------------------

test('a line that was PARTIAL on the first read is counted once it completes', async () => {
  // THE defect this file exists for. The transcript is appended to live, so a
  // read routinely lands mid-line. Resuming from the previous BYTE COUNT starts
  // the next read inside that line: the completed line never parses, its tokens
  // are lost permanently, and nothing ever reports an error. Resume from the
  // last NEWLINE instead.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');

  const whole = line(U(100, 200));
  const cut = Math.floor(whole.length / 2);
  fs.writeFileSync(f, line(U(10, 20)) + whole.slice(0, cut));   // half a line

  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 30, 'the partial line contributes nothing yet');

  fs.appendFileSync(f, whole.slice(cut));                        // it completes
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330, 'the completed line was LOST');
});

test('a line completed across several appends is still counted exactly once', async () => {
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const whole = line(U(1000, 0));
  fs.writeFileSync(f, '');

  for (let i = 0; i < whole.length; i++) {
    fs.appendFileSync(f, whole[i]);
    const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
    // Never counted early, never counted twice.
    assert.ok(r.session.total === 0 || r.session.total === 1000, String(r.session.total));
  }
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 1000);
});

test('multi-byte characters do not corrupt the resume point', async () => {
  // REWRITTEN. Dexter, Finding 4: the previous fixture did not pin this, and
  // the bug it exists to prevent PASSED it. That fixture drifted bytes against
  // UTF-16 units by only 11, so a character-offset resume started 11 bytes
  // early, landed inside the tail of line 1, and produced an ASCII fragment
  // that fails JSON.parse and contributes NOTHING. The total came out right by
  // accident.
  //
  // The fix is to make the drift LARGER than a whole line, so a character-offset
  // resume re-counts that line in full instead of producing garbage.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');

  const heavy = JSON.stringify({
    type: 'user', message: { content: '\u{1F332}'.repeat(300), usage: U(1, 0) },
  }) + NL;                                   // 300 astral chars: drift = 600 bytes
  const light = line(U(1000, 0));            // far smaller than the drift
  assert.ok(Buffer.byteLength(heavy) - heavy.length > Buffer.byteLength(light),
    'fixture must drift further than one whole line, or it pins nothing');

  fs.writeFileSync(f, heavy + light);
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 1001);

  fs.appendFileSync(f, line(U(0, 0)));
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 1001, 'a character-offset resume re-counts a line');
});

test('a multi-byte sequence straddling a READ_CHUNK boundary is not split', async () => {
  // The carry-concat path across chunks was correct but pinned by nothing: both
  // multi-chunk tests were pure ASCII. Sequences crossing the 1MB edge are the
  // case that would corrupt a decode done per chunk rather than per line.
  const { READ_CHUNK } = require('../host/usage');
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');

  const chunks = [];
  let bytes = 0;
  while (bytes < READ_CHUNK * 3) {
    const l = JSON.stringify({
      type: 'user', message: { content: '\u{1F332}\u00E1\u65E5'.repeat(40), usage: U(1, 0) },
    }) + NL;
    chunks.push(l);
    bytes += Buffer.byteLength(l);
  }
  fs.writeFileSync(f, chunks.join(''));
  assert.ok(fs.statSync(f).size > READ_CHUNK * 3, 'fixture must span several chunks');

  const incremental = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  const cold = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache: new Map() });
  assert.strictEqual(incremental.session.total, chunks.length);
  assert.strictEqual(incremental.session.total, cold.session.total);
});

// --- when the append-only assumption breaks ----------------------------------

test('a file that SHRANK is re-read from the beginning', async () => {
  // Append-only is an assumption about someone else's writer, not a guarantee.
  // Trusting it blindly leaves the cached total of a file that no longer exists
  // in that form, and the figure never recovers.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(10, 20)) + line(U(100, 200)));
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330);

  fs.writeFileSync(f, line(U(1, 1)));                 // rewritten, smaller
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 2);
});

test('a file rewritten to the SAME length is re-read, not trusted', async () => {
  // Same size, new mtime. Cheap to be right about: it cannot happen on an
  // append-only log, so the full re-read it forces costs nothing in practice.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(11, 11)));
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 22);

  const rewritten = line(U(99, 99));
  assert.strictEqual(rewritten.length, fs.readFileSync(f, 'utf8').length, 'fixture must be same-length');
  fs.writeFileSync(f, rewritten);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 1000));
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 198);
});

test('a deleted session leaves the project total to the survivors', async () => {
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line(U(5, 0)));
  let r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.project.total, 15);

  fs.unlinkSync(path.join(dir, 'b.jsonl'));
  r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.project.total, 10, 'a vanished transcript must leave the total');
  assert.strictEqual(r.project.sessions, 1);
});

test('two projects with the same session filename do not share a cached total', async () => {
  // The cache is keyed by absolute path for this reason: `s1.jsonl` exists in
  // every project folder, and a basename key would report one project's spend
  // as another's.
  const a = project('C:/w/alpha');
  const b = project('C:/w/beta');
  fs.writeFileSync(path.join(a.dir, 's1.jsonl'), line(U(10, 0)));
  fs.writeFileSync(path.join(b.dir, 's1.jsonl'), line(U(999, 0)));

  const ra = await readUsage({ cwd: 'C:/w/alpha', sessionId: 's1', projectsDir: a.root });
  const rb = await readUsage({ cwd: 'C:/w/beta', sessionId: 's1', projectsDir: b.root });
  assert.strictEqual(ra.session.total, 10);
  assert.strictEqual(rb.session.total, 999);
});

// --- not blocking the loop ----------------------------------------------------

test('the read yields to the event loop instead of blocking it', async () => {
  // The reason this is async at all. fog.js records the incident: an 80ms
  // named-pipe connect timeout on the hook helper, and a synchronous span
  // longer than that drops the event. setImmediate does NOT fix it -- the check
  // phase is the same loop turn -- so the read has to await between batches.
  const { root, dir } = project(CWD);
  const many = [];
  for (let i = 0; i < 4000; i++) many.push(line(U(1, 1)));
  const body = many.join('');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), body);

  let turns = 0;
  const tick = () => { turns++; if (!done) setImmediate(tick); };
  let done = false;
  setImmediate(tick);

  const r = await readUsage({ cwd: CWD, sessionId: 's0', projectsDir: root });
  done = true;

  assert.strictEqual(r.project.total, 4 * 4000 * 2);
  // A blocking implementation lets the loop turn once, after everything.
  assert.ok(turns > 5, `the loop got ${turns} turns during the read`);
});

test('a warm read of a large unchanged project reads NOTHING AT ALL', async () => {
  // THE HEADLINE, and it deserves an exact assertion rather than a ratio. This
  // was `warm < cold / 4` on wall clock -- the same unsound comparison this PR
  // was opened to remove from one test, left in place ninety lines above it
  // (Miguel B2). Fixing the instance I was pointed at rather than the class I
  // had just diagnosed.
  //
  // And a ratio was never the claim here anyway. An unchanged file takes the
  // mtime+size fast path and returns BEFORE openFile is ever called, so the
  // warm read performs no I/O whatsoever (Dexter, Finding C). Exactly zero is
  // available, with no constant, no ratio and no coupling to fixture size --
  // and it fails the instant the fast path stops being taken.
  const { root, dir } = project(CWD);
  const many = [];
  for (let i = 0; i < 8000; i++) many.push(line(U(1, 1)));
  const body = many.join('');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), body);

  const bytes = [];
  const openFile = countingOpen(bytes);
  const cache = new Map();

  await readUsage({ cwd: CWD, sessionId: 's0', projectsDir: root, cache, openFile });
  const coldBytes = drain(bytes);
  assert.ok(coldBytes > 0, 'a cold read must actually read');

  await readUsage({ cwd: CWD, sessionId: 's0', projectsDir: root, cache, openFile });
  assert.strictEqual(drain(bytes), 0,
    'an unchanged project must not be opened at all on a warm read');
});

test('appending one line to a huge file costs EXACTLY one line plus two fingerprints', async () => {
  // The measurement that actually decides the design: the active session is
  // 52.8MB of this project's 64.4MB and changes every turn, so an mtime cache
  // alone would still re-parse all of it on every single tick.
  //
  // MEASURED IN BYTES, NOT MILLISECONDS. This asserted `grown < cold / 4` on
  // wall clock and flaked -- observed as "cold 18.7ms, after one append
  // 11.6ms". Nothing was wrong with the cache: the cold read is fast enough in
  // absolute terms that scheduler noise can put the warm read within a factor
  // of four of it, so the test failed for a reason unrelated to its own name.
  //
  // AND THE COST IS EXACT, not a ratio. Miguel measured it as invariant over
  // ten runs: the verify read in prefixIntact (64), the appended line in the
  // chunk loop (138), and the re-cache read in readFingerprint (64). My first
  // rewrite asserted `warmBytes < coldBytes / 100`, which is 103x of slack on a
  // number that never moves -- a regression resuming from a wrong offset and
  // re-reading 200 lines passed it silently. Only total loss of resume failed.
  //
  // The companion bound `warmBytes >= appended.length` was worse: its message
  // said "it must still read the appended 138 bytes" while it actually checked
  // that the TOTAL of all reads was at least 138 -- and 128 of those come from
  // the fingerprints. It bit only because 138 > 128, by ten bytes. Shorten the
  // fixture line at all and it passes having read NONE of the append, with its
  // failure message still claiming it verified them.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const many = [];
  for (let i = 0; i < 20000; i++) many.push(line(U(1, 1)));
  fs.writeFileSync(f, many.join(''));

  const bytes = [];
  const openFile = countingOpen(bytes);
  const cache = new Map();

  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache, openFile });
  const coldBytes = drain(bytes);
  const fileSize = fs.statSync(f).size;
  // EXACT, not `>=`. Dexter, Finding G: `coldBytes >= fileSize` carries 64 bytes
  // of slack it does not know it has -- a cold read that started at pos 64
  // instead of 0 consumes fileSize-64 in the loop plus 64 in the fingerprint,
  // totals exactly fileSize, and PASSES. The fingerprint read pays for the
  // bytes that were skipped. Today only the totals assertion catches that,
  // because the dropped first line has no id.
  //
  // The exact value is determined: on a cold cache `grown` is falsy so
  // prefixIntact short-circuits and never reads, the loop consumes stat.size,
  // and readFingerprint reads min(64, size).
  assert.strictEqual(coldBytes, fileSize + FINGERPRINT_BYTES,
    `a cold read must read the whole file exactly once: ${coldBytes} vs ${fileSize}`);

  const appended = line(U(3, 4));
  fs.appendFileSync(f, appended);
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache, openFile });
  const warmBytes = drain(bytes);

  assert.strictEqual(r.session.total, 20000 * 2 + 7);
  // Buffer.byteLength, NOT .length. Dexter, Finding H: `.length` is a count of
  // UTF-16 units and this assertion's units are BYTES. It is correct today only
  // because the fixture line happens to be ASCII -- and this very file already
  // uses Buffer.byteLength at :152, in a test that exists precisely because a
  // character offset and a byte offset are different numbers and confusing them
  // corrupts the resume point. The file knew; the new measurement forgot.
  //
  // Put one emoji in the fixture and `.length` and the byte count diverge. As an
  // EQUALITY this fails loudly rather than silently weakening, which is the only
  // reason it is a Medium and not a High.
  assert.strictEqual(warmBytes, Buffer.byteLength(appended) + 2 * FINGERPRINT_BYTES,
    `a resumed read must cost the appended line plus two fingerprint reads, not ${warmBytes}`);

  // A THIRD READ, because two cannot see the hazard Dexter found. A throw in
  // readFingerprint is invisible on the tick it happens -- the read and the
  // chunk loop have already run -- and then stores `fingerprint: null`, after
  // which `!cached.fingerprint` forces a full re-read on EVERY subsequent tick,
  // permanently, with every total still exactly correct. Cold-then-warm cannot
  // reach it; cold-warm-warm can.
  const second = line(U(5, 6));
  fs.appendFileSync(f, second);
  const r3 = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache, openFile });
  assert.strictEqual(drain(bytes), Buffer.byteLength(second) + 2 * FINGERPRINT_BYTES,
    'the second resumed read must be cheap too -- the fingerprint must persist');
  assert.strictEqual(r3.session.total, 20000 * 2 + 7 + 11);
});

// --- the failure semantics, which milestones depend on ------------------------

test('a read failure is still ABSENCE, not a cached zero', async () => {
  const r = await readUsage({ cwd: 'C:/never/used', sessionId: 'x', projectsDir: os.tmpdir() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.project.total, 0);
});

test('a top-level DIRECTORY named like a transcript is not one', async () => {
  // Rewritten: this used to assert such a directory made the read `unreadable`.
  // It is not unreadable, it is not a transcript -- and since the enumeration
  // moved to host/transcripts.js it is skipped on the way in, which is the
  // right answer rather than a tolerated one. The session count must not
  // include it either.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  fs.mkdirSync(path.join(dir, 'b.jsonl'));

  const r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.project.total, 10);
  assert.strictEqual(r.project.sessions, 1, 'a directory is not a session');
});

test('a DIRECTORY named like a subagent transcript is gone, not absence', async () => {
  // Rewritten. This used to assert such a directory made the read absent. It
  // does not: there are no tokens at that path to miss, so contributing nothing
  // IS the complete total. Absence is reserved for "something is there and we
  // could not read it", which the lock tests cover properly.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  const sub = path.join(dir, 'a', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(sub, 'agent-x.jsonl'));

  const r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.absent, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.project.total, 10);
});

test('a SIZE change alone invalidates the cache, even with an unchanged mtime', async () => {
  // Found by mutation: dropping the size check from the "untouched" fast path
  // survived every other test here. It is not academic on Windows, where the
  // last-write time is updated lazily -- an append can land inside the same
  // timestamp, and the tokens would then be invisible until something else
  // happened to move the clock.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(10, 0)));
  const { atime, mtime } = fs.statSync(f);

  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 10);

  fs.appendFileSync(f, line(U(5, 0)));
  fs.utimesSync(f, atime, mtime);              // as if the clock had not moved
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 15, 'an append was invisible behind a stale mtime');
});

// --- the resume point has to prove it is still the same file ------------------

test('a file REPLACED between ticks does not resume onto a stale total', async () => {
  // Dexter, Finding 2. `size > cached.size` was used as a proxy for "the cached
  // prefix is still this file's prefix", and it is not. No truncation-during-
  // read is needed -- a delete-and-recreate between two 5-second ticks is
  // enough, and the poisoned accumulator is PERMANENT: every later append keeps
  // resuming from it. The existing shrink test only heals this if a read
  // happens while the file is small, which a shrink-and-regrow never allows.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');

  fs.writeFileSync(f, line(U(10, 20)) + line(U(100, 200)));
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330);

  // Replaced with DIFFERENT content that happens to be longer.
  fs.writeFileSync(f, line(U(1, 1)) + line(U(1, 1)) + line(U(1, 1)));
  assert.ok(fs.statSync(f).size > 0);
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 6, 'resumed onto a total from a file that no longer exists');
});

test('a genuine append still takes the fast path, so the guard is not just "always re-read"', async () => {
  // The other half. A guard that re-reads everything would pass the test above
  // and silently undo the entire optimisation -- which is the failure mode that
  // looks like success.
  //
  // BYTES, for the same reason as its twin. This carried the SAME unsound
  // `warm < cold / 4` that this PR was opened to remove, in the same file,
  // ninety lines further down, and my first pass left it -- fixing the instance
  // I was pointed at rather than the class I had just diagnosed (Miguel B2).
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const many = [];
  for (let i = 0; i < 20000; i++) many.push(line(U(1, 1)));
  fs.writeFileSync(f, many.join(''));

  const bytes = [];
  const openFile = countingOpen(bytes);
  const cache = new Map();

  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache, openFile });
  const coldBytes = drain(bytes);
  assert.ok(coldBytes >= fs.statSync(f).size, 'the cold read must be a real full read');

  const appended = line(U(3, 4));
  fs.appendFileSync(f, appended);
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache, openFile });
  const warmBytes = drain(bytes);

  assert.strictEqual(r.session.total, 20000 * 2 + 7);
  // Buffer.byteLength, not .length -- see the twin above (Dexter, Finding H).
  assert.strictEqual(warmBytes, Buffer.byteLength(appended) + 2 * FINGERPRINT_BYTES,
    `the fast path was lost: a resumed read cost ${warmBytes} bytes`);
});

test('a rewrite that PRESERVES the prefix is still resumed, not re-read', async () => {
  // The fingerprint checks the bytes before the resume point. If those are
  // unchanged the cached total describes them correctly, whatever else moved.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const head = line(U(10, 20)) + line(U(100, 200));
  fs.writeFileSync(f, head);
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330);

  fs.writeFileSync(f, head + line(U(1, 1)));      // same prefix, appended
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 332);
});

// --- the final line, when nothing terminates it -------------------------------

test('a COMPLETE final line with no trailing newline is still counted', async () => {
  // Miguel, I1 -- a regression this branch introduced, and a silent, permanent
  // one. The old code split the whole buffer and parsed the last line whatever
  // followed it. The new code parses only up to the last newline, so an
  // unterminated final record becomes `carry` and is discarded. Worse, the file
  // is then FINISHED: its mtime and size never change again, so the fast path
  // returns the cached total forever and those tokens are lost for the life of
  // the project folder.
  //
  // Both fixture helpers append a trailing newline, which is why nothing caught
  // it. This one deliberately does not.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(10, 20)) + JSON.stringify({
    type: 'assistant', message: { usage: U(100, 200) },
  }));                                          // no NL

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330);
});

test('the unterminated final line survives the CACHED path too', async () => {
  // The half that makes it permanent. A second read of an unchanged file takes
  // the mtime+size fast path, so caching only the terminated part loses the
  // tail on every read after the first.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, line(U(10, 20)) + JSON.stringify({
    type: 'assistant', message: { usage: U(100, 200) },
  }));

  const a = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  const b = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(a.session.total, 330);
  assert.strictEqual(b.session.total, 330, 'the tail was dropped on the cached path');
});

test('counting an unterminated line does not double-count it when it completes', async () => {
  // The safety property that makes the fix admissible: the tentative tail is
  // reported but never cached, so when the writer terminates the line and
  // appends more, the resume re-reads it and still counts it once.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const whole = line(U(100, 200));
  fs.writeFileSync(f, line(U(10, 20)) + whole.slice(0, whole.length - 1));  // no NL

  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 330);

  fs.appendFileSync(f, NL + line(U(1, 1)));
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 332, 'the tail was counted twice');
});

test('a genuinely PARTIAL final line still contributes nothing', async () => {
  // Unchanged behaviour, re-asserted because the fix above is what could break
  // it: half a JSON object does not parse, so it contributes nothing whether it
  // is read tentatively or not.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const whole = line(U(100, 200));
  fs.writeFileSync(f, line(U(10, 20)) + whole.slice(0, Math.floor(whole.length / 2)));

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 30);
});

test('a file with no newline at all is abandoned, not buffered into the heap', async () => {
  // Miguel, I2. `carry` grew by Buffer.concat on every chunk, so a 60MB file
  // with no newline copies ~1.8GB synchronously in spans reaching 60MB -- the
  // exact hazard the chunked read exists to prevent, reached by a corrupted
  // transcript or anything binary that got the extension.
  const { root, dir } = project(CWD);
  const { READ_CHUNK } = require('../host/usage');
  fs.writeFileSync(path.join(dir, 'good.jsonl'), line(U(10, 0)));
  fs.writeFileSync(path.join(dir, 'junk.jsonl'), 'x'.repeat(READ_CHUNK * 6));

  let worst = 0, last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 1);
  const r = await readUsage({ cwd: CWD, sessionId: 'good', projectsDir: root });
  clearInterval(iv);

  assert.strictEqual(r.project.total, 10, 'the readable file is still counted');
  assert.strictEqual(r.unreadable, 1, 'the junk file is absence, not a zero-token file');
  assert.ok(worst < 400, `longest synchronous span was ${worst}ms`);
});

// --- fresh / stale / absent ---------------------------------------------------
// Dexter and Miguel converged here from opposite directions. `ok` gates whether
// the milestone announcer trusts a total as a BASELINE, so the only question it
// answers is "could the true total be higher than what I am reporting?"
//
//   a locked file we have read before  -> substitute its last known total (STALE)
//   a locked file we have never read   -> ABSENT, and ok must go false
//   a file that vanished               -> contributes nothing, and that is CORRECT
//   a directory named *.jsonl          -> not a transcript, no tokens there
//
// Only the first two are absence. Counting a benign deletion as absence was
// Miguel's point; refusing to substitute for a vanished file was Dexter's, and
// his reason is sharper than mine was: substituting for a file that is GONE
// over-reports, which can announce a rung early -- after which `highest`
// suppresses the real crossing permanently.

// A lock is not reproducible portably, so the open is injectable. Without this
// seam the most load-bearing new logic on the branch would sit in a region
// nothing measures, which is the trap this project has hit before.
const lockOn = (names) => {
  const fsp = require('fs/promises');
  return (file, flags) =>
    names.some(n => file.endsWith(n))
      ? Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
      : fsp.open(file, flags);
};

test('a file locked for ONE tick keeps its last known total, and stays ok', async () => {
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'big.jsonl'), line(U(1000, 0)));
  fs.writeFileSync(path.join(dir, 'small.jsonl'), line(U(7, 0)));
  const cache = new Map();

  let r = await readUsage({ cwd: CWD, sessionId: 'big', projectsDir: root, cache });
  assert.strictEqual(r.project.total, 1007);

  // It has to have CHANGED, or the mtime+size fast path answers from cache and
  // never opens the file -- which made this test pass without ever reaching the
  // lock on its first draft.
  fs.appendFileSync(path.join(dir, 'big.jsonl'), line(U(5, 0)));
  r = await readUsage({ cwd: CWD, sessionId: 'big', projectsDir: root, cache,
    openFile: lockOn(['big.jsonl']) });
  assert.strictEqual(r.project.total, 1007, 'the total must not DROP on a lock');
  assert.strictEqual(r.ok, true, 'a stale figure is still a usable baseline');
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(r.absent, 0);
});

test('a locked file keeps its SESSION figure too, with the session still counted', async () => {
  // The old `continue` skipped the matchedSession assignment as well, so a lock
  // on the active session zeroed session.total AND left sessions at 0.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'), line(U(1000, 0)));
  const cache = new Map();
  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });

  fs.appendFileSync(path.join(dir, 's1.jsonl'), line(U(5, 0)));   // so the open is reached
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache,
    openFile: lockOn(['s1.jsonl']) });
  assert.strictEqual(r.session.total, 1000, 'the last known figure, not zero');
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(r.session.sessions, 1, 'a non-zero total alongside sessions:0 is incoherent');
});

test('a file locked on the FIRST tick is absence, because there is nothing to substitute', async () => {
  // The test that catches narrowing `ok` to "the folder could not be read".
  // Substitution cannot cover a cold cache, and the first tick is exactly when
  // the announcer seeds -- an AV lock at launch would otherwise seed the
  // baseline at a fraction of the truth and announce a rung it already passed.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'big.jsonl'), line(U(1000, 0)));
  fs.writeFileSync(path.join(dir, 'small.jsonl'), line(U(7, 0)));

  const r = await readUsage({ cwd: CWD, sessionId: 'big', projectsDir: root,
    cache: new Map(), openFile: lockOn(['big.jsonl']) });
  assert.strictEqual(r.ok, false, 'a cold-cache lock must NOT be a trustworthy baseline');
  assert.strictEqual(r.absent, 1);
  assert.strictEqual(r.stale, 0);
  assert.strictEqual(r.project.total, 7, 'what WAS readable is still reported');
});

test('a DELETED transcript contributes nothing, and that is the correct total', async () => {
  // Not absence: the total over the files that exist is complete. Substituting
  // here would over-report and could announce a rung early.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line(U(1000, 0)));
  const cache = new Map();
  let r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root, cache });
  assert.strictEqual(r.project.total, 1010);

  fs.unlinkSync(path.join(dir, 'b.jsonl'));
  r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root, cache });
  assert.strictEqual(r.project.total, 10, 'a vanished file must not be substituted');
  assert.strictEqual(r.ok, true, 'a deletion is not a failure to read');
  assert.strictEqual(r.stale, 0);
  assert.strictEqual(r.absent, 0);
});

test('a lock that persists is a VISIBLE freeze, not an invisible one', async () => {
  // Dexter's rider. Substitution trades a visible drop for a frozen number, and
  // a frozen number with no signal is the worse of the two. `stale` is how the
  // host can say "held steady because we could not read it" rather than
  // implying nothing has happened.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'), line(U(1000, 0)));
  const cache = new Map();
  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });
  fs.appendFileSync(path.join(dir, 's1.jsonl'), line(U(5, 0)));   // so the open is reached

  for (let i = 0; i < 5; i++) {
    const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache,
      openFile: lockOn(['s1.jsonl']) });
    assert.strictEqual(r.stale, 1, `tick ${i} must keep reporting the substitution`);
    assert.strictEqual(r.project.total, 1000);
  }
});

test('a transcript deleted BETWEEN the listing and the read is not substituted', async () => {
  // Found by mutation: substituting a vanished file's cached total survived
  // every other test here, because a deleted file is not enumerated at all --
  // so the ENOENT-on-stat path was never reached. The genuine race is a file
  // that WAS listed and is gone by the time we stat it, and it has to be
  // constructed deterministically to be pinned.
  //
  // Why it matters, per Dexter: substituting here OVER-reports, an over-report
  // can cross a rung that was never really crossed, and `highest` then
  // suppresses the genuine crossing permanently. One rung, silently, forever.
  const { root, dir } = project(CWD);
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, line(U(10, 0)));
  fs.writeFileSync(b, line(U(1000, 0)));

  const cache = new Map();
  let r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root, cache });
  assert.strictEqual(r.project.total, 1010, 'both files are cached');

  // Make both files look changed so neither takes the mtime fast path, then
  // delete b at the moment a is opened -- b is already in the listing.
  fs.appendFileSync(a, line(U(1, 0)));
  fs.appendFileSync(b, line(U(1, 0)));
  const fsp = require('fs/promises');
  const raceOn = (file, flags) => {
    if (file.endsWith('a.jsonl') && fs.existsSync(b)) fs.unlinkSync(b);
    return fsp.open(file, flags);
  };

  r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root, cache, openFile: raceOn });
  assert.strictEqual(r.project.total, 11, 'the vanished file must contribute NOTHING');
  assert.strictEqual(r.stale, 0, 'a deletion is not a lock');
  assert.strictEqual(r.absent, 0, 'nor is it absence -- the total is correct without it');
  assert.strictEqual(r.ok, true);
});

// --- one message, one usage ---------------------------------------------------
// MEASURED on this project: 2,178 of 4,648 usage-bearing lines were the same
// message counted again, inflating the headline by 44.3% -- 1.60B where the
// truth is 892M. Ricardo spotted it by eye ("the numbers feel too crazy high")
// before any test did.
//
// The cause: one assistant message is ONE API call with ONE usage figure, but
// Claude Code writes each content block on its own JSONL line and repeats the
// identical usage on every one. A message with a `thinking` block and a
// `tool_use` block is two lines carrying `in=2 out=99 cw=49066 cr=51634` each.
// Counting per line multiplies a turn by how many blocks it happened to have.

const twoBlockMessage = (id, usage) => [
  JSON.stringify({ type: 'assistant', message: { id, usage, content: [{ type: 'thinking' }] } }),
  JSON.stringify({ type: 'assistant', message: { id, usage, content: [{ type: 'tool_use' }] } }),
].join(NL) + NL;

test('a message split across several lines is counted ONCE', async () => {
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'), twoBlockMessage('msg_a', U(2, 99, 49066, 51634)));

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 2 + 99 + 49066 + 51634);
});

test('different messages are still counted separately', async () => {
  // The guard against over-correcting into an undercount.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'),
    twoBlockMessage('msg_a', U(10, 0)) + twoBlockMessage('msg_b', U(20, 0)));

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 30);
});

test('a five-block message is counted once, not five times', async () => {
  const { root, dir } = project(CWD);
  const usage = U(1, 1, 1, 97);
  const lines = [];
  for (const type of ['thinking', 'text', 'tool_use', 'tool_use', 'tool_use']) {
    lines.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_x', usage, content: [{ type }] } }));
  }
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.join(NL) + NL);

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 100);
});

test('deduplication SURVIVES an incremental resume', async () => {
  // The hard half. The reader resumes from a byte offset and carries a cached
  // accumulator, so the set of message ids already counted has to be cached
  // alongside it -- otherwise the second block of a message that straddles two
  // reads is counted as a fresh message.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const usage = U(10, 0);

  // First read sees only the first block of msg_a.
  fs.writeFileSync(f, JSON.stringify({
    type: 'assistant', message: { id: 'msg_a', usage, content: [{ type: 'thinking' }] } }) + NL);
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 10);

  // Its second block arrives later, in a separate read.
  fs.appendFileSync(f, JSON.stringify({
    type: 'assistant', message: { id: 'msg_a', usage, content: [{ type: 'tool_use' }] } }) + NL);
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 10, 'the second block of the same message was counted again');

  // And a genuinely new message still lands.
  fs.appendFileSync(f, JSON.stringify({
    type: 'assistant', message: { id: 'msg_b', usage, content: [{ type: 'text' }] } }) + NL);
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 20);
});

test('an entry with no message id is still counted', async () => {
  // Defensive. Measured 0 such entries in this project, but an older transcript
  // or another writer may omit the id, and dropping those would trade a 44%
  // overcount for an unknown undercount.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 's1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { usage: U(7, 0) } }) + NL +
    JSON.stringify({ type: 'assistant', message: { usage: U(3, 0) } }) + NL);

  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 10, 'id-less entries must not collapse into one');
});

test('the same message id in DIFFERENT sessions is counted in each', async () => {
  // Dedup is per transcript, not global: measured, no message id appears in
  // more than one file, and two projects legitimately could. Deduplicating
  // across files would silently drop real spend.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), twoBlockMessage('msg_same', U(10, 0)));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), twoBlockMessage('msg_same', U(10, 0)));

  const r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.project.total, 20);
});
