'use strict';
/**
 * One host's side of the Schedules panel (BACKLOG #119 A7). The model is host/schedules.js; this file is what keeps it between hosts.
 *
 * Every host is one session, and the panel lists EVERY session's scheduled work, so the hosts share one install-wide file,
 * `.harness/state/schedules.json`:
 *
 *   { version: 1, sessions: { [hostKey]: { key, cwd, label, pid, updatedAt, endedAt, rows } } }
 *
 * A host writes ONLY its own entry (inside the store's cross-process lock) and reads all of them; a watch on the file
 * (host/wand-watch.js, in host.js) tells it when another host wrote. The list is REGENERABLE (a wakeup is back the next time its session
 * schedules one), so a corrupt file is replaced; a file that merely could not be read just now (the antivirus holds it for a moment) is
 * left alone and the next event tries again. The panel always shows this host's own rows from memory, so an unwritable file never blanks
 * the session you are looking at.
 *
 * LIVENESS. A host that exits cleanly marks its entry `endedAt`. One that dies does not, so a host with rows refreshes `updatedAt` on a
 * heartbeat (beat(), every ~30 s) and a neighbour treats three silent minutes as "ended". Either way the rows are dimmed "session ended"
 * and dropped ten minutes later (host/schedules.js buildView), and any write prunes the entries that are already past that.
 * A host with NOTHING scheduled keeps no entry at all: an idle session costs no file traffic.
 *
 * AFTER A RESTART (start()): only this host's DURABLE cron jobs come back, because only those survive in the CLI itself
 * (.claude/scheduled_tasks.json). A wakeup or a session-only cron job died with the session it was scheduled in. They come back only for
 * THE SAME FOLDER: an entry is keyed by port AND folder, because a port outlives its host and the next project to get it is not the one that
 * scheduled them. A durable job whose host is gone is NOT pruned with the rest of its host's rows: the CLI still fires it, so it stays
 * listed as "host ended, still scheduled by the CLI" until its own 7 days (recurring) or its run (one-shot) is over.
 * start() is called only once the host's socket is LISTENING: a host that loses the bind (EADDRINUSE) never writes this file.
 *
 * KNOWN LIMITS (reviewed, kept): the 30 s heartbeat reads the file on an idle host too (cheap, and it is what moves "in 23 min" along);
 * the heartbeat interval is not cleared at exit; a failed save is retried on the next heartbeat, not sooner.
 *
 * The frames: hello carries `schedules: payload()`; every change is `{ type: 'schedules', schedules: payload }`, broadcast to every
 * window of this host; a window may ask `{ type: 'schedules' }` (when the panel opens) and gets the same frame back.
 */

const path = require('path');
const { createSessionSchedule, buildView, cronExpired, ENDED_DROP_MS, ENDED_STALE_MS } = require('./schedules');

const STORE_KEY = 'schedules';
const VERSION = 1;
const CONTROL_TYPE = 'schedules';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The Pre and Post of CronCreate / CronDelete: events only this feature asked for (host/settings-writer.js CRON_MATCHER). The host feeds
 * them here and goes no further: the mood engine would read the tool as work. (ScheduleWakeup's belong to the bedtime flag, isBedtimeOnly.)
 */
function isSchedulesOnly(ev) {
  return isObj(ev) && (ev.event === 'PreToolUse' || ev.event === 'PostToolUse')
    && isObj(ev.payload) && (ev.payload.tool_name === 'CronCreate' || ev.payload.tool_name === 'CronDelete');
}

const isDurableCron = (r) => isObj(r) && r.kind === 'cron' && r.durable === true;

/**
 * What to keep of an entry another host left. One already past the point buildView would drop it keeps only its durable cron jobs (the
 * CLI still fires those, PR #200 Miguel 3) and is removed when it has none; a junk entry goes. Anything else is kept as it is.
 */
function pruned(entry, now) {
  if (!isObj(entry)) return null;
  let endedAt = null;
  if (isNum(entry.endedAt)) endedAt = entry.endedAt;
  else if (isNum(entry.updatedAt)) endedAt = entry.updatedAt + ENDED_STALE_MS;
  else return null;
  if (now - endedAt <= ENDED_DROP_MS) return entry;
  const durable = (Array.isArray(entry.rows) ? entry.rows : []).filter(r => isDurableCron(r) && !cronExpired(r, now));
  return durable.length > 0 ? { ...entry, rows: durable } : null;
}

/**
 * The same folder, however it is spelled: resolved, forward slashes, no trailing separator, lower-cased on Windows (where the file system
 * ignores case). The host builds its entry's KEY from this, so a successor host whose folder is spelled differently owns the same entry
 * (PR #200 Dexter r2 N2). Null for anything that is not a path.
 */
function normalizeFolder(p) {
  if (typeof p !== 'string' || p === '') return null;
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
const folderKey = normalizeFolder;

function createSchedulesControl({ store, key, cwd = null, label = () => '', now = Date.now, emit = () => {}, nightView = () => null, log = () => {},
  retryMs = 250, maxRetries = 20 } = {}) {
  if (!store) throw new Error('createSchedulesControl: store is required');
  if (typeof key !== 'string' || key === '') throw new Error('createSchedulesControl: key is required');

  const model = createSessionSchedule({ now });
  let told = null;                 // JSON of the list the windows of THIS host were last told
  let loggedFailure = false;
  let ended = false;
  let started = false;             // a host whose bind failed never starts, and so never writes the shared file (PR #200 Dexter 5)
  let dirty = false;               // the last save did not land: the next heartbeat tries again, whether or not any rows are left
  let lastGood = {};               // the other hosts' entries from the last READABLE file: shown while the file is busy
  let retryTimer = null;
  let retries = 0;

  const say = (line) => { try { log(line); } catch { /* a logger must never stop the host */ } };

  /** { ok, sessions }: ok:false means "could not read it just now" (never overwrite), a corrupt file reads as empty. */
  function readFile() {
    let state;
    try { state = store.readState(STORE_KEY); } catch (err) { state = { status: 'unreadable', error: err }; }
    if (!state || state.status === 'unreadable') return { ok: false, sessions: {} };
    if (state.status === 'ok' && isObj(state.value) && isObj(state.value.sessions)) return { ok: true, sessions: state.value.sessions };
    return { ok: true, sessions: {} };               // missing, corrupt, or the wrong shape
  }

  function nightFor() {
    let v = null;
    try { v = nightView(); } catch { v = null; }
    return isObj(v) && isNum(v.startedAt)
      ? { startedAt: v.startedAt, wakes: isNum(v.wakes) ? v.wakes : 0, prs: isNum(v.prs) ? v.prs : null }
      : null;
  }

  function ownRows() {
    return model.rows().map(r => (r.kind === 'bedtime' ? { ...r, night: nightFor() } : r));
  }

  function ownEntry(at) {
    let name = '';
    try { name = String(label() || ''); } catch { name = ''; }
    return { key, cwd, label: name, pid: process.pid, updatedAt: at, endedAt: null, rows: ownRows() };
  }

  /** Write (or remove) this host's entry. Returns whether the file now says what memory says. */
  function persist({ markEnded = false } = {}) {
    if (!started) return false;
    const at = now();
    const rows = ownRows();
    dirty = true;                                       // until the file says what memory says
    try {
      const ok = store.withLock(STORE_KEY, () => {
        const cur = readFile();
        if (!cur.ok) return false;
        const sessions = {};
        for (const [k, e] of Object.entries(cur.sessions)) {
          if (k === key) continue;
          const kept = pruned(e, at);
          if (kept !== null) sessions[k] = kept;
        }
        if (rows.length > 0) {
          const mine = ownEntry(at);
          sessions[key] = markEnded ? { ...mine, endedAt: at } : mine;
        }
        const same = JSON.stringify(sessions) === JSON.stringify(cur.sessions);
        if (!same) store.write(STORE_KEY, { version: VERSION, sessions });
        return true;
      }) === true;
      dirty = !ok;
      return ok;
    } catch (err) {
      if (!loggedFailure) { loggedFailure = true; say(`[schedules] could not save: ${err && err.message ? err.message : err}`); }
      return false;
    }
  }

  /**
   * The list the windows should see: every host's entry from the file, with this host's own taken from memory. A file that cannot be
   * read just now (the antivirus holds a file it has just seen renamed) shows the last good copy, never a list without the other
   * sessions, and is looked at again shortly (armRetry).
   */
  function currentView() {
    const at = now();
    const entries = {};
    const cur = readFile();
    if (cur.ok) { lastGood = cur.sessions; retries = 0; } else armRetry();
    const others = cur.ok ? cur.sessions : lastGood;
    for (const [k, e] of Object.entries(others)) if (k !== key && isObj(e)) entries[k] = e;
    if (!ended) {
      const mine = ownEntry(at);
      if (mine.rows.length > 0) entries[key] = mine;
    } else if (isObj(others[key])) {
      entries[key] = others[key];
    }
    return buildView(entries, at);
  }

  // No further file event is coming to say "look again", so a busy read arms a bounded retry that announces whatever it then finds.
  function armRetry() {
    if (retryTimer !== null || ended || retries >= maxRetries) return;
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      try { announce(); } catch { /* the next event retries */ }
    }, retryMs);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  const payload = () => {
    try { return currentView(); } catch (err) { say(`[schedules] view failed: ${err && err.message ? err.message : err}`); return buildView({}, now()); }
  };
  const frameOf = (view) => ({ type: 'schedules', schedules: view });

  /** Tell the windows when the list differs from what they were last told. */
  function announce() {
    const view = payload();
    const text = JSON.stringify(view);
    if (text === told) return false;
    told = text;
    try { emit(frameOf(view)); } catch { /* a bad listener must never wedge the hook handler */ }
    return true;
  }

  function start() {
    try {
      const cur = readFile();
      const mine = cur.sessions[key];
      // Only THIS folder's own entry: a port outlives its host, and the next project to get it is not the one that scheduled these.
      if (model.rows().length === 0 && isObj(mine) && folderKey(mine.cwd) !== null && folderKey(mine.cwd) === folderKey(cwd)) model.restore(mine.rows);
    } catch { /* restoring is best effort */ }
    started = true;
    persist();
    told = JSON.stringify(payload());
  }

  /** One hook event. Returns whether this session's schedule changed. */
  function event(ev) {
    let changed = false;
    try { changed = model.handle(ev); } catch (err) { say(`[schedules] event failed: ${err && err.message ? err.message : err}`); }
    if (changed) { persist(); announce(); }
    return changed;
  }

  /** The night's PR count (or anything else the rows borrow) moved: rewrite this host's rows and tell the windows. */
  function touch() {
    if (model.rows().length === 0) return false;
    persist();
    return announce();
  }

  /** The heartbeat: keeps a host with rows "alive" for its neighbours, follows a branch rename, and moves "in 23 min" along. */
  function beat() {
    if (!ended && (dirty || model.rows().length > 0)) persist();
    announce();
  }

  /** A watched write by another host: the frame for this host's windows, or null when nothing they show has changed. */
  function changed() {
    let view;
    try { view = currentView(); } catch { return null; }
    const text = JSON.stringify(view);
    if (text === told) return null;
    told = text;
    return frameOf(view);
  }

  /** A clean exit: neighbours see "session ended" at once instead of after three silent minutes. */
  function end() {
    if (ended || !started) return;
    persist({ markEnded: true });
    ended = true;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  const handles = (type) => type === CONTROL_TYPE;
  const reply = () => frameOf(payload());

  return { start, event, touch, beat, changed, end, payload, handles, reply };
}

module.exports = { createSchedulesControl, isSchedulesOnly, normalizeFolder, STORE_KEY, CONTROL_TYPE };
