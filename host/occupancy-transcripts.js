'use strict';
/**
 * The FALLBACK producer of worktree occupancy: claims read off the subagent transcripts (backlog #44 + #47,
 * Ricardo 2026-10-03).
 *
 * The hook producer (host/occupancy-producer.js) only hears the agents of a session that a host of this
 * build runs. A session in a plain terminal, or under a host of an older build, has agents working in other
 * worktrees and nothing says so. But every session leaves its agents' transcripts on disk:
 *
 *   <projects>\<encoded launching folder>\<session>\subagents\agent-<id>.jsonl   (+ .meta.json)
 *
 * MEASURED 2026-10-03 on personal-agent session 3c8efad6 (six teammates in six worktrees): a subagent's lines
 * carry the SESSION's cwd and gitBranch, never the worktree it works in, and its .meta.json has no cwd. Only
 * the tool_use blocks name the worktree -- so they are judged by the hook path's own test
 * (host/agent-occupancy.js touchOf).
 *
 * THE LAUNCHING FOLDER (the one that never counts) IS WHERE THE TRANSCRIPT IS FILED, not the cwd on a line.
 * Measured on the same session: that cwd follows a `cd` in Bash (60 lines of one teammate said
 * `~\.claude\reviews\personal-agent`), and with it as the launching folder the agent's next call into dev read
 * as "working in dev". A transcript under <projects>\<encoded root>\ was launched from that root.
 *
 * THE SESSION is the folder it is filed under too (<session>\subagents\): the id the hook payloads carry as
 * session_id, so a hub card matches the run of its OWN session, not another one's in the same folder (backlog #57).
 *
 * Run by the Electron main process, once per window, beside the reader (host/occupancy-service.js). It costs
 * no hook: a pass lists a few folders, and reads only the NEW bytes of the transcripts that are fresh.
 *
 *   createTranscriptScanner({ projectsDir, roots, writer, dir, ownPid, ownStartedAt, liveClaims, ... })
 *     .pass()             -> Promise<{ claimed: [agentId], removed: [agentId] }>   never rejects
 *     .start() / .close()    a pass every PASS_MS; close removes the claims this producer still owns
 *   newState / foldLines / touchesOf   the pure part: transcript lines -> an agent's touches
 *
 * THE RULES
 *   - FRESH means the transcript's mtime is under STALE_MS (10 minutes) old. An older one claims nothing, and
 *     a claim made from it is removed. (So an agent that waits more than 10 minutes on one command goes dark
 *     until its next line. Known, and accepted.)
 *   - THE TAIL, THEN ONLY WHAT IS NEW. The first look reads at most `tailBytes` from the end (a cut line is
 *     dropped); later looks read what was appended, complete lines only. A file that shrank is read anew.
 *   - A PLAIN subagent whose last message has stop_reason `end_turn` has finished: it claims nothing, and
 *     if it is resumed it starts from scratch. An `in_process_teammate` (.meta.json taskKind) that ends a
 *     turn is IDLE, not gone: its claim stays until the transcript goes stale.
 *   - THE SAME STORE, with this process as the proof: `hostPid` / `hostStartedAt` are this producer's own,
 *     so a reader shows the claim only while this producer is alive. Nothing is written until this process
 *     knows its own start time (a claim without it is never shown).
 *   - ONE PRODUCER PER AGENT. A claim file that names another producer is left alone while readers show it
 *     as live, and for one pass after that (a claim a host wrote a moment ago isn't judged yet); only then
 *     is it taken over. This producer removes only files that still name it.
 *   - AN EMPTY SLOT IS NOT "UNOWNED" WHEN ITS OWNER EMPTIED IT. Another producer deleting its own file is
 *     the precise "this agent is done here" (SubagentStop, a teammate's idle expiry, SessionEnd, the host's
 *     exit), and the transcript stays fresh for minutes after it. So an agent whose claim file was
 *     another producer's on the last look, and is gone now, is not claimed again until one of its calls
 *     proves a touch NEWER than the ones that claim was made of (PR #96 Dexter F1).
 *   - ABSENCE IS NOT "FINISHED", FOLDER BY FOLDER: a claim whose transcript sits under a folder that
 *     couldn't be listed this pass is kept; every other claim is judged as usual (Dexter F6).
 *   - Only a real start time (a FILETIME, host/proc-start.js) is this producer's proof (Miguel S2).
 */

const fs = require('fs');
const path = require('path');
const { touchOf, buildClaim, parseClaim, safeAgentId, claimFileName } = require('./agent-occupancy');
const { normPath, samePath, isInside } = require('./project-layout');
const { filetimeToMs } = require('./background-hosts');
const { projectDirName } = require('./project-dir');
const { readMeta, SUBAGENTS } = require('./transcripts');

const STALE_MS = 10 * 60 * 1000;
const TAIL_BYTES = 1024 * 1024;
const PASS_MS = 15_000;
const TOUCHES_MAX = 16;
const GRACE_PASSES = 2;
const RELEASED_MAX = 500;
const TEAMMATE = 'in_process_teammate';
const NL = 10;
const AGENT_FILE = /^agent-.+\.jsonl$/;

const isStr = s => typeof s === 'string' && s !== '';
const isStartTime = s => typeof s === 'string' && filetimeToMs(s) !== null;
const errText = err => (err && err.message) || String(err);

// --- the pure part ----------------------------------------------------------------------------------------

/**
 * What is known about one transcript. `all` is every worktree its calls touched (as far back as was read);
 * `current` only those since its last `end_turn`. Which one speaks depends on what the agent is (touchesOf).
 */
function newState({ teammate = false } = {}) {
  return {
    offset: null, agentId: null, branch: null,
    teammate, name: null, metaKnown: false, all: new Map(), current: new Map(),
  };
}

function bump(map, worktree, at) {
  const key = normPath(worktree);
  const prev = map.get(key);
  map.delete(key);                                     // re-inserted last: Map order is "least recently touched first"
  map.set(key, {
    worktree,
    firstAt: prev ? Math.min(prev.firstAt, at) : at,
    lastAt: prev ? Math.max(prev.lastAt, at) : at,
    count: (prev ? prev.count : 0) + 1,
  });
  while (map.size > TOUCHES_MAX) map.delete(map.keys().next().value);
}

/**
 * Folds the COMPLETE lines of `text` into `state` (mutated and returned). Only an agent's own assistant
 * messages count: a line with a safe `agentId`. `ownRoot` is the launching folder (where the transcript is
 * filed), which never counts as a touch; the session's branch is read off a line written IN that folder.
 * `fallbackAt` times a line that carries no usable timestamp.
 */
function foldLines(state, text, roots, fallbackAt, ownRoot) {
  for (const line of String(text).split('\n')) {
    if (line === '' || !line.includes('"assistant"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || o.type !== 'assistant') continue;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;
    const id = safeAgentId(o.agentId);
    if (id === null) continue;
    state.agentId = id;
    // a line written elsewhere (after a cd) carries that folder's branch, or none: not the session's
    if (isStr(o.gitBranch) && samePath(o.cwd, ownRoot)) state.branch = o.gitBranch;
    const stamp = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const at = Number.isFinite(stamp) ? stamp : fallbackAt;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
        const worktree = touchOf(b.name, b.input, roots, ownRoot);
        if (worktree === null) continue;
        bump(state.all, worktree, at);
        bump(state.current, worktree, at);
      }
    }
    // The run is over: what it touched is no longer where a plain subagent is working.
    if (msg.stop_reason === 'end_turn') state.current.clear();
  }
  return state;
}

/**
 * The touches that make this agent's claim right now: `[{ worktree, firstAt, lastAt, count }]`, maybe none.
 * A teammate: everything it touched (an ended turn is an idle teammate). A plain subagent: what it touched
 * since its last `end_turn` -- nothing, when that was its last message.
 */
function touchesOf(state) {
  return [...(state.teammate ? state.all : state.current).values()];
}

// --- the producer -----------------------------------------------------------------------------------------

function createTranscriptScanner({
  projectsDir, roots, writer, dir, ownPid, ownStartedAt, liveClaims = () => [],
  fsp = fs.promises, fsImpl = fs, now = Date.now, log = () => {},
  staleMs = STALE_MS, tailBytes = TAIL_BYTES, passMs = PASS_MS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimer = clearTimeout,
} = {}) {
  const states = new Map();        // transcript file -> state
  const mine = new Set();          // agent ids whose claim file this producer wrote and still answers for
  const grace = new Map();         // agent id -> passes a claim file of another, not-live producer was seen
  const source = new Map();        // agent id -> the transcript this producer's claim for it was read from
  const theirs = new Set();        // agent ids whose claim file was another producer's on the last look
  const released = new Map();      // agent id -> the newest touch (ms) its owner's removed claim was made of
  const logged = new Set();
  let running = null;
  let closed = false;
  let timer = null;

  const logOnce = (key, ...args) => { if (!logged.has(key)) { logged.add(key); log(...args); } };

  // The fresh agent transcripts under every worktree's project folder, each with the root it is filed under
  // (its launching folder). `failed` is every folder that exists and could not be listed: its transcripts
  // may be there, unseen. Two roots whose names encode alike (`feat-a`, `feat.a`) share one
  // folder: the first one git lists is taken as the launcher, the same one on every pass.
  async function listFresh(known) {
    const files = [];
    const failed = [];
    const seen = new Set();
    for (const root of known) {
      const name = projectDirName(root);
      if (seen.has(name)) continue;
      seen.add(name);
      const base = path.join(projectsDir, name);
      let sessions;
      try {
        sessions = await fsp.readdir(base, { withFileTypes: true });
      } catch (err) {
        if (!err || err.code !== 'ENOENT') { failed.push(base); logOnce(`list|${base}`, `[occupancy] ${base} can't be listed:`, errText(err)); }
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const sub = path.join(base, s.name, SUBAGENTS);
        let names;
        try {
          names = await fsp.readdir(sub);
        } catch (err) {
          // ENOENT only is "no agents": every other errno means they may be there and we could not look.
          if (!err || err.code !== 'ENOENT') { failed.push(sub); logOnce(`list|${sub}`, `[occupancy] ${sub} can't be listed:`, errText(err)); }
          continue;
        }
        for (const f of names.sort()) {
          if (!AGENT_FILE.test(f)) continue;
          const file = path.join(sub, f);
          let st;
          try { st = await fsp.stat(file); } catch { continue; }      // gone between the listing and the stat
          if (now() - st.mtimeMs < staleMs) files.push({ file, root, session: s.name, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    return { files, failed };
  }

  async function readMetaOnce(file, state) {
    if (state.metaKnown) return;
    const { meta, error } = await readMeta(file);
    if (error || !meta) return;                 // unreadable or not written yet: asked for again next pass
    state.metaKnown = true;
    state.name = isStr(meta.name) ? meta.name : (isStr(meta.agentType) ? meta.agentType : null);
    state.teammate = meta.taskKind === TEAMMATE;
  }

  // Reads what is new in one transcript into its state: at most `tailBytes` from the end, complete lines.
  async function readNew({ file, root, size, mtimeMs }, state, known) {
    if (state.offset !== null && state.offset > size) {
      // shorter than what was read: a different file now. What it is (its meta) is asked for again too.
      Object.assign(state, newState());
    }
    const from = state.offset === null ? 0 : state.offset;
    const start = Math.max(from, size - tailBytes);
    if (start >= size) { state.offset = from; return; }
    const fh = await fsp.open(file, 'r');
    let data;
    try {
      const buf = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      data = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    // When `start` landed in the middle of a line (the tail cut it), what is left of that line is not JSON
    // and foldLines drops it like any other junk: the cut line is never half-read.
    const end = data.lastIndexOf(NL);
    if (end < 0) { state.offset = start; return; }       // a line still being written: next time
    foldLines(state, data.subarray(0, end + 1).toString('utf8'), known, mtimeMs, root);
    state.offset = start + end + 1;
  }

  function onDisk(agentId) {
    const name = claimFileName(agentId);
    if (name === null) return null;
    try {
      const r = parseClaim(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
      return r.ok ? r.claim : null;
    } catch {
      return null;
    }
  }
  const foreign = claim => claim !== null && claim.hostPid !== ownPid;

  async function run() {
    const out = { claimed: [], removed: [] };
    let started = null;
    try { started = await ownStartedAt(); } catch { started = null; }
    try {
      if (roots.stale()) await roots.refresh();
    } catch (err) {
      logOnce('roots', '[occupancy] could not refresh the worktree list; using the last one:', errText(err));
    }
    const known = roots.get();
    const listing = await listFresh(known);
    // a transcript under a folder that couldn't be listed: unseen this pass, which says nothing about it
    const unseen = file => listing.failed.some(d => isInside(file, d));

    const wanted = new Map();        // agent id -> the claim record its transcript makes
    const fresh = new Set();
    for (const f of listing.files) {
      fresh.add(f.file);
      let state = states.get(f.file);
      if (!state) { state = newState(); states.set(f.file, state); }
      try {
        await readNew(f, state, known);
        await readMetaOnce(f.file, state);
      } catch (err) {
        logOnce(`read|${f.file}`, `[occupancy] ${f.file} can't be read:`, errText(err));
        continue;
      }
      if (state.agentId === null) continue;
      const rec = buildClaim({
        agentId: state.agentId, agent: state.name, fromBranch: state.branch, fromRoot: f.root, sessionId: f.session,
        hostPid: ownPid, hostStartedAt: started, touches: touchesOf(state),
      });
      if (rec !== null) { wanted.set(state.agentId, rec); source.set(state.agentId, f.file); }
    }
    // A transcript that went stale is forgotten: if it is written again, its tail is read anew.
    for (const file of [...states.keys()]) if (!fresh.has(file) && !unseen(file)) states.delete(file);

    if (isStartTime(started)) {
      let live = [];
      try { const l = liveClaims(); live = Array.isArray(l) ? l : []; } catch { live = []; }
      for (const [id, rec] of wanted) {
        const disk = onDisk(id);
        if (disk === null && theirs.delete(id)) {
          // its owner removed it: remember what that claim was made of
          released.delete(id);
          released.set(id, rec.lastAt);
          while (released.size > RELEASED_MAX) released.delete(released.keys().next().value);
        }
        if (foreign(disk)) {
          theirs.delete(id);
          theirs.add(id);
          while (theirs.size > RELEASED_MAX) theirs.delete(theirs.keys().next().value);
          const shown = live.some(c => c && c.agentId === id && c.hostPid === disk.hostPid);
          const seen = shown ? 0 : (grace.get(id) || 0) + 1;
          // left to it (if this producer wrote that file earlier, the removal below and close() see whose
          // it is now, and leave it)
          if (shown || seen < GRACE_PASSES) { grace.set(id, seen); continue; }
          writer.forget(id);       // taking it over: whatever this writer last wrote there is not what is there
          theirs.delete(id);
        }
        grace.delete(id);
        if (released.has(id)) {
          if (rec.lastAt <= released.get(id)) continue;      // nothing newer than what its owner let go of
          released.delete(id);
        }
        const w = writer.write(rec);
        if (w && w.ok) { mine.add(id); out.claimed.push(id); } else log('[occupancy] transcript claim not written:', w && w.error);
      }
    }
    for (const id of [...grace.keys()]) if (!wanted.has(id)) grace.delete(id);

    for (const id of [...mine]) {
      if (wanted.has(id)) continue;
      if (unseen(source.get(id) || '')) continue;       // absence is not "finished"
      mine.delete(id);
      if (foreign(onDisk(id))) continue;                // somebody else's file now: theirs to remove
      writer.remove(id);
      out.removed.push(id);
    }
    for (const id of [...source.keys()]) if (!mine.has(id) && !wanted.has(id)) source.delete(id);
    return out;
  }

  function pass() {
    if (running) return running;
    running = run()
      .catch((err) => { log('[occupancy] transcript pass failed:', errText(err)); return { claimed: [], removed: [] }; })
      .finally(() => { running = null; });
    return running;
  }

  function schedule() {
    if (closed) return;
    timer = setTimer(async () => {
      timer = null;
      await pass();
      schedule();
    }, passMs);
  }

  function start() {
    if (closed) return;
    pass();
    schedule();
  }

  function close() {
    closed = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    for (const id of [...mine]) {
      mine.delete(id);
      if (!foreign(onDisk(id))) writer.remove(id);
    }
  }

  return { pass, start, close };
}

module.exports = {
  createTranscriptScanner, newState, foldLines, touchesOf, STALE_MS, TAIL_BYTES, PASS_MS, GRACE_PASSES, TOUCHES_MAX,
};
