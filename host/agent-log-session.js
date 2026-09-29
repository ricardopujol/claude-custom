'use strict';
/**
 * BACKLOG #10, the host half: find the transcript of the agent that was clicked
 * and stream its log to the window that asked.
 *
 * WHICH FILE.
 *
 *   The agent is RUNNING and the mood machine knows its `agent_id`: the file is
 *   `agent-<agent_id>.jsonl` (measured -- the CLI names the transcript for the
 *   id its hooks report). The id is only ever COMPARED with real file names from
 *   a directory listing, never joined into a path: it arrives from a hook
 *   payload, which is somebody else's process boundary.
 *
 *   The agent is running but has not yet said who it is (an id is learned from
 *   its first call): the answer is "pending". NOT the newest transcript of that
 *   name -- that is last week's run, and drawing it under a live card would
 *   fabricate the very thing this panel exists to show.
 *
 *   The agent is not running: the MOST RECENT transcript resolving to that
 *   agent in this project, by the identity tables host/agent-stats.js already
 *   builds (a named spawn is filed under its true type, not its label).
 *
 * ABSENCE IS EXPLICIT. `{ source: null, reason }` with reason
 *   no-transcript  nothing on disk for this agent (or it vanished)
 *   pending        it is running and its transcript is not written yet
 *   unreadable     the file exists and could not be read
 * The window shows each as words, never as an empty list.
 *
 * The polling here is deliberately an interval and not fs.watch: a watcher on a
 * file being appended to by another process is unreliable on Windows, and a
 * ~750 ms tick is invisible for a log a person reads.
 */

const fsp = require('fs/promises');
const path = require('path');
const { projectDirName } = require('./project-dir');
const { transcriptFiles } = require('./transcripts');
const { identityTables, resolveAgent, defaultProjectsDir } = require('./agent-stats');
const agentLog = require('./agent-log');

const POLL_MS = 750;
// One frame carries at most this many lines, so opening a huge transcript is a
// stream of modest frames rather than one that stalls the socket.
const FRAME_ENTRIES = 500;

async function readMeta(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Absent or corrupt: the run simply resolves by nothing but its label. The
    // stats module counts these; a log has no total to under-report.
    return null;
  }
}

/**
 * The transcript for one agent in one project.
 *
 * @param agentId  when given, the exact run (`agent-<agentId>.jsonl`)
 * @returns `{ file }` or `{ file: null, reason: 'no-transcript' }`
 */
async function findTranscript({ cwd, projectsDir, agent, agentId } = {}) {
  const dir = path.join(projectsDir || defaultProjectsDir(), projectDirName(cwd));
  const { files } = await transcriptFiles(dir);
  const none = { file: null, reason: 'no-transcript' };
  if (files === null) return none;

  const subagents = files.filter(f => f.subagent);

  if (typeof agentId === 'string' && agentId) {
    const wanted = `agent-${agentId}.jsonl`;
    const hit = subagents.find(f => path.basename(f.file) === wanted);
    return hit ? { file: hit.file } : none;
  }

  const tables = await identityTables(files);
  let best = null;
  for (const f of subagents) {
    const { agent: who } = resolveAgent(await readMeta(f.file), tables, f.session);
    if (who !== agent) continue;
    let mtime;
    try { mtime = (await fsp.stat(f.file)).mtimeMs; } catch { continue; }
    // Newest wins; the path breaks a tie so the pick never depends on readdir order.
    if (!best || mtime > best.mtime || (mtime === best.mtime && f.file > best.file)) {
      best = { file: f.file, mtime };
    }
  }
  return best ? { file: best.file } : none;
}

/**
 * One window's open log. At most one agent at a time; opening another replaces
 * it. `poll()` is exposed so tests drive it directly.
 *
 * @param invocations  () => the mood machine's live invocations
 *                     (`[{ name, agentId }]`), the same source as the roster
 * @param send         (frame) => void, to the window that asked
 */
function createLogSession({
  cwd, projectsDir, invocations, send, intervalMs = POLL_MS,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  find = findTranscript, read = agentLog.readMore,
} = {}) {
  let cur = null;

  function none(c, reason, running) {
    const key = `${reason}|${running}`;
    if (c.lastNone === key) return;
    c.lastNone = key;
    // An absence frame WIPES what the window holds (the reducer clears its
    // entries), so recovery cannot pick up where the tail left off: the offset
    // is already past everything that was wiped. Restart the file from the top
    // and make the next data frame a reset, and forget the status dedupe -- the
    // window has forgotten what those statuses were. (Dexter F1, PR #63: one
    // EBUSY left a finished agent's panel on "couldn't read" forever, and made
    // a running agent's history vanish with `dropped: 0`.)
    c.lastRunning = null;
    c.lastDone = null;
    if (c.tail) { c.tail = agentLog.createTail(c.tail.file); c.first = true; }
    send({ type: 'agent-log', agent: c.agent, source: null, reason, running });
  }

  async function step(c) {
    const runs = (typeof invocations === 'function' ? invocations() : []).filter(i => i && i.name === c.agent);
    const running = runs.length > 0;
    // The newest run that has said who it is.
    const bound = [...runs].reverse().find(i => typeof i.agentId === 'string' && i.agentId);
    const want = bound ? `id:${bound.agentId}` : running ? 'pending' : 'name';

    if (want !== c.want) {
      // A run that ENDS keeps the file it was streaming: the log stays readable
      // and is not re-fetched by name (which could pick a different run).
      const ended = want === 'name' && typeof c.want === 'string' && c.want.startsWith('id:') && c.tail;
      c.want = want; c.resolved = false;
      if (!ended) c.tail = null;
    }
    if (want === 'pending') { none(c, 'pending', running); return; }

    if (!c.tail) {
      // A name lookup walks every transcript in the project, so a miss is not
      // repeated every tick: nothing will appear until a run starts, and that
      // changes `want`. An id lookup is one directory listing and is retried.
      if (c.resolved && want === 'name') return;
      const r = await find({ cwd, projectsDir, agent: c.agent, agentId: bound ? bound.agentId : undefined });
      if (cur !== c) return;
      c.resolved = true;
      if (!r.file) {
        none(c, want === 'name' || c.everFound ? 'no-transcript' : 'pending', running);
        return;
      }
      c.everFound = true;
      c.tail = agentLog.createTail(r.file);
      c.first = true;
    }

    for (;;) {
      let r;
      try {
        r = await read(c.tail, { maxEntries: FRAME_ENTRIES });
      } catch (err) {
        if (cur !== c) return;
        if (err && err.code === 'ENOENT') {
          c.tail = null;
          c.resolved = true;
          none(c, 'no-transcript', running);
        } else {
          none(c, 'unreadable', running);
        }
        return;
      }
      if (cur !== c) return;
      c.tail = r.state;
      const reset = c.first || r.reset === true;
      c.first = false;
      const done = !running && !r.more;
      if (r.entries.length > 0 || reset || running !== c.lastRunning || done !== c.lastDone) {
        c.lastNone = null;
        send({
          type: 'agent-log', agent: c.agent, source: r.state.file,
          entries: r.entries, reset, running, done, unknown: r.state.unknown,
        });
      }
      c.lastRunning = running;
      c.lastDone = done;
      if (!r.more) return;
    }
  }

  async function poll() {
    const c = cur;
    if (!c || c.busy) return;
    c.busy = true;
    try {
      await step(c);
    } catch (err) {
      console.log('[agent-log] poll failed:', err && err.message);
    } finally {
      c.busy = false;
    }
  }

  function close() {
    if (cur && cur.timer) clearIntervalFn(cur.timer);
    cur = null;
  }

  async function open(agent) {
    close();
    if (typeof agent !== 'string' || !agent) return;
    const c = {
      agent, timer: null, busy: false, want: null, resolved: false, everFound: false,
      tail: null, first: false, lastNone: null, lastRunning: null, lastDone: null,
    };
    cur = c;
    c.timer = setIntervalFn(() => { poll().catch(() => {}); }, intervalMs);
    if (c.timer && typeof c.timer.unref === 'function') c.timer.unref();
    await poll();
  }

  return { open, close, poll, isOpen: () => cur !== null, current: () => (cur ? cur.agent : null) };
}

module.exports = { findTranscript, createLogSession, POLL_MS, FRAME_ENTRIES };
