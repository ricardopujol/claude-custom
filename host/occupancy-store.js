'use strict';
/**
 * Where the occupancy claims live, and how they're written, read and swept (backlog #44 + #47,
 * documentation/DESIGN_WORKTREE_OCCUPANCY.md). host/agent-occupancy.js is the pure half.
 *
 *   <stateRoot>\.claude-custom\occupancy\<agent_id>.json     one file per agent, behind the same `*`
 *                                                            .gitignore as the look and the tab marks
 *
 * SHARED THROUGH FILES, not a host-to-host push: a window sees claims made by another window's host, and for
 * tabs that aren't open.
 *
 * WRITING (the launching host only):
 *   - temp file + rename, never the target opened with 'w' (a failed write leaves the old file whole);
 *   - `lastAt` is rewritten at most every REWRITE_MS (no write per tool call). A CHANGE -- a new worktree, a
 *     new `also` -- is written at once, and a failed write doesn't start the window;
 *   - `.claude-custom` that is a link or junction to somewhere else is never written through
 *     (host/style.js lookDirState: a cloned repo can ship one pointing anywhere);
 *   - deleted on SubagentStop (remove), and when the host exits (removeAll).
 *
 * READING (every window): readAll never throws and never decides liveness (host/occupancy-live.js does).
 *   - the folder missing is `missing` (nothing was ever claimed); any other failure to list it is
 *     `unreadable` and says why -- never a quiet empty "free";
 *   - only `<safe id>.json` is opened; a file that won't parse, isn't a claim, names a different agent than
 *     its own file name, can't be read or is oversize is SKIPPED and reported, never shown.
 *
 * SWEEPING: a dead claim is deleted by the next PRODUCER that starts in the project (sweepDead), never by a
 * reader. Only claims judged `dead` go; unknown, unproven and malformed files are left alone, and a file
 * that was rewritten while it was being judged isn't deleted on the old verdict.
 */

const fs = require('fs');
const path = require('path');
const { lookDir, lookDirState, ensureLookDir } = require('./style');
const { renameWithRetry } = require('./atomic-write');
const { parseClaim, serializeClaim, claimFileName, safeAgentId } = require('./agent-occupancy');

const DIR_NAME = 'occupancy';
const REWRITE_MS = 30_000;
const MAX_CLAIM_BYTES = 64 * 1024;
const FILE_RE = /^([A-Za-z0-9_-]{1,64})\.json$/;

const occupancyDir = stateRoot => path.join(lookDir(stateRoot), DIR_NAME);
const errText = err => (err && err.message) || String(err);

function createClaimWriter({ stateRoot, fsImpl = fs, now = Date.now, log = () => {} } = {}) {
  const written = new Map();       // agentId -> { key, at } of the last write that landed

  function write(record) {
    let parsed;
    try { parsed = record && typeof record === 'object' ? parseClaim(serializeClaim(record)) : null; } catch { parsed = null; }
    if (!parsed || !parsed.ok) return { ok: false, error: `not a claim: ${parsed ? parsed.reason : 'no record'}` };
    const name = claimFileName(record.agentId);
    // What a CHANGE is: where the agent is, and the host's proof (its start time can arrive after the first claim).
    const key = `${record.worktree}|${record.also.join('|')}|${record.hostStartedAt}`;
    const prev = written.get(record.agentId);
    if (prev && prev.key === key && now() - prev.at < REWRITE_MS) return { ok: true, wrote: false };

    if (lookDirState(stateRoot, fsImpl) === 'foreign') {
      return { ok: false, error: `${lookDir(stateRoot)} is a link to somewhere else; not writing through it` };
    }
    const dir = occupancyDir(stateRoot);
    const file = path.join(dir, name);
    const temp = `${file}.tmp${process.pid}`;
    try {
      ensureLookDir(stateRoot, fsImpl);
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.writeFileSync(temp, serializeClaim(record));
      renameWithRetry(temp, file, { rename: fsImpl.renameSync });
    } catch (err) {
      try { fsImpl.unlinkSync(temp); } catch { /* best effort */ }
      log('[occupancy] could not write a claim:', errText(err));
      return { ok: false, error: errText(err) };
    }
    written.set(record.agentId, { key, at: now() });
    return { ok: true, wrote: true };
  }

  function remove(agentId) {
    const name = claimFileName(agentId);
    if (name === null) return { ok: false, error: 'not a safe agent id' };
    written.delete(agentId);
    try {
      fsImpl.unlinkSync(path.join(occupancyDir(stateRoot), name));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        log('[occupancy] could not remove a claim:', errText(err));
        return { ok: false, error: errText(err) };
      }
    }
    return { ok: true };
  }

  function removeAll() {
    for (const id of [...written.keys()]) remove(id);
  }

  return { write, remove, removeAll };
}

/**
 * `{ state: 'ok' | 'missing' | 'unreadable', claims, skipped, error? }`. `skipped` is `[{ file, reason }]`.
 */
function readAll(dir, { fsImpl = fs } = {}) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', claims: [], skipped: [] };
    return { state: 'unreadable', claims: [], skipped: [], error: errText(err) };
  }
  const claims = [];
  const skipped = [];
  for (const file of names) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const full = path.join(dir, file);
    let text;
    try {
      const st = fsImpl.lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_CLAIM_BYTES) { skipped.push({ file, reason: 'file too large to be a claim' }); continue; }
      text = fsImpl.readFileSync(full, 'utf8');
    } catch (err) {
      skipped.push({ file, reason: `can't be read: ${errText(err)}` });
      continue;
    }
    const r = parseClaim(text);
    if (!r.ok) { skipped.push({ file, reason: r.reason }); continue; }
    if (r.claim.agentId !== m[1]) { skipped.push({ file, reason: 'names a different agent than its file name' }); continue; }
    claims.push(r.claim);
  }
  return { state: 'ok', claims, skipped };
}

/**
 * Deletes the claims `judge(claims)` calls dead. `judge` -> Promise<[{ claim, verdict }]>
 * (host/occupancy-live.js). Resolves `{ removed: [agentId] }`; never rejects.
 */
async function sweepDead(dir, { judge, fsImpl = fs, log = () => {} } = {}) {
  const removed = [];
  try {
    const read = readAll(dir, { fsImpl });
    if (read.claims.length === 0) return { removed };
    const verdicts = await judge(read.claims);
    for (const { claim, verdict } of verdicts) {
      if (verdict !== 'dead') continue;
      const file = path.join(dir, claimFileName(claim.agentId));
      // The file may have been rewritten while the verdict was worked out: only what was judged is deleted.
      let again;
      try { again = parseClaim(fsImpl.readFileSync(file, 'utf8')); } catch { continue; }
      if (!again.ok || serializeClaim(again.claim) !== serializeClaim(claim)) continue;
      try { fsImpl.unlinkSync(file); removed.push(claim.agentId); } catch (err) {
        if (!err || err.code !== 'ENOENT') log('[occupancy] could not sweep a dead claim:', errText(err));
      }
    }
  } catch (err) {
    log('[occupancy] sweep failed:', errText(err));
  }
  return { removed };
}

module.exports = {
  occupancyDir, createClaimWriter, readAll, sweepDead, REWRITE_MS, MAX_CLAIM_BYTES, DIR_NAME, safeAgentId,
};
