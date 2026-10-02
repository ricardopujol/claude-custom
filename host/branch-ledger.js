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

const { isInside, samePath } = require('./project-layout');

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
    if (!inProject(o.cwd, projectRoot)) continue;
    // ONE MESSAGE IS ONE USAGE (host/usage.js:117): its content blocks repeat the same figure on
    // consecutive lines. Measured over all 381 claude-custom transcripts: 20,484 repeats, all
    // adjacent (G1), so the previous id is the whole resume state. A line with no id always counts.
    const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
    if (id && id === rec.lastId) continue;
    rec.lastId = id;
    const b = rec.branches[o.gitBranch] || (rec.branches[o.gitBranch] = { spend: 0, first: null, last: null, cwds: [] });
    b.spend += spendOf(msg.usage);
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

const emptyTotal = () => ({ spend: 0, first: null, last: null, cwds: [], runs: [] });

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
      runSpend += num(b.spend);
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

module.exports = { addLines, emptyRecord, spendOf, mergeLedgers, totals };
