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
 */

const fsp = require('fs/promises');
const path = require('path');
const { isInside, samePath } = require('./project-layout');
const { projectDirName } = require('./project-dir');
const { transcriptFiles, readMeta } = require('./transcripts');
const { readFingerprint, prefixIntact, READ_CHUNK } = require('./usage');
const { renameWithRetryAsync } = require('./atomic-write');

// Strict: `Number(null)` is 0 and `Number('7')` is 7, and a payload field can be either.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// What was spent, the host/usage.js / app/usage-display.js partition: cache reads are the same
// context re-read every turn and never count as spend.
function spendOf(u) {
  if (!u || typeof u !== 'object') return 0;
  return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
}

function emptyRecord() {
  return { offset: 0, fp: null, lastId: null, subagent: false, agentType: null, runBranch: null, branches: {} };
}

const inProject = (cwd, root) => typeof cwd === 'string' && (samePath(cwd, root) || isInside(cwd, root));

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
    const b = rec.branches[o.gitBranch] || (rec.branches[o.gitBranch] = { spend: 0, loose: 0, first: null, last: null, cwds: [] });
    if (loose) b.loose += spendOf(msg.usage);
    else b.spend += spendOf(msg.usage);
    const day = typeof o.timestamp === 'string' && /^\d{4}-\d\d-\d\d/.test(o.timestamp) ? o.timestamp.slice(0, 10) : null;
    if (day) {
      if (!b.first || day < b.first) b.first = day;
      if (!b.last || day > b.last) b.last = day;
    }
    if (!b.cwds.some(c => samePath(c, o.cwd))) b.cwds.push(o.cwd);
    rec.runBranch = o.gitBranch;
  }
  return rec;
}

/**
 * Every tab's host keeps the same project ledger, so two can save it at once. Per file, the record
 * read FURTHEST wins: both hosts read the same bytes, so the longer read contains the shorter one.
 * A file only one side knows is kept -- including one whose transcript is gone (G3).
 */
function mergeLedgers(a, b) {
  const files = { ...((a && a.files) || {}) };
  for (const [p, rec] of Object.entries((b && b.files) || {})) {
    const cur = files[p];
    if (!cur || num(rec.offset) >= num(cur.offset)) files[p] = rec;
  }
  return { version: 1, files };
}

const emptyTotal = () => ({ spend: 0, loose: 0, first: null, last: null, cwds: [], runs: [] });

/**
 * { [branch]: { spend, first, last, cwds, runs: [{ agentType, spend }] } } over every file the ledger
 * has ever seen. A subagent's transcript is ONE run, on the branch its last line was on, worth all
 * of its spend. `HEAD` (a detached checkout) stays a key; the model decides where it belongs.
 */
function totals(ledger) {
  const out = {};
  for (const rec of Object.values((ledger && ledger.files) || {})) {
    let runSpend = 0;
    for (const [name, b] of Object.entries(rec.branches || {})) {
      const t = out[name] || (out[name] = emptyTotal());
      t.spend += num(b.spend);
      t.loose += num(b.loose);
      runSpend += num(b.spend) + num(b.loose);
      if (b.first && (!t.first || b.first < t.first)) t.first = b.first;
      if (b.last && (!t.last || b.last > t.last)) t.last = b.last;
      for (const c of b.cwds || []) if (!t.cwds.some(x => samePath(x, c))) t.cwds.push(c);
    }
    if (rec.subagent && rec.runBranch) {
      const t = out[rec.runBranch] || (out[rec.runBranch] = emptyTotal());
      t.runs.push({ agentType: rec.agentType || 'unknown', spend: runSpend });
    }
  }
  return out;
}

// ---------- disk (Task 5) ----------

const emptyLedger = () => ({ version: 1, files: {} });
const NL = 10;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * Reads what's new in one transcript into `rec` (mutated). Returns the bytes read from disk.
 * Resumes on a line boundary; a prefix that no longer matches (rewritten) or a file shorter than
 * what was read (truncated) means re-read from 0. Throws only on I/O; the caller counts it.
 */
async function readNew(file, rec, projectRoot) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (rec.offset > 0) {
      const fingerprint = rec.fp ? Buffer.from(rec.fp, 'base64') : null;
      if (rec.offset > size || !(await prefixIntact(fh, { offset: rec.offset, fingerprint }))) {
        // a different file now: its old record is replaced, not added to (who it belongs to stays)
        Object.assign(rec, { ...emptyRecord(), subagent: rec.subagent, agentType: rec.agentType });
      }
    }
    const start = rec.offset;
    if (start >= size) return 0;
    let pos = start;
    let carry = Buffer.alloc(0);
    let consumed = 0;
    while (pos < size) {
      const want = Math.min(READ_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const nl = data.lastIndexOf(NL);
      if (nl >= 0) {
        addLines(rec, data.subarray(0, nl + 1).toString('utf8'), projectRoot);
        consumed += nl + 1;
        carry = Buffer.from(data.subarray(nl + 1));
      } else {
        carry = Buffer.from(data);
      }
      // a single unterminated "line" past this can't be a real record (host/usage.js MAX_CARRY)
      if (carry.length > 4 * READ_CHUNK) break;
      await yieldToLoop();
    }
    rec.offset += consumed;
    const fp = await readFingerprint(fh, rec.offset);
    rec.fp = fp ? fp.toString('base64') : null;
    return pos - start;
  } finally {
    await fh.close();
  }
}

/**
 * Brings `ledger` up to date with every transcript of the project (mutated and returned).
 * A project folder is any whose encoded name starts with the project root's; whether a LINE belongs
 * is then decided by its own cwd (G2). Records of files no longer on disk are kept (G3).
 *
 * -> { ledger, read: bytes read, errors: folders or files that couldn't be read }
 */
async function updateLedger(ledger, { projectsDir, projectRoot }) {
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
      const rec = out.files[entry.file] || emptyRecord();
      if (entry.subagent && !rec.subagent) {
        // A meta that exists but can't be read (locked, half-written) is asked for again next
        // time; only a readable one, or none at all (ENOENT), settles who this run was.
        const { meta, error } = await readMeta(entry.file);
        if (!error) {
          rec.subagent = true;
          rec.agentType = meta && typeof meta.agentType === 'string' ? meta.agentType : null;
        } else errors++;
      }
      try {
        read += await readNew(entry.file, rec, projectRoot);
        out.files[entry.file] = rec;
      } catch {
        errors++;
      }
    }
  }
  return { ledger: out, read, errors };
}

/** -> { ledger, corrupt }. Missing: empty, not corrupt. Unreadable or the wrong shape: empty, corrupt. */
async function loadLedger(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    return { ledger: emptyLedger(), corrupt: !(err && err.code === 'ENOENT') };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.files === 'object' && parsed.files !== null && !Array.isArray(parsed.files)) {
      return { ledger: { version: 1, files: parsed.files }, corrupt: false };
    }
  } catch { /* falls through */ }
  return { ledger: emptyLedger(), corrupt: true };
}

/**
 * Merges with whatever another host saved since, then writes temp-then-rename (never a truncating
 * open of the real file: CLAUDE.md). -> the ledger as saved.
 */
async function saveLedger(file, ledger) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const { ledger: onDisk } = await loadLedger(file);
  const merged = mergeLedgers(onDisk, ledger);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(merged));
  await renameWithRetryAsync(tmp, file);
  return merged;
}

module.exports = {
  addLines, emptyRecord, spendOf, mergeLedgers, totals,
  emptyLedger, updateLedger, loadLedger, saveLedger,
};
