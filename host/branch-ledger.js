'use strict';
/**
 * Tokens spent per git branch, from Claude Code's transcripts, in a ledger that OUTLIVES them
 * (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md G1-G3).
 *
 * Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). The git tree draws a
 * branch's length from its spend, so without a ledger every branch older than a month would quietly
 * shrink. A record per transcript file is kept for as long as the ledger lives, even after its file
 * is gone.
 *
 * Every assistant line carries `gitBranch`, `cwd` and `message.usage`, so attribution is per line:
 * a session that switched branches splits its spend correctly.
 *
 * BRANCH NAMES ARE DATA, NOT KEYS OF OURS (PR #84 Miguel B2 / Dexter F12): a branch may be called
 * `__proto__`, `constructor` or `toString`. Maps keyed by a branch name are only ever read with
 * getOwn and written with putOwn -- a plain `o[name] = v` on `__proto__` would replace the object's
 * prototype, and a plain `o[name]` on `constructor` would find Object.
 */

const fsp = require('fs/promises');
const path = require('path');
const { isInside, samePath } = require('./project-layout');
const { projectDirName } = require('./project-dir');
const { transcriptFiles, readMeta } = require('./transcripts');
const { readFingerprint, prefixIntact, READ_CHUNK } = require('./usage');
const { renameWithRetryAsync } = require('./atomic-write');

const VERSION = 1;
// A single unterminated "line" past this can't be a real usage record (host/usage.js MAX_CARRY):
// it's skipped, never waited on -- waiting would stop the file there for good (PR #84 Dexter F4).
const MAX_CARRY = 4 * READ_CHUNK;
const NL = 10;

// Strict: `Number(null)` is 0 and `Number('7')` is 7, and a payload field can be either.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const getOwn = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
function putOwn(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return v;
}

// What was spent, the host/usage.js / app/usage-display.js partition: cache reads are the same
// context re-read every turn and never count as spend.
function spendOf(u) {
  if (!u || typeof u !== 'object') return 0;
  return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
}

/** `at` is when this record was last checked against its file (mergeLedgers). */
function emptyRecord() {
  return { offset: 0, fp: null, at: null, lastId: null, subagent: false, agentType: null, branches: {} };
}

const inProject = (cwd, root) => typeof cwd === 'string' && (samePath(cwd, root) || isInside(cwd, root));
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

const two = n => String(n).padStart(2, '0');

/**
 * The LOCAL Y-M-D of a transcript line's ISO timestamp, the day git prints for the same instant
 * (`%ad --date=short-local`, host/git-history.js). Not the UTC date: near midnight a branch's last day of
 * work and its merge would land on different days and a week arc would split (backlog #38). Null
 * for anything that isn't a date-and-time string (a bare `2026-09-21` parses as UTC midnight, a
 * different local day west of UTC) -- absence is never a day (`new Date(null)` is 1970).
 */
function localDay(ts) {
  if (typeof ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(ts)) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Adds the COMPLETE lines of `text` to `rec` (mutated and returned). Whatever follows the last
 * '\n' is a line still being written: it's ignored here, and the caller reads it next time.
 */
function addLines(rec, text, projectRoot) {
  const parts = text.split('\n');
  parts.pop();
  for (const line of parts) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o && o.message;
    if (!msg || !msg.usage || typeof o.gitBranch !== 'string' || !o.gitBranch) continue;
    // Outside the root is LOOSE, not dropped: an old-layout worktree beside the repo
    // (claude-custom-ptf: 113,090 tokens of feat/process-tracker-failure) or a session that cd'd
    // out writes such lines, and so would another project whose folder shares the prefix. Only the
    // model can tell those apart (it counts loose spend for branch names this repo's git knows).
    const loose = !inProject(o.cwd, projectRoot);
    // ONE MESSAGE IS ONE USAGE (host/usage.js:117): its content blocks repeat the same figure on
    // consecutive lines. Measured over all 381 claude-custom transcripts: 20,484 repeats, all
    // adjacent (G1), so the previous id is the whole resume state. A line with no id always counts.
    const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
    if (id && id === rec.lastId) continue;
    rec.lastId = id;
    const b = getOwn(rec.branches, o.gitBranch)
      || putOwn(rec.branches, o.gitBranch, { spend: 0, loose: 0, first: null, last: null, cwds: [] });
    if (loose) b.loose += spendOf(msg.usage);
    else b.spend += spendOf(msg.usage);
    // Lines read before the local-day change keep the UTC day they were stored with: the ledger
    // VERSION isn't bumped, because a full re-read would drop the tokens of transcripts Claude Code
    // has already deleted. Only lines read from now on get local days (PR #88 F2).
    const day = localDay(o.timestamp);
    if (day) {
      if (!b.first || day < b.first) b.first = day;
      if (!b.last || day > b.last) b.last = day;
    }
    // only a real path: a line with no cwd would otherwise add `undefined` on every line (Dexter F14)
    if (typeof o.cwd === 'string' && !b.cwds.some(c => samePath(c, o.cwd))) b.cwds.push(o.cwd);
  }
  return rec;
}

/**
 * Every tab's host keeps the same project ledger, so two can save it at once. Per file, the record
 * CHECKED MOST RECENTLY wins (`at`): every save follows a read of each file to its end, so the
 * newer check is the truer one -- including after a transcript shrank or was rewritten, when the
 * newer record is the SHORTER one (PR #84 Dexter F1: "further read wins" brought the stale, longer
 * record back on every save). Records without `at` (older ledgers) fall back to the further read.
 * A file only one side knows is kept -- including one whose transcript is gone (G3).
 */
function replaces(cur, rec) {
  const a = num(cur.at);
  const b = num(rec.at);
  if (a !== b) return b > a;
  return num(rec.offset) >= num(cur.offset);
}

function mergeLedgers(a, b) {
  const files = {};
  for (const [p, rec] of Object.entries((a && a.files) || {})) putOwn(files, p, rec);
  for (const [p, rec] of Object.entries((b && b.files) || {})) {
    const cur = getOwn(files, p);
    if (!cur || replaces(cur, rec)) putOwn(files, p, rec);
  }
  return { version: VERSION, files };
}

const emptyTotal = () => ({ spend: 0, loose: 0, first: null, last: null, cwds: [], runs: [] });

/**
 * { [branch]: { spend, loose, first, last, cwds, runs: [{ agentType, spend, loose }] } } over every
 * file the ledger has ever seen. A subagent's transcript is ONE run, on the branch most of its spend
 * landed on, worth only that branch's spend and loose, kept apart (PR #84 Dexter F7) so the model
 * can drop loose spend it doesn't recognise. Measured: 63 of 257 subagents touched several
 * branches (agents in the shared dev\ checkout while sessions switched branches under them); their
 * spend stays split per line, but a 1% brush is not a run. `HEAD` stays a key; the model decides.
 */
// The branch a subagent mostly worked on; a tie goes to the first name, so every host agrees.
function mainBranchOf(rec) {
  let best = null;
  for (const [name, b] of Object.entries(rec.branches || {})) {
    const w = num(b.spend) + num(b.loose);
    if (!best || w > best.w || (w === best.w && name < best.name)) best = { name, w };
  }
  return best && best.name;
}

function totals(ledger) {
  const out = {};
  for (const rec of Object.values((ledger && ledger.files) || {})) {
    const runOn = rec && rec.subagent ? mainBranchOf(rec) : null;
    for (const [name, b] of Object.entries((rec && rec.branches) || {})) {
      const t = getOwn(out, name) || putOwn(out, name, emptyTotal());
      t.spend += num(b.spend);
      t.loose += num(b.loose);
      if (b.first && (!t.first || b.first < t.first)) t.first = b.first;
      if (b.last && (!t.last || b.last > t.last)) t.last = b.last;
      for (const c of b.cwds || []) if (typeof c === 'string' && !t.cwds.some(x => samePath(x, c))) t.cwds.push(c);
      if (name === runOn) t.runs.push({ agentType: rec.agentType || 'unknown', spend: num(b.spend), loose: num(b.loose) });
    }
  }
  return out;
}

// ---------- disk ----------

const emptyLedger = () => ({ version: VERSION, files: {} });

function cloneRecord(r) {
  const c = { ...emptyRecord(), ...r, branches: {} };
  for (const [k, b] of Object.entries(r.branches || {})) putOwn(c.branches, k, { ...b, cwds: [...(b.cwds || [])] });
  return c;
}

/**
 * Reads what's new in one transcript. -> { bytes, rec }: `rec` is a NEW record; the one passed in
 * is never touched, so a read that fails halfway leaves the ledger exactly as it was and the retry
 * counts every line once (PR #84 Dexter F8 / Miguel I1). Resumes on a line boundary; a prefix that
 * no longer matches (rewritten) or a file shorter than what was read (truncated) starts over from 0.
 */
async function readNew(file, prev, projectRoot, open) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    let rec = cloneRecord(prev);
    if (rec.offset > 0) {
      const fingerprint = rec.fp ? Buffer.from(rec.fp, 'base64') : null;
      if (rec.offset > size || !(await prefixIntact(fh, { offset: rec.offset, fingerprint }))) {
        // a different file now: its old record is replaced, not added to (who it belongs to stays)
        rec = { ...emptyRecord(), subagent: rec.subagent, agentType: rec.agentType };
      }
    }
    const start = rec.offset;
    if (start >= size) return { bytes: 0, rec };
    let pos = start;
    let carry = Buffer.alloc(0);
    let consumed = 0;
    let skipping = false;
    while (pos < size) {
      const want = Math.min(READ_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      if (skipping) {
        const end = data.indexOf(NL);
        if (end < 0) {
          consumed += data.length;
          carry = Buffer.alloc(0);
          await yieldToLoop();
          continue;
        }
        consumed += end + 1;
        data = data.subarray(end + 1);
        skipping = false;
      }
      const nl = data.lastIndexOf(NL);
      if (nl >= 0) {
        addLines(rec, data.subarray(0, nl + 1).toString('utf8'), projectRoot);
        consumed += nl + 1;
        carry = Buffer.from(data.subarray(nl + 1));
      } else {
        carry = Buffer.from(data);
      }
      if (carry.length > MAX_CARRY) {
        // no usage record is this long (a pasted image, a huge tool result): step over it
        consumed += carry.length;
        carry = Buffer.alloc(0);
        skipping = true;
      }
      await yieldToLoop();
    }
    rec.offset += consumed;
    const fp = await readFingerprint(fh, rec.offset);
    rec.fp = fp ? fp.toString('base64') : null;
    return { bytes: pos - start, rec };
  } finally {
    await fh.close();
  }
}

/**
 * Brings `ledger` up to date with every transcript of the project (mutated and returned).
 * A project folder is any whose encoded name starts with the project root's; whether a LINE belongs
 * is then decided by its own cwd (G2). Records of files no longer on disk are kept (G3).
 *
 * opts: { projectsDir, projectRoot, now = Date.now, open = fsp.open }
 * -> { ledger, read: bytes read, errors: folders or files that couldn't be read }
 */
async function updateLedger(ledger, { projectsDir, projectRoot, now = Date.now, open = fsp.open }) {
  const out = ledger && ledger.files ? ledger : emptyLedger();
  let read = 0;
  let errors = 0;
  let dirs;
  try {
    dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { ledger: out, read, errors: 1 };
  }
  const prefix = projectDirName(projectRoot);
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith(prefix)) continue;
    const { files, errors: listErrors } = await transcriptFiles(path.join(projectsDir, d.name));
    if (files === null) { errors++; continue; }
    errors += listErrors;
    for (const entry of files) {
      const prev = getOwn(out.files, entry.file) || emptyRecord();
      if (entry.subagent && !prev.subagent) {
        // A meta that exists but can't be read (locked, half-written) is asked for again next
        // time; only a readable one, or none at all (ENOENT), settles who this run was.
        const { meta, error } = await readMeta(entry.file);
        if (!error) {
          prev.subagent = true;
          prev.agentType = meta && typeof meta.agentType === 'string' ? meta.agentType : null;
        } else errors++;
      }
      try {
        const r = await readNew(entry.file, prev, projectRoot, open);
        // only ever goes up: a wall clock stepping back must not let an older record win the
        // merge again (PR #84 Dexter round 2)
        r.rec.at = Math.max(now(), num(prev.at) + 1);
        putOwn(out.files, entry.file, r.rec);
        read += r.bytes;
      } catch {
        errors++;
      }
    }
  }
  return { ledger: out, read, errors };
}

/**
 * -> { ledger, state, corrupt }
 *   ok          read and understood
 *   missing     no ledger yet: empty
 *   invalid     not a ledger (bad JSON, wrong shape): empty; saving moves the file aside
 *   unreadable  can't be read right now (locked, EISDIR...) or written by a newer version: empty,
 *               and saving REFUSES -- overwriting it would lose every record of a deleted
 *               transcript for good (PR #84 Dexter F6 / Miguel I2)
 */
async function loadLedger(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return { ledger: emptyLedger(), state: missing ? 'missing' : 'unreadable', corrupt: !missing };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ledger: emptyLedger(), state: 'invalid', corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object' || parsed.files === null || Array.isArray(parsed.files)) {
    return { ledger: emptyLedger(), state: 'invalid', corrupt: true };
  }
  if (parsed.version !== VERSION) return { ledger: emptyLedger(), state: 'unreadable', corrupt: true };
  return { ledger: { version: VERSION, files: parsed.files }, state: 'ok', corrupt: false };
}

/**
 * Merges with whatever another host saved since, then writes temp-then-rename (never a truncating
 * open of the real file: CLAUDE.md). Refuses to replace a ledger it can't read; moves an invalid one
 * aside (`.corrupt-<time>`) rather than destroying it. -> the ledger as saved.
 */
async function saveLedger(file, ledger, { rename = renameWithRetryAsync } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const disk = await loadLedger(file);
  if (disk.state === 'unreadable') throw new Error(`branch ledger ${file} can't be read right now: not overwriting it`);
  if (disk.state === 'invalid') await fsp.rename(file, `${file}.corrupt-${Date.now()}`);
  const merged = mergeLedgers(disk.ledger, ledger);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(merged));
    await rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return merged;
}

module.exports = {
  addLines, localDay, emptyRecord, spendOf, mergeLedgers, totals,
  emptyLedger, updateLedger, loadLedger, saveLedger,
};
