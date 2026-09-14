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

const { readUsage, projectDirName } = require('../host/usage');

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

test('a warm read of a large unchanged project is much cheaper than a cold one', async () => {
  // The headline. Asserted as a ratio rather than a wall-clock figure so it
  // means the same thing on a slower machine.
  const { root, dir } = project(CWD);
  const many = [];
  for (let i = 0; i < 8000; i++) many.push(line(U(1, 1)));
  const body = many.join('');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), body);

  const cache = new Map();
  const t0 = process.hrtime.bigint();
  await readUsage({ cwd: CWD, sessionId: 's0', projectsDir: root, cache });
  const cold = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  await readUsage({ cwd: CWD, sessionId: 's0', projectsDir: root, cache });
  const warm = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.ok(warm < cold / 4, `cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms`);
});

test('appending one line to a huge file costs about what one line costs', async () => {
  // The measurement that actually decides the design: the active session is
  // 52.8MB of this project's 64.4MB and changes every turn, so an mtime cache
  // alone would still re-parse all of it on every single tick.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const many = [];
  for (let i = 0; i < 20000; i++) many.push(line(U(1, 1)));
  fs.writeFileSync(f, many.join(''));

  const cache = new Map();
  const t0 = process.hrtime.bigint();
  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });
  const cold = Number(process.hrtime.bigint() - t0) / 1e6;

  fs.appendFileSync(f, line(U(3, 4)));
  const t1 = process.hrtime.bigint();
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });
  const grown = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.strictEqual(r.session.total, 20000 * 2 + 7);
  assert.ok(grown < cold / 4, `cold ${cold.toFixed(1)}ms, after one append ${grown.toFixed(1)}ms`);
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

test('a transcript that is enumerated but cannot be read is REPORTED', async () => {
  // The real trigger, which the old fixture never reached: inside subagents/
  // the listing is by name, so a directory ending .jsonl IS enumerated and then
  // fails to read. What WAS readable is still reported -- reporting a confident
  // lower total is what seeds a false baseline and throws a party later.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  const sub = path.join(dir, 'a', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(sub, 'agent-x.jsonl'));

  const r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.unreadable, 1, 'the failure must be counted');
  assert.strictEqual(r.project.total, 10, 'what WAS readable is still reported');
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
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const many = [];
  for (let i = 0; i < 20000; i++) many.push(line(U(1, 1)));
  fs.writeFileSync(f, many.join(''));

  const cache = new Map();
  const t0 = process.hrtime.bigint();
  await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });
  const cold = Number(process.hrtime.bigint() - t0) / 1e6;

  fs.appendFileSync(f, line(U(3, 4)));
  const t1 = process.hrtime.bigint();
  const r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root, cache });
  const warm = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.strictEqual(r.session.total, 20000 * 2 + 7);
  assert.ok(warm < cold / 4, `the fast path was lost: cold ${cold.toFixed(1)}ms, append ${warm.toFixed(1)}ms`);
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
