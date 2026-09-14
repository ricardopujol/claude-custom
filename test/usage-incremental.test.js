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
  // The offset is in BYTES and the parse is in characters. Mixing the two
  // splits a UTF-8 sequence and the following line fails to parse -- another
  // silent undercount, and one that only appears on transcripts containing
  // non-ASCII, which is most real ones.
  const { root, dir } = project(CWD);
  const f = path.join(dir, 's1.jsonl');
  const emoji = JSON.stringify({
    type: 'user', message: { content: 'árbol 🌲 日本語 ✨', usage: U(7, 0) },
  }) + NL;
  fs.writeFileSync(f, emoji);
  let r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 7);

  fs.appendFileSync(f, emoji);
  r = await readUsage({ cwd: CWD, sessionId: 's1', projectsDir: root });
  assert.strictEqual(r.session.total, 14);
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

test('one unreadable transcript does not silently understate the project', async () => {
  // A file that cannot be read is not a file worth zero. Reporting a confident
  // lower total is what seeds a false baseline and throws a party later.
  const { root, dir } = project(CWD);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(U(10, 0)));
  fs.mkdirSync(path.join(dir, 'b.jsonl'));    // a directory named like a transcript

  const r = await readUsage({ cwd: CWD, sessionId: 'a', projectsDir: root });
  assert.strictEqual(r.ok, false, 'an unreadable transcript must be reported');
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
